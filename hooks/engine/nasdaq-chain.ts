// Option chains from Nasdaq's public quote API: the source when CBOE does not
// answer. No key.
//
// Payload facts checked against live data (Nov 2026):
// - Each row is one strike of one expiry with the call and the put side by
//   side; a header row carries `expirygroup`. Numbers are strings ('--' for
//   none, '13,370.30' with separators).
// - `drillDownURL` ends in the OCC symbol padded with dashes
//   ('…/spy---261124c00550000'), which gives root, expiry and strike.
// - Stocks, ETFs and NDX are served; SPX, XSP, RUT and VIX are not. A wrong
//   asset class answers `rCode` 400.
// - There is no usable implied vol (the greeks endpoint returns 0), so vols
//   are solved here. Quotes run about 15 minutes behind and already move
//   before the open for stocks and ETFs; NDX stays at the last close. Open
//   interest and volume are the last published ones.
// - Before the open the less traded names show no bid or ask at all, only last
//   trades: vols then come from the last session's trades, and say so.
// - `lastTrade` is not a dependable price, so the underlying comes from CNBC.

import { bsDelta, bsGamma, AM_ROOTS, EXTRA_ROOTS, normCdf, RISK_FREE, DIV_YIELD } from './options'
import type { Chain, Contract, OptionType } from './options'
import { cashHours, CNBC_CASH, cnbcRows, cnbcUrl, etInstant, etParts } from './futures'
import type { IndexSymbol } from './futures'
import { getJson, num, type Fetch } from './http'
import { addDays } from '../data'

export type NasdaqClass = 'stocks' | 'etf' | 'index'

const DAY_MS = 86_400_000
const YEAR_MS = 365 * DAY_MS
const MIN_T = 1 / (365 * 24)
const DELAY_MS = 15 * 60_000

export const nasdaqChainUrl = (symbol: string, cls: NasdaqClass, from: string, to: string) =>
  `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/option-chain?assetclass=${cls}&limit=10000&fromdate=${from}&todate=${to}&excode=oprac&callput=callput&money=all&type=all`

// ─── The underlying ───────────────────────────────────────────────────────

export type SpotQuote = {
  /** The last regular-session price (the prior close before the open). */
  last: number
  /** The latest print, extended hours included. */
  current: number
  /** The close before `last`'s session while that session is open, else `last`. */
  prevClose: number
  /** The session `last` belongs to, 'YYYY-MM-DD'. */
  sessionDate: string
}

/** One CNBC quote row → the underlying's price, extended hours included. */
export function parseSpotQuote(row: any, now = Date.now()): SpotQuote | undefined {
  const last = num(row?.last)
  if (!row || (row.code !== undefined && Number(row.code) !== 0) || last === undefined || last <= 0) return undefined
  const status = String(row.curmktstatus ?? '')
  const ext = row.ExtendedMktQuote
  const extLast = (status === 'PRE_MKT' || status === 'POST_MKT') && ext?.type === status ? num(ext?.last) : undefined
  const date = /^\d{4}-\d{2}-\d{2}/.exec(String(row.last_time ?? ''))?.[0] ?? etParts(now).date
  const open = cashHours(now) && date === etParts(now).date
  const change = num(row.change)

  return {
    last,
    current: extLast !== undefined && extLast > 0 ? extLast : last,
    prevClose: open && change !== undefined ? last - change : last,
    sessionDate: date,
  }
}

const cnbcSymbol = (symbol: string) => (symbol in CNBC_CASH ? CNBC_CASH[symbol as IndexSymbol] : symbol)

/** CNBC quotes for several underlyings, by our symbol. */
export async function loadSpots(fetch: Fetch, symbols: string[], now = Date.now()): Promise<Map<string, SpotQuote>> {
  const rows = cnbcRows(await getJson(fetch, cnbcUrl(symbols.map(cnbcSymbol))))
  const out = new Map<string, SpotQuote>()
  for (const s of symbols) {
    const q = parseSpotQuote(rows.find(r => r?.symbol === cnbcSymbol(s)), now)
    if (q) out.set(s, q)
  }

  return out
}

// ─── Implied volatility ───────────────────────────────────────────────────

/** Black-76 price of a European option on a forward, undiscounted. */
function black(type: OptionType, f: number, k: number, t: number, iv: number): number {
  const sd = iv * Math.sqrt(t)
  const d1 = Math.log(f / k) / sd + sd / 2
  const call = f * normCdf(d1) - k * normCdf(d1 - sd)

  return type === 'C' ? call : call - f + k
}

/** The vol at which Black-76 gives `price` (undiscounted); undefined when no vol between 1% and 400% does. */
export function impliedVol(type: OptionType, price: number, f: number, k: number, t: number): number | undefined {
  if (!(price > 0 && f > 0 && k > 0 && t > 0)) return undefined
  let lo = 0.01
  let hi = 4
  if (price <= black(type, f, k, t, lo) || price >= black(type, f, k, t, hi)) return undefined
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (black(type, f, k, t, mid) > price) hi = mid
    else lo = mid
  }

  return (lo + hi) / 2
}

/** Whether a two-sided quote is tight enough to solve a vol from. */
function usable(c: Contract, spot: number): boolean {
  if (!(c.bid > 0 && c.ask >= c.bid)) return false
  const spread = c.ask - c.bid

  return spread <= 0.5 * c.mid || spread <= Math.max(0.05, spot * 0.0002)
}

/** Forward estimates of one expiry from put-call parity, at the strikes where call and put are closest. */
function forwards(list: Contract[], t: number, spot: number): number[] {
  const calls = new Map<number, Contract>()
  const puts = new Map<number, Contract>()
  for (const c of list) if (usable(c, spot)) (c.type === 'C' ? calls : puts).set(c.strike, c)

  return [...calls.values()]
    .flatMap(c => {
      const p = puts.get(c.strike)

      return p ? [{ gap: Math.abs(c.mid - p.mid), f: c.strike + (c.mid - p.mid) * Math.exp(RISK_FREE * t) }] : []
    })
    .sort((x, y) => x.gap - y.gap)
    .slice(0, 5)
    .map(x => x.f)
    .sort((x, y) => x - y)
}

const median = (sorted: number[]) => sorted[Math.floor(sorted.length / 2)]

function forwardOf(list: Contract[], t: number, spot: number): number {
  const fallback = spot * Math.exp((RISK_FREE - DIV_YIELD) * t)
  const mid = median(forwards(list, t, spot))

  return mid !== undefined && Math.abs(mid / fallback - 1) < 0.03 ? mid : fallback
}

function byExpiry(contracts: Contract[]): Contract[][] {
  const map = new Map<string, Contract[]>()
  for (const c of contracts) {
    const key = `${c.expiry}|${c.t}`
    const list = map.get(key)
    if (list) list.push(c)
    else map.set(key, [c])
  }

  return [...map.values()]
}

/** The underlying price the quotes reflect: parity at the expiry nearest 30 days (3–60) with three or more usable pairs. */
export function paritySpot(contracts: Contract[], spot: number): number | undefined {
  const lists = byExpiry(contracts)
    .filter(l => l[0]!.days >= 3 && l[0]!.days <= 60)
    .sort((x, y) => Math.abs(x[0]!.days - 30) - Math.abs(y[0]!.days - 30))
  for (const list of lists) {
    const t = list[0]!.t
    const f = forwards(list, t, spot)
    if (f.length >= 3) return median(f)! * Math.exp(-(RISK_FREE - DIV_YIELD) * t)
  }

  return undefined
}

/**
 * Implied vol and greeks for every contract. Each expiry gets one smile, from
 * its out-of-the-money quotes (they carry the vol; deep in-the-money quotes
 * are wide and hold early-exercise value), read linearly between strikes and
 * flat beyond them. Contracts with no two-sided quote thus still get a vol for
 * the gamma totals. An expiry with fewer than three solved strikes gets none.
 * `fromTrades` solves from the last session's trades instead of the quotes.
 */
export function fillVols(contracts: Contract[], spot: number, fromTrades = false): void {
  for (const list of byExpiry(contracts)) {
    const t = list[0]!.t
    const f = fromTrades ? spot * Math.exp((RISK_FREE - DIV_YIELD) * t) : forwardOf(list, t, spot)
    const growth = Math.exp(RISK_FREE * t)
    const smile: { k: number; iv: number }[] = []
    for (const c of list) {
      if (c.type === 'C' ? c.strike < f : c.strike >= f) continue
      const price = fromTrades ? (c.volume > 0 ? c.last : 0) : usable(c, spot) ? c.mid : 0
      const iv = impliedVol(c.type, price * growth, f, c.strike, t)
      if (iv !== undefined) smile.push({ k: c.strike, iv })
    }
    if (smile.length < 3) continue
    smile.sort((x, y) => x.k - y.k)
    for (const c of list) {
      c.iv = smileAt(smile, c.strike)
      c.delta = bsDelta(c.type, spot, c.strike, t, c.iv)
      c.gamma = bsGamma(spot, c.strike, t, c.iv)
    }
  }
}

/** The share of near-the-money contracts with open interest that have a usable two-sided quote. */
export function quotedShare(contracts: Contract[], spot: number): number {
  const near = contracts.filter(c => c.oi > 0 && c.days <= 45 && Math.abs(c.strike / spot - 1) <= 0.1)

  return near.length ? near.filter(c => usable(c, spot)).length / near.length : 0
}

function smileAt(smile: { k: number; iv: number }[], k: number): number {
  const first = smile[0]!
  const last = smile[smile.length - 1]!
  if (k <= first.k) return first.iv
  if (k >= last.k) return last.iv
  let lo = 0
  let hi = smile.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (smile[mid]!.k <= k) lo = mid
    else hi = mid
  }
  const a = smile[lo]!
  const b = smile[hi]!

  return a.iv + ((b.iv - a.iv) * (k - a.k)) / (b.k - a.k)
}

// ─── Parsing ──────────────────────────────────────────────────────────────

type Row = { root: string; expiry: string; type: OptionType; strike: number; bid: number; ask: number; last: number; oi: number; volume: number }

const OCC = /\/([a-z0-9]+)-+(\d{2})(\d{2})(\d{2})[cp]\d{8}$/i
const n0 = (x: unknown) => Math.max(0, num(x) ?? 0)

function rowsOf(json: any, symbol: string): Row[] {
  const raw: any[] = Array.isArray(json?.data?.table?.rows) ? json.data.table.rows : []
  const roots = new Set([symbol, ...(EXTRA_ROOTS[symbol] ?? [])])
  const out: Row[] = []
  for (const r of raw) {
    const m = OCC.exec(String(r?.drillDownURL ?? ''))
    const strike = num(r?.strike)
    if (!m || strike === undefined || strike <= 0) continue
    const root = m[1]!.toUpperCase()
    // Adjusted contracts ('SPY1') have another deliverable.
    if (!roots.has(root)) continue
    const expiry = `20${m[2]}-${m[3]}-${m[4]}`
    for (const type of ['C', 'P'] as const) {
      const p = type === 'C' ? 'c' : 'p'
      const row: Row = { root, expiry, type, strike, bid: n0(r[`${p}_Bid`]), ask: n0(r[`${p}_Ask`]), last: n0(r[`${p}_Last`]), oi: n0(r[`${p}_Openinterest`]), volume: n0(r[`${p}_Volume`]) }
      if (row.bid || row.ask || row.oi || row.volume) out.push(row)
    }
  }

  return out
}

function contractsAt(rows: Row[], asOfMs: number, maxDays: number): Contract[] {
  const today = Date.parse(`${etParts(asOfMs).date}T00:00:00Z`)
  const out: Contract[] = []
  for (const r of rows) {
    const days = Math.round((Date.parse(`${r.expiry}T00:00:00Z`) - today) / DAY_MS)
    if (days < 0 || days > maxDays) continue
    const settle = AM_ROOTS.has(r.root) ? etInstant(r.expiry, 9, 30) : etInstant(r.expiry, 16)
    if (settle - asOfMs < 20 * 60_000) continue
    const { expiry, type, strike, bid, ask, last, oi, volume } = r
    out.push({ expiry, days, t: Math.max(MIN_T, (settle - asOfMs) / YEAR_MS), type, strike, bid, ask, mid: ask > 0 ? (bid + ask) / 2 : last, last, iv: 0, oi, volume, delta: 0, gamma: 0 })
  }

  return out.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike || (a.type < b.type ? -1 : 1)))
}

/**
 * When the quotes are from. In the regular session: 15 minutes ago. Otherwise
 * the last close, unless it is the pre-market and put-call parity says the
 * quotes have moved with the pre-market price (nearer to it than to the close
 * by at least 0.15%).
 */
export function quotesAsOf(spot: SpotQuote, parity: number | undefined, now: number): { ms: number; atClose: boolean } {
  const { date, minutes, weekday } = etParts(now)
  if (cashHours(now) && spot.sessionDate === date) return { ms: now - DELAY_MS, atClose: false }
  const preMarket = weekday >= 1 && weekday <= 5 && minutes >= 240 && minutes < 570 && spot.sessionDate < date
  if (preMarket && parity !== undefined && Math.abs(parity - spot.last) - Math.abs(parity - spot.current) > 0.0015 * spot.last) return { ms: now - DELAY_MS, atClose: false }

  return { ms: etInstant(spot.sessionDate, 16), atClose: true }
}

/** Nasdaq's chain payload → the engine's `Chain`, with vols and greeks solved from the quotes. */
export function parseNasdaqChain(json: any, symbol: string, spot: SpotQuote, opts: { now?: number; maxDays?: number; cls?: NasdaqClass } = {}): Chain {
  const now = opts.now ?? Date.now()
  const maxDays = opts.maxDays ?? 120
  const sym = symbol.toUpperCase()
  const rows = rowsOf(json, sym)
  if (!rows.length) throw new Error(`Nasdaq has no option chain for ${sym}`)
  const { ms, atClose } = quotesAsOf(spot, paritySpot(contractsAt(rows, now, maxDays), spot.current), now)
  const contracts = contractsAt(rows, ms, maxDays)
  const base = atClose ? spot.last : spot.current
  const fromTrades = atClose && quotedShare(contracts, base) < 0.3
  // Quotes that are not posted have no mid: the last trade stands in.
  if (fromTrades) for (const c of contracts) c.mid = c.last
  const quoteSpot = (fromTrades ? undefined : paritySpot(contracts, base)) ?? base
  fillVols(contracts, quoteSpot, fromTrades)

  return {
    symbol: sym,
    spot: spot.current,
    asOf: new Date(ms).toISOString(),
    prevClose: spot.prevClose,
    securityType: opts.cls === 'index' ? 'index' : 'stock',
    contracts,
    quoteSpot,
    source: { provider: 'nasdaq', ...(atClose ? { atClose: true } : {}), ...(fromTrades ? { fromTrades: true } : {}) },
  }
}

/** Fetch and parse Nasdaq's chain, trying each asset class in turn (about 1.5 MB for SPY). */
export async function loadNasdaqChain(fetch: Fetch, symbol: string, classes: NasdaqClass[], opts: { now?: number; maxDays?: number } = {}): Promise<Chain> {
  const now = opts.now ?? Date.now()
  const maxDays = opts.maxDays ?? 120
  const sym = symbol.toUpperCase()
  const today = etParts(now).date
  const spots = loadSpots(fetch, [sym], now)
  spots.catch(() => undefined)
  for (const cls of classes) {
    const json = await getJson(fetch, nasdaqChainUrl(sym, cls, today, addDays(today, maxDays)))
    if (!Array.isArray(json?.data?.table?.rows) || !json.data.table.rows.length) continue
    const spot = (await spots).get(sym)
    if (!spot) throw new Error(`No price for ${sym} from CNBC`)

    return parseNasdaqChain(json, sym, spot, { now, maxDays, cls })
  }
  throw new Error(`Nasdaq has no option chain for ${sym}`)
}
