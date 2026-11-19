// Options-market analysis: what the listed options say about a stock, ETF or
// index — positioning (put/call, open interest), dealer gamma, skew, term
// structure and the move the market prices.
//
// Data: CBOE's free delayed quotes (no key). The chain endpoint returns every
// listed contract with greeks; index chains use an underscore (`_SPX`). The
// mod's fetch does not follow redirects, so the final `cdn-api` host is used
// (`cdn.cboe.com` answers 307 to it).
//
// Payload facts checked against live data (Nov 2026):
// - `data.current_price` can include extended-hours trading; `close` /
//   `prev_day_close` is the last regular close; `iv30` is in percent.
// - Contract `iv` is a decimal (0.2812 = 28.12%); a few junk rows carry 0 or
//   absurd values (800%+).
// - Negative `gamma` appears only on dead rows (zero bid, zero ask, almost no
//   open interest), mostly adjusted contracts ('B1SPY…'). Adjusted roots have
//   a different deliverable and are dropped; any remaining negative gamma is
//   treated as 0.
// - The top-level `timestamp` ('2026-11-19 11:08:49') is UTC and is when the
//   snapshot was built; the underlying's `last_trade_time` is US Eastern and
//   stays at the regular close outside the session. Option quotes and greeks
//   are as of the earlier of the two, which is the chain's `asOf`. Contracts
//   that expired before it are still listed and are dropped here.
// - Outside regular hours `current_price` moves with extended trading while
//   option quotes stay at the close, so price-based reads (ATM IV, straddles,
//   skew deltas) use the spot implied by put-call parity (`optionSpot`).

import { bi, biasText, joinText } from '../i18n'
import { biasOf, clampScore, type ModuleResult, type Reading, type Text } from './types'
import { getJson, num, type Fetch } from './http'

// ─── Types ────────────────────────────────────────────────────────────────

export type OptionType = 'C' | 'P'

export type Contract = {
  /** 'YYYY-MM-DD' */
  expiry: string
  /** Calendar days from the as-of date (US Eastern) to expiry; 0 = expires that day. */
  days: number
  /** Years from the as-of time to the expiry's settlement time (≥ 1 hour). */
  t: number
  type: OptionType
  strike: number
  bid: number
  ask: number
  /** (bid + ask) / 2 when there is an ask, otherwise the last trade. */
  mid: number
  last: number
  /** Implied volatility as a decimal; 0 when the feed has no usable value. */
  iv: number
  oi: number
  volume: number
  /** The feed's delta and gamma (as of the feed's reference price). */
  delta: number
  gamma: number
}

export type Chain = {
  symbol: string
  spot: number
  /**
   * ISO time (UTC) the option quotes are as of: the underlying's last regular
   * trade when that is before the snapshot (options quoted only in the regular
   * session), the snapshot time for SPX/XSP/VIX (quoted overnight too).
   */
  asOf: string
  /** ISO time (UTC) CBOE built the snapshot. */
  snapshotAt?: string
  /** 30-day implied volatility from CBOE, decimal. */
  iv30?: number
  /** Last regular-session close of the underlying. */
  prevClose?: number
  /** CBOE's security type: 'stock' (also ETFs) or 'index'. */
  securityType?: string
  contracts: Contract[]
}

export type LoadChainOptions = {
  /** Drop contracts expiring later than this many days out (default 120). */
  maxDays?: number
}

export type ParsedOcc = { root: string; expiry: string; type: OptionType; strike: number }

export type TermPoint = { expiry: string; days: number; iv: number }

export type SkewRead = 'steep' | 'normal' | 'flat' | 'call skew'

const SKEW_ZH: Record<SkewRead, string> = { steep: '陡峭', normal: '正常', flat: '平坦', 'call skew': '认购偏斜' }

/** The 25-delta skew read in both languages. */
export const skewReadText = (r: SkewRead): Text => bi(r, SKEW_ZH[r])

export type SkewStats = {
  expiry: string
  days: number
  /** IV of the −25-delta put and the +25-delta call (decimals). */
  put25: number
  call25: number
  atm?: number
  /** put25 − call25, in IV decimals (0.05 = 5 vol points). */
  skew: number
  /** skew / ATM IV — comparable across underlyings. */
  ratio?: number
  read: SkewRead
}

export type StrikeGex = { strike: number; call: number; put: number; net: number }

export type GexStats = {
  /** Net dealer gamma exposure at the current spot, $ of delta per 1% move. */
  total: number
  callTotal: number
  putTotal: number
  /** Per-strike exposure within ±10% of spot, by strike. */
  byStrike: StrikeGex[]
  /** The 10 strikes with the largest |net| exposure, largest first. */
  top: StrikeGex[]
  /** Strike at/above spot with the largest call exposure. */
  callWall?: number
  /** Strike at/below spot with the largest (most negative) put exposure. */
  putWall?: number
  /** Spot level where total exposure crosses zero, nearest the current spot. */
  flip?: number
  /** Total exposure on a grid of hypothetical spots (±10%, 0.25% steps). */
  profile: { spot: number; gex: number }[]
  note: Text
}

export type MaxPain = { expiry: string; days: number; strike: number; monthly: boolean }

export type ExpectedMove = {
  expiry: string
  days: number
  monthly: boolean
  /** ATM straddle mid price, interpolated at the spot the quotes reflect (`optionSpot`). */
  straddle: number
  /** straddle / optionSpot × 100; `lo`/`hi` apply it to the current spot. */
  pct: number
  lo: number
  hi: number
  /** σ·√T·spot from the expiry's ATM IV, for comparison. */
  ivMove?: number
  ivPct?: number
}

export type StrikeOi = { strike: number; oi: number }

export type UnusualContract = {
  expiry: string
  days: number
  type: OptionType
  strike: number
  volume: number
  oi: number
  /** volume / OI (OI floored at 1). */
  ratio: number
  mid: number
  /** volume × mid × 100 */
  premium: number
}

export type OptionsStats = {
  symbol: string
  /**
   * Reference spot for GEX, walls, the flip and the expected-move bands: the
   * chain's last price, except for an index whose options trade overnight
   * (SPX/VIX global trading hours) while the cash index print is stale — then
   * the parity-implied spot when they differ by more than 0.2%.
   */
  spot: number
  /** The chain's last price as CBOE gave it (may include extended hours). */
  lastPrice: number
  /** Underlying price the option quotes reflect (put-call parity). */
  optionSpot: number
  asOf: string
  securityType?: string
  contracts: number
  callOi: number
  putOi: number
  totalOi: number
  callVolume: number
  putVolume: number
  /** Put volume / call volume, all loaded expiries. */
  pcVolume?: number
  /** Put volume / call volume, expiries within 7 days. */
  pcVolumeNear?: number
  /** Put OI / call OI, all loaded expiries. */
  pcOi?: number
  /** ATM IV of the first 8 expiries. */
  term: TermPoint[]
  /** ATM IV interpolated (in variance) at 30 days; falls back to CBOE's iv30. */
  ivAtm30?: number
  /** ATM IV at 9 days / ATM IV at 90 days (like VIX9D/VIX3M); > 1 = inverted. */
  termRatio?: number
  skew?: SkewStats
  gex: GexStats
  maxPain: { nearest?: MaxPain; monthly?: MaxPain }
  expectedMoves: ExpectedMove[]
  topCallOi: StrikeOi[]
  topPutOi: StrikeOi[]
  unusual: UnusualContract[]
  assumptions: { r: number; q: number }
}

export type VolQuote = { value: number; change?: number; changePct?: number; prevClose?: number }

export type VolRegime = 'contango (calm)' | 'flat' | 'backwardation (stress)'

const VOL_REGIME_ZH: Record<VolRegime, string> = {
  'contango (calm)': 'contango 升水，市场平静',
  flat: '平坦',
  'backwardation (stress)': 'backwardation 贴水，市场承压',
}

/** The VIX term-structure regime in both languages. */
export const volRegimeText = (r: VolRegime): Text => bi(r, VOL_REGIME_ZH[r])

export type VolIndexes = {
  asOf?: string
  vix?: VolQuote
  vix9d?: VolQuote
  vix3m?: VolQuote
  vvix?: VolQuote
  skew?: VolQuote
  /** > 1: the coming week is priced as more volatile than the coming month. */
  vix9dToVix?: number
  /** > 1: backwardation, the classic stress signal. */
  vixToVix3m?: number
  regime?: VolRegime
}

export type OptionsLevels = { callWall?: number; putWall?: number; gammaFlip?: number; maxPain?: number }

export type OptionsModuleResult = ModuleResult & { stats: OptionsStats; levels: OptionsLevels }

// ─── Constants ────────────────────────────────────────────────────────────

const CBOE = 'https://cdn-api.cboe.com/api/global/delayed_quotes'

/** Black-Scholes inputs for the gamma grid: a flat rate and dividend yield. */
export const RISK_FREE = 0.04
export const DIV_YIELD = 0.012

const YEAR_MS = 365 * 86_400_000
const DAY_MS = 86_400_000
const MIN_T = 1 / (365 * 24) // one hour

const INDEXES = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'XSP', 'DJX'])

/** Extra standard roots per underlying (weeklies / PM-settled series). */
const EXTRA_ROOTS: Record<string, string[]> = {
  SPX: ['SPXW'],
  NDX: ['NDXP'],
  RUT: ['RUTW'],
  VIX: ['VIXW'],
  XSP: ['XSPW'],
  DJX: ['DJXW'],
}

/** AM-settled roots: they settle on the expiry morning's open. */
const AM_ROOTS = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'DJX'])

/** Underlyings whose options trade in CBOE's global (overnight) session. */
const GTH = new Set(['SPX', 'XSP', 'VIX'])

const GEX_NOTE = bi(
  'Dealer gamma uses the common public convention (SqueezeMetrics-style): dealers are assumed long the calls and short the puts customers trade, so call GEX = +Γ·OI·100·S²·1% and put GEX = −Γ·OI·100·S²·1%, in $ of delta change per 1% move. Positive totals mean dealer hedging tends to damp moves; negative totals mean it tends to amplify them. It is an estimate: real dealer positions are not public.',
  '做市商伽马（GEX）采用公开市场的通用口径（SqueezeMetrics 式）：假定做市商持有客户所交易认购期权的多头、认沽期权的空头，因此认购 GEX = +Γ·OI·100·S²·1%，认沽 GEX = −Γ·OI·100·S²·1%，单位为标的每变动 1% 时的 delta 变化（美元）。总值为正，做市商对冲往往抑制波动；为负则往往放大波动。这只是估算：做市商的真实持仓并不公开。',
)

// ─── Symbols and parsing ──────────────────────────────────────────────────

/** SPX/NDX/RUT/VIX/XSP/DJX → '_SPX' etc. (CBOE's index form); others unchanged. */
export function cboeSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/^[_^$]/, '')

  return INDEXES.has(s) ? `_${s}` : s
}

const OCC_TAIL = /(\d{6})([CP])(\d{8})$/

/** 'SPY261120C00710000' (or 'B1SPY…', 'SPXW…') → root, expiry, type, strike. */
export function parseOcc(option: string): ParsedOcc | undefined {
  const m = OCC_TAIL.exec(option)
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return undefined
  const ymd = m[1]
  const expiry = `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`

  return { root: option.slice(0, m.index), expiry, type: m[2] as OptionType, strike: Number(m[3]) / 1000 }
}

// ─── Dates (US Eastern) ───────────────────────────────────────────────────

function nthSunday(year: number, month: number, n: number): number {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay()

  return 1 + ((7 - first) % 7) + 7 * (n - 1)
}

/** Whether US daylight saving time is in effect at this instant. */
function isUsDst(ms: number): boolean {
  const y = new Date(ms).getUTCFullYear()
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7)
  const end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6)

  return ms >= start && ms < end
}

const etOffsetHours = (ms: number) => (isUsDst(ms) ? 4 : 5)

/** The US Eastern calendar date of an instant, 'YYYY-MM-DD'. */
function etDate(ms: number): string {
  return new Date(ms - etOffsetHours(ms) * 3_600_000).toISOString().slice(0, 10)
}

/** An Eastern wall-clock time on a date → epoch ms. */
function etTime(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const noon = Date.UTC(y, m - 1, d, 12)

  return Date.UTC(y, m - 1, d, hour + etOffsetHours(noon), minute)
}

const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`)

/** Third Friday of its month (or the Thursday before when that Friday is not listed). */
function isMonthlyExpiry(expiry: string, listed: Set<string>): boolean {
  const d = new Date(`${expiry}T12:00:00Z`)
  const dom = d.getUTCDate()
  if (dom < 15 || dom > 21) return false
  const wd = d.getUTCDay()
  if (wd === 5) return true
  if (wd === 4) return !listed.has(new Date(d.getTime() + DAY_MS).toISOString().slice(0, 10))

  return false
}

/** CBOE's snapshot `timestamp` ('YYYY-MM-DD HH:MM:SS', UTC). */
function parseSnapshot(json: any): number | undefined {
  const ts = json?.timestamp
  if (typeof ts !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(ts)) return undefined
  const ms = Date.parse(`${ts.replace(' ', 'T').slice(0, 19)}Z`)

  return Number.isFinite(ms) ? ms : undefined
}

/** The underlying's `last_trade_time` ('YYYY-MM-DDTHH:MM:SS', US Eastern). */
function parseLastTrade(json: any): number | undefined {
  const lt = json?.data?.last_trade_time
  if (typeof lt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(lt)) return undefined
  const [date, time] = lt.split('T') as [string, string]
  const [h, mi, sec] = time.split(':').map(Number) as [number, number, number?]

  return etTime(date, h, mi) + (sec ?? 0) * 1000
}

// ─── Loading ──────────────────────────────────────────────────────────────

const n0 = (x: unknown) => num(x) ?? 0

/**
 * Turn CBOE's chain payload into a compact `Chain`: standard roots only,
 * unexpired contracts within `maxDays`, dead rows dropped, junk IV/gamma
 * zeroed. Pure, so tests and tools can feed it a payload directly.
 */
export function parseChain(json: any, symbol: string, opts: LoadChainOptions = {}): Chain {
  const data = json?.data
  const rows: any[] = Array.isArray(data?.options) ? data.options : []
  const spot = n0(data?.current_price) || n0(data?.close) || n0(data?.prev_day_close)
  if (!(spot > 0)) throw new Error(`No price for ${symbol} in the CBOE chain`)
  const snapshotMs = parseSnapshot(json)
  const lastTradeMs = parseLastTrade(json)
  const base = cboeSymbol(symbol).replace(/[^A-Z]/g, '')
  // Options on SPX/XSP/VIX are quoted overnight (global trading hours) and
  // CBOE reprices them, so their quotes are as of the snapshot. Everything
  // else is quoted only in the regular session: as of the last regular trade.
  const asOfMs = GTH.has(base)
    ? (snapshotMs ?? lastTradeMs ?? Date.now())
    : snapshotMs !== undefined && lastTradeMs !== undefined
      ? Math.min(snapshotMs, lastTradeMs)
      : (snapshotMs ?? lastTradeMs ?? Date.now())
  const today = dayMs(etDate(asOfMs))
  const maxDays = opts.maxDays ?? 120

  const roots = new Set([base, ...(EXTRA_ROOTS[base] ?? [])])
  const build = (acceptRoot: (root: string) => boolean): Contract[] => {
    const out: Contract[] = []
    for (const r of rows) {
      const occ = typeof r?.option === 'string' ? parseOcc(r.option) : undefined
      if (!occ || !acceptRoot(occ.root)) continue
      const days = Math.round((dayMs(occ.expiry) - today) / DAY_MS)
      if (days < 0 || days > maxDays) continue
      const settle = AM_ROOTS.has(occ.root) ? etTime(occ.expiry, 9, 30) : etTime(occ.expiry, 16, 0)
      // Expired, or settling within 20 minutes of the quotes (a closing print).
      if (settle - asOfMs < 20 * 60_000) continue
      const bid = Math.max(0, n0(r.bid))
      const ask = Math.max(0, n0(r.ask))
      const oi = Math.max(0, n0(r.open_interest))
      const volume = Math.max(0, n0(r.volume))
      const last = Math.max(0, n0(r.last_trade_price))
      if (bid === 0 && ask === 0 && oi === 0 && volume === 0) continue
      let iv = n0(r.iv)
      if (!(iv > 0.005 && iv < 5)) iv = 0
      const gamma = n0(r.gamma)
      out.push({
        expiry: occ.expiry,
        days,
        t: Math.max(MIN_T, (settle - asOfMs) / YEAR_MS),
        type: occ.type,
        strike: occ.strike,
        bid,
        ask,
        mid: ask > 0 ? (bid + ask) / 2 : last,
        last,
        iv,
        oi,
        volume,
        delta: n0(r.delta),
        gamma: gamma > 0 ? gamma : 0,
      })
    }

    return out
  }

  let contracts = build(root => roots.has(root))
  // Unknown root scheme: fall back to every root without digits (adjusted
  // contracts like 'B1SPY' or 'SPY1' always carry one).
  if (contracts.length === 0 && rows.length > 0) contracts = build(root => !/\d/.test(root))
  contracts.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike || (a.type < b.type ? -1 : 1)))

  const iv30 = n0(data?.iv30)
  const prevClose = n0(data?.prev_day_close) || n0(data?.close)

  return {
    symbol: symbol.trim().toUpperCase().replace(/^_/, ''),
    spot,
    asOf: new Date(asOfMs).toISOString(),
    ...(snapshotMs !== undefined ? { snapshotAt: new Date(snapshotMs).toISOString() } : {}),
    ...(iv30 > 0 ? { iv30: iv30 / 100 } : {}),
    ...(prevClose > 0 ? { prevClose } : {}),
    ...(typeof data?.security_type === 'string' ? { securityType: data.security_type } : {}),
    contracts,
  }
}

/** Fetch and parse the CBOE delayed chain (≈5 MB for SPY, ≈14 MB for SPX). */
export async function loadChain(fetch: Fetch, symbol: string, opts: LoadChainOptions = {}): Promise<Chain> {
  const json = await getJson(fetch, `${CBOE}/options/${cboeSymbol(symbol)}.json`)

  return parseChain(json, symbol, opts)
}

// ─── Math ─────────────────────────────────────────────────────────────────

const SQRT_2PI = Math.sqrt(2 * Math.PI)
const pdf = (x: number) => Math.exp(-0.5 * x * x) / SQRT_2PI

/** Standard normal CDF (Abramowitz–Stegun 26.2.17, error < 7.5e-8). */
export function normCdf(x: number): number {
  const z = Math.abs(x)
  const k = 1 / (1 + 0.2316419 * z)
  const poly = k * (0.31938153 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))))
  const p = 1 - pdf(z) * poly

  return x >= 0 ? p : 1 - p
}

function d1Of(s: number, k: number, t: number, iv: number, r: number, q: number): number {
  return (Math.log(s / k) + (r - q + 0.5 * iv * iv) * t) / (iv * Math.sqrt(t))
}

/** Black-Scholes gamma (same for calls and puts). */
export function bsGamma(s: number, k: number, t: number, iv: number, r = RISK_FREE, q = DIV_YIELD): number {
  if (!(s > 0 && k > 0 && t > 0 && iv > 0)) return 0

  return (Math.exp(-q * t) * pdf(d1Of(s, k, t, iv, r, q))) / (s * iv * Math.sqrt(t))
}

/** Black-Scholes delta: calls 0..1, puts −1..0. */
export function bsDelta(type: OptionType, s: number, k: number, t: number, iv: number, r = RISK_FREE, q = DIV_YIELD): number {
  if (!(s > 0 && k > 0 && t > 0 && iv > 0)) return 0
  const nd = normCdf(d1Of(s, k, t, iv, r, q))

  return Math.exp(-q * t) * (type === 'C' ? nd : nd - 1)
}

const lerp = (x: number, x0: number, x1: number, y0: number, y1: number) => (x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0))

/** Value at `x` from points sorted by x: linear inside, flat outside. */
function interp(points: { x: number; y: number }[], x: number): number | undefined {
  const first = points[0]
  const lastP = points[points.length - 1]
  if (!first || !lastP) return undefined
  if (x <= first.x) return first.y
  if (x >= lastP.x) return lastP.y
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    if (x <= b.x) return lerp(x, a.x, b.x, a.y, b.y)
  }

  return lastP.y
}

// ─── Analysis ─────────────────────────────────────────────────────────────

type Expiry = { expiry: string; days: number; t: number; monthly: boolean; contracts: Contract[] }

function groupExpiries(contracts: Contract[]): Expiry[] {
  const map = new Map<string, Contract[]>()
  for (const c of contracts) {
    const list = map.get(c.expiry)
    if (list) list.push(c)
    else map.set(c.expiry, [c])
  }
  const listed = new Set(map.keys())

  return [...map.entries()]
    .map(([expiry, list]) => ({
      expiry,
      days: list[0]!.days,
      t: Math.max(...list.map(c => c.t)),
      monthly: isMonthlyExpiry(expiry, listed),
      contracts: list,
    }))
    .sort((a, b) => (a.expiry < b.expiry ? -1 : 1))
}

/** ATM IV of one expiry: call/put IV averaged per strike, interpolated at spot. */
function atmIv(e: Expiry, spot: number): number | undefined {
  const byStrike = new Map<number, { c?: number; p?: number }>()
  for (const c of e.contracts) {
    if (!(c.iv > 0)) continue
    const s = byStrike.get(c.strike) ?? {}
    if (c.type === 'C') s.c = c.iv
    else s.p = c.iv
    byStrike.set(c.strike, s)
  }
  const pts = [...byStrike.entries()]
    .map(([x, v]) => ({ x, y: v.c !== undefined && v.p !== undefined ? (v.c + v.p) / 2 : (v.c ?? v.p)! }))
    .sort((a, b) => a.x - b.x)
  const below = pts.filter(p => p.x <= spot).slice(-1)
  const above = pts.filter(p => p.x >= spot).slice(0, 1)
  const window = [...below, ...above.filter(a => !below.some(b => b.x === a.x))]

  return interp(window.length ? window : pts, spot)
}

/** IV at `days` from ATM points, interpolating total variance; flat outside. */
function ivAtDays(points: { t: number; iv: number }[], days: number): number | undefined {
  const T = Math.max(MIN_T, days / 365)
  const pts = points.filter(p => p.iv > 0).sort((a, b) => a.t - b.t)
  const first = pts[0]
  const lastP = pts[pts.length - 1]
  if (!first || !lastP) return undefined
  if (T <= first.t) return first.iv
  if (T >= lastP.t) return lastP.iv
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    if (T <= b.t) {
      const w = lerp(T, a.t, b.t, a.iv * a.iv * a.t, b.iv * b.iv * b.t)

      return w > 0 ? Math.sqrt(w / T) : undefined
    }
  }

  return lastP.iv
}

/** IV at a target delta for one side of an expiry, interpolated by delta. */
function ivAtDelta(e: Expiry, type: OptionType, target: number, spot: number): number | undefined {
  const pts = e.contracts
    .filter(c => c.type === type && c.iv > 0)
    .map(c => ({ x: bsDelta(type, spot, c.strike, c.t, c.iv) || c.delta, y: c.iv }))
    .filter(p => Math.abs(p.x) > 0.02 && Math.abs(p.x) < 0.6)
    .sort((a, b) => a.x - b.x)
  if (pts.length < 2) return undefined
  const first = pts[0]!
  const lastP = pts[pts.length - 1]!
  if (target < first.x || target > lastP.x) return undefined

  return interp(pts, target)
}

/**
 * Skew read from skew / ATM IV. Index 30-day 25-delta put-minus-call skew
 * usually runs 0.15–0.35 of ATM IV; single stocks 0.05–0.20.
 * steep ≥ 0.35 · flat ≤ 0.08 · call skew < 0 (calls bid over puts).
 */
function skewRead(skew: number, atm: number | undefined): SkewRead {
  const ratio = atm && atm > 0 ? skew / atm : skew / 0.2
  if (skew < 0) return 'call skew'
  if (ratio >= 0.35) return 'steep'
  if (ratio <= 0.08) return 'flat'

  return 'normal'
}

function maxPainOf(e: Expiry): MaxPain | undefined {
  const strikes = [...new Set(e.contracts.map(c => c.strike))].sort((a, b) => a - b)
  const withOi = e.contracts.filter(c => c.oi > 0)
  if (!withOi.length) return undefined
  let best: { strike: number; pain: number } | undefined
  for (const k of strikes) {
    let pain = 0
    for (const c of withOi) pain += c.oi * (c.type === 'C' ? Math.max(0, k - c.strike) : Math.max(0, c.strike - k))
    if (!best || pain < best.pain) best = { strike: k, pain }
  }

  return best && { expiry: e.expiry, days: e.days, strike: best.strike, monthly: e.monthly }
}

/** Straddle interpolated at the quotes' spot; the band is centred on the current spot. */
function expectedMoveOf(e: Expiry, quoteSpot: number, spot: number, iv: number | undefined): ExpectedMove | undefined {
  const byStrike = new Map<number, { c?: number; p?: number }>()
  for (const c of e.contracts) {
    if (!(c.mid > 0)) continue
    const s = byStrike.get(c.strike) ?? {}
    if (c.type === 'C') s.c = c.mid
    else s.p = c.mid
    byStrike.set(c.strike, s)
  }
  const pts = [...byStrike.entries()]
    .filter(([, v]) => v.c !== undefined && v.p !== undefined)
    .map(([x, v]) => ({ x, y: v.c! + v.p! }))
    .sort((a, b) => a.x - b.x)
  const below = pts.filter(p => p.x <= quoteSpot).slice(-1)
  const above = pts.filter(p => p.x >= quoteSpot).slice(0, 1)
  if (!below.length || !above.length) return undefined
  const straddle = interp([...below, ...above.filter(a => a.x !== below[0]!.x)], quoteSpot)
  if (straddle === undefined || !(straddle > 0)) return undefined
  const ivMove = iv && iv > 0 ? iv * Math.sqrt(e.t) * spot : undefined

  return {
    expiry: e.expiry,
    days: e.days,
    monthly: e.monthly,
    straddle,
    pct: (straddle / quoteSpot) * 100,
    lo: spot * (1 - straddle / quoteSpot),
    hi: spot * (1 + straddle / quoteSpot),
    ...(ivMove !== undefined ? { ivMove, ivPct: (ivMove / spot) * 100 } : {}),
  }
}

/**
 * Dealer gamma exposure (see GEX_NOTE for the convention). Uses Black-Scholes
 * gamma from each contract's own IV and time to expiry (r = RISK_FREE,
 * q = DIV_YIELD), so the value at the current spot and the hypothetical-spot
 * profile are computed the same way; the feed's gamma (struck at its own
 * reference price) is used only for contracts without a usable IV.
 */
function gexOf(contracts: Contract[], spot: number): GexStats {
  const live = contracts.filter(c => c.oi > 0 && (c.iv > 0 || c.gamma > 0))
  const perContract = (c: Contract, s: number) => {
    const g = c.iv > 0 ? bsGamma(s, c.strike, c.t, c.iv) : s === spot ? c.gamma : 0

    return (c.type === 'C' ? 1 : -1) * g * c.oi * 100 * s * s * 0.01
  }

  const strikes = new Map<number, StrikeGex>()
  let callTotal = 0
  let putTotal = 0
  for (const c of live) {
    const g = perContract(c, spot)
    const row = strikes.get(c.strike) ?? { strike: c.strike, call: 0, put: 0, net: 0 }
    if (c.type === 'C') {
      row.call += g
      callTotal += g
    } else {
      row.put += g
      putTotal += g
    }
    row.net += g
    strikes.set(c.strike, row)
  }
  const all = [...strikes.values()].sort((a, b) => a.strike - b.strike)
  const top = [...all].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 10)

  let callWall: StrikeGex | undefined
  let putWall: StrikeGex | undefined
  for (const row of all) {
    if (row.strike >= spot && row.call > 0 && (!callWall || row.call > callWall.call)) callWall = row
    if (row.strike <= spot && row.put < 0 && (!putWall || row.put < putWall.put)) putWall = row
  }

  // Hypothetical-spot profile, ±10% in 0.25% steps.
  const prepared = live
    .filter(c => c.iv > 0)
    .map(c => ({
      lnK: Math.log(c.strike),
      sd: c.iv * Math.sqrt(c.t),
      drift: (RISK_FREE - DIV_YIELD + 0.5 * c.iv * c.iv) * c.t,
      w: ((c.type === 'C' ? 1 : -1) * c.oi * 100 * 0.01 * Math.exp(-DIV_YIELD * c.t)) / (c.iv * Math.sqrt(c.t)),
    }))
  const profile: { spot: number; gex: number }[] = []
  for (let i = -40; i <= 40; i++) {
    const s = spot * (1 + i * 0.0025)
    const lnS = Math.log(s)
    let total = 0
    // Γ·S² = e^{-qT}·φ(d1)·S / (σ√T)
    for (const p of prepared) {
      const d1 = (lnS - p.lnK + p.drift) / p.sd
      total += p.w * pdf(d1) * s
    }
    profile.push({ spot: s, gex: total })
  }
  let flip: number | undefined
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]!
    const b = profile[i]!
    if (a.gex === 0 && b.gex === 0) continue
    if ((a.gex <= 0 && b.gex > 0) || (a.gex >= 0 && b.gex < 0)) {
      const x = a.spot + ((b.spot - a.spot) * (0 - a.gex)) / (b.gex - a.gex)
      if (flip === undefined || Math.abs(x - spot) < Math.abs(flip - spot)) flip = x
    }
  }

  return {
    total: callTotal + putTotal,
    callTotal,
    putTotal,
    byStrike: all.filter(r => Math.abs(r.strike / spot - 1) <= 0.1),
    top,
    ...(callWall ? { callWall: callWall.strike } : {}),
    ...(putWall ? { putWall: putWall.strike } : {}),
    ...(flip !== undefined ? { flip } : {}),
    profile,
    note: GEX_NOTE,
  }
}

function topOi(contracts: Contract[], type: OptionType): StrikeOi[] {
  const map = new Map<number, number>()
  for (const c of contracts) if (c.type === type && c.oi > 0) map.set(c.strike, (map.get(c.strike) ?? 0) + c.oi)

  return [...map.entries()]
    .map(([strike, oi]) => ({ strike, oi }))
    .sort((a, b) => b.oi - a.oi)
    .slice(0, 5)
}

/**
 * Unusual volume: volume > 3× open interest and above a floor of
 * max(500, 0.05% of the chain's total volume) contracts, excluding deep
 * in-the-money contracts (|Δ| ≥ 0.9: mostly spreads, exercises and dividend
 * trades). Ranked by premium.
 */
function unusualOf(contracts: Contract[], totalVolume: number): UnusualContract[] {
  const floor = Math.max(500, totalVolume * 0.0005)

  return contracts
    .filter(c => c.volume >= floor && c.volume > 3 * c.oi && Math.abs(c.delta) < 0.9)
    .map(c => ({
      expiry: c.expiry,
      days: c.days,
      type: c.type,
      strike: c.strike,
      volume: c.volume,
      oi: c.oi,
      ratio: c.volume / Math.max(1, c.oi),
      mid: c.mid,
      premium: c.volume * c.mid * 100,
    }))
    .sort((a, b) => b.premium - a.premium)
    .slice(0, 5)
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : undefined)

/**
 * The underlying price the option quotes reflect, from put-call parity at the
 * expiry nearest 30 days (3–60 days out): S = (K + (C − P)·e^{rT})·e^{−(r−q)T},
 * median over the three strikes where calls and puts are closest in price.
 * Falls back to `spot` when quotes are missing or the estimate is more than
 * 10% from `spot` and more than 3% from `prevClose`.
 */
export function impliedSpot(contracts: Contract[], spot: number, prevClose?: number): number {
  const expiries = groupExpiries(contracts)
    .filter(e => e.days >= 3 && e.days <= 60)
    .sort((a, b) => Math.abs(a.days - 30) - Math.abs(b.days - 30))
  const e = expiries[0]
  if (!e) return spot
  const calls = new Map<number, number>()
  const puts = new Map<number, number>()
  for (const c of e.contracts) if (c.bid > 0 && c.ask > 0) (c.type === 'C' ? calls : puts).set(c.strike, c.mid)
  const est = [...calls.entries()]
    .filter(([k]) => puts.has(k))
    .map(([k, c]) => ({ gap: Math.abs(c - puts.get(k)!), s: (k + (c - puts.get(k)!) * Math.exp(RISK_FREE * e.t)) * Math.exp(-(RISK_FREE - DIV_YIELD) * e.t) }))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 3)
    .map(x => x.s)
    .sort((a, b) => a - b)
  const mid = est[Math.floor(est.length / 2)]

  if (mid === undefined) return spot
  const near = Math.abs(mid / spot - 1) <= 0.1 || (prevClose !== undefined && prevClose > 0 && Math.abs(mid / prevClose - 1) <= 0.03)

  return near ? mid : spot
}

export function analyzeChain(chain: Chain): OptionsStats {
  const { contracts } = chain
  const expiries = groupExpiries(contracts)
  // Price-based reads (ATM IV, straddles, skew deltas) use the spot the quotes
  // were struck at; GEX, walls and bands use the most current spot.
  const optionSpot = impliedSpot(contracts, chain.spot, chain.prevClose)
  const spot = chain.securityType === 'index' && Math.abs(optionSpot / chain.spot - 1) > 0.002 ? optionSpot : chain.spot

  let callOi = 0
  let putOi = 0
  let callVolume = 0
  let putVolume = 0
  let callVolNear = 0
  let putVolNear = 0
  for (const c of contracts) {
    if (c.type === 'C') {
      callOi += c.oi
      callVolume += c.volume
      if (c.days <= 7) callVolNear += c.volume
    } else {
      putOi += c.oi
      putVolume += c.volume
      if (c.days <= 7) putVolNear += c.volume
    }
  }

  const atm = expiries.map(e => ({ e, iv: atmIv(e, optionSpot) }))
  const term: TermPoint[] = atm
    .slice(0, 8)
    .filter((p): p is { e: Expiry; iv: number } => p.iv !== undefined)
    .map(p => ({ expiry: p.e.expiry, days: p.e.days, iv: p.iv }))
  // 0-1 day expiries are left out of the interpolation basis: their IV is noisy.
  const basis = atm.filter(p => p.iv !== undefined && p.e.days >= 2).map(p => ({ t: p.e.t, iv: p.iv! }))
  const ivAtm30 = ivAtDays(basis, 30) ?? chain.iv30
  const iv9 = ivAtDays(basis, 9)
  const iv90 = ivAtDays(basis, 90)

  // Skew at the expiry nearest 30 days (at least a week out).
  const skewExpiry = [...expiries.filter(e => e.days >= 7)].sort((a, b) => Math.abs(a.days - 30) - Math.abs(b.days - 30))[0]
  let skew: SkewStats | undefined
  if (skewExpiry) {
    const put25 = ivAtDelta(skewExpiry, 'P', -0.25, optionSpot)
    const call25 = ivAtDelta(skewExpiry, 'C', 0.25, optionSpot)
    const atmSkew = atm.find(p => p.e === skewExpiry)?.iv
    if (put25 !== undefined && call25 !== undefined) {
      const s = put25 - call25
      skew = {
        expiry: skewExpiry.expiry,
        days: skewExpiry.days,
        put25,
        call25,
        ...(atmSkew !== undefined ? { atm: atmSkew, ratio: s / atmSkew } : {}),
        skew: s,
        read: skewRead(s, atmSkew),
      }
    }
  }

  const nearest = expiries[0]
  const monthly = expiries.find(e => e.monthly)
  const nearestPain = nearest && maxPainOf(nearest)
  const monthlyPain = monthly && maxPainOf(monthly)

  const moveExpiries = [...expiries.slice(0, 3), ...(monthly && !expiries.slice(0, 3).includes(monthly) ? [monthly] : [])]
  const expectedMoves = moveExpiries
    .map(e => expectedMoveOf(e, optionSpot, spot, atm.find(p => p.e === e)?.iv))
    .filter((m): m is ExpectedMove => m !== undefined)

  return {
    symbol: chain.symbol,
    spot,
    lastPrice: chain.spot,
    optionSpot,
    asOf: chain.asOf,
    ...(chain.securityType ? { securityType: chain.securityType } : {}),
    contracts: contracts.length,
    callOi,
    putOi,
    totalOi: callOi + putOi,
    callVolume,
    putVolume,
    ...opt('pcVolume', ratio(putVolume, callVolume)),
    ...opt('pcVolumeNear', ratio(putVolNear, callVolNear)),
    ...opt('pcOi', ratio(putOi, callOi)),
    term,
    ...opt('ivAtm30', ivAtm30),
    ...opt('termRatio', basis.length >= 2 && iv9 !== undefined && iv90 ? iv9 / iv90 : undefined),
    ...(skew ? { skew } : {}),
    gex: gexOf(contracts, spot),
    maxPain: { ...(nearestPain ? { nearest: nearestPain } : {}), ...(monthlyPain ? { monthly: monthlyPain } : {}) },
    expectedMoves,
    topCallOi: topOi(contracts, 'C'),
    topPutOi: topOi(contracts, 'P'),
    unusual: unusualOf(contracts, callVolume + putVolume),
    assumptions: { r: RISK_FREE, q: DIV_YIELD },
  }
}

function opt<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return (value !== undefined && Number.isFinite(value) ? { [key]: value } : {}) as { [P in K]?: number }
}

// ─── Volatility indexes ───────────────────────────────────────────────────

async function volQuote(fetch: Fetch, sym: string): Promise<VolQuote | undefined> {
  const json = await getJson(fetch, `${CBOE}/quotes/${sym}.json`)
  const d = json?.data
  const value = n0(d?.current_price)
  if (!(value > 0)) return undefined
  const change = num(d?.price_change)
  const changePct = num(d?.price_change_percent)

  return {
    value,
    ...(change !== undefined ? { change, prevClose: value - change } : {}),
    ...(changePct !== undefined ? { changePct } : {}),
  }
}

/** Term-structure regime from VIX / VIX3M: < 0.92 contango, > 1.0 backwardation. */
export function volRegime(vixToVix3m: number): VolRegime {
  if (vixToVix3m > 1) return 'backwardation (stress)'
  if (vixToVix3m < 0.92) return 'contango (calm)'

  return 'flat'
}

/** VIX, VIX9D, VIX3M, VVIX and SKEW from CBOE; any one may be missing. */
export async function loadVolIndexes(fetch: Fetch): Promise<VolIndexes> {
  const syms = ['_VIX', '_VIX9D', '_VIX3M', '_VVIX', '_SKEW'] as const
  const got = await Promise.all(syms.map(s => volQuote(fetch, s).catch(() => undefined)))
  const [vix, vix9d, vix3m, vvix, skew] = got
  if (!got.some(Boolean)) throw new Error('CBOE volatility indexes unavailable')
  const vix9dToVix = vix && vix9d ? vix9d.value / vix.value : undefined
  const vixToVix3m = vix && vix3m ? vix.value / vix3m.value : undefined

  return {
    ...(vix ? { vix } : {}),
    ...(vix9d ? { vix9d } : {}),
    ...(vix3m ? { vix3m } : {}),
    ...(vvix ? { vvix } : {}),
    ...(skew ? { skew } : {}),
    ...opt('vix9dToVix', vix9dToVix),
    ...opt('vixToVix3m', vixToVix3m),
    ...(vixToVix3m !== undefined ? { regime: volRegime(vixToVix3m) } : {}),
  }
}

// ─── Module ───────────────────────────────────────────────────────────────

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`

/** $1.23bn / $456m / $12k */
export function fmtGex(x: number): string {
  const a = Math.abs(x)
  const sign = x < 0 ? '−' : '+'
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}bn`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}m`

  return `${sign}$${(a / 1e3).toFixed(0)}k`
}

const price = (x: number) =>
  Number.isInteger(x) ? x.toLocaleString('en-US') : x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x >= 100 ? x.toFixed(1) : x.toFixed(2)

/**
 * Score thresholds (sum, clamped to −100..100):
 * - Gamma regime: total GEX ≥ 0 → +10, plus up to +10 more as spot sits up to
 *   2% above the flip (damped moves, mildly supportive). Total GEX < 0 → −15,
 *   minus up to −15 more as spot sits up to 2% below the flip (amplified
 *   moves). No flip in the ±10% window counts as 2% away.
 * - Skew: steep −12; call skew +4 (upside chasing; flagged as froth).
 * - Chain term structure (ATM IV 9d / 90d): ≥ 1.05 inverted −12; ≥ 1.00 flat −5;
 *   ≤ 0.85 steep contango +5. (An earnings date inside 9 days also inverts it;
 *   the caller should discount this when one is due.)
 * - VIX regime (market backdrop): backwardation −10, contango +5;
 *   VIX9D/VIX ≥ 1.10 another −5.
 * - Put/call: today's volume P/C relative to the OI P/C (self-normalising, so
 *   index hedging does not read as fear). ≥ 1.4 → +8 contrarian (fear in the
 *   flow), capped there however extreme; ≤ 0.65 → −8 complacency / call chasing.
 *   Absolute volume P/C ≥ 2 or ≤ 0.4 is flagged.
 * - Walls: call wall within 1% above spot −5 (capped upside); put wall within
 *   1% below +5 (support).
 * Confidence: 0.65 with ≥ 1M contracts of OI, 0.55 ≥ 200k, 0.4 ≥ 50k, else
 * 0.25; −0.1 when the ATM IV or the gamma flip is missing.
 */
export function optionsModule(stats: OptionsStats, vol?: VolIndexes): OptionsModuleResult {
  const { spot, gex } = stats
  const flags: Text[] = []
  let score = 0

  // Gamma regime
  const positive = gex.total >= 0
  const dist = gex.flip !== undefined ? (spot - gex.flip) / spot : positive ? 0.02 : -0.02
  if (positive) score += 10 + Math.min(10, Math.max(0, dist) * 500)
  else score -= 15 + Math.min(15, Math.max(0, -dist) * 750)
  const flipText = gex.flip !== undefined ? `${price(gex.flip)} flip` : 'flip'
  const flipZh = gex.flip !== undefined ? `${price(gex.flip)} 伽马翻转点（gamma flip）` : '伽马翻转点（gamma flip）'
  if (!positive)
    flags.push(
      bi(
        `Dealers look short gamma (${fmtGex(gex.total)} per 1%): hedging tends to amplify moves.`,
        `做市商看起来处于负伽马（每 1% ${fmtGex(gex.total)}）：对冲往往会放大波动。`,
      ),
    )
  else if (gex.flip !== undefined && dist < 0.005)
    flags.push(bi(`Spot is within 0.5% of the ${flipText}: the gamma cushion is thin.`, `现价距 ${flipZh}不到 0.5%：伽马缓冲很薄。`))

  // Skew
  if (stats.skew?.read === 'steep') {
    score -= 12
    flags.push(
      bi(
        `Steep put skew: 25Δ puts ${pct(stats.skew.skew)} over calls — heavy demand for crash protection.`,
        `认沽偏斜陡峭：25Δ 认沽比认购高 ${pct(stats.skew.skew)}，防暴跌保护需求旺盛。`,
      ),
    )
  } else if (stats.skew?.read === 'call skew') {
    score += 4
    flags.push(bi('Call skew: upside calls are bid over puts — speculative chasing, can unwind fast.', '认购偏斜：上行认购期权比认沽更贵，投机追涨，可能很快回吐。'))
  }

  // Term structure
  const tr = stats.termRatio
  if (tr !== undefined) {
    if (tr >= 1.05) {
      score -= 12
      flags.push(bi(`Implied-vol term structure is inverted (9d/90d ${tr.toFixed(2)}): near-term stress is priced.`, `隐含波动率期限结构倒挂（9 日/90 日 ${tr.toFixed(2)}）：市场已为近期压力定价。`))
    } else if (tr >= 1) score -= 5
    else if (tr <= 0.85) score += 5
  }

  // VIX backdrop
  if (vol?.regime === 'backwardation (stress)') {
    score -= 10
    flags.push(bi(`VIX is above VIX3M (${vol.vixToVix3m?.toFixed(2)}): market-wide volatility backwardation.`, `VIX 高于 VIX3M（${vol.vixToVix3m?.toFixed(2)}）：全市场波动率贴水（backwardation）。`))
  } else if (vol?.regime === 'contango (calm)') score += 5
  if (vol?.vix9dToVix !== undefined && vol.vix9dToVix >= 1.1) {
    score -= 5
    flags.push(bi(`VIX9D is ${vol.vix9dToVix.toFixed(2)}× VIX: the coming week is priced as unusually risky.`, `VIX9D 是 VIX 的 ${vol.vix9dToVix.toFixed(2)} 倍：市场认为未来一周风险异常高。`))
  }

  // Put/call
  const rel = stats.pcVolume !== undefined && stats.pcOi ? stats.pcVolume / stats.pcOi : undefined
  if (rel !== undefined) {
    if (rel >= 1.4) score += 8
    else if (rel <= 0.65) score -= 8
  }
  if (stats.pcVolume !== undefined && stats.pcVolume >= 2)
    flags.push(
      bi(
        `Put/call volume ${stats.pcVolume.toFixed(2)}: panic-level hedging (contrarian only in moderation; extremes can persist).`,
        `成交量 P/C ${stats.pcVolume.toFixed(2)}：恐慌级对冲（适度时才有反向意义，极端状态可能持续）。`,
      ),
    )
  if (stats.pcVolume !== undefined && stats.pcVolume <= 0.4)
    flags.push(bi(`Put/call volume ${stats.pcVolume.toFixed(2)}: very little hedging — complacency.`, `成交量 P/C ${stats.pcVolume.toFixed(2)}：几乎没人对冲，市场过于安逸。`))

  // Walls
  if (gex.callWall !== undefined && gex.callWall >= spot && (gex.callWall - spot) / spot <= 0.01) {
    score -= 5
    flags.push(bi(`Spot is just under the ${price(gex.callWall)} call wall: upside may stall there.`, `现价紧贴 ${price(gex.callWall)} 看涨墙（call wall）下方：上行可能在此受阻。`))
  }
  if (gex.putWall !== undefined && gex.putWall <= spot && (spot - gex.putWall) / spot <= 0.01) score += 5

  const top = stats.unusual[0]
  if (top) {
    const vol = top.volume.toLocaleString('en-US')
    const oi = top.oi.toLocaleString('en-US')
    const prem = fmtGex(top.premium).slice(1)
    flags.push(
      bi(
        `Unusual volume: ${vol} ${price(top.strike)}${top.type} ${top.expiry} vs ${oi} OI (${prem} premium).`,
        `异常成交：${top.expiry} 到期 ${price(top.strike)}${top.type} 成交 ${vol} 张，未平仓量 ${oi} 张（权利金 ${prem}）。`,
      ),
    )
  }

  const pain = stats.maxPain.monthly ?? stats.maxPain.nearest
  const levels: OptionsLevels = {
    ...(gex.callWall !== undefined ? { callWall: gex.callWall } : {}),
    ...(gex.putWall !== undefined ? { putWall: gex.putWall } : {}),
    ...(gex.flip !== undefined ? { gammaFlip: gex.flip } : {}),
    ...(pain ? { maxPain: pain.strike } : {}),
  }

  let confidence = stats.totalOi >= 1e6 ? 0.65 : stats.totalOi >= 2e5 ? 0.55 : stats.totalOi >= 5e4 ? 0.4 : 0.25
  if (stats.ivAtm30 === undefined || gex.flip === undefined) confidence -= 0.1
  if (stats.totalOi < 5e4)
    flags.push(
      bi(
        `Thin options market (${stats.totalOi.toLocaleString('en-US')} contracts open): positioning reads are unreliable.`,
        `期权市场清淡（未平仓 ${stats.totalOi.toLocaleString('en-US')} 张）：持仓解读不可靠。`,
      ),
    )

  const final = clampScore(score)
  const flipAt = gex.flip !== undefined ? price(gex.flip) : undefined
  const regime = positive
    ? bi(
        `dealers look long gamma${flipAt !== undefined ? ` above the ${flipAt} flip` : ''}, which tends to damp moves`,
        `做市商${flipAt !== undefined ? `在 ${flipAt} 伽马翻转点（gamma flip）上方` : ''}看起来处于正伽马，往往会抑制波动`,
      )
    : bi(
        `dealers look short gamma${flipAt !== undefined ? ` below the ${flipAt} flip` : ''}, which tends to amplify moves`,
        `做市商${flipAt !== undefined ? `在 ${flipAt} 伽马翻转点（gamma flip）下方` : ''}看起来处于负伽马，往往会放大波动`,
      )
  const walls = joinText(
    [
      gex.callWall !== undefined ? bi(`call wall ${price(gex.callWall)}`, `看涨墙（call wall）${price(gex.callWall)}`) : undefined,
      gex.putWall !== undefined ? bi(`put wall ${price(gex.putWall)}`, `看跌墙（put wall）${price(gex.putWall)}`) : undefined,
    ].filter((x): x is Text => x !== undefined),
    ', ',
    '，',
  )
  const bias = biasOf(final)
  const verdict = bi(
    `Options positioning reads ${bias}: ${regime.en}${walls.en ? `; ${walls.en}` : ''}.`,
    `期权持仓信号${biasText(bias).zh}：${regime.zh}${walls.zh ? `；${walls.zh}` : ''}。`,
  )

  const readings: Reading[] = []
  if (stats.pcVolume !== undefined)
    readings.push({
      name: bi('Put/call (volume)', '认沽/认购比（成交量）'),
      value: Number(stats.pcVolume.toFixed(2)),
      note:
        rel === undefined
          ? undefined
          : rel >= 1.4
            ? bi('fearful flow', '资金偏恐慌')
            : rel <= 0.65
              ? bi('call-heavy flow', '认购成交偏多')
              : bi('normal flow', '资金流正常'),
    })
  if (stats.pcOi !== undefined) readings.push({ name: bi('Put/call (open interest)', '认沽/认购比（未平仓量）'), value: Number(stats.pcOi.toFixed(2)) })
  if (stats.ivAtm30 !== undefined) readings.push({ name: bi('ATM IV 30d', '平值 IV（30 日）'), value: pct(stats.ivAtm30) })
  if (tr !== undefined)
    readings.push({
      name: bi('IV term 9d/90d', 'IV 期限结构 9 日/90 日'),
      value: Number(tr.toFixed(2)),
      note: tr >= 1.05 ? bi('inverted', '倒挂') : tr >= 1 ? bi('flat', '平坦') : bi('upward sloping', '向上倾斜'),
    })
  if (stats.skew) {
    const pts = (stats.skew.skew * 100).toFixed(1)
    readings.push({ name: bi(`25Δ skew (${stats.skew.days}d)`, `25Δ 偏斜（${stats.skew.days} 日）`), value: bi(`${pts} pts`, `${pts} 个百分点`), note: skewReadText(stats.skew.read) })
  }
  readings.push({
    name: bi('Dealer gamma', '做市商伽马（GEX）'),
    value: fmtGex(gex.total),
    note: positive ? bi('long gamma: damping', '正伽马：抑制波动') : bi('short gamma: amplifying', '负伽马：放大波动'),
  })
  if (gex.flip !== undefined)
    readings.push({
      name: bi('Gamma flip', '伽马翻转点（gamma flip）'),
      value: price(gex.flip),
      note: bi(`spot ${dist >= 0 ? 'above' : 'below'} by ${pct(Math.abs(dist))}`, `现价${dist >= 0 ? '高于' : '低于'}该点 ${pct(Math.abs(dist))}`),
    })
  if (gex.callWall !== undefined)
    readings.push({ name: bi('Call wall', '看涨墙（call wall）'), value: price(gex.callWall), note: bi(`${pct((gex.callWall - spot) / spot)} away`, `距现价 ${pct((gex.callWall - spot) / spot)}`) })
  if (gex.putWall !== undefined)
    readings.push({ name: bi('Put wall', '看跌墙（put wall）'), value: price(gex.putWall), note: bi(`${pct((gex.putWall - spot) / spot)} away`, `距现价 ${pct((gex.putWall - spot) / spot)}`) })
  if (pain)
    readings.push({
      name: bi(`Max pain ${pain.expiry}`, `最大痛点（max pain）${pain.expiry}`),
      value: price(pain.strike),
      note: bi(`${pct((pain.strike - spot) / spot)} from spot`, `距现价 ${pct((pain.strike - spot) / spot)}`),
    })
  const move = stats.expectedMoves.find(m => m.monthly) ?? stats.expectedMoves[0]
  if (move)
    readings.push({
      name: bi(`Expected move to ${move.expiry}`, `至 ${move.expiry} 的预期波幅`),
      value: `±${move.pct.toFixed(1)}%`,
      note: bi(`${price(move.lo)}–${price(move.hi)}`, `区间 ${price(move.lo)}–${price(move.hi)}`),
    })
  if (vol?.vix) readings.push({ name: bi('VIX', 'VIX 恐慌指数'), value: Number(vol.vix.value.toFixed(2)), ...(vol.regime ? { note: volRegimeText(vol.regime) } : {}) })

  return { key: 'options', score: final, confidence: Math.max(0.1, confidence), verdict, readings: readings.map(clean), flags, stats, levels }
}

/** Drop an `undefined` note so readings stay plain JSON. */
function clean(r: Reading): Reading {
  return r.note === undefined ? { name: r.name, value: r.value } : r
}
