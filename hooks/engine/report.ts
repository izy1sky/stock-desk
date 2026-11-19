// The analysis report: loads what a ticker needs, runs every module, weighs
// them into one composite for the chosen horizon, and adds levels, expected
// moves, scenarios and the historical-analog study. Also the market overview,
// beta mapping and level probabilities the tools answer with.

import type { AssetClass } from '../../types'
import { loadHistory } from '../data'
import { bi, pick, type Lang } from '../i18n'
import { analogs, expectedMoves, probAbove, probTouch, scenarios } from './forecast'
import type { AnalogStudy, ExpectedMove, Scenarios } from './forecast'
import {
  betaStats,
  cotStats,
  futuresModule,
  impliedCash,
  INDEX_OF,
  loadCashIndexes,
  loadCot,
  loadDailyBars,
  loadFutures,
  loadIndexHistory,
  projectMove,
} from './futures'
import type { BetaStats, CashQuote, CotStats, FuturesQuote, ImpliedCash, IndexSymbol, Projection } from './futures'
import type { Fetch } from './http'
import { analyzeChain, fmtGex, loadChain, loadVolIndexes, optionsModule } from './options'
import type { OptionsLevels, OptionsStats, SkewRead, VolIndexes } from './options'
import { fmtPrice, keyLevelsDetail, trendModule, volatilityModule, volumeModule } from './technicals'
import type { LevelPoint } from './technicals'
import { biasOf, clampScore } from './types'
import type { Bar, Bias, ModuleKey, ModuleResult, Text } from './types'

// ---------------------------------------------------------------- weights

/**
 * How much each module counts, by horizon (trading days). Short horizons lean
 * on what moves price in days (futures, options positioning, volume); longer
 * ones on the trend. Each weight is then multiplied by the module's own
 * confidence, so an unsure module counts for little.
 */
export function compositeWeights(days: number): Record<ModuleKey, number> {
  if (days <= 5) return { futures: 0.25, options: 0.25, volume: 0.2, trend: 0.15, volatility: 0.15 }
  if (days <= 30) return { trend: 0.35, volume: 0.2, options: 0.2, volatility: 0.15, futures: 0.1 }

  return { trend: 0.5, volume: 0.2, volatility: 0.15, options: 0.1, futures: 0.05 }
}

/** Tickers whose price is the index (or a fixed multiple of it): futures count in full for them. */
const INDEX_LINKED = new Set([
  'SPX', 'XSP', 'SPY', 'VOO', 'IVV', 'SPLG', 'SSO', 'UPRO', 'SPXL', 'SDS', 'SPXU', 'SPXS', 'SH',
  'NDX', 'QQQ', 'QQQM', 'QLD', 'TQQQ', 'SQQQ', 'PSQ',
  'DJI', 'DIA', 'UDOW', 'SDOW',
  'RUT', 'IWM', 'TNA', 'TZA',
])

/** Index symbols, which Nasdaq's stock history does not serve, and the ETF that stands in for them in a regression. */
const INDEX_PROXY: Partial<Record<string, string>> = { SPX: 'SPY', NDX: 'QQQ', DJI: 'DIA', RUT: 'IWM' }

export type Composite = {
  score: number
  bias: Bias
  /** 0..1: confidence-weighted agreement of the modules with the composite's sign. */
  confidence: number
  agree: number
  total: number
  weights: Partial<Record<ModuleKey, number>>
}

export function composite(modules: ModuleResult[], days: number, indexLinked: boolean): Composite {
  const base = compositeWeights(days)
  let sum = 0
  let wsum = 0
  const used: Partial<Record<ModuleKey, number>> = {}
  for (const m of modules) {
    const w = base[m.key] * (m.key === 'futures' && !indexLinked ? 0.5 : 1) * m.confidence
    if (w <= 0) continue
    used[m.key] = +w.toFixed(3)
    sum += w * m.score
    wsum += w
  }
  const score = wsum > 0 ? clampScore(sum / wsum) : 0
  const voting = modules.filter(m => m.confidence > 0 && Math.abs(m.score) >= 10)
  const agree = voting.filter(m => Math.sign(m.score) === Math.sign(score) && score !== 0).length
  const agreement = voting.length ? agree / voting.length : 0
  const meanConf = modules.length ? modules.reduce((s, m) => s + m.confidence, 0) / modules.length : 0
  const confidence = +Math.min(1, 0.5 * agreement + 0.3 * meanConf + 0.2 * Math.min(1, Math.abs(score) / 50)).toFixed(2)

  return { score, bias: biasOf(score), confidence, agree, total: voting.length, weights: used }
}

// ---------------------------------------------------------------- the report

export type OptionsSummary = {
  asOf: string
  spot: number
  pcVolume?: number
  pcVolumeNear?: number
  pcOi?: number
  ivAtm30?: number
  termRatio?: number
  term: { expiry: string; days: number; iv: number }[]
  skew?: { expiry: string; days: number; put25: number; call25: number; skew: number; read: SkewRead }
  gexTotal: number
  gexNote: Text
  levels: OptionsLevels
  maxPainNearest?: { expiry: string; strike: number }
  maxPainMonthly?: { expiry: string; strike: number }
  moves: { expiry: string; days: number; monthly: boolean; straddle: number; pct: number; lo: number; hi: number }[]
  topCallOi: { strike: number; oi: number }[]
  topPutOi: { strike: number; oi: number }[]
  unusual: { expiry: string; type: 'C' | 'P'; strike: number; volume: number; oi: number; premium: number }[]
}

export type Report = {
  symbol: string
  horizonDays: number
  /** Last daily close the analysis is anchored on, and its date. */
  spot: number
  asOf: string
  /** A later print than the close (pre-market, after hours or intraday), from the option feed. */
  indicated?: { price: number; changePct: number }
  fetchedAt: number
  bars: number
  modules: ModuleResult[]
  composite: Composite
  supports: LevelPoint[]
  resistances: LevelPoint[]
  options?: OptionsSummary
  /** Annualized vol the forecast uses, and where it came from. */
  sigma: number
  sigmaSource: 'implied' | 'realized'
  moves: ExpectedMove[]
  scenarios: Scenarios
  analogs: AnalogStudy
  /** Event risk and other caveats the reader must weigh. */
  notes: Text[]
  /** Sources that failed: each a short line. */
  errors: string[]
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Drops `stats` (large, and only the tools' JSON needs it) from a module result. */
function slim(m: ModuleResult & { stats?: unknown; levels?: unknown }): ModuleResult {
  const { key, score, confidence, verdict, readings, flags } = m

  return { key, score, confidence, verdict, readings, flags }
}

function summarizeOptions(s: OptionsStats): OptionsSummary {
  return {
    asOf: s.asOf,
    spot: s.spot,
    pcVolume: s.pcVolume,
    pcVolumeNear: s.pcVolumeNear,
    pcOi: s.pcOi,
    ivAtm30: s.ivAtm30,
    termRatio: s.termRatio,
    term: s.term.map(t => ({ expiry: t.expiry, days: t.days, iv: t.iv })),
    skew: s.skew && { expiry: s.skew.expiry, days: s.skew.days, put25: s.skew.put25, call25: s.skew.call25, skew: s.skew.skew, read: s.skew.read },
    gexTotal: s.gex.total,
    gexNote: s.gex.note,
    levels: { callWall: s.gex.callWall, putWall: s.gex.putWall, gammaFlip: s.gex.flip, maxPain: s.maxPain.nearest?.strike },
    maxPainNearest: s.maxPain.nearest && { expiry: s.maxPain.nearest.expiry, strike: s.maxPain.nearest.strike },
    maxPainMonthly: s.maxPain.monthly && { expiry: s.maxPain.monthly.expiry, strike: s.maxPain.monthly.strike },
    moves: s.expectedMoves.map(m => ({ expiry: m.expiry, days: m.days, monthly: m.monthly, straddle: m.straddle, pct: m.pct, lo: m.lo, hi: m.hi })),
    topCallOi: s.topCallOi.slice(0, 5),
    topPutOi: s.topPutOi.slice(0, 5),
    unusual: s.unusual.slice(0, 5).map(u => ({ expiry: u.expiry, type: u.type, strike: u.strike, volume: u.volume, oi: u.oi, premium: u.premium })),
  }
}

/** Ten years of daily bars for a stock, ETF or index, whichever the symbol is. */
export async function loadBars(fetch: Fetch, symbol: string, assetClass?: AssetClass): Promise<Bar[]> {
  const sym = symbol.toUpperCase()
  if (sym in INDEX_PROXY) {
    if (sym === 'DJI') return loadHistory(fetch, 'DIA', 'etf')

    return loadIndexHistory(fetch, sym as IndexSymbol, 3650)
  }
  for (const cls of assetClass ? [assetClass] : (['stocks', 'etf'] as const)) {
    const bars = await loadHistory(fetch, sym, cls).catch(() => [] as Bar[])
    if (bars.length) return bars
  }
  throw new Error(`No price history for ${sym}`)
}

export type MarketContext = {
  quotes: FuturesQuote[]
  cash: CashQuote[]
  cot: CotStats[]
  vol?: VolIndexes
  errors: string[]
  fetchedAt: number
}

/** Futures, cash indexes, COT for ES and NQ and the VIX family: shared by every report and the overview. */
export async function loadMarketContext(fetch: Fetch): Promise<MarketContext> {
  const errors: string[] = []
  const [quotes, cash, cotEs, cotNq, vol] = await Promise.all([
    loadFutures(fetch).catch(e => (errors.push(`Futures quotes: ${message(e)}`), [] as FuturesQuote[])),
    loadCashIndexes(fetch).catch(e => (errors.push(`Cash indexes: ${message(e)}`), [] as CashQuote[])),
    loadCot(fetch, 'ES').then(rows => cotStats(rows, Date.now(), 'ES')).catch(e => (errors.push(`COT ES: ${message(e)}`), undefined)),
    loadCot(fetch, 'NQ').then(rows => cotStats(rows, Date.now(), 'NQ')).catch(e => (errors.push(`COT NQ: ${message(e)}`), undefined)),
    loadVolIndexes(fetch).catch(e => (errors.push(`VIX indexes: ${message(e)}`), undefined)),
  ])

  return { quotes, cash, cot: [cotEs, cotNq].filter((c): c is CotStats => !!c), vol, errors, fetchedAt: Date.now() }
}

export type ReportOptions = {
  horizonDays?: number
  assetClass?: AssetClass
  /** Already loaded market context, reused across tickers. */
  market?: MarketContext
  /** Already loaded bars (ten years is best for the analogs). */
  bars?: Bar[]
  /** Trading days to the ticker's next earnings report, when known. */
  earningsInDays?: number
}

export async function buildReport(fetch: Fetch, symbol: string, opts: ReportOptions = {}): Promise<Report> {
  const sym = symbol.toUpperCase()
  const horizonDays = Math.max(1, Math.min(120, Math.round(opts.horizonDays ?? 10)))
  const errors: string[] = []
  const notes: Text[] = []

  const [bars, chainStats, market] = await Promise.all([
    opts.bars?.length ? Promise.resolve(opts.bars) : loadBars(fetch, sym, opts.assetClass),
    loadChain(fetch, sym)
      .then(chain => analyzeChain(chain))
      .catch(e => (errors.push(`Options chain: ${message(e)}`), undefined)),
    opts.market ? Promise.resolve(opts.market) : loadMarketContext(fetch),
  ])
  errors.push(...market.errors)
  if (bars.length < 60) throw new Error(`Only ${bars.length} days of history for ${sym}: too little to analyse.`)

  const last = bars[bars.length - 1]!
  const spot = last.c
  const iv = chainStats?.ivAtm30
  const trend = trendModule(bars)
  const volatility = volatilityModule(bars, iv ? { iv } : undefined)
  const volume = volumeModule(bars)
  const modules: ModuleResult[] = [slim(trend), slim(volatility), slim(volume)]
  if (chainStats) {
    const om = slim(optionsModule(chainStats, market.vol))
    const e = opts.earningsInDays
    if (e !== undefined && e >= 0 && e <= 9) {
      // An earnings report inside the front expiries lifts near-term IV: the
      // inverted term structure is the event being priced, not market stress.
      om.flags.unshift(
        bi(
          `Earnings in ${e} trading day${e === 1 ? '' : 's'}: near-term IV and the term structure price the report, not general stress.`,
          `${e} 个交易日后发布财报：近月 IV 与期限结构反映的是财报事件，而非整体市场压力。`,
        ),
      )
      om.confidence = +(om.confidence * 0.7).toFixed(2)
    }
    modules.push(om)
  }
  if (opts.earningsInDays !== undefined && opts.earningsInDays >= 0 && opts.earningsInDays <= horizonDays)
    notes.push(
      bi(
        `Earnings in ${opts.earningsInDays} trading days, inside the horizon: expect a gap that the levels and the model odds do not capture.`,
        `${opts.earningsInDays} 个交易日后发布财报，落在周期之内：可能出现跳空，关键位与模型概率都无法反映。`,
      ),
    )
  if (market.quotes.length) modules.push(slim(futuresModule({ quotes: market.quotes, cash: market.cash, cot: market.cot })))

  const comp = composite(modules, horizonDays, INDEX_LINKED.has(sym))
  const { supports, resistances } = keyLevelsDetail(bars, spot)
  const sigma = volatility.stats.sigma ?? 0.25
  const levels = {
    supports: supports.map(s => s.price),
    resistances: resistances.map(r => r.price),
  }

  return {
    symbol: sym,
    horizonDays,
    spot,
    asOf: last.t,
    indicated:
      chainStats && Math.abs(chainStats.spot / spot - 1) > 0.0005
        ? { price: chainStats.spot, changePct: (chainStats.spot / spot - 1) * 100 }
        : undefined,
    fetchedAt: Date.now(),
    bars: bars.length,
    modules,
    composite: comp,
    supports,
    resistances,
    options: chainStats && summarizeOptions(chainStats),
    sigma,
    sigmaSource: volatility.stats.sigmaSource === 'iv' ? 'implied' : 'realized',
    moves: expectedMoves(spot, sigma),
    scenarios: scenarios({ spot, sigma, days: horizonDays, levels, compositeScore: comp.score }),
    analogs: analogs(bars, { horizons: [...new Set([5, 20, horizonDays])].sort((a, b) => a - b) }),
    notes,
    errors,
  }
}

// ---------------------------------------------------------------- formatting

const sgn = (n: number, digits = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`
const pctOf = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`
const cell = (s: string) => s.replace(/\|/g, '\\|')
const MODULE_NAME: Record<ModuleKey, string> = { trend: 'Trend', volatility: 'Volatility', volume: 'Volume / flow', options: 'Options', futures: 'Futures' }
const MODULE_NAME_ZH: Record<ModuleKey, string> = { trend: '趋势', volatility: '波动率', volume: '成交量/资金流', options: '期权', futures: '期货' }

export function moduleLabel(key: ModuleKey, lang: Lang = 'en'): string {
  return lang === 'zh' ? MODULE_NAME_ZH[key] : MODULE_NAME[key]
}

/** Tool answers are English: the 'en' side of a Text, or the value as it is. */
const en = (t: Text | string | number | undefined) => pick('en', t)

/** A −100..100 score as a ten-cell bar, e.g. "▁▁▁▁▁|███▁▁" (left of the bar = bearish). */
export function scoreBar(score: number): string {
  const n = Math.round(Math.abs(score) / 20)
  const left = score < 0 ? '░'.repeat(5 - n) + '█'.repeat(n) : '░'.repeat(5)
  const right = score > 0 ? '█'.repeat(n) + '░'.repeat(5 - n) : '░'.repeat(5)

  return `${left}│${right}`
}

function modulesMarkdown(modules: ModuleResult[], weights: Partial<Record<ModuleKey, number>>): string {
  const rows = modules.map(m => `| ${MODULE_NAME[m.key]} | ${sgn(m.score, 0)} | ${m.confidence.toFixed(2)} | ${weights[m.key]?.toFixed(2) ?? '0'} | ${cell(en(m.verdict))} |`)

  return `| Module | Score | Confidence | Weight used | Verdict |\n|---|---|---|---|---|\n${rows.join('\n')}`
}

function readingsMarkdown(m: ModuleResult): string {
  const lines = m.readings.map(r => `- ${en(r.name)}: ${typeof r.value === 'number' ? +r.value.toFixed(4) : en(r.value)}${r.note && r.note.en ? ` (${r.note.en})` : ''}`)
  const flags = m.flags.map(f => `- ⚑ ${en(f)}`)

  return [`**${MODULE_NAME[m.key]}** ${sgn(m.score, 0)} · confidence ${m.confidence.toFixed(2)} — ${en(m.verdict)}`, ...lines, ...flags].join('\n')
}

function analogsMarkdown(a: AnalogStudy): string {
  if (!a.ok) return `Historical analogs: ${en(a.note)}`
  const rows = a.horizons.map(
    h =>
      `| ${h.days} days | ${h.analogs.n} | ${h.analogs.winRate.toFixed(0)}% | ${sgn(h.analogs.mean)}% | ${sgn(h.analogs.median)}% | ${sgn(h.analogs.p10)}% / ${sgn(h.analogs.p90)}% | ${h.baseline.winRate.toFixed(0)}% | ${sgn(h.baseline.mean)}% |`,
  )

  return (
    `Historical analogs (${a.k} closest past days by trend, momentum, volatility and volume features, ${a.eligibleDays} days searched):\n\n` +
    `| Horizon | n | Win rate | Mean | Median | p10 / p90 | Baseline win | Baseline mean |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n` +
    `Closest analog dates: ${a.closest.map(c => c.date).join(', ')}. ${en(a.note)}`
  )
}

function optionsMarkdown(o: OptionsSummary): string {
  const lv = o.levels
  const lines = [
    `Options (CBOE delayed, as of ${o.asOf}, reference spot ${fmtPrice(o.spot)}):`,
    `- Put/call volume ${o.pcVolume?.toFixed(2) ?? '—'} (≤7 days ${o.pcVolumeNear?.toFixed(2) ?? '—'}), put/call OI ${o.pcOi?.toFixed(2) ?? '—'}`,
    `- ATM IV 30d ${o.ivAtm30 !== undefined ? pctOf(o.ivAtm30) : '—'}; term ${o.term.slice(0, 6).map(t => `${t.days}d ${pctOf(t.iv)}`).join(', ')}${o.termRatio !== undefined ? `; 9d/90d ratio ${o.termRatio.toFixed(2)}${o.termRatio > 1 ? ' (inverted)' : ''}` : ''}`,
    o.skew ? `- 25Δ skew (${o.skew.days}d): put ${pctOf(o.skew.put25)} vs call ${pctOf(o.skew.call25)} = ${(o.skew.skew * 100).toFixed(1)} vol pts (${o.skew.read})` : '- 25Δ skew: —',
    `- Dealer gamma ${fmtGex(o.gexTotal)} per 1% move; gamma flip ${lv.gammaFlip !== undefined ? fmtPrice(lv.gammaFlip) : 'none nearby'}; call wall ${lv.callWall !== undefined ? fmtPrice(lv.callWall) : '—'}; put wall ${lv.putWall !== undefined ? fmtPrice(lv.putWall) : '—'}`,
    `- Max pain: nearest ${o.maxPainNearest ? `${fmtPrice(o.maxPainNearest.strike)} (${o.maxPainNearest.expiry})` : '—'}, monthly ${o.maxPainMonthly ? `${fmtPrice(o.maxPainMonthly.strike)} (${o.maxPainMonthly.expiry})` : '—'}`,
    `- Straddle-implied moves: ${o.moves.map(m => `${m.expiry}${m.monthly ? ' (monthly)' : ''} ±${m.pct.toFixed(2)}% → ${fmtPrice(m.lo)}–${fmtPrice(m.hi)}`).join('; ')}`,
    `- Largest call OI: ${o.topCallOi.map(s => `${fmtPrice(s.strike)} (${s.oi.toLocaleString('en-US')})`).join(', ')}`,
    `- Largest put OI: ${o.topPutOi.map(s => `${fmtPrice(s.strike)} (${s.oi.toLocaleString('en-US')})`).join(', ')}`,
  ]
  if (o.unusual.length)
    lines.push(`- Unusual volume: ${o.unusual.map(u => `${u.expiry} ${fmtPrice(u.strike)}${u.type} vol ${u.volume.toLocaleString('en-US')} vs OI ${u.oi.toLocaleString('en-US')} (~$${(u.premium / 1e6).toFixed(2)}M)`).join('; ')}`)
  lines.push(`- ${en(o.gexNote)}`)

  return lines.join('\n')
}

export function reportMarkdown(r: Report): string {
  const c = r.composite
  const lvl = (l: LevelPoint) => `${fmtPrice(l.price)} (${l.kind}${l.date ? ` ${l.date}` : ''}, ${sgn(((l.price - r.spot) / r.spot) * 100, 1)}%)`
  const moves = r.moves.map(m => `| ${en(m.label)} | ±${m.pct1.toFixed(2)}% | ${fmtPrice(m.lower1)}–${fmtPrice(m.upper1)} | ${fmtPrice(m.lower2)}–${fmtPrice(m.upper2)} |`)
  const scen = r.scenarios.rows.map(s => {
    const where = s.target !== undefined ? fmtPrice(s.target) : s.range ? `${fmtPrice(s.range[0])}–${fmtPrice(s.range[1])}` : '—'
    const mv = Array.isArray(s.movePct) ? `${sgn(s.movePct[0], 1)}% / ${sgn(s.movePct[1], 1)}%` : `${sgn(s.movePct, 1)}%`

    return `| ${s.name} | ${where} | ${mv} | ${(s.probability * 100).toFixed(0)}% ${s.probKind} | ${cell(en(s.trigger))} | ${cell(en(s.invalidation))} |`
  })

  return [
    `# ${r.symbol} — ${c.bias}, composite ${sgn(c.score, 0)} (confidence ${c.confidence.toFixed(2)}, ${c.agree}/${c.total} modules agree), horizon ${r.horizonDays} trading days`,
    `Anchored on the ${r.asOf} close ${fmtPrice(r.spot)}${r.indicated ? ` · latest print ${fmtPrice(r.indicated.price)} (${sgn(r.indicated.changePct)}% vs that close; levels and odds below are measured from the close)` : ''} · ${r.bars} daily bars · σ ${pctOf(r.sigma)} (${r.sigmaSource})`,
    modulesMarkdown(r.modules, c.weights),
    r.modules.map(readingsMarkdown).join('\n\n'),
    `Key levels — resistance: ${r.resistances.map(lvl).join('; ') || 'none above'}\nsupport: ${r.supports.map(lvl).join('; ') || 'none below'}`,
    r.options ? optionsMarkdown(r.options) : 'Options: no chain (not optionable, or the source failed).',
    `Expected moves (lognormal, σ ${pctOf(r.sigma)}):\n\n| Horizon | 1σ | 1σ range | 2σ range |\n|---|---|---|---|\n${moves.join('\n')}`,
    `Scenarios over ${r.scenarios.days} sessions (model probabilities, not direction calls):\n\n| Case | Target | Move | Probability | Trigger | Invalidation |\n|---|---|---|---|---|---|\n${scen.join('\n')}\n\n${en(r.scenarios.note)}`,
    analogsMarkdown(r.analogs),
    ...r.notes.map(n => `⚠ ${en(n)}`),
    r.errors.length ? `Data gaps: ${r.errors.join('; ')}` : 'All sources answered.',
  ].join('\n\n')
}

// ---------------------------------------------------------------- options alone

export async function buildOptions(fetch: Fetch, symbol: string, vol?: VolIndexes): Promise<{ summary: OptionsSummary; module: ModuleResult }> {
  const sym = symbol.toUpperCase()
  const [stats, v] = await Promise.all([
    loadChain(fetch, sym).then(analyzeChain),
    vol ? Promise.resolve(vol) : loadVolIndexes(fetch).catch(() => undefined),
  ])

  return { summary: summarizeOptions(stats), module: slim(optionsModule(stats, v)) }
}

export function optionsReportMarkdown(symbol: string, o: { summary: OptionsSummary; module: ModuleResult }): string {
  return `# ${symbol.toUpperCase()} options positioning\n\n${readingsMarkdown(o.module)}\n\n${optionsMarkdown(o.summary)}`
}

// ---------------------------------------------------------------- market overview

export type MarketReport = {
  context: MarketContext
  futures?: ModuleResult
  implied: ImpliedCash[]
  spy?: Report
  fetchedAt: number
}

export async function buildMarket(fetch: Fetch, horizonDays = 5): Promise<MarketReport> {
  const context = await loadMarketContext(fetch)
  const fm = context.quotes.length ? futuresModule({ quotes: context.quotes, cash: context.cash, cot: context.cot }) : undefined
  const implied: ImpliedCash[] = []
  for (const q of context.quotes) {
    const cash = context.cash.find(c => c.symbol === INDEX_OF[q.root])
    if (cash) implied.push(impliedCash(q, cash))
  }
  const spy = await buildReport(fetch, 'SPY', { horizonDays, market: context, assetClass: 'etf' }).catch(e => {
    context.errors.push(`SPY report: ${message(e)}`)

    return undefined
  })

  return { context, futures: fm && slim(fm), implied, spy, fetchedAt: Date.now() }
}

export function marketMarkdown(m: MarketReport): string {
  const ctx = m.context
  const fut = ctx.quotes.map(q => {
    const imp = m.implied.find(i => i.root === q.root)

    return `| ${q.root} ${q.contract ?? ''} | ${fmtPrice(q.last)} | ${sgn(q.changePct)}% | ${fmtPrice(q.prevSettle)} | ${imp ? `${imp.index} ${fmtPrice(imp.impliedCash)} (${sgn(imp.impliedChangePct)}%)` : '—'} | ${q.session} · ${q.time} · ${q.source} |`
  })
  const v = ctx.vol
  const vix = v
    ? `VIX ${v.vix?.value.toFixed(2) ?? '—'} · VIX9D ${v.vix9d?.value.toFixed(2) ?? '—'} · VIX3M ${v.vix3m?.value.toFixed(2) ?? '—'} · VVIX ${v.vvix?.value.toFixed(1) ?? '—'} · SKEW ${v.skew?.value.toFixed(1) ?? '—'}; VIX9D/VIX ${v.vix9dToVix?.toFixed(2) ?? '—'}, VIX/VIX3M ${v.vixToVix3m?.toFixed(2) ?? '—'} → ${v.regime ?? '—'}`
    : 'VIX family: unavailable'
  const cot = ctx.cot.map(
    c =>
      `| ${c.market} | ${c.date} | ${c.lev.net.toLocaleString('en-US')} (${sgn(c.lev.pctOi, 1)}% OI) | ${c.lev.index3y.toFixed(0)} / ${c.lev.index26w.toFixed(0)}${c.lev.crowded ? ` crowded ${c.lev.crowded}` : ''} | ${c.am.net.toLocaleString('en-US')} | ${c.am.index3y.toFixed(0)} / ${c.am.index26w.toFixed(0)}${c.am.crowded ? ` crowded ${c.am.crowded}` : ''} | ${c.dealer.net.toLocaleString('en-US')} |`,
  )

  return [
    '# Market overview',
    fut.length
      ? `| Future | Last | vs settle | Prior settle | Implied cash | Session · time · source |\n|---|---|---|---|---|---|\n${fut.join('\n')}`
      : 'Futures quotes unavailable.',
    m.futures ? readingsMarkdown(m.futures) : '',
    vix,
    cot.length
      ? `COT (Traders in Financial Futures; index = 0 lowest … 100 highest net of the window, 3y / 26w):\n\n| Market | As of | Leveraged funds net | Lev. index 3y/26w | Asset managers net | AM index 3y/26w | Dealers net |\n|---|---|---|---|---|---|---|\n${cot.join('\n')}`
      : 'COT: unavailable',
    m.spy ? `## SPY\n\n${reportMarkdown(m.spy)}` : '',
    ctx.errors.length ? `Data gaps: ${ctx.errors.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ---------------------------------------------------------------- beta map and probabilities

export type BetaRow = { symbol: string; stats?: BetaStats; prev?: number; projection?: Projection; error?: string }

export type BetaMap = { base: string; baseRef: number; baseRefNote: string; baseTarget: number; baseMovePct: number; lookback: number; rows: BetaRow[] }

/**
 * Where each target would be if `base` moved to `baseTarget` (or by
 * `baseMovePct`), from the regression of daily returns over `lookback` days.
 * An index base (SPX, NDX, DJI, RUT) is measured from its cash close, with its
 * ETF's history standing in for the regression.
 */
export async function buildBetaMap(
  fetch: Fetch,
  input: { base: string; targets: string[]; baseTarget?: number; baseMovePct?: number; lookback?: number },
): Promise<BetaMap> {
  const base = input.base.toUpperCase()
  const lookback = Math.max(20, Math.min(250, Math.round(input.lookback ?? 60)))
  const days = Math.round(lookback * 1.6) + 20
  const proxy = INDEX_PROXY[base]
  const baseBars = await loadDailyBars(fetch, proxy ?? base, days)
  if (baseBars.length < lookback / 2) throw new Error(`Not enough history for ${proxy ?? base}`)
  let baseRef = baseBars[baseBars.length - 1]!.c
  let baseRefNote = `${proxy ?? base} close ${baseBars[baseBars.length - 1]!.t}`
  if (proxy) {
    const cash = (await loadCashIndexes(fetch, [base as IndexSymbol])).find(c => c.symbol === base)
    if (!cash) throw new Error(`No cash quote for ${base}`)
    baseRef = cash.open ? cash.prevClose : cash.last
    baseRefNote = `${base} ${cash.open ? 'prior close' : 'close'} (${cash.sessionDate}${cash.open ? ', market open' : ''})`
  }
  const baseTarget = input.baseTarget ?? baseRef * (1 + (input.baseMovePct ?? 0) / 100)
  const rows = await Promise.all(
    input.targets.map(async (t): Promise<BetaRow> => {
      const symbol = t.toUpperCase()
      try {
        const bars = await loadDailyBars(fetch, symbol, days)
        const stats = betaStats(baseBars, bars, lookback)
        const prev = bars[bars.length - 1]?.c
        if (!stats || prev === undefined) return { symbol, error: 'too little overlapping history' }

        return { symbol, stats, prev, projection: projectMove(stats, { basePrev: baseRef, baseTarget, targetPrev: prev }) }
      } catch (e) {
        return { symbol, error: message(e) }
      }
    }),
  )

  return { base, baseRef, baseRefNote, baseTarget, baseMovePct: ((baseTarget - baseRef) / baseRef) * 100, lookback, rows }
}

export function betaMarkdown(b: BetaMap): string {
  const rows = b.rows.map(r =>
    r.projection && r.stats
      ? `| ${r.symbol} | ${r.stats.beta.toFixed(2)} | ${r.stats.corr.toFixed(2)} | ${(r.stats.residSd * 100).toFixed(2)}% | ${fmtPrice(r.prev!)} | ${sgn(r.projection.movePct)}% | **${fmtPrice(r.projection.price)}** | ${fmtPrice(r.projection.lo)}–${fmtPrice(r.projection.hi)} |`
      : `| ${r.symbol} | — | — | — | — | — | — | ${r.error ?? ''} |`,
  )

  return (
    `${b.base} ${fmtPrice(b.baseRef)} → ${fmtPrice(b.baseTarget)} (${sgn(b.baseMovePct)}%), measured from the ${b.baseRefNote}; betas from ${b.lookback} days of daily returns.\n\n` +
    `| Ticker | Beta | Corr | Residual σ (1 day) | Last close | Projected move | Projected price | ±1σ band |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n` +
    'The band is one daily residual standard deviation: a one-session estimate. Low correlation means the ticker often moves on its own news; multi-day moves of leveraged ETFs compound and drift from the single-day multiple.'
  )
}

export type ProbabilityRow = { level: number; pctAway: number; above: number; below: number; touch: number }

export async function buildProbabilities(
  fetch: Fetch,
  input: { symbol: string; levels: number[]; days: number },
): Promise<{ symbol: string; spot: number; asOf: string; sigma: number; sigmaSource: string; days: number; rows: ProbabilityRow[] }> {
  const sym = input.symbol.toUpperCase()
  const days = Math.max(1, Math.min(252, Math.round(input.days)))
  const [bars, chain] = await Promise.all([loadBars(fetch, sym), loadChain(fetch, sym).then(analyzeChain).catch(() => undefined)])
  const last = bars[bars.length - 1]!
  let sigma: number | undefined
  let sigmaSource = 'realized volatility (no option chain)'
  if (chain?.term.length) {
    // The expiry closest to the horizon in calendar days.
    const cal = days * 1.45
    const near = [...chain.term].sort((a, b) => Math.abs(a.days - cal) - Math.abs(b.days - cal))[0]
    if (near && near.iv > 0) {
      sigma = near.iv
      sigmaSource = `implied vol of the ${near.expiry} expiry (${near.days} days)`
    }
  }
  if (sigma === undefined) sigma = volatilityModule(bars).stats.sigma ?? 0.25
  const spot = last.c
  const rows = input.levels.map(level => {
    const above = probAbove(spot, level, sigma!, days)

    return { level, pctAway: ((level - spot) / spot) * 100, above, below: 1 - above, touch: probTouch(spot, level, sigma!, days) }
  })

  return { symbol: sym, spot, asOf: last.t, sigma, sigmaSource, days, rows }
}

export function probabilitiesMarkdown(p: Awaited<ReturnType<typeof buildProbabilities>>): string {
  const rows = p.rows.map(r => `| ${fmtPrice(r.level)} | ${sgn(r.pctAway, 1)}% | ${(r.above * 100).toFixed(1)}% | ${(r.below * 100).toFixed(1)}% | ${(r.touch * 100).toFixed(1)}% |`)

  return (
    `${p.symbol} from the ${p.asOf} close ${fmtPrice(p.spot)}, ${p.days} trading days, σ ${pctOf(p.sigma)} from ${p.sigmaSource}.\n\n` +
    `| Level | Distance | Close above | Close below | Touch before then |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n` +
    'Zero-drift lognormal model: it prices the size of moves, not their direction. Real returns have fatter tails than this model.'
  )
}
