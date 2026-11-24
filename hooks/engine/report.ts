// The analysis report: loads what a ticker needs, runs every module, weighs
// them into one composite for the chosen horizon, and adds levels, expected
// moves, scenarios and the historical-analog study. Also the market overview,
// beta mapping and level probabilities the tools answer with.

import type { AssetClass } from '../../types'
import { loadHistory } from '../data'
import { bi, biasText, pick, type Lang } from '../i18n'
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
import type { BetaStats, CashQuote, CotStats, FuturesQuote, FuturesRoot, ImpliedCash, IndexSymbol, Projection } from './futures'
import type { Fetch } from './http'
import { loadOptionStats, loadVol, type OptionCache } from './chains'
import { fmtGex, optionsModule, sourceText } from './options'
import type { ChainSource, OptionsLevels, OptionsStats, SkewRead, VolIndexes } from './options'
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

/** Tickers whose price is the index (or a fixed multiple of it), and the futures contract on that index: futures count in full for them. */
const INDEX_FUTURE: Record<string, FuturesRoot> = {
  ...Object.fromEntries(['SPX', 'XSP', 'SPY', 'VOO', 'IVV', 'SPLG', 'SSO', 'UPRO', 'SPXL', 'SDS', 'SPXU', 'SPXS', 'SH'].map(s => [s, 'ES'])),
  ...Object.fromEntries(['NDX', 'QQQ', 'QQQM', 'QLD', 'TQQQ', 'SQQQ', 'PSQ'].map(s => [s, 'NQ'])),
  ...Object.fromEntries(['DJI', 'DIA', 'UDOW', 'SDOW'].map(s => [s, 'YM'])),
  ...Object.fromEntries(['RUT', 'IWM', 'TNA', 'TZA'].map(s => [s, 'RTY'])),
}
const INDEX_LINKED = new Set(Object.keys(INDEX_FUTURE))
/** Funds that move against their index: a futures rally is bearish for them. */
const INVERSE = new Set(['SDS', 'SPXU', 'SPXS', 'SH', 'SQQQ', 'PSQ', 'SDOW', 'TZA'])

/** The futures contract a ticker tracks, if it is an index fund (and whether it is inverse). */
export function futuresLeadOf(symbol: string): { root: FuturesRoot; inverse: boolean } | undefined {
  const sym = symbol.toUpperCase()
  const root = INDEX_FUTURE[sym]

  return root ? { root, inverse: INVERSE.has(sym) } : undefined
}

/** The futures module for one ticker: its own contract leads, and an inverse fund reads the signal the other way. */
function futuresFor(sym: string, market: MarketContext): ModuleResult {
  const lead = futuresLeadOf(sym)
  const m = slim(futuresModule({ quotes: market.quotes, cash: market.cash, cot: market.cot, lead: lead?.root }))
  if (!lead?.inverse) return m

  return {
    ...m,
    score: -m.score,
    flags: [bi(`${sym} is an inverse fund: the futures signal counts against it`, `${sym} 是反向基金：期货信号对它的方向相反`), ...m.flags],
  }
}

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
  /** Where the chain came from (absent from summaries built before 0.6.0: CBOE). */
  source?: ChainSource
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
  /** The numbers a side-by-side comparison needs (absent from reports built before 0.5.0). */
  key?: KeyStats
}

export type KeyStats = {
  ma20?: number
  ma50?: number
  ma200?: number
  adx?: number
  /** Annualized, decimal. */
  rv20?: number
  rvPct1y?: number
  distributionDays: number
  accumulationDays: number
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
    ...(s.source ? { source: s.source } : {}),
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
    loadVol(fetch).catch(e => (errors.push(`VIX indexes: ${message(e)}`), undefined)),
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
  /** Option chains kept between reads. */
  optionCache?: OptionCache
}

export async function buildReport(fetch: Fetch, symbol: string, opts: ReportOptions = {}): Promise<Report> {
  const sym = symbol.toUpperCase()
  const horizonDays = Math.max(1, Math.min(120, Math.round(opts.horizonDays ?? 10)))
  const errors: string[] = []
  const notes: Text[] = []

  const [bars, chainStats, market] = await Promise.all([
    opts.bars?.length ? Promise.resolve(opts.bars) : loadBars(fetch, sym, opts.assetClass),
    loadOptionStats(fetch, sym, { cache: opts.optionCache, assetClass: opts.assetClass })
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
  if (market.quotes.length) modules.push(futuresFor(sym, market))

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
    key: {
      ma20: trend.stats.ma.ma20,
      ma50: trend.stats.ma.ma50,
      ma200: trend.stats.ma.ma200,
      adx: trend.stats.adx,
      rv20: volatility.stats.rv20,
      rvPct1y: volatility.stats.rvPct1y,
      distributionDays: volume.stats.distributionDays,
      accumulationDays: volume.stats.accumulationDays,
    },
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
    `Options (${en(sourceText(o.source))}, as of ${o.asOf}, reference spot ${fmtPrice(o.spot)}):`,
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
  if (o.source?.fallback) lines.push(`- CBOE did not answer (${o.source.fallback}), so this is Nasdaq's chain; put/call volume and open interest are its last published figures`)
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

export async function buildOptions(fetch: Fetch, symbol: string, vol?: VolIndexes, optionCache?: OptionCache): Promise<{ summary: OptionsSummary; module: ModuleResult }> {
  const sym = symbol.toUpperCase()
  const [stats, v] = await Promise.all([
    loadOptionStats(fetch, sym, { cache: optionCache }),
    vol ? Promise.resolve(vol) : loadVol(fetch).catch(() => undefined),
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
  /** The two indexes the market read covers: SPX through SPY, NDX through QQQ. */
  spy?: Report
  qqq?: Report
  fetchedAt: number
}

/** The index funds the market read analyses in full, and the cash index each stands for. */
export const MARKET_INDEXES = [
  { symbol: 'SPY', index: 'SPX' },
  { symbol: 'QQQ', index: 'NDX' },
] as const

export async function buildMarket(fetch: Fetch, horizonDays = 5, optionCache?: OptionCache): Promise<MarketReport> {
  const context = await loadMarketContext(fetch)
  const fm = context.quotes.length ? futuresModule({ quotes: context.quotes, cash: context.cash, cot: context.cot }) : undefined
  const implied: ImpliedCash[] = []
  for (const q of context.quotes) {
    const cash = context.cash.find(c => c.symbol === INDEX_OF[q.root])
    if (cash) implied.push(impliedCash(q, cash))
  }
  const [spy, qqq] = await Promise.all(
    MARKET_INDEXES.map(({ symbol }) =>
      buildReport(fetch, symbol, { horizonDays, market: context, assetClass: 'etf', optionCache }).catch(e => {
        context.errors.push(`${symbol} report: ${message(e)}`)

        return undefined
      }),
    ),
  )

  return { context, futures: fm && slim(fm), implied, spy, qqq, fetchedAt: Date.now() }
}

/** How two composite reads relate: both one way, split, or both neutral. */
export function indexAgreement(a: Report, b: Report): Text {
  const x = a.composite
  const y = b.composite
  const side = (s: number) => (s >= 15 ? 1 : s <= -15 ? -1 : 0)
  const gap = Math.abs(x.score - y.score)
  if (side(x.score) === 0 && side(y.score) === 0) return bi(`Both ${a.symbol} and ${b.symbol} read neutral.`, `${a.symbol} 与 ${b.symbol} 都是中性。`)
  if (side(x.score) === side(y.score)) {
    const dir = side(x.score) > 0 ? 'bullish' : 'bearish'
    const strong = Math.abs(x.score) >= Math.abs(y.score) ? a : b

    return gap < 10
      ? bi(`Both lean ${dir}, about equally (${gap} pts apart).`, `两者都${dir === 'bullish' ? '偏多' : '偏空'}，程度相近（相差 ${gap} 分）。`)
      : bi(`Both lean ${dir}; ${strong.symbol} is the stronger read (${gap} pts apart).`, `两者都${dir === 'bullish' ? '偏多' : '偏空'}；${strong.symbol} 的信号更强（相差 ${gap} 分）。`)
  }

  return bi(
    `They disagree: ${a.symbol} ${x.bias} (${sgn(x.score, 0)}), ${b.symbol} ${y.bias} (${sgn(y.score, 0)}). A split market: weigh the index the question is about.`,
    `两者分歧：${a.symbol} ${biasText(x.bias).zh}（${sgn(x.score, 0)}），${b.symbol} ${biasText(y.bias).zh}（${sgn(y.score, 0)}）。市场分化：以所问的指数为准。`,
  )
}

/** SPY and QQQ side by side: the composite, every module, the trend and volatility numbers, analogs and the nearest levels. */
export function indexComparisonMarkdown(m: MarketReport): string {
  const reports = [m.spy, m.qqq].filter((r): r is Report => !!r)
  if (reports.length < 2) return ''
  const [a, b] = reports as [Report, Report]
  const col = (f: (r: Report) => string) => `${f(a)} | ${f(b)}`
  const dist = (r: Report, ma?: number) => (ma ? `${sgn((r.spot / ma - 1) * 100, 1)}%` : '—')
  const mod = (r: Report, key: ModuleKey) => {
    const x = r.modules.find(x => x.key === key)
    if (!x) return '—'
    const lead = key === 'futures' ? futuresLeadOf(r.symbol)?.root : undefined

    return `${sgn(x.score, 0)} (${x.confidence.toFixed(2)})${lead ? ` · ${lead}` : ''}`
  }
  const imp = (r: Report) => {
    const idx = MARKET_INDEXES.find(x => x.symbol === r.symbol)?.index
    const i = m.implied.find(x => x.index === idx)

    return i ? `${idx} ${fmtPrice(i.impliedCash)} (${sgn(i.impliedChangePct)}%)` : '—'
  }
  const analog5 = (r: Report) => {
    const h = r.analogs.ok ? r.analogs.horizons.find(x => x.days === 5) : undefined

    return h ? `${h.analogs.winRate.toFixed(0)}% vs ${h.baseline.winRate.toFixed(0)}%, mean ${sgn(h.analogs.mean)}% (n ${h.analogs.n})` : '—'
  }
  const near = (r: Report) => `${r.resistances[0] ? fmtPrice(r.resistances[0].price) : '—'} / ${r.supports[0] ? fmtPrice(r.supports[0].price) : '—'}`
  const volIndex = (r: Report, v?: VolIndexes) => {
    const [name, q] = r.symbol === 'QQQ' ? ['VXN', v?.vxn] : ['VIX', v?.vix]

    return q ? `${name} ${q.value.toFixed(2)}${q.changePct !== undefined ? ` (${sgn(q.changePct, 1)}%)` : ''}` : '—'
  }
  const optionLevels = (r: Report) => {
    const o = r.options
    if (!o) return '—'
    const lv = (x?: number) => (x !== undefined ? fmtPrice(x) : '—')

    return `${o.ivAtm30 !== undefined ? pctOf(o.ivAtm30) : '—'} / ${lv(o.levels.gammaFlip)} / call ${lv(o.levels.callWall)}, put ${lv(o.levels.putWall)}`
  }
  const move = (r: Report, i: number) => (r.moves[i] ? `±${r.moves[i]!.pct1.toFixed(2)}%` : '—')
  const rows: [string, string][] = [
    ['Close', col(r => `${fmtPrice(r.spot)} (${r.asOf})`)],
    ['Futures-implied index', col(imp)],
    ['Composite', col(r => `${r.composite.bias} ${sgn(r.composite.score, 0)} (conf ${r.composite.confidence.toFixed(2)}, ${r.composite.agree}/${r.composite.total} agree)`)],
    ...(['trend', 'volatility', 'volume', 'options', 'futures'] as ModuleKey[]).map(k => [MODULE_NAME[k], col(r => mod(r, k))] as [string, string]),
    ['Close vs MA20 / MA50 / MA200', col(r => `${dist(r, r.key?.ma20)} / ${dist(r, r.key?.ma50)} / ${dist(r, r.key?.ma200)}`)],
    ['MA200', col(r => (r.key?.ma200 ? fmtPrice(r.key.ma200) : '—'))],
    ['ADX(14)', col(r => r.key?.adx?.toFixed(1) ?? '—')],
    ['RV20 (1y percentile)', col(r => (r.key?.rv20 !== undefined ? `${pctOf(r.key.rv20)} (${r.key.rvPct1y?.toFixed(0) ?? '—'})` : '—'))],
    ['Volatility index', col(r => volIndex(r, m.context.vol))],
    ['ATM IV 30d / gamma flip / walls', col(optionLevels)],
    ['Distribution / accumulation (25d)', col(r => (r.key ? `${r.key.distributionDays} / ${r.key.accumulationDays}` : '—'))],
    ['1σ 1 day / 1 week', col(r => `${move(r, 0)} / ${move(r, 1)}`)],
    ['Analogs 5 days: win vs baseline', col(analog5)],
    ['Nearest resistance / support', col(near)],
  ]

  return [
    `## ${a.symbol} vs ${b.symbol} (SPX vs NDX), horizon ${a.horizonDays} trading days`,
    `| | ${a.symbol} | ${b.symbol} |\n|---|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}`,
    `**${en(indexAgreement(a, b))}**`,
  ].join('\n\n')
}

export function marketMarkdown(m: MarketReport): string {
  const ctx = m.context
  const fut = ctx.quotes.map(q => {
    const imp = m.implied.find(i => i.root === q.root)

    return `| ${q.root} ${q.contract ?? ''} | ${fmtPrice(q.last)} | ${sgn(q.changePct)}% | ${fmtPrice(q.prevSettle)} | ${imp ? `${imp.index} ${fmtPrice(imp.impliedCash)} (${sgn(imp.impliedChangePct)}%)` : '—'} | ${q.session} · ${q.time} · ${q.source} |`
  })
  const v = ctx.vol
  const vix = v
    ? `VIX ${v.vix?.value.toFixed(2) ?? '—'} · VIX9D ${v.vix9d?.value.toFixed(2) ?? '—'} · VIX3M ${v.vix3m?.value.toFixed(2) ?? '—'} · VVIX ${v.vvix?.value.toFixed(1) ?? '—'} · SKEW ${v.skew?.value.toFixed(1) ?? '—'} · VXN ${v.vxn?.value.toFixed(2) ?? '—'}; VIX9D/VIX ${v.vix9dToVix?.toFixed(2) ?? '—'}, VIX/VIX3M ${v.vixToVix3m?.toFixed(2) ?? '—'} → ${v.regime ?? '—'}${v.source && v.source !== 'cboe' ? ` (${v.source === 'cnbc' ? 'CNBC' : 'CBOE and CNBC'})` : ''}`
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
    indexComparisonMarkdown(m),
    m.spy ? `## SPY\n\n${reportMarkdown(m.spy)}` : '',
    m.qqq ? `## QQQ\n\n${reportMarkdown(m.qqq)}` : '',
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
  optionCache?: OptionCache,
): Promise<{ symbol: string; spot: number; asOf: string; sigma: number; sigmaSource: string; days: number; rows: ProbabilityRow[] }> {
  const sym = input.symbol.toUpperCase()
  const days = Math.max(1, Math.min(252, Math.round(input.days)))
  const [bars, chain] = await Promise.all([loadBars(fetch, sym), loadOptionStats(fetch, sym, { cache: optionCache }).catch(() => undefined)])
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
