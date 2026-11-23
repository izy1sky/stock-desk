// Index futures: live quotes (ES, NQ, YM, RTY), the cash indexes they track,
// the basis between them, CFTC positioning, and a beta map that turns an index
// move into a move of any other ticker ("SPX to 7500 → SOXL where?").
//
// Sources, all free and keyless, every URL final (the mod's fetch does not
// follow redirects):
// - CNBC quote web service: futures and cash index quotes in one request each.
// - Yahoo chart API: futures fallback only (it often answers 429).
// - CBOE delayed quotes (cdn-api.cboe.com): cash index fallback and SPX/RUT
//   daily history. Its _DJI quote can be days stale, so stale rows are dropped.
// - Nasdaq: NDX daily history, and daily bars for stocks and ETFs (beta).
// - CFTC Socrata, Traders in Financial Futures, futures only (gpe5-46if).

import { addDays, marketToday, parseBars } from '../data'
import { getJson, num, type Fetch } from './http'
import { bi, biasText, joinText } from '../i18n'
import { biasOf, clampScore, type Bar, type ModuleResult, type Reading, type Text } from './types'

export type FuturesRoot = 'ES' | 'NQ' | 'YM' | 'RTY'
export type IndexSymbol = 'SPX' | 'NDX' | 'DJI' | 'RUT'

/** The cash index each futures contract settles against. */
export const INDEX_OF: Record<FuturesRoot, IndexSymbol> = { ES: 'SPX', NQ: 'NDX', YM: 'DJI', RTY: 'RUT' }

const ROOTS: FuturesRoot[] = ['ES', 'NQ', 'YM', 'RTY']
const INDEXES: IndexSymbol[] = ['SPX', 'NDX', 'DJI', 'RUT']

/**
 * Where the CME equity index futures are in their trading week (ET):
 * Sunday 6 pm to Friday 5 pm, with a 5-6 pm break each day. Exchange holidays
 * are not modelled.
 */
export type FuturesSession = 'overnight' | 'pre-market' | 'regular' | 'after close' | 'daily break' | 'weekend'

const SESSION_ZH: Record<FuturesSession, string> = {
  overnight: '隔夜',
  'pre-market': '盘前',
  regular: '常规交易时段',
  'after close': '收盘后',
  'daily break': '每日休市',
  weekend: '周末',
}

/** The futures session in both languages. */
export const sessionText = (s: FuturesSession): Text => bi(s, SESSION_ZH[s])

export type FuturesQuote = {
  root: FuturesRoot
  index: IndexSymbol
  name: string
  /** Exchange contract code, e.g. "ESZ26", when the source gives it. */
  contract?: string
  last: number
  /** Points from the prior settlement. */
  change: number
  /** Percent from the prior settlement, e.g. 1.22 for +1.22%. */
  changePct: number
  /** Prior day's settlement price (taken at 4:00 pm ET, 3:00 pm CT). */
  prevSettle: number
  /** Trading date of `prevSettle` (YYYY-MM-DD), when the source gives it. */
  settleDate?: string
  /** Time of `last`, ISO 8601. */
  time: string
  /** Last trading day of the contract (YYYY-MM-DD, third Friday of the quarter month). */
  expiry?: string
  session: FuturesSession
  open?: number
  high?: number
  low?: number
  volume?: number
  openInterest?: number
  source: 'cnbc' | 'yahoo'
}

export type CashQuote = {
  symbol: IndexSymbol
  name: string
  /** Live value during the session, else the last close. */
  last: number
  change: number
  changePct: number
  /** Close of the session before the one `last` belongs to (last − change). */
  prevClose: number
  /** Trading date `last` belongs to (YYYY-MM-DD, New York). */
  sessionDate: string
  time: string
  /** Cash market open right now (weekday 9:30-16:00 ET and quotes from today). */
  open: boolean
  source: 'cnbc' | 'cboe'
}

// ---------------------------------------------------------------- time (ET)

const DAY_MS = 86_400_000

/** UTC offset of New York in hours at an instant: US rules, DST from the second Sunday of March 2 am to the first Sunday of November 2 am. */
export function etOffsetHours(ms: number): -4 | -5 {
  const y = new Date(ms).getUTCFullYear()
  const mar1 = new Date(Date.UTC(y, 2, 1)).getUTCDay()
  const nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay()
  const start = Date.UTC(y, 2, 1 + ((7 - mar1) % 7) + 7, 7) // 2 am EST = 07:00 UTC
  const end = Date.UTC(y, 10, 1 + ((7 - nov1) % 7), 6) // 2 am EDT = 06:00 UTC

  return ms >= start && ms < end ? -4 : -5
}

/** Wall-clock date, minutes after midnight and weekday (0 = Sunday) in New York. */
export function etParts(ms: number): { date: string; minutes: number; weekday: number } {
  const local = new Date(ms + etOffsetHours(ms) * 3_600_000)

  return {
    date: local.toISOString().slice(0, 10),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    weekday: local.getUTCDay(),
  }
}

/** The instant of a New York wall-clock time. */
export function etInstant(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number)
  const naive = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hour, minute)

  return naive - etOffsetHours(naive + 5 * 3_600_000) * 3_600_000
}

export function sessionLabel(ms: number): FuturesSession {
  const { minutes, weekday } = etParts(ms)
  const h = minutes / 60
  if (weekday === 6 || (weekday === 5 && h >= 17) || (weekday === 0 && h < 18)) return 'weekend'
  if (h >= 17 && h < 18) return 'daily break'
  if (h >= 18 || h < 4) return 'overnight'
  if (h < 9.5) return 'pre-market'
  if (h < 16) return 'regular'

  return 'after close'
}

function cashHours(ms: number): boolean {
  const { minutes, weekday } = etParts(ms)

  return weekday >= 1 && weekday <= 5 && minutes >= 570 && minutes < 960
}

/** Third Friday of a month: equity index futures expire then (quarterly). */
export function thirdFriday(year: number, month: number): string {
  const dow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const day = 1 + ((5 - dow + 7) % 7) + 14

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** "2026-11-19T05:59:04.000-0500" → "2026-11-19T05:59:04.000-05:00"; a bare date stays a date. */
function isoTime(text: unknown): string {
  const s = String(text ?? '').trim()

  return s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** "E-Mini S&P 500 Dec 26" or "S&P 500 Fut (Dec'26)" → third Friday of Dec 2026. */
function expiryFromName(name: string): string | undefined {
  const m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s']+(\d{2})\b/i.exec(name)
  const month = m ? MONTHS[m[1]!.toLowerCase()] : undefined

  return m && month ? thirdFriday(2000 + Number(m[2]), month) : undefined
}

const rnd = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits

// ---------------------------------------------------------------- futures quotes

const CNBC = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'
const cnbcUrl = (symbols: string[]) =>
  `${CNBC}?symbols=${symbols.map(encodeURIComponent).join('%7C')}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`

/** CNBC continuous front-month symbols. @TFS.1 is the CME Russell 2000 E-mini (RTY); @RTY.1 and @TF.1 return empty rows. */
export const CNBC_FUTURES: Record<FuturesRoot, string> = { ES: '@SP.1', NQ: '@ND.1', YM: '@DJ.1', RTY: '@TFS.1' }
const CNBC_CASH: Record<IndexSymbol, string> = { SPX: '.SPX', NDX: '.NDX', DJI: '.DJI', RUT: '.RUT' }

function cnbcRows(data: any): any[] {
  const rows = data?.FormattedQuoteResult?.FormattedQuote

  return Array.isArray(rows) ? rows : rows ? [rows] : []
}

/** CNBC futures rows → quotes; rows with an error code or no price (unknown symbols) are skipped. */
export function parseCnbcFutures(data: any, now = Date.now()): FuturesQuote[] {
  const out: FuturesQuote[] = []
  for (const r of cnbcRows(data)) {
    const root = ROOTS.find(k => CNBC_FUTURES[k] === r?.symbol)
    const last = num(r?.last)
    const prevSettle = num(r?.previous_day_closing) ?? num(r?.settlePrice)
    if (!root || (r.code !== undefined && Number(r.code) !== 0) || last === undefined || prevSettle === undefined || prevSettle === 0) continue
    const change = num(r.change) ?? last - prevSettle
    const name = String(r.name ?? root)
    out.push({
      root,
      index: INDEX_OF[root],
      name,
      contract: r.altSymbol ? String(r.altSymbol) : undefined,
      last,
      change,
      changePct: num(r.change_pct) ?? rnd(((last - prevSettle) / prevSettle) * 100),
      prevSettle,
      settleDate: /^\d{4}-\d{2}-\d{2}$/.test(String(r.settleDate ?? '')) ? String(r.settleDate) : undefined,
      time: isoTime(r.last_time),
      expiry: /^\d{4}-\d{2}-\d{2}$/.test(String(r.expiration_date ?? '')) ? String(r.expiration_date) : expiryFromName(name),
      session: sessionLabel(now),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      volume: num(r.volume),
      openInterest: num(r.open_interest),
      source: 'cnbc',
    })
  }

  return out
}

const YAHOO_SYMBOL: Record<FuturesRoot, string> = { ES: 'ES%3DF', NQ: 'NQ%3DF', YM: 'YM%3DF', RTY: 'RTY%3DF' }
const yahooUrl = (root: FuturesRoot) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${YAHOO_SYMBOL[root]}?range=1d&interval=5m&includePrePost=true`

/** Yahoo chart meta → quote. Yahoo gives no settlement date; the previous close it reports is the prior settlement. */
export function parseYahooFutures(root: FuturesRoot, data: any, now = Date.now()): FuturesQuote | undefined {
  const meta = data?.chart?.result?.[0]?.meta
  const last = num(meta?.regularMarketPrice)
  const prevSettle = num(meta?.previousClose) ?? num(meta?.chartPreviousClose)
  if (last === undefined || prevSettle === undefined || prevSettle === 0) return undefined
  const name = String(meta.shortName ?? meta.longName ?? root)
  const t = num(meta.regularMarketTime)

  return {
    root,
    index: INDEX_OF[root],
    name,
    last,
    change: rnd(last - prevSettle),
    changePct: rnd(((last - prevSettle) / prevSettle) * 100),
    prevSettle,
    time: t ? new Date(t * 1000).toISOString() : new Date(now).toISOString(),
    expiry: expiryFromName(name),
    session: sessionLabel(now),
    high: num(meta.regularMarketDayHigh),
    low: num(meta.regularMarketDayLow),
    volume: num(meta.regularMarketVolume),
    source: 'yahoo',
  }
}

/** Front-month ES, NQ, YM and RTY: CNBC first, Yahoo for any CNBC did not answer. Missing roots are left out. */
export async function loadFutures(fetch: Fetch, roots: FuturesRoot[] = ROOTS, now = Date.now()): Promise<FuturesQuote[]> {
  const got = new Map<FuturesRoot, FuturesQuote>()
  try {
    for (const q of parseCnbcFutures(await getJson(fetch, cnbcUrl(roots.map(r => CNBC_FUTURES[r]))), now)) got.set(q.root, q)
  } catch {
    // fall through to Yahoo
  }
  const missing = roots.filter(r => !got.has(r))
  await Promise.all(
    missing.map(async root => {
      try {
        const q = parseYahooFutures(root, await getJson(fetch, yahooUrl(root)), now)
        if (q) got.set(root, q)
      } catch {
        // leave it out
      }
    }),
  )

  return roots.flatMap(r => {
    const q = got.get(r)

    return q ? [q] : []
  })
}

// ---------------------------------------------------------------- cash indexes

function cashQuote(
  symbol: IndexSymbol,
  name: string,
  last: number,
  change: number,
  changePct: number | undefined,
  sessionDate: string,
  time: string,
  now: number,
  source: CashQuote['source'],
): CashQuote {
  const prevClose = last - change

  return {
    symbol,
    name,
    last,
    change,
    changePct: changePct ?? (prevClose ? rnd((change / prevClose) * 100) : 0),
    prevClose: rnd(prevClose, 4),
    sessionDate,
    time,
    open: cashHours(now) && sessionDate === etParts(now).date,
    source,
  }
}

/**
 * CNBC cash index rows. Its `previous_day_closing` means "the close before
 * now": after the bell it equals `last`. So the close before `last`'s session
 * is taken as last − change instead, which holds at any hour.
 */
export function parseCnbcCash(data: any, now = Date.now()): CashQuote[] {
  const out: CashQuote[] = []
  for (const r of cnbcRows(data)) {
    const symbol = INDEXES.find(k => CNBC_CASH[k] === r?.symbol)
    const last = num(r?.last)
    if (!symbol || (r.code !== undefined && Number(r.code) !== 0) || last === undefined) continue
    const time = isoTime(r.last_time)
    const sessionDate = /^\d{4}-\d{2}-\d{2}/.test(time) ? time.slice(0, 10) : etParts(now).date
    const change = num(r.change) ?? (num(r.previous_day_closing) !== undefined ? last - num(r.previous_day_closing)! : 0)
    out.push(cashQuote(symbol, String(r.name ?? symbol), last, change, num(r.change_pct), sessionDate, time, now, 'cnbc'))
  }

  return out
}

const cboeQuoteUrl = (s: IndexSymbol) => `https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/_${s}.json`

/** CBOE delayed quote. `last_trade_time` is New York time without an offset; a quote more than 5 days old is dropped (CBOE's _DJI lags). */
export function parseCboeCash(symbol: IndexSymbol, data: any, now = Date.now()): CashQuote | undefined {
  const d = data?.data
  const last = num(d?.current_price)
  const ltt = String(d?.last_trade_time ?? '')
  if (last === undefined || !/^\d{4}-\d{2}-\d{2}/.test(ltt)) return undefined
  const sessionDate = ltt.slice(0, 10)
  if (sessionDate < addDays(etParts(now).date, -5)) return undefined
  const offset = etOffsetHours(Date.parse(`${sessionDate}T12:00:00Z`))
  const time = ltt.length >= 19 ? `${ltt.slice(0, 19)}${offset === -4 ? '-04:00' : '-05:00'}` : sessionDate

  return cashQuote(symbol, symbol, last, num(d.price_change) ?? 0, num(d.price_change_percent), sessionDate, time, now, 'cboe')
}

/** SPX, NDX, DJI and RUT: CNBC first, CBOE for any missing. */
export async function loadCashIndexes(fetch: Fetch, symbols: IndexSymbol[] = INDEXES, now = Date.now()): Promise<CashQuote[]> {
  const got = new Map<IndexSymbol, CashQuote>()
  try {
    for (const q of parseCnbcCash(await getJson(fetch, cnbcUrl(symbols.map(s => CNBC_CASH[s]))), now)) got.set(q.symbol, q)
  } catch {
    // fall through to CBOE
  }
  await Promise.all(
    symbols
      .filter(s => !got.has(s))
      .map(async s => {
        try {
          const q = parseCboeCash(s, await getJson(fetch, cboeQuoteUrl(s)), now)
          if (q) got.set(s, q)
        } catch {
          // leave it out
        }
      }),
  )

  return symbols.flatMap(s => {
    const q = got.get(s)

    return q ? [q] : []
  })
}

const NASDAQ = 'https://api.nasdaq.com/api/quote'

/**
 * Daily cash index bars, oldest first: SPX and RUT from CBOE's history file,
 * NDX from Nasdaq. No free source for DJI history was found (Nasdaq does not
 * know it, CBOE's file is stale), so DJI throws.
 */
export async function loadIndexHistory(fetch: Fetch, symbol: IndexSymbol, days = 400): Promise<Bar[]> {
  if (symbol === 'NDX') {
    const today = marketToday()
    const json = await getJson(fetch, `${NASDAQ}/NDX/historical?assetclass=index&fromdate=${addDays(today, -Math.ceil(days * 1.5))}&todate=${today}&limit=${days}`)

    return parseBars(json?.data).slice(-days)
  }
  if (symbol === 'DJI') throw new Error('No daily history source for DJI; use DIA bars instead')
  const json = await getJson(fetch, `https://cdn-api.cboe.com/api/global/delayed_quotes/charts/historical/_${symbol}.json`)
  const rows: any[] = Array.isArray(json?.data) ? json.data.slice(-days) : []
  const bars: Bar[] = []
  for (const r of rows) {
    const c = num(r.close)
    if (c === undefined || c <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) continue
    const pick = (v: unknown) => {
      const n = num(v)

      return n !== undefined && n > 0 ? n : c
    }
    bars.push({ t: String(r.date), o: pick(r.open), h: pick(r.high), l: pick(r.low), c, v: 0 })
  }

  return bars
}

/** Daily bars of a stock or ETF from Nasdaq, oldest first; tries stocks then ETFs unless told. */
export async function loadDailyBars(fetch: Fetch, symbol: string, days = 150, assetClass?: 'stocks' | 'etf'): Promise<Bar[]> {
  const sym = symbol.toUpperCase()
  const today = marketToday()
  const from = addDays(today, -Math.ceil(days * 1.5) - 5)
  for (const cls of assetClass ? [assetClass] : (['stocks', 'etf'] as const)) {
    const json = await getJson(fetch, `${NASDAQ}/${sym}/historical?assetclass=${cls}&fromdate=${from}&todate=${today}&limit=${days + 10}`)
    const bars = parseBars(json?.data)
    if (bars.length) return bars.slice(-days)
  }

  return []
}

// ---------------------------------------------------------------- basis

export type ImpliedCash = {
  root: FuturesRoot
  index: IndexSymbol
  /** Cash close on the futures' settlement date, the basis reference. */
  cashRef: number
  cashRefDate: string
  /** prevSettle − cashRef, in index points. */
  basisPrev: number
  /** basisPrev scaled to the time left at the futures quote. */
  basisNow: number
  /** Calendar days to expiry at the settlement and at the quote. */
  daysPrev: number
  daysNow: number
  /** The basis as an annualised carry, percent: roughly the interest rate minus the dividend yield. */
  carryPct: number
  /** Futures last − basisNow: what the futures say the cash index is worth now. */
  impliedCash: number
  /** impliedCash against the latest cash close (today's prior close while the cash market is open, else the last close). */
  impliedChangePct: number
  /** The cash value `impliedChangePct` is measured from. */
  changeBase: number
  fairBasisNote: string
  /** Set when the basis is outside a normal carry (about -1% to +8% a year). */
  anomaly?: Text
}

/**
 * The cash-equivalent of a futures price.
 *
 * Fair value is F = S·e^((r−q)T), so the basis F − S ≈ S·(r−q)·T shrinks in
 * proportion to the time T left until expiry. The basis measured at the last
 * settlement (prevSettle − cash close that day) is therefore scaled by
 * T_now / T_prev, where both are measured to the expiry morning (the final
 * settlement is the special opening quotation, 9:30 am ET on the third
 * Friday). Rates and dividend expectations are taken as unchanged since the
 * settlement, so the result is the futures price with yesterday's carry
 * stripped out.
 *
 * Timing: CME takes the daily settlement at 3:00 pm CT (4:00 pm ET), the
 * moment the cash market closes, so the two prices are near enough
 * simultaneous; closing-auction prints and the settlement window add a few
 * hundredths of a percent of noise. Futures trade on until 5:00 pm ET, so a
 * late move after 4:00 pm already shows up in `change`.
 */
export function impliedCash(fut: FuturesQuote, cash: CashQuote, now = Date.now()): ImpliedCash {
  // The cash close on the futures' settlement date. Cash quoting a later
  // session (open today) → its prior close; cash quoting that same session
  // (closed) → its last. Without a settlement date (Yahoo) assume it matches
  // the last completed cash session.
  const useLast = fut.settleDate ? cash.sessionDate <= fut.settleDate : !cash.open
  const cashRef = useLast ? cash.last : cash.prevClose
  const cashRefDate = fut.settleDate ?? (useLast ? cash.sessionDate : 'previous session')
  const basisPrev = fut.prevSettle - cashRef

  const quoteMs = Number.isFinite(Date.parse(fut.time)) ? Date.parse(fut.time) : now
  const settleMs = fut.settleDate ? etInstant(fut.settleDate, 16) : useLast ? etInstant(cash.sessionDate, 16) : quoteMs - DAY_MS
  const expiryMs = fut.expiry ? etInstant(fut.expiry, 9, 30) : undefined
  const daysPrev = expiryMs ? (expiryMs - settleMs) / DAY_MS : 0
  const daysNow = expiryMs ? Math.max(0, (expiryMs - quoteMs) / DAY_MS) : 0
  const scale = daysPrev > 0.25 ? Math.min(1, daysNow / daysPrev) : 1
  const basisNow = basisPrev * scale
  const implied = fut.last - basisNow
  const changeBase = cash.open ? cash.prevClose : cash.last
  const carryPct = daysPrev > 0.25 && cashRef ? (basisPrev / cashRef) * (365 / daysPrev) * 100 : NaN

  const anomaly = !Number.isFinite(carryPct)
    ? undefined
    : carryPct > 8
      ? bi(
          `${fut.root} basis rich: ${rnd(carryPct, 1)}% a year over cash (demand for long futures, or a stale cash close)`,
          `${fut.root} 基差偏高：较现货年化 ${rnd(carryPct, 1)}%（期货多头需求旺盛，或现货收盘价已过时）`,
        )
      : carryPct < -1
        ? bi(
            `${fut.root} below fair value: ${rnd(carryPct, 1)}% a year (hedging pressure, or a stale cash close)`,
            `${fut.root} 低于公允价值：年化 ${rnd(carryPct, 1)}%（对冲压力，或现货收盘价已过时）`,
          )
        : undefined
  const note =
    `${fut.root} settled ${rnd(basisPrev)} pts over ${cash.symbol} (${Number.isFinite(carryPct) ? `${rnd(carryPct, 1)}% a year carry, ` : ''}` +
    `${rnd(daysPrev, 1)} days to expiry); scaled to ${rnd(basisNow)} pts with ${rnd(daysNow, 1)} days left. ` +
    `Settlement and cash close are both 4:00 pm ET, so the basis reference is close to simultaneous.`

  return {
    root: fut.root,
    index: cash.symbol,
    cashRef,
    cashRefDate,
    basisPrev: rnd(basisPrev),
    basisNow: rnd(basisNow),
    daysPrev: rnd(daysPrev, 2),
    daysNow: rnd(daysNow, 2),
    carryPct: Number.isFinite(carryPct) ? rnd(carryPct, 2) : NaN,
    impliedCash: rnd(implied),
    impliedChangePct: changeBase ? rnd((implied / changeBase - 1) * 100, 3) : 0,
    changeBase,
    fairBasisNote: note,
    anomaly,
  }
}

// ---------------------------------------------------------------- COT

/** CFTC contract market codes (Traders in Financial Futures, futures only). */
export const COT_CODES: Record<FuturesRoot, string> = {
  ES: '13874A', // E-MINI S&P 500 - CME
  NQ: '209742', // NASDAQ MINI - CME
  YM: '124603', // DJIA x $5 - CBOT
  RTY: '239742', // RUSSELL E-MINI - CME
}

export type CotRow = {
  /** Report date (the Tuesday positions are as of), YYYY-MM-DD. */
  date: string
  oi: number
  levLong: number
  levShort: number
  amLong: number
  amShort: number
  dealerLong: number
  dealerShort: number
}

const COT_FIELDS = [
  'report_date_as_yyyy_mm_dd',
  'open_interest_all',
  'lev_money_positions_long',
  'lev_money_positions_short',
  'asset_mgr_positions_long',
  'asset_mgr_positions_short',
  'dealer_positions_long_all',
  'dealer_positions_short_all',
]

export const cotUrl = (market: FuturesRoot, weeks: number) =>
  `https://publicreporting.cftc.gov/resource/gpe5-46if.json?$select=${COT_FIELDS.join(',')}&cftc_contract_market_code=${COT_CODES[market]}` +
  `&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${weeks}`

/** Socrata rows → COT rows, oldest first; incomplete rows dropped. */
export function parseCot(data: any): CotRow[] {
  const rows: any[] = Array.isArray(data) ? data : []
  const out: CotRow[] = []
  for (const r of rows) {
    const date = String(r?.report_date_as_yyyy_mm_dd ?? '').slice(0, 10)
    const v = COT_FIELDS.slice(1).map(f => num(r?.[f]))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || v.some(x => x === undefined)) continue
    const [oi, levLong, levShort, amLong, amShort, dealerLong, dealerShort] = v as number[]
    out.push({ date, oi: oi!, levLong: levLong!, levShort: levShort!, amLong: amLong!, amShort: amShort!, dealerLong: dealerLong!, dealerShort: dealerShort! })
  }

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

export async function loadCot(fetch: Fetch, market: FuturesRoot, weeks = 160): Promise<CotRow[]> {
  return parseCot(await getJson(fetch, cotUrl(market, weeks)))
}

export type CotGroup = {
  /** Long − short contracts. */
  net: number
  /** Change from the previous report. */
  change?: number
  /** net as a percent of open interest. */
  pctOi: number
  /**
   * COT index: where the latest net sits between the lowest (0) and highest
   * (100) net of the window, the usual (Williams / Shapiro) definition.
   */
  index3y: number
  index26w: number
  /** Rank percentile of the latest net within the window (0 = lowest, 100 = highest). */
  pct3y: number
  pct26w: number
  /** 3-year COT index ≥ 90 → 'long', ≤ 10 → 'short'. */
  crowded?: 'long' | 'short'
}

export type CotStats = {
  market?: FuturesRoot
  /** Tuesday the positions are as of. */
  date: string
  /** Friday the report came out (date + 3). */
  released: string
  /** Friday the next report is due (date + 10). */
  nextRelease: string
  /** Days from the as-of Tuesday to today. */
  ageDays: number
  /** True when the next report is overdue by more than a weekend. */
  overdue: boolean
  oi: number
  oiChange?: number
  /** Reports in the 3-year and 26-week windows. */
  weeks3y: number
  weeks26w: number
  lev: CotGroup
  am: CotGroup
  dealer: CotGroup
  flags: Text[]
}

function positionIn(values: number[], x: number): { index: number; pct: number } {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const below = values.filter(v => v < x).length
  const equal = values.filter(v => v === x).length

  return {
    index: max === min ? 50 : rnd(((x - min) / (max - min)) * 100, 1),
    pct: values.length > 1 ? rnd(((below + (equal - 1) / 2) / (values.length - 1)) * 100, 1) : 50,
  }
}

/** Net positions, COT indexes and crowding of the latest report; throws on an empty series. */
export function cotStats(rows: CotRow[], now = Date.now(), market?: FuturesRoot): CotStats {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const latest = sorted[sorted.length - 1]
  if (!latest) throw new Error('No COT rows')
  const prev = sorted[sorted.length - 2]
  const in3y = sorted.filter(r => r.date > addDays(latest.date, -3 * 365))
  const in26w = sorted.filter(r => r.date > addDays(latest.date, -26 * 7))

  const group = (pick: (r: CotRow) => number): CotGroup => {
    const net = pick(latest)
    const a = positionIn(in3y.map(pick), net)
    const b = positionIn(in26w.map(pick), net)

    return {
      net,
      change: prev ? net - pick(prev) : undefined,
      pctOi: latest.oi ? rnd((net / latest.oi) * 100, 1) : 0,
      index3y: a.index,
      index26w: b.index,
      pct3y: a.pct,
      pct26w: b.pct,
      crowded: a.index >= 90 ? 'long' : a.index <= 10 ? 'short' : undefined,
    }
  }
  const lev = group(r => r.levLong - r.levShort)
  const am = group(r => r.amLong - r.amShort)
  const dealer = group(r => r.dealerLong - r.dealerShort)

  const today = etParts(now).date
  const nextRelease = addDays(latest.date, 10)
  const ageDays = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${latest.date}T12:00:00Z`)) / DAY_MS)
  const overdue = today > addDays(nextRelease, 3)
  const name = market ?? 'COT'
  const flags: Text[] = []
  if (lev.crowded)
    flags.push(
      bi(
        `${name} leveraged funds crowded ${lev.crowded} (3y COT index ${lev.index3y})`,
        `${name} 杠杆基金${lev.crowded === 'long' ? '多头拥挤' : '空头拥挤'}（3 年 COT 指数 ${lev.index3y}）`,
      ),
    )
  if (am.crowded)
    flags.push(
      bi(
        `${name} asset managers at a 3-year ${am.crowded === 'long' ? 'high' : 'low'} (index ${am.index3y})`,
        `${name} 资产管理机构净持仓处于 3 年${am.crowded === 'long' ? '高点' : '低点'}（指数 ${am.index3y}）`,
      ),
    )
  if (overdue) flags.push(bi(`${name} COT report overdue: latest is as of ${latest.date}`, `${name} COT 报告逾期：最新数据截至 ${latest.date}`))

  return {
    market,
    date: latest.date,
    released: addDays(latest.date, 3),
    nextRelease,
    ageDays,
    overdue,
    oi: latest.oi,
    oiChange: prev ? latest.oi - prev.oi : undefined,
    weeks3y: in3y.length,
    weeks26w: in26w.length,
    lev,
    am,
    dealer,
    flags,
  }
}

// ---------------------------------------------------------------- beta map

export type BetaStats = {
  /** Slope of target daily returns on base daily returns. */
  beta: number
  /** Daily intercept, decimal (0.001 = 0.1% a day). */
  alpha: number
  corr: number
  /** Standard deviation of the daily residual, decimal. */
  residSd: number
  /** Number of daily returns used. */
  n: number
  /** First and last date of the returns window. */
  from: string
  to: string
}

/**
 * OLS beta of `target` on `base` over the last `lookback` close-to-close
 * returns. Bars are aligned by date first; a day missing from either series is
 * skipped in both, so a return then spans the gap on both sides. Returns
 * undefined with fewer than 10 overlapping returns.
 */
export function betaStats(base: Bar[], target: Bar[], lookback = 60): BetaStats | undefined {
  const baseClose = new Map(base.map(b => [b.t, b.c]))
  const common = [...target]
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .flatMap(b => {
      const c = baseClose.get(b.t)

      return c !== undefined && c > 0 && b.c > 0 ? [{ t: b.t, x: c, y: b.c }] : []
    })
  const pts: { x: number; y: number }[] = []
  for (let i = 1; i < common.length; i++) {
    const p = common[i - 1]!
    const q = common[i]!
    pts.push({ x: q.x / p.x - 1, y: q.y / p.y - 1 })
  }
  const window = pts.slice(-lookback)
  const n = window.length
  if (n < 10) return undefined
  const mx = window.reduce((s, p) => s + p.x, 0) / n
  const my = window.reduce((s, p) => s + p.y, 0) / n
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of window) {
    sxx += (p.x - mx) ** 2
    syy += (p.y - my) ** 2
    sxy += (p.x - mx) * (p.y - my)
  }
  if (sxx === 0) return undefined
  const beta = sxy / sxx
  const alpha = my - beta * mx
  const ssr = window.reduce((s, p) => s + (p.y - alpha - beta * p.x) ** 2, 0)

  return {
    beta,
    alpha,
    corr: syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0,
    residSd: Math.sqrt(ssr / Math.max(1, n - 2)),
    n,
    from: common[common.length - 1 - n]!.t,
    to: common[common.length - 1]!.t,
  }
}

export type Projection = {
  /** Base move implied by the target level, percent. */
  baseMovePct: number
  /** beta × baseMovePct, percent. */
  movePct: number
  price: number
  /** ±1 daily residual sd around `price`: about two days in three land inside. */
  lo: number
  hi: number
}

/**
 * Where the target would trade if the base went from `basePrev` to
 * `baseTarget`, by beta alone. Alpha is left out (a day's drift is noise next
 * to the move). The band is one daily residual sd, so it fits a one-session
 * move; over k sessions the residual grows roughly with √k. Large moves of
 * leveraged products are better read with `leveragedEstimate`.
 */
export function projectMove(stats: Pick<BetaStats, 'beta' | 'residSd'>, p: { basePrev: number; baseTarget: number; targetPrev: number }): Projection {
  const baseMovePct = (p.baseTarget / p.basePrev - 1) * 100
  const movePct = Math.max(-100, stats.beta * baseMovePct)
  const band = stats.residSd * 100
  const at = (pct: number) => Math.max(0, p.targetPrev * (1 + pct / 100))

  return {
    baseMovePct: rnd(baseMovePct, 3),
    movePct: rnd(movePct, 3),
    price: rnd(at(movePct)),
    lo: rnd(at(movePct - band)),
    hi: rnd(at(movePct + band)),
  }
}

/**
 * Naive daily-reset estimate for a leveraged ETF, percent. Within one session
 * a 3× fund's return from its prior close is ≈ 3 × the index return from the
 * index's prior close (the fund resets its exposure at each close), so this
 * holds intraday and for a one-day target. Across several days the fund
 * compounds daily, so the result differs from leverage × the total move: see
 * `leveragedCompound`. Fees, financing and tracking error are ignored.
 */
export function leveragedEstimate(underlyingMovePct: number, leverage: number): number {
  return Math.max(-100, leverage * underlyingMovePct)
}

/** A daily-reset fund over a path of daily index moves (percent): naive leverage × total versus the compounded result. */
export function leveragedCompound(dailyMovesPct: number[], leverage: number): { underlyingPct: number; naivePct: number; compoundedPct: number } {
  let u = 1
  let f = 1
  for (const m of dailyMovesPct) {
    u *= 1 + m / 100
    f *= Math.max(0, 1 + (leverage * m) / 100)
  }
  const underlyingPct = (u - 1) * 100

  return { underlyingPct: rnd(underlyingPct, 3), naivePct: rnd(leveragedEstimate(underlyingPct, leverage), 3), compoundedPct: rnd((f - 1) * 100, 3) }
}

// ---------------------------------------------------------------- module

export type FuturesStats = {
  session?: FuturesSession
  /** The contract scored alone (the ticker's own index), when one was given and quoted. */
  lead?: FuturesRoot
  /** Change from prior settlement, percent, per root. */
  changePct: Partial<Record<FuturesRoot, number>>
  /** The move scored: implied cash move when the cash quote is there, else the futures' own change. */
  movePct: Partial<Record<FuturesRoot, number>>
  /** NQ − ES move, percentage points (tech versus the broad market). */
  nqMinusEs?: number
  /** RTY − ES move, percentage points (small caps versus large). */
  rtyMinusEs?: number
  implied: Partial<Record<FuturesRoot, ImpliedCash>>
  cot: CotStats[]
  components: { move: number; relative: number; basis: number; positioning: number }
  /** Minutes since the newest futures quote. */
  quoteAgeMin?: number
}

const pct = (n: number, digits = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`

/**
 * Futures read for the US index market.
 *
 * Score (−100..100), the sum of:
 * - move: the lead contract's move (ES for SPX funds, NQ for NDX funds…),
 *   or the mean ES/NQ move without one, measured as the futures-implied cash move
 *   against the latest cash close (or the futures' change from settlement
 *   without cash quotes), scaled so a typical 1% daily move = 40 points;
 *   capped at ±50.
 * - relative: NQ leading ES is risk appetite (8 points per 0.5 pp), ±15.
 * - basis: ±5 when the ES basis is outside a normal carry (rich basis =
 *   demand for longs, discount = hedging).
 * - positioning (COT, leveraged funds: the lead's report, else the mean of those given):
 *   contrarian at the extremes of the 3-year COT index (≥ 90 → −20, ≤ 10 →
 *   +20), since a crowded speculative side has to unwind; in between, mildly
 *   trend-following on the 26-week index ((index − 50) / 50 × 8), since
 *   funds building a position tends to go with the flow.
 */
export function futuresModule(input: {
  quotes: FuturesQuote[]
  cash?: CashQuote[]
  cot?: CotStats | CotStats[]
  now?: number
  /** The contract the ticker tracks (ES for SPX funds, NQ for NDX funds…): its move and its COT are scored alone. Without it, the ES/NQ mean. */
  lead?: FuturesRoot
}): ModuleResult & { stats: FuturesStats } {
  const now = input.now ?? Date.now()
  const byRoot = new Map(input.quotes.map(q => [q.root, q]))
  const cashBy = new Map((input.cash ?? []).map(c => [c.symbol, c]))
  const allCots = input.cot === undefined ? [] : Array.isArray(input.cot) ? input.cot : [input.cot]

  const implied: Partial<Record<FuturesRoot, ImpliedCash>> = {}
  const changePct: Partial<Record<FuturesRoot, number>> = {}
  const movePct: Partial<Record<FuturesRoot, number>> = {}
  for (const q of input.quotes) {
    changePct[q.root] = q.changePct
    const c = cashBy.get(q.index)
    if (c) implied[q.root] = impliedCash(q, c, now)
    movePct[q.root] = implied[q.root]?.impliedChangePct ?? q.changePct
  }

  // A lead without a quote falls back to the market mean.
  const lead = input.lead !== undefined && movePct[input.lead] !== undefined ? input.lead : undefined
  const es = movePct.ES
  const nq = movePct.NQ
  const core = [es, nq].filter((x): x is number => x !== undefined)
  const fallback = [movePct.YM, movePct.RTY].filter((x): x is number => x !== undefined)
  const moves = lead ? [movePct[lead]!] : core.length ? core : fallback
  const avgMove = moves.length ? moves.reduce((s, x) => s + x, 0) / moves.length : undefined

  const move = avgMove === undefined ? 0 : Math.max(-50, Math.min(50, (avgMove / 1) * 40))
  const nqMinusEs = es !== undefined && nq !== undefined ? rnd(nq - es, 3) : undefined
  const rtyMinusEs = es !== undefined && movePct.RTY !== undefined ? rnd(movePct.RTY - es, 3) : undefined
  const relative = nqMinusEs === undefined ? 0 : Math.max(-15, Math.min(15, (nqMinusEs / 0.5) * 8))
  const leadBasis = (lead && implied[lead]) || implied.ES || Object.values(implied)[0]
  const basis = leadBasis?.anomaly ? (leadBasis.carryPct > 0 ? 5 : -5) : 0
  // The lead's own positioning when its COT report is there; else every report given.
  const leadCots = lead ? allCots.filter(c => c.market === lead) : []
  const cots = leadCots.length ? leadCots : allCots
  const cotScores = cots.map(c => (c.lev.index3y >= 90 ? -20 : c.lev.index3y <= 10 ? 20 : ((c.lev.index26w - 50) / 50) * 8))
  const positioning = cotScores.length ? cotScores.reduce((s, x) => s + x, 0) / cotScores.length : 0
  const score = clampScore(move + relative + basis + positioning)

  const times = input.quotes.map(q => Date.parse(q.time)).filter(Number.isFinite)
  const quoteAgeMin = times.length ? Math.round((now - Math.max(...times)) / 60_000) : undefined
  const session: FuturesSession = input.quotes[0]?.session ?? sessionLabel(now)
  const confidence =
    input.quotes.length === 0
      ? 0
      : Math.min(
          0.9,
          0.3 +
            (core.length === 2 ? 0.15 : 0) +
            (Object.keys(implied).length ? 0.15 : 0) +
            (cots.length ? 0.1 : 0) +
            (quoteAgeMin !== undefined && quoteAgeMin <= 30 ? 0.15 : 0),
        )

  const readings: Reading[] = []
  const flags: Text[] = []
  for (const q of input.quotes) {
    const name = `${q.root} ${q.contract ?? ''}`.trim()
    readings.push({
      name: bi(name, `${name} 期货`),
      value: q.last,
      note: bi(`${pct(q.changePct)} vs settle ${q.prevSettle} (${q.source})`, `较结算价 ${q.prevSettle} ${pct(q.changePct)}，来源 ${q.source}`),
    })
  }
  for (const imp of Object.values(implied)) {
    if (!imp) continue
    readings.push({
      name: bi(`${imp.index} implied`, `期货隐含 ${imp.index}`),
      value: imp.impliedCash,
      note: bi(`${pct(imp.impliedChangePct)} vs ${imp.changeBase}; basis ${imp.basisNow} pts`, `较 ${imp.changeBase} ${pct(imp.impliedChangePct)}；基差 ${imp.basisNow} 点`),
    })
    if (imp.anomaly) flags.push(imp.anomaly)
  }
  const pp = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`
  if (nqMinusEs !== undefined)
    readings.push({
      name: bi('NQ − ES', 'NQ − ES 强弱差'),
      value: bi(`${pp(nqMinusEs)} pp`, `${pp(nqMinusEs)} 个百分点`),
      note:
        nqMinusEs > 0.25
          ? bi('tech leading: risk appetite', '科技股领涨：风险偏好较强')
          : nqMinusEs < -0.25
            ? bi('tech lagging: defensive', '科技股落后：偏防御')
            : bi('in line', '步调一致'),
    })
  if (rtyMinusEs !== undefined)
    readings.push({
      name: bi('RTY − ES', 'RTY − ES 强弱差'),
      value: bi(`${pp(rtyMinusEs)} pp`, `${pp(rtyMinusEs)} 个百分点`),
      note: rtyMinusEs > 0.25 ? bi('small caps leading', '小盘股领涨') : rtyMinusEs < -0.25 ? bi('small caps lagging', '小盘股落后') : bi('in line', '步调一致'),
    })
  for (const c of allCots) {
    const m = c.market ?? ''
    const ch = c.lev.change === undefined ? undefined : `${c.lev.change >= 0 ? '+' : ''}${c.lev.change}`
    readings.push({
      name: bi(`${m} lev funds net`.trim(), `${m} 杠杆基金净持仓`.trim()),
      value: c.lev.net,
      note: bi(
        `3y index ${c.lev.index3y}, 26w ${c.lev.index26w}, ${ch === undefined ? '' : `${ch} w/w, `}as of ${c.date}`,
        `3 年 COT 指数 ${c.lev.index3y}，26 周 ${c.lev.index26w}，${ch === undefined ? '' : `周变化 ${ch}，`}截至 ${c.date}`,
      ),
    })
    readings.push({
      name: bi(`${m} asset mgr net`.trim(), `${m} 资产管理机构净持仓`.trim()),
      value: c.am.net,
      note: bi(`3y index ${c.am.index3y}, ${c.am.pctOi}% of OI`, `3 年指数 ${c.am.index3y}，占未平仓量 ${c.am.pctOi}%`),
    })
    flags.push(...c.flags)
  }
  if (session)
    readings.push({
      name: bi('Session', '交易时段'),
      value: sessionText(session),
      note: quoteAgeMin === undefined ? undefined : bi(`quote ${quoteAgeMin} min old`, `报价为 ${quoteAgeMin} 分钟前`),
    })
  if (avgMove !== undefined && Math.abs(avgMove) >= 1) flags.unshift(bi(`Large overnight move: ${pct(avgMove)} indicated`, `隔夜波动较大：期货指示 ${pct(avgMove)}`))
  if (nqMinusEs !== undefined && Math.abs(nqMinusEs) >= 0.75) {
    const gap = Math.abs(nqMinusEs).toFixed(2)
    flags.push(bi(`NQ ${nqMinusEs > 0 ? 'outpacing' : 'trailing'} ES by ${gap} pp`, `NQ ${nqMinusEs > 0 ? '跑赢' : '跑输'} ES ${gap} 个百分点`))
  }
  if (quoteAgeMin !== undefined && quoteAgeMin > 18 * 60) {
    const h = Math.round(quoteAgeMin / 60)
    flags.push(bi(`Futures quotes are ${h} hours old (${session})`, `期货报价已是 ${h} 小时前（${SESSION_ZH[session]}）`))
  }
  for (const r of ROOTS) if (!byRoot.has(r)) flags.push(bi(`${r} quote unavailable`, `${r} 报价不可用`))

  let verdict: Text
  if (avgMove === undefined) verdict = bi('No futures quotes available.', '暂无期货报价。')
  else {
    const dir = avgMove > 0.15 ? 'higher' : avgMove < -0.15 ? 'lower' : 'flat'
    const dirZh = avgMove > 0.15 ? '上涨' : avgMove < -0.15 ? '下跌' : '持平'
    // The lead contract first, then ES and NQ for context.
    const order: FuturesRoot[] = lead ? [lead, ...(['ES', 'NQ'] as FuturesRoot[]).filter(r => r !== lead)] : ['ES', 'NQ']
    const parts = order.filter(r => movePct[r] !== undefined).map(r => `${r} ${pct(changePct[r] ?? movePct[r]!)}`)
    const moved = joinText(parts.length ? parts : [bi(`move ${pct(avgMove)}`, `变动 ${pct(avgMove)}`)], ', ', '，')
    const impRoot = lead && implied[lead] ? lead : 'ES'
    const impOf = implied[impRoot]
    const imp = impOf ? bi(`, implying ${impOf.index} ${pct(impOf.impliedChangePct)}`, `，对应 ${impOf.index} ${pct(impOf.impliedChangePct)}`) : bi('', '')
    const rs =
      nqMinusEs === undefined ? bi('', '') : nqMinusEs > 0.25 ? bi(', tech leading', '，科技股领涨') : nqMinusEs < -0.25 ? bi(', tech lagging', '，科技股落后') : bi('', '')
    const crowded = cots[0]?.lev.crowded
    const lev = crowded ? bi(`; leveraged funds crowded ${crowded}`, `；杠杆基金${crowded === 'long' ? '多头拥挤' : '空头拥挤'}`) : bi('', '')
    const bias = biasOf(score)
    verdict = bi(
      `Futures point ${dir} (${bias}): ${moved.en} vs settle${imp.en}${rs.en}${lev.en}.`,
      `期货指示${dirZh}（${biasText(bias).zh}）：较结算价 ${moved.zh}${imp.zh}${rs.zh}${lev.zh}。`,
    )
  }

  return {
    key: 'futures',
    score,
    confidence: rnd(confidence, 2),
    verdict,
    readings,
    flags,
    stats: {
      session,
      lead,
      changePct,
      movePct,
      nqMinusEs,
      rtyMinusEs,
      implied,
      cot: cots,
      components: { move: rnd(move, 1), relative: rnd(relative, 1), basis, positioning: rnd(positioning, 1) },
      quoteAgeMin,
    },
  }
}
