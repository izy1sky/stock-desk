// Where option data comes from: CBOE when it answers, otherwise Nasdaq's chain
// with vols solved here; the VIX family from CBOE, with CNBC filling what is
// missing. One place decides, so every read says the same thing.

import type { AssetClass } from '../../types'
import { cnbcRows, cnbcUrl } from './futures'
import { getJson, num, type Fetch } from './http'
import { loadNasdaqChain, loadSpots, type NasdaqClass } from './nasdaq-chain'
import { analyzeChain, loadChain, loadVolIndexes, VOL_KEYS, volFamily } from './options'
import type { OptionsStats, VolIndexes, VolKey, VolParts, VolQuote } from './options'

const TTL = 10 * 60_000

/** Analysed chains by symbol, kept ten minutes: the quotes behind them are 15 minutes old anyway. */
export type OptionCache = Map<string, { at: number; stats: Promise<OptionsStats> }>

/** Index options only CBOE lists here, and the fund whose chain stands in for them. */
const PROXY_FUND: Record<string, string> = { SPX: 'SPY', RUT: 'IWM' }

/** Funds most often asked about: asked of Nasdaq as ETFs first. */
const FUNDS = new Set(
  'SPY QQQ IWM DIA VOO IVV QQQM RSP MDY TQQQ SQQQ UPRO SPXU SPXL SPXS SSO SDS QLD PSQ SH UDOW SDOW TNA TZA SOXL SOXS SOXX SMH XLK XLF XLE XLV XLY XLP XLI XLB XLU XLC XLRE GLD SLV TLT HYG LQD USO ARKK KRE XBI XOP EEM EFA FXI KWEB UVXY VXX IBIT'.split(' '),
)

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function classesFor(sym: string, assetClass?: AssetClass): NasdaqClass[] {
  if (sym === 'NDX') return ['index']
  const etfFirst = assetClass ? assetClass === 'etf' : FUNDS.has(sym)

  return etfFirst ? ['etf', 'stocks'] : ['stocks', 'etf']
}

/** Every price in an analysed chain times `ratio`: a fund's option levels in its index's points. Dollar gamma and contract counts stay the fund's own. */
export function scaleStats(s: OptionsStats, symbol: string, ratio: number): OptionsStats {
  const x = (n: number) => Math.round(n * ratio * 100) / 100
  const pain = <T extends { strike: number }>(m: T | undefined) => (m ? { ...m, strike: x(m.strike) } : undefined)
  const { nearest, monthly } = s.maxPain
  const g = s.gex

  return {
    ...s,
    symbol,
    securityType: 'index',
    spot: x(s.spot),
    lastPrice: x(s.lastPrice),
    optionSpot: x(s.optionSpot),
    gex: {
      ...g,
      byStrike: g.byStrike.map(r => ({ ...r, strike: x(r.strike) })),
      top: g.top.map(r => ({ ...r, strike: x(r.strike) })),
      profile: g.profile.map(p => ({ ...p, spot: x(p.spot) })),
      ...(g.callWall !== undefined ? { callWall: x(g.callWall) } : {}),
      ...(g.putWall !== undefined ? { putWall: x(g.putWall) } : {}),
      ...(g.flip !== undefined ? { flip: x(g.flip) } : {}),
    },
    maxPain: { ...(nearest ? { nearest: pain(nearest)! } : {}), ...(monthly ? { monthly: pain(monthly)! } : {}) },
    expectedMoves: s.expectedMoves.map(m => ({ ...m, straddle: x(m.straddle), lo: x(m.lo), hi: x(m.hi), ...(m.ivMove !== undefined ? { ivMove: x(m.ivMove) } : {}) })),
    topCallOi: s.topCallOi.map(r => ({ ...r, strike: x(r.strike) })),
    topPutOi: s.topPutOi.map(r => ({ ...r, strike: x(r.strike) })),
    unusual: s.unusual.map(u => ({ ...u, strike: x(u.strike) })),
    source: { ...(s.source ?? { provider: 'nasdaq' as const }), via: { symbol: s.symbol, ratio } },
  }
}

async function fromNasdaq(fetch: Fetch, sym: string, assetClass: AssetClass | undefined, now: number): Promise<OptionsStats> {
  const fund = PROXY_FUND[sym]
  if (!fund) return analyzeChain(await loadNasdaqChain(fetch, sym, classesFor(sym, assetClass), { now }))
  const [chain, spots] = await Promise.all([loadNasdaqChain(fetch, fund, ['etf'], { now }), loadSpots(fetch, [sym, fund], now)])
  const index = spots.get(sym)
  const base = spots.get(fund)
  if (!index || !base || index.sessionDate !== base.sessionDate) throw new Error(`No same-session ${sym} and ${fund} prices to scale ${fund}'s chain`)

  return scaleStats(analyzeChain(chain), sym, index.last / base.last)
}

async function load(fetch: Fetch, sym: string, assetClass: AssetClass | undefined, now: number): Promise<OptionsStats> {
  let reason: string
  try {
    const chain = await loadChain(fetch, sym)

    return analyzeChain({ ...chain, source: { provider: 'cboe' } })
  } catch (e) {
    reason = message(e)
  }
  try {
    const stats = await fromNasdaq(fetch, sym, assetClass, now)

    return { ...stats, source: { ...(stats.source ?? { provider: 'nasdaq' as const }), fallback: reason } }
  } catch (e) {
    throw new Error(`${reason}; ${message(e)}`)
  }
}

/** One ticker's analysed option chain from the first source that has it. Calls that ask at once share one load. */
export function loadOptionStats(fetch: Fetch, symbol: string, opts: { cache?: OptionCache; assetClass?: AssetClass; now?: number } = {}): Promise<OptionsStats> {
  const sym = symbol.trim().toUpperCase().replace(/^[_^$]/, '')
  const now = opts.now ?? Date.now()
  const have = opts.cache?.get(sym)
  if (have && now - have.at < TTL) return have.stats
  const stats = load(fetch, sym, opts.assetClass, now)
  opts.cache?.set(sym, { at: now, stats })
  // A failure is not kept: the next read tries again.
  stats.catch(() => {
    if (opts.cache?.get(sym)?.stats === stats) opts.cache.delete(sym)
  })

  return stats
}

// ─── Volatility indexes ───────────────────────────────────────────────────

/** CNBC's quote rows for the VIX family (it has no SKEW). */
export function parseCnbcVol(data: any): VolParts {
  const out: VolParts = {}
  for (const r of cnbcRows(data)) {
    const key = VOL_KEYS.find(k => `.${k.toUpperCase()}` === r?.symbol)
    const value = num(r?.last)
    if (!key || (r.code !== undefined && Number(r.code) !== 0) || value === undefined || value <= 0) continue
    const change = num(r.change)
    const prevClose = change !== undefined ? value - change : num(r.previous_day_closing)
    const changePct = num(r.change_pct)
    const date = /^\d{4}-\d{2}-\d{2}/.exec(String(r.last_time ?? ''))?.[0]
    const q: VolQuote = { value }
    if (change !== undefined) q.change = change
    if (prevClose !== undefined) q.prevClose = Math.round(prevClose * 100) / 100
    if (changePct !== undefined) q.changePct = changePct
    if (date) q.date = date
    out[key] = q
  }

  return out
}

/** The VIX family and VXN: CBOE, with CNBC filling whatever it did not give. */
export async function loadVol(fetch: Fetch): Promise<VolIndexes> {
  let cboe: VolIndexes | undefined
  let reason: string | undefined
  try {
    cboe = await loadVolIndexes(fetch)
    if (cboe.vix && cboe.vix9d && cboe.vix3m) return { ...cboe, source: 'cboe' }
  } catch (e) {
    reason = message(e)
  }
  const wanted: VolKey[] = VOL_KEYS.filter(k => k !== 'skew')
  const cnbc = await getJson(fetch, cnbcUrl(wanted.map(k => `.${k.toUpperCase()}`)))
    .then(parseCnbcVol)
    .catch(() => ({}) as VolParts)
  if (cboe) {
    const filled = VOL_KEYS.filter(k => !cboe![k] && cnbc[k])
    if (!filled.length) return { ...cboe, source: 'cboe' }
    const parts: VolParts = {}
    for (const k of VOL_KEYS) {
      const q = cboe[k] ?? cnbc[k]
      if (q) parts[k] = q
    }

    return { ...volFamily(parts), source: 'cboe+cnbc' }
  }
  if (!Object.keys(cnbc).length) throw new Error(reason ?? 'volatility indexes unavailable')

  return { ...volFamily(cnbc), source: 'cnbc' }
}
