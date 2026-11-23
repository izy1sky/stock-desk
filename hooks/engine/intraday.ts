// Intraday analysis: today's session minute by minute — the gap and the
// pre-market, the opening ranges and the initial balance (first hour), VWAP
// and its bands, relative volume by time of day, the opening type, breadth
// and leadership from sector ETFs, the options levels that matter today, and
// what past sessions that looked like this one did for the rest of the day.
//
// Data: CNBC's chart API (real-time 1- and 5-minute bars with volume,
// pre-market from 04:00 ET, about 70 sessions back) and CNBC quotes (sector
// ETFs, RSP, VIX). All times are US Eastern.
//
// THE TYPES AND EXPORTED SIGNATURES BELOW ARE THE CONTRACT the pane, the tool
// and the tests are written against. Implement them; do not rename or reshape
// them without telling the lead.
//
// Payload facts checked against live data (Nov 19 2026):
// - `tradeTime` is New York wall time (EST5EDT, DST-aware) and marks the bar's
//   start; `tradeTimeinMills` is the same instant. A request for one day of
//   1-minute bars returns 04:00 onwards for stocks and 00:00 onwards for
//   futures; the bar in progress is included.
// - Each past day of 5-minute bars runs 04:00-20:00 and ends with a
//   zero-volume 20:00 bar whose price is the official close (SPY Nov 18:
//   730.20, while the 15:55 bar closed at 730.41). The 16:00 bar carries the
//   closing-cross volume (hundreds of millions of shares for SPY), so volume
//   studies stop at 15:59.
// - The 5-minute feed also holds a few zero-volume bars on weekends; a date
//   counts as a session only with at least 12 traded regular-hours bars.
// - Quotes: in pre-market `last` is still the prior close and the live price
//   is in `ExtendedMktQuote`; the prior close is taken as last − change.

import { addDays } from '../data'
import { bi, biasText, joinText, type Text } from '../i18n'
import { etInstant, etParts } from './futures'
import { getJson, num, type Fetch } from './http'
import { fmtPrice } from './technicals'
import { biasOf, clampScore, type Bias, type Reading } from './types'

/** One intraday bar. `t` is the bar's start, epoch ms; `date` and `time` are its New York date and HH:MM. */
export type MinuteBar = { t: number; date: string; time: string; o: number; h: number; l: number; c: number; v: number }

export type SessionPhase = 'pre-market' | 'opening range' | 'first hour' | 'regular' | 'after hours' | 'closed'

export type IntradayData = {
  symbol: string
  /** Today's (or the latest session's) 1-minute bars, pre-market included, oldest first. */
  bars: MinuteBar[]
  /** Past sessions' 5-minute bars (regular and extended hours), oldest first, today excluded. */
  history: MinuteBar[]
  /** The session `bars` belongs to (YYYY-MM-DD, New York). */
  sessionDate: string
  /** The previous regular session's close, high and low. */
  prev: { date: string; close: number; high: number; low: number }
  /** 14-day average true range of daily bars built from `history` plus earlier days when known. */
  dailyAtr?: number
  fetchedAt: number
}

export type BreadthRow = { symbol: string; name: Text; last: number; open: number; prevClose: number; changePct: number; vsOpenPct: number }

export type Breadth = {
  asOf: string
  /** The 11 SPDR sector ETFs. */
  sectors: BreadthRow[]
  /** RSP, SPY, QQQ, IWM, SMH, DIA. */
  benchmarks: BreadthRow[]
  sectorsUp: number
  sectorsAboveOpen: number
  /** Equal weight minus cap weight, percentage points from the prior close (narrow vs broad move). */
  rspMinusSpy?: number
  qqqMinusSpy?: number
  iwmMinusSpy?: number
  /** `vsOpenPct`: VIX since its 09:30 open (absent before the open). */
  vix?: { last: number; changePct: number; vsOpenPct?: number }
}

export type RangeStatus = 'forming' | 'inside' | 'above' | 'below' | 'failed above' | 'failed below'

/** The opening range of the first `minutes` of the regular session (60 = the initial balance). */
export type OpeningRange = { minutes: 5 | 15 | 30 | 60; high: number; low: number; complete: boolean; status: RangeStatus; widthVsAtr?: number }

export type OpenType =
  | 'too early'
  | 'open-drive up'
  | 'open-drive down'
  | 'open-test-drive up'
  | 'open-test-drive down'
  | 'open-rejection-reverse up'
  | 'open-rejection-reverse down'
  | 'open-auction'

export type Vwap = {
  value: number
  upper1: number
  lower1: number
  upper2: number
  lower2: number
  /** Price vs VWAP, percent. */
  vsPct: number
  /** VWAP's slope over the last 15 minutes, percent per hour. */
  slopePctPerHour: number
  /** Share of regular-session minutes that closed above VWAP, 0..100. */
  pctTimeAbove: number
  /** One value per regular-session minute (aligned with those bars), for the chart. */
  series: { t: number; vwap: number; upper1: number; lower1: number }[]
}

export type IntradayLevel = {
  price: number
  kind:
    | 'prior close'
    | 'prior high'
    | 'prior low'
    | 'pre-market high'
    | 'pre-market low'
    | 'open'
    | 'opening range high'
    | 'opening range low'
    | 'initial balance high'
    | 'initial balance low'
    | 'VWAP'
    | 'VWAP +1σ'
    | 'VWAP −1σ'
    | 'gamma flip'
    | 'call wall'
    | 'put wall'
    | 'daily resistance'
    | 'daily support'
  label: Text
}

/** The read as it stood at one moment of the first hour, for the timeline. */
export type Checkpoint = { time: string; price: number; vsOpenPct: number; vsVwapPct?: number; score: number; bias: Bias; note: Text }

/** Past sessions that looked like today at the same clock time, and what they did next. */
export type SessionStudy = {
  /** Clock time the states were compared at (HH:MM). */
  at: string
  /** What "looked like today" meant, e.g. "gap up, above VWAP, above the 30-min range". */
  matchedOn: Text
  n: number
  /** Share of matched sessions that closed above their open / above the price at `at` / beyond the IB high / beyond the IB low (0..100). */
  closeAboveOpen: number
  closeAboveNow: number
  extendedHigh: number
  extendedLow: number
  /** Mean and median move from `at` to the close, percent. */
  meanRestOfDay: number
  medianRestOfDay: number
  /** The same over every session, unconditional. */
  baseline: { n: number; closeAboveNow: number; meanRestOfDay: number }
  dates: string[]
  note: Text
}

export type IntradayScenario = { name: 'trend up' | 'trend down' | 'range' | 'reversal up' | 'reversal down'; label: Text; trigger: Text; target?: number; invalidation: Text }

export type OptionsContext = { gammaFlip?: number; callWall?: number; putWall?: number; maxPain?: number; todayMove?: { expiry: string; pct: number; lo: number; hi: number } }

export type IntradayRead = {
  symbol: string
  phase: SessionPhase
  sessionDate: string
  asOf: string
  /** Minutes since 09:30 ET (negative before the open). */
  minutesSinceOpen: number
  price: number
  open?: number
  changePct: number
  gap: { pct: number; vsAtr?: number; direction: 'up' | 'down' | 'flat'; filled: boolean }
  premarket?: { high: number; low: number; last: number; volume: number }
  ranges: OpeningRange[]
  vwap?: Vwap
  /** Volume since the open over the average volume of the same minutes in past sessions. */
  rvol?: { value: number; sessions: number }
  openType: OpenType
  breadth?: Breadth
  options?: OptionsContext
  study?: SessionStudy
  /** −100..100 lean for the rest of the session, as the other modules score. */
  score: number
  bias: Bias
  confidence: number
  verdict: Text
  readings: Reading[]
  flags: Text[]
  scenarios: IntradayScenario[]
  /** Every level that matters today, highest first. */
  levels: IntradayLevel[]
  /** 09:35, 09:45, 10:00, 10:30 (those already reached). */
  timeline: Checkpoint[]
  notes: Text[]
  errors: string[]
}

/** The compact record kept after each close, so the session study grows past what the feed keeps. */
export type DaySummary = {
  date: string
  symbol: string
  prevClose: number
  open: number
  high: number
  low: number
  close: number
  ibHigh: number
  ibLow: number
  /** Price, VWAP and the 30-minute range at 10:00 and 10:30, for matching. */
  at: Record<'10:00' | '10:30', { price: number; vwap: number; or30High: number; or30Low: number }>
}

// ---------------------------------------------------------------- clock and bars

const OPEN = 570 // 09:30
const OR_END = 600 // 10:00, the 30-minute range is complete
const IB_END = 630 // 10:30, the initial balance is complete
const CLOSE = 960 // 16:00
const EXT_START = 240 // 04:00
const EXT_END = 1200 // 20:00
const SLOTS = 78 // 5-minute slots in a regular session
const MIN = 60_000

const last = <T>(a: T[]): T | undefined => a[a.length - 1]
const clamp = (n: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, n))
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0)
const fin = (n: number | undefined | null): n is number => typeof n === 'number' && Number.isFinite(n)
const rnd = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d
const sg = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`
const pctTxt = (n: number, d = 2) => `${sg(n, d)}%`
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)

  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`
const fmtVol = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : String(Math.round(v)))
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Minutes after New York midnight of a bar's start. */
export const minuteOf = (b: { time: string }) => Number(b.time.slice(0, 2)) * 60 + Number(b.time.slice(3, 5))
const isRegular = (b: MinuteBar) => {
  const m = minuteOf(b)

  return m >= OPEN && m < CLOSE
}
const hi = (bars: MinuteBar[]) => bars.reduce((m, b) => Math.max(m, b.h), -Infinity)
const lo = (bars: MinuteBar[]) => bars.reduce((m, b) => Math.min(m, b.l), Infinity)

/** CNBC `barData.priceBars` → bars, oldest first; rows without a price are skipped. */
export function parseCnbcBars(data: any): MinuteBar[] {
  const rows = data?.barData?.priceBars
  if (!Array.isArray(rows)) return []
  const out: MinuteBar[] = []
  for (const r of rows) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(r?.tradeTime ?? ''))
    const o = num(r?.open)
    const h = num(r?.high)
    const l = num(r?.low)
    const c = num(r?.close)
    if (!m || o === undefined || h === undefined || l === undefined || c === undefined || c <= 0) continue
    const date = `${m[1]}-${m[2]}-${m[3]}`
    const t = num(r.tradeTimeinMills) ?? etInstant(date, Number(m[4]), Number(m[5]))
    out.push({ t, date, time: `${m[4]}:${m[5]}`, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: num(r.volume) ?? 0 })
  }
  out.sort((a, b) => a.t - b.t)

  return out.filter((b, i) => i === 0 || b.t !== out[i - 1]!.t)
}

type Session = { date: string; reg: MinuteBar[]; open: number; high: number; low: number; close: number; official: number }

/**
 * Past bars grouped into regular sessions (09:30-16:00 traded bars; a date
 * needs 12 of them). `close` is the last regular bar's close; `official` is
 * CNBC's zero-volume close marker after 16:00 when it is within 2% of it.
 */
function toSessions(bars: MinuteBar[]): Session[] {
  const by = new Map<string, MinuteBar[]>()
  for (const b of bars) {
    const a = by.get(b.date)
    if (a) a.push(b)
    else by.set(b.date, [b])
  }
  const out: Session[] = []
  for (const date of [...by.keys()].sort()) {
    const all = by.get(date)!
    const reg = all.filter(b => b.v > 0 && isRegular(b))
    if (reg.length < 12) continue
    const close = last(reg)!.c
    const marker = [...all].reverse().find(b => b.v === 0 && minuteOf(b) >= CLOSE)
    const official = marker && Math.abs(marker.c / close - 1) < 0.02 ? marker.c : close
    out.push({ date, reg, open: reg[0]!.o, high: hi(reg), low: lo(reg), close, official })
  }

  return out
}

/** 14-day Wilder ATR of daily bars (needs n + 1 days). */
function wilderAtr(days: { h: number; l: number; c: number }[], n = 14): number | undefined {
  if (days.length < n + 1) return undefined
  const tr: number[] = []
  for (let i = 1; i < days.length; i++) {
    const d = days[i]!
    const pc = days[i - 1]!.c
    tr.push(Math.max(d.h - d.l, Math.abs(d.h - pc), Math.abs(d.l - pc)))
  }
  let atr = mean(tr.slice(0, n))
  for (let i = n; i < tr.length; i++) atr = (atr * (n - 1) + tr[i]!) / n

  return atr
}

// ---------------------------------------------------------------- loading

const BARS = 'https://ts-api.cnbc.com/harmony/app/bars'
const ymd = (iso: string) => iso.replace(/-/g, '')

/** CNBC chart bars for a New York date range ('@SP.1'-style futures symbols keep their '@'). */
export const barsUrl = (symbol: string, res: '1M' | '5M', from: string, to: string) =>
  `${BARS}/${encodeURIComponent(symbol).replace(/%40/g, '@')}/${res}/${ymd(from)}000000/${ymd(to)}235900/adjusted/EST5EDT.json`

export async function loadIntraday(fetch: Fetch, symbol: string, opts: { now?: number } = {}): Promise<IntradayData> {
  const now = opts.now ?? Date.now()
  const sym = symbol.trim().toUpperCase()
  const today = etParts(now).date
  const [dayJson, histJson] = await Promise.all([getJson(fetch, barsUrl(sym, '1M', today, today)), getJson(fetch, barsUrl(sym, '5M', addDays(today, -120), today))])
  const hist = parseCnbcBars(histJson)
  const sessions = toSessions(hist)
  let sessionDate = today
  let bars = parseCnbcBars(dayJson).filter(b => b.v > 0 && b.date === today)
  if (!bars.length) {
    // Before 04:00, on a weekend or a holiday: show the latest session.
    const latest = last(sessions.filter(s => s.date <= today))
    if (!latest) throw new Error(`No intraday bars for ${sym}`)
    sessionDate = latest.date
    try {
      bars = parseCnbcBars(await getJson(fetch, barsUrl(sym, '1M', sessionDate, sessionDate))).filter(b => b.v > 0 && b.date === sessionDate)
    } catch {
      bars = []
    }
    if (!bars.length) bars = hist.filter(b => b.v > 0 && b.date === sessionDate)
  }
  if (!bars.length) throw new Error(`No intraday bars for ${sym}`)
  const past = sessions.filter(s => s.date < sessionDate)
  const prev = last(past)
  if (!prev) throw new Error(`No prior session in CNBC's 5-minute history for ${sym}`)
  const kept = new Set(past.map(s => s.date))

  return {
    symbol: sym,
    bars,
    history: hist.filter(b => kept.has(b.date)),
    sessionDate,
    prev: { date: prev.date, close: prev.official, high: prev.high, low: prev.low },
    dailyAtr: wilderAtr(past.map(s => ({ h: s.high, l: s.low, c: s.official }))),
    fetchedAt: now,
  }
}

const SECTORS: [string, string, string][] = [
  ['XLK', 'Technology', '科技'],
  ['XLF', 'Financials', '金融'],
  ['XLE', 'Energy', '能源'],
  ['XLV', 'Health care', '医疗保健'],
  ['XLY', 'Consumer discretionary', '可选消费'],
  ['XLP', 'Consumer staples', '必需消费'],
  ['XLI', 'Industrials', '工业'],
  ['XLB', 'Materials', '原材料'],
  ['XLU', 'Utilities', '公用事业'],
  ['XLRE', 'Real estate', '房地产'],
  ['XLC', 'Communication services', '通信服务'],
]
const BENCHMARKS: [string, string, string][] = [
  ['RSP', 'S&P 500 equal weight', '标普 500 等权'],
  ['SPY', 'S&P 500', '标普 500'],
  ['QQQ', 'Nasdaq-100', '纳斯达克 100'],
  ['IWM', 'Russell 2000', '罗素 2000'],
  ['SMH', 'Semiconductors', '半导体'],
  ['DIA', 'Dow Jones Industrials', '道琼斯工业指数'],
]
const DEFENSIVE = new Set(['XLP', 'XLU', 'XLV', 'XLRE'])
const TECH = new Set(['XLK', 'SMH', 'XLC'])

const QUOTES = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'
const breadthUrl = () =>
  `${QUOTES}?symbols=${[...SECTORS, ...BENCHMARKS].map(s => s[0]).concat('.VIX').join('%7C')}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`

/** CNBC quote rows → breadth. In pre-market the extended-hours price is used and the open is not known yet (vsOpenPct 0). */
export function parseBreadth(data: any): Breadth {
  const raw = data?.FormattedQuoteResult?.FormattedQuote
  const rows: any[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  const bySym = new Map<string, any>()
  for (const r of rows) if (r && (r.code === undefined || Number(r.code) === 0)) bySym.set(String(r.symbol), r)
  let asOf = ''
  const row = ([symbol, en, zh]: [string, string, string]): BreadthRow[] => {
    const r = bySym.get(symbol)
    const regLast = num(r?.last)
    if (!r || regLast === undefined || regLast <= 0) return []
    const ext = r.ExtendedMktQuote
    const extLast = num(ext?.last)
    const time = String((r.curmktstatus === 'PRE_MKT' && ext?.last_time) || r.last_time || '')
    if (time > asOf) asOf = time
    if (r.curmktstatus === 'PRE_MKT' && extLast !== undefined && extLast > 0) {
      // Before the open `last` is still the prior close.
      return [{ symbol, name: bi(en, zh), last: extLast, open: extLast, prevClose: regLast, changePct: rnd((extLast / regLast - 1) * 100), vsOpenPct: 0 }]
    }
    const change = num(r.change)
    const prevClose = change !== undefined ? regLast - change : (num(r.previous_day_closing) ?? regLast)
    const open = num(r.open) ?? regLast
    const changePct = prevClose > 0 ? (regLast / prevClose - 1) * 100 : (num(r.change_pct) ?? 0)

    return [{ symbol, name: bi(en, zh), last: regLast, open, prevClose: rnd(prevClose, 4), changePct: rnd(changePct), vsOpenPct: open > 0 ? rnd((regLast / open - 1) * 100) : 0 }]
  }
  const sectors = SECTORS.flatMap(row)
  const benchmarks = BENCHMARKS.flatMap(row)
  const chg = (s: string) => benchmarks.find(b => b.symbol === s)?.changePct
  const spy = chg('SPY')
  const diff = (s: string) => {
    const x = chg(s)

    return x !== undefined && spy !== undefined ? rnd(x - spy) : undefined
  }
  const v = bySym.get('.VIX')
  const vixLast = num(v?.last)
  const vixPrev = vixLast !== undefined && num(v?.change) !== undefined ? vixLast - num(v.change)! : num(v?.previous_day_closing)

  return {
    asOf: asOf.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'),
    sectors,
    benchmarks,
    sectorsUp: sectors.filter(s => s.changePct > 0).length,
    sectorsAboveOpen: sectors.filter(s => s.vsOpenPct > 0).length,
    rspMinusSpy: diff('RSP'),
    qqqMinusSpy: diff('QQQ'),
    iwmMinusSpy: diff('IWM'),
    vix:
      vixLast !== undefined
        ? {
            last: vixLast,
            changePct: vixPrev ? rnd((vixLast / vixPrev - 1) * 100) : (num(v?.change_pct) ?? 0),
            vsOpenPct: v?.curmktstatus !== 'PRE_MKT' && (num(v?.open) ?? 0) > 0 ? rnd((vixLast / num(v.open)! - 1) * 100) : undefined,
          }
        : undefined,
  }
}

export async function loadBreadth(fetch: Fetch): Promise<Breadth> {
  const b = parseBreadth(await getJson(fetch, breadthUrl()))
  if (!b.sectors.length && !b.benchmarks.length) throw new Error('No sector ETF quotes from CNBC')

  return b
}

// ---------------------------------------------------------------- the state at one moment

type State = {
  /** New York clock, minutes after midnight (fractional). */
  clock: number
  /** Minutes since 09:30. */
  elapsed: number
  pre: MinuteBar[]
  reg: MinuteBar[]
  /** Latest print (extended hours included). */
  price: number
  /** Latest regular-session close (the ranges and VWAP are regular-session measures). */
  regPrice: number
  open?: number
  hod?: number
  lod?: number
  gap: IntradayRead['gap']
  premarket?: IntradayRead['premarket']
  ranges: OpeningRange[]
  vwap?: Vwap
  openType: OpenType
  rvol?: { value: number; sessions: number }
}

function phaseOf(clock: number, sameDay: boolean): SessionPhase {
  if (!sameDay || clock < EXT_START || clock >= EXT_END) return 'closed'
  if (clock < OPEN) return 'pre-market'
  if (clock < OR_END) return 'opening range'
  if (clock < IB_END) return 'first hour'
  if (clock < CLOSE) return 'regular'

  return 'after hours'
}

/** VWAP of regular-session bars on the typical price (h + l + c) / 3, with volume-weighted standard deviation bands. */
function vwapOf(reg: MinuteBar[], price: number): Vwap | undefined {
  if (!reg.length) return undefined
  let pv = 0
  let pv2 = 0
  let vol = 0
  let above = 0
  let sd = 0
  const series: Vwap['series'] = []
  for (const b of reg) {
    const tp = (b.h + b.l + b.c) / 3
    pv += tp * b.v
    pv2 += tp * tp * b.v
    vol += b.v
    const vw = vol > 0 ? pv / vol : tp
    sd = vol > 0 ? Math.sqrt(Math.max(0, pv2 / vol - vw * vw)) : 0
    series.push({ t: b.t, vwap: rnd(vw, 4), upper1: rnd(vw + sd, 4), lower1: rnd(vw - sd, 4) })
    if (b.c > vw) above++
  }
  const end = last(series)!
  const value = vol > 0 ? pv / vol : end.vwap
  let ref = series[0]!
  for (const p of series) if (p.t <= end.t - 15 * MIN) ref = p
  const hours = (end.t - ref.t) / 3_600_000

  return {
    value: rnd(value, 4),
    upper1: rnd(value + sd, 4),
    lower1: rnd(value - sd, 4),
    upper2: rnd(value + 2 * sd, 4),
    lower2: rnd(value - 2 * sd, 4),
    vsPct: rnd((price / value - 1) * 100, 3),
    slopePctPerHour: hours > 0 ? rnd(((end.vwap / ref.vwap - 1) * 100) / hours, 3) : 0,
    pctTimeAbove: rnd((100 * above) / reg.length, 1),
    series,
  }
}

const RANGE_MINUTES = [5, 15, 30, 60] as const

/**
 * Opening ranges. Complete once `minutes` have passed. A breakout is a bar
 * closing beyond the range after it completed; the status is where the latest
 * price is, and "failed above/below" when the latest close beyond the range
 * was on that side but price is back inside.
 */
function rangesOf(reg: MinuteBar[], elapsed: number, price: number, atr?: number): OpeningRange[] {
  const out: OpeningRange[] = []
  for (const minutes of RANGE_MINUTES) {
    const inside = reg.filter(b => minuteOf(b) < OPEN + minutes)
    if (!inside.length) continue
    const high = hi(inside)
    const low = lo(inside)
    const complete = elapsed >= minutes
    let status: RangeStatus = 'forming'
    if (complete) {
      let broke: 'above' | 'below' | undefined
      for (const b of reg) {
        if (minuteOf(b) < OPEN + minutes) continue
        if (b.c > high) broke = 'above'
        else if (b.c < low) broke = 'below'
      }
      status = price > high ? 'above' : price < low ? 'below' : broke === 'above' ? 'failed above' : broke === 'below' ? 'failed below' : 'inside'
    }
    out.push({ minutes, high: rnd(high, 4), low: rnd(low, 4), complete, status, widthVsAtr: atr ? rnd((high - low) / atr, 2) : undefined })
  }

  return out
}

/**
 * Dalton's opening types, read from the first 30 minutes (the first 15-29
 * once 15 have passed; 'too early' before 09:45). O = the open, R = the
 * window's range, c = its last close, tol = max(4 bp of O, 12% of R).
 * - The open is "won" by one side when |c − O| ≥ 25% of R; otherwise
 *   open-auction (price rotates around the open).
 * - open-drive: the side against the move never got more than tol beyond the
 *   open, and c keeps at least half of the move from the open.
 * - open-test-drive: price first probed the other side (beyond tol), but the
 *   probe was at most half the size of the drive and its extreme came in the
 *   first 10 minutes, before the drive's extreme.
 * - open-rejection-reverse: price first moved the other way (a bigger or
 *   slower probe than a test), was rejected, and reversed through the open.
 * - Anything else (a high and a low on both sides in the wrong order, or a
 *   drive that gave back more than half) is open-auction.
 */
function openTypeOf(reg: MinuteBar[], elapsed: number): OpenType {
  if (elapsed < 15 || !reg.length) return 'too early'
  const win = Math.min(30, Math.floor(elapsed))
  const w = reg.filter(b => minuteOf(b) < OPEN + win)
  if (!w.length) return 'too early'
  const o = w[0]!.o
  let h = -Infinity
  let l = Infinity
  let tHi = 0
  let tLo = 0
  for (const b of w) {
    const m = minuteOf(b) - OPEN
    if (b.h > h) {
      h = b.h
      tHi = m
    }
    if (b.l < l) {
      l = b.l
      tLo = m
    }
  }
  const r = h - l
  if (r <= 0) return 'open-auction'
  const c = last(w)!.c
  const net = c - o
  if (Math.abs(net) < 0.25 * r) return 'open-auction'
  const tol = Math.max(0.0004 * o, 0.12 * r)
  const up = net > 0
  const withMove = up ? h - o : o - l
  const against = up ? o - l : h - o
  const tWith = up ? tHi : tLo
  const tAgainst = up ? tLo : tHi
  const dir = up ? 'up' : 'down'
  if (against <= tol) return Math.abs(net) >= 0.5 * withMove ? `open-drive ${dir}` : 'open-auction'
  if (tAgainst < tWith) return against <= 0.5 * withMove && tAgainst < 10 ? `open-test-drive ${dir}` : `open-rejection-reverse ${dir}`

  return 'open-auction'
}

/** Regular-session volume of each past full session in 5-minute slots, the last 20 sessions. */
function volumeProfile(history: MinuteBar[]): number[][] {
  const out: number[][] = []
  for (const s of toSessions(history)) {
    const slots = new Array<number>(SLOTS).fill(0)
    for (const b of s.reg) {
      const k = Math.floor((minuteOf(b) - OPEN) / 5)
      if (k >= 0 && k < SLOTS) slots[k] = slots[k]! + b.v
    }
    if (slots.filter(x => x > 0).length >= 70) out.push(slots)
  }

  return out.slice(-20)
}

/** Cumulative volume `e` minutes after the open, interpolating inside the 5-minute slot. */
function cumAt(slots: number[], e: number): number {
  const k = Math.floor(e / 5)
  let s = 0
  for (let j = 0; j < Math.min(k, SLOTS); j++) s += slots[j]!
  if (k < SLOTS) s += (slots[k] ?? 0) * ((e - 5 * k) / 5)

  return s
}

function rvolOf(reg: MinuteBar[], elapsed: number, profile: number[][]): State['rvol'] {
  if (!profile.length || !reg.length || elapsed < 1) return undefined
  const e = Math.min(elapsed, 390)
  const base = mean(profile.map(p => cumAt(p, e)))
  if (base <= 0) return undefined

  return { value: rnd(reg.reduce((s, b) => s + b.v, 0) / base, 2), sessions: profile.length }
}

function stateAt(data: IntradayData, cutoff: number, clock: number, profile: number[][]): State {
  const all = data.bars.filter(b => b.t < cutoff)
  const pre = all.filter(b => b.date === data.sessionDate && minuteOf(b) < OPEN)
  const reg = all.filter(b => b.date === data.sessionDate && isRegular(b))
  const elapsed = clock - OPEN
  const price = last(all)?.c ?? data.prev.close
  const regPrice = last(reg)?.c ?? price
  const open = reg[0]?.o
  const pc = data.prev.close
  const atr = data.dailyAtr
  const premarket = pre.length ? { high: hi(pre), low: lo(pre), last: last(pre)!.c, volume: pre.reduce((s, b) => s + b.v, 0) } : undefined
  const hod = reg.length ? hi(reg) : undefined
  const lod = reg.length ? lo(reg) : undefined
  const ref = open ?? premarket?.last ?? price
  const g = (ref / pc - 1) * 100

  return {
    clock,
    elapsed,
    pre,
    reg,
    price,
    regPrice,
    open,
    hod,
    lod,
    gap: {
      pct: rnd(g),
      vsAtr: atr ? rnd((ref - pc) / atr) : undefined,
      direction: g >= 0.25 ? 'up' : g <= -0.25 ? 'down' : 'flat',
      filled: open !== undefined && lod! <= pc && hod! >= pc,
    },
    premarket,
    ranges: rangesOf(reg, elapsed, regPrice, atr),
    vwap: vwapOf(reg, regPrice),
    openType: openTypeOf(reg, elapsed),
    rvol: rvolOf(reg, elapsed, profile),
  }
}

/** The largest opening range that is complete (the initial balance once it is). */
const mainRange = (st: State) => [...st.ranges].reverse().find(r => r.complete)

// ---------------------------------------------------------------- the session study

type DayState = { gap: 'up' | 'down' | 'flat'; vwap: 'above' | 'below'; range: 'above' | 'inside' | 'below' }
type PastDay = { date: string; state: DayState; open: number; close: number; priceAt: number; extHigh: boolean; extLow: boolean }

/**
 * A session's coarse state from its regular bars that started before `atMin`
 * (so nothing after `at` is seen): gap (open vs prior close, ±0.25%), price vs
 * VWAP, and price vs the 30-minute range (the 15-minute range before 10:00).
 */
function featuresAt(reg: MinuteBar[], prevClose: number, atMin: number): { state: DayState; price: number } | undefined {
  const before = reg.filter(b => minuteOf(b) < atMin)
  if (!before.length || minuteOf(before[0]!) > OPEN + 4) return undefined
  const open = before[0]!.o
  const price = last(before)!.c
  const vw = vwapOf(before, price)!.value
  const rb = before.filter(b => minuteOf(b) < OPEN + (atMin >= OR_END ? 30 : 15))
  const h = hi(rb)
  const l = lo(rb)
  const g = (open / prevClose - 1) * 100

  return { state: { gap: g >= 0.25 ? 'up' : g <= -0.25 ? 'down' : 'flat', vwap: price >= vw ? 'above' : 'below', range: price > h ? 'above' : price < l ? 'below' : 'inside' }, price }
}

const GAP_TEXT: Record<DayState['gap'], Text> = { up: bi('gap up', '高开'), down: bi('gap down', '低开'), flat: bi('flat open', '平开') }
const VWAP_SIDE: Record<DayState['vwap'], Text> = { above: bi('above VWAP', '位于 VWAP 上方'), below: bi('below VWAP', '位于 VWAP 下方') }
const rangeSide = (side: DayState['range'], minutes: number): Text =>
  side === 'inside'
    ? bi(`inside the ${minutes}-min range`, `位于 ${minutes} 分钟开盘区间内`)
    : side === 'above'
      ? bi(`above the ${minutes}-min range`, `位于 ${minutes} 分钟开盘区间上方`)
      : bi(`below the ${minutes}-min range`, `位于 ${minutes} 分钟开盘区间下方`)

/**
 * Past sessions whose state at the same clock time (rounded down to 5
 * minutes, 09:45 at the earliest) matched today's, and what they did for the
 * rest of the day. Matching starts on all three features and drops the
 * weakest first — gap, then the range — until at least 8 sessions match.
 * Sessions come from the 5-minute history (full regular sessions only) and
 * archived DaySummary rows (used only when `at` is 10:00-10:45, from their
 * 10:00 / 10:30 states).
 */
function sessionStudy(data: IntradayData, st: State, archive: DaySummary[]): SessionStudy | undefined {
  const atMin = Math.min(955, Math.max(585, Math.floor(st.clock / 5) * 5))
  const today = featuresAt(st.reg, data.prev.close, atMin)
  if (!today) return undefined
  const rangeMin = atMin >= OR_END ? 30 : 15
  const sessions = toSessions(data.history)
  const days: PastDay[] = []
  for (let i = 1; i < sessions.length; i++) {
    const s = sessions[i]!
    if (minuteOf(s.reg[0]!) > OPEN + 4 || minuteOf(last(s.reg)!) < 955) continue
    const f = featuresAt(s.reg, sessions[i - 1]!.official, atMin)
    if (!f) continue
    const ib = s.reg.filter(b => minuteOf(b) < IB_END)
    const ibHigh = hi(ib)
    const ibLow = lo(ib)
    const after = s.reg.filter(b => minuteOf(b) >= Math.max(atMin, IB_END))
    days.push({ date: s.date, state: f.state, open: s.open, close: s.close, priceAt: f.price, extHigh: after.some(b => b.h > ibHigh), extLow: after.some(b => b.l < ibLow) })
  }
  const fromHistory = days.length
  const key = atMin >= 600 && atMin < 615 ? '10:00' : atMin >= 615 && atMin <= 645 ? '10:30' : undefined
  if (key) {
    const have = new Set(days.map(d => d.date))
    for (const a of archive) {
      const x = a.at?.[key]
      if (!x || a.symbol.toUpperCase() !== data.symbol.toUpperCase() || a.date >= data.sessionDate || have.has(a.date) || !(a.prevClose > 0)) continue
      have.add(a.date)
      const g = (a.open / a.prevClose - 1) * 100
      days.push({
        date: a.date,
        state: { gap: g >= 0.25 ? 'up' : g <= -0.25 ? 'down' : 'flat', vwap: x.price >= x.vwap ? 'above' : 'below', range: x.price > x.or30High ? 'above' : x.price < x.or30Low ? 'below' : 'inside' },
        open: a.open,
        close: a.close,
        priceAt: x.price,
        extHigh: a.high > a.ibHigh,
        extLow: a.low < a.ibLow,
      })
    }
  }
  const archived = days.length - fromHistory
  const feats: (keyof DayState)[] = ['vwap', 'range', 'gap']
  let keys = feats
  let matched = days
  for (;;) {
    matched = days.filter(d => keys.every(k => d.state[k] === today.state[k]))
    if (matched.length >= 8 || keys.length === 1) break
    keys = keys.slice(0, -1)
  }
  const share = (xs: PastDay[], f: (d: PastDay) => boolean) => (xs.length ? rnd((100 * xs.filter(f).length) / xs.length, 1) : 0)
  const rest = (d: PastDay) => (d.close / d.priceAt - 1) * 100
  const at = hhmm(atMin)
  const matchedOn = joinText(
    keys.map(k => (k === 'gap' ? GAP_TEXT[today.state.gap] : k === 'vwap' ? VWAP_SIDE[today.state.vwap] : rangeSide(today.state.range, rangeMin))),
    ', ',
    '、',
  )
  const n = matched.length
  const closeAboveNow = share(matched, d => d.close > d.priceAt)
  const baseline = { n: days.length, closeAboveNow: share(days, d => d.close > d.priceAt), meanRestOfDay: rnd(mean(days.map(rest)), 3) }
  const edge = rnd(closeAboveNow - baseline.closeAboveNow, 1)
  const notes: Text[] = []
  if (n === 0) notes.push(bi(`No past session matched at ${at}.`, `${at} 时没有可匹配的历史交易日。`))
  else if (n < 8) notes.push(bi(`Only ${n} sessions matched even on "${matchedOn.en}" alone: anecdotal, not a statistic.`, `即使只按「${matchedOn.zh}」匹配也只有 ${n} 个交易日：只能当个例参考，不构成统计。`))
  else if (n < 20)
    notes.push(bi(`Small sample (${n} of ${days.length} sessions): differences under about 20 points from the baseline are noise.`, `样本较小（${days.length} 个交易日中 ${n} 个）：与基准相差不到约 20 个百分点都属噪音。`))
  else notes.push(bi(`${n} of ${days.length} sessions matched.`, `${days.length} 个交易日中有 ${n} 个匹配。`))
  if (n > 0)
    notes.push(
      bi(
        `They closed above the ${at} price ${closeAboveNow}% of the time vs ${baseline.closeAboveNow}% for all sessions (${sg(edge, 0)} pts).`,
        `其中收盘高于 ${at} 价格的比例为 ${closeAboveNow}%，全部交易日为 ${baseline.closeAboveNow}%（${sg(edge, 0)} 个百分点）。`,
      ),
    )
  notes.push(
    bi(
      `${fromHistory} sessions of 5-minute history${archived ? ` + ${archived} archived days (their 10:00/10:30 state)` : ''}; states use only bars before ${at}.`,
      `${fromHistory} 个交易日的 5 分钟历史${archived ? ` + ${archived} 个存档交易日（按其 10:00/10:30 状态）` : ''}；状态只用 ${at} 之前的 K 线。`,
    ),
  )

  return {
    at,
    matchedOn,
    n,
    closeAboveOpen: share(matched, d => d.close > d.open),
    closeAboveNow,
    extendedHigh: share(matched, d => d.extHigh),
    extendedLow: share(matched, d => d.extLow),
    meanRestOfDay: rnd(mean(matched.map(rest)), 3),
    medianRestOfDay: rnd(median(matched.map(rest)), 3),
    baseline,
    dates: matched.map(d => d.date).reverse(),
    note: joinText(notes, ' ', ''),
  }
}

// ---------------------------------------------------------------- breadth read

type BreadthKind = 'broad rally' | 'narrow rally' | 'broad selloff' | 'narrow selloff' | 'masked weakness' | 'masked strength' | 'mixed'
/** `narrowSide`: +1 when the index's gain (or hold) rests on a few leaders, −1 when its loss does; 0 otherwise. */
type BreadthRead = { kind: BreadthKind; tech: boolean; defensive: boolean; label: Text; detail: Text; narrowSide: -1 | 0 | 1; spy?: number }

const rowTxt = (r: BreadthRow) => `${r.symbol} ${pctTxt(r.changePct, 1)}`

/**
 * Narrow vs broad, from SPY's change (m), RSP minus SPY (rs) and sectors up:
 * - m > +0.15%: narrow rally when rs ≤ −0.5 pts or ≤ 40% of sectors are up;
 *   broad when ≥ 80% are up; else mixed. A selloff (m < −0.15%) mirrors it.
 * - flat index: masked weakness when rs ≤ −0.5 or ≤ 30% of sectors are up
 *   (a few leaders hold the index while the average stock falls), masked
 *   strength in the mirror case, else mixed.
 */
function readBreadth(b: Breadth): BreadthRead {
  const spy = b.benchmarks.find(x => x.symbol === 'SPY')?.changePct
  const n = b.sectors.length || 11
  const rs = b.rspMinusSpy ?? 0
  const up = b.sectorsUp
  const m = spy ?? mean(b.sectors.map(s => s.changePct))
  let kind: BreadthKind = 'mixed'
  if (m > 0.15) kind = rs <= -0.5 || up <= n * 0.4 ? 'narrow rally' : up >= n * 0.8 ? 'broad rally' : 'mixed'
  else if (m < -0.15) kind = rs >= 0.5 || up >= n * 0.6 ? 'narrow selloff' : up <= n * 0.2 ? 'broad selloff' : 'mixed'
  else kind = rs <= -0.5 || up <= n * 0.3 ? 'masked weakness' : rs >= 0.5 || up >= n * 0.7 ? 'masked strength' : 'mixed'
  const ranked = [...b.sectors, ...b.benchmarks.filter(x => x.symbol === 'SMH')].sort((x, y) => y.changePct - x.changePct)
  const leaders = ranked.slice(0, 2)
  const laggards = [...b.sectors].sort((x, y) => x.changePct - y.changePct).slice(0, 2)
  const downSide = kind === 'narrow selloff' || kind === 'masked strength'
  const tech = downSide ? (b.qqqMinusSpy ?? 0) <= -0.4 || laggards.some(x => TECH.has(x.symbol)) : (b.qqqMinusSpy ?? 0) >= 0.4 || leaders.some(x => TECH.has(x.symbol))
  const defensive = leaders.some(x => DEFENSIVE.has(x.symbol))
  const leadEn = leaders.map(x => x.name.en.toLowerCase()).join(' and ')
  const leadZh = leaders.map(x => x.name.zh).join('、')
  const LABEL: Record<BreadthKind, Text> = {
    'narrow rally': tech ? bi('a narrow, tech-led rally', '科技股主导、广度偏窄的上涨') : bi(`a narrow rally led by ${leadEn}`, `由${leadZh}带动、广度偏窄的上涨`),
    'broad rally': bi('a broad rally', '普涨'),
    'narrow selloff': tech
      ? bi('a narrow, tech-led selloff (the average stock is holding)', '科技权重股领跌、普通股票相对抗跌的下跌')
      : bi('a narrow selloff (cap weights down, the average stock holding)', '权重股领跌、普通股票相对抗跌的下跌'),
    'broad selloff': leaders.some(x => TECH.has(x.symbol)) && (b.qqqMinusSpy ?? 0) >= 0.3
      ? bi('a broad selloff, with tech holding up the index', '普跌，科技股托住指数')
      : bi('a broad selloff', '普跌'),
    'masked weakness': tech
      ? bi('a flat index held up by tech while the average stock falls', '指数持平靠科技股支撑，多数股票下跌')
      : bi(`a flat index held up by ${leadEn} while the average stock falls`, `指数持平靠${leadZh}支撑，多数股票下跌`),
    'masked strength': bi('a flat index while the average stock rises', '指数持平，但多数股票上涨'),
    mixed: defensive ? bi('a mixed, defensive tape', '分化行情，防御板块占优') : bi('a mixed tape', '分化行情'),
  }
  const rsp = b.benchmarks.find(x => x.symbol === 'RSP')
  const bits: Text[] = [
    bi(`leaders ${leaders.map(rowTxt).join(', ')}`, `领涨 ${leaders.map(rowTxt).join('、')}`),
    bi(`laggards ${laggards.map(rowTxt).join(', ')}`, `落后 ${laggards.map(rowTxt).join('、')}`),
  ]
  if (rsp && spy !== undefined) bits.push(bi(`RSP ${pctTxt(rsp.changePct)} vs SPY ${pctTxt(spy)} (${sg(rs)} pts)`, `RSP ${pctTxt(rsp.changePct)} 对 SPY ${pctTxt(spy)}（${sg(rs)} 个百分点）`))
  bits.push(bi(`${up}/${n} sectors up, ${b.sectorsAboveOpen} above their open`, `${n} 个板块中 ${up} 个上涨，${b.sectorsAboveOpen} 个高于开盘价`))
  if (b.vix) {
    const o = b.vix.vsOpenPct !== undefined ? `, ${pctTxt(b.vix.vsOpenPct, 1)} since the open` : ''
    const oz = b.vix.vsOpenPct !== undefined ? `，较开盘 ${pctTxt(b.vix.vsOpenPct, 1)}` : ''
    bits.push(bi(`VIX ${b.vix.last.toFixed(2)} (${pctTxt(b.vix.changePct, 1)}${o})`, `VIX ${b.vix.last.toFixed(2)}（${pctTxt(b.vix.changePct, 1)}${oz}）`))
  }
  const narrowSide = kind === 'narrow rally' || kind === 'masked weakness' ? 1 : kind === 'narrow selloff' || kind === 'masked strength' ? -1 : 0

  return { kind, tech, defensive, label: LABEL[kind], detail: joinText(bits, '; ', '；'), narrowSide, spy }
}

// ---------------------------------------------------------------- score

/** Cap-weighted broad-market symbols: breadth weighs more and narrow moves are discounted. */
const BROAD = new Set(['SPY', 'VOO', 'IVV', 'SPLG', 'DIA', '@SP.1', '@DJ.1', '.SPX', 'SPX', '.DJI'])

/**
 * Score weights (renormalized over the components that exist), each
 * component −1..1:
 * - vwap 22: 0.5 × z of price vs VWAP (±1.5σ saturates) + 0.3 × VWAP slope
 *   (±0.15 × the daily ATR% per hour saturates) + 0.2 × share of minutes above.
 * - range 20: status of the largest complete opening range (IB first):
 *   above +1, below −1, failed above −0.6, failed below +0.6, inside ±0.3 by
 *   position; × 0.5 / 0.7 / 0.85 / 1 for the 5 / 15 / 30 / 60-minute range.
 * - openType 14: drive ±1, test-drive ±0.8, rejection-reverse ±0.6, auction 0
 *   (× 0.6 after 11:30).
 * - gap 10: gap holding and price beyond the open +0.6 in the gap's direction,
 *   fading toward the fill −0.2, filled −0.5; flat gaps don't count; before
 *   the open the indicated gap counts ±0.3.
 * - breadth 12 for broad symbols, 6 otherwise: 0.5 × sectors up vs half
 *   + 0.5 × RSP's change (±0.8% saturates).
 * - relative 8 (not for broad symbols): the symbol's change minus SPY's
 *   (±1.5 points saturates).
 * - vix 6: −(half VIX's change on the day + half its change since the open),
 *   ±8% saturates.
 * - options 8: above the gamma flip +0.35 / below −0.35; within 0.3% (or a
 *   quarter of today's straddle move) of the call wall −0.4, of the put wall +0.4.
 * - study ≤ 8, × min(1, n / 30): matched sessions' close-above-now share minus
 *   the baseline (±25 points saturates).
 * Then: RVOL ≥ 1.2 amplifies the score by up to 25%, RVOL < 0.8 cuts it 15%;
 * a broad symbol whose score points the way a few leaders are carrying the index
 * (narrow rally / masked weakness up, narrow selloff / masked strength down) is cut 15%.
 */
type Parts = Record<'vwap' | 'range' | 'openType' | 'gap' | 'breadth' | 'relative' | 'vix' | 'options' | 'study', number | undefined>

const OPEN_TYPE_SCORE: Record<OpenType, number | undefined> = {
  'too early': undefined,
  'open-drive up': 1,
  'open-drive down': -1,
  'open-test-drive up': 0.8,
  'open-test-drive down': -0.8,
  'open-rejection-reverse up': 0.6,
  'open-rejection-reverse down': -0.6,
  'open-auction': 0,
}

function nearPct(o: OptionsContext | undefined) {
  return Math.max(0.3, (o?.todayMove?.pct ?? 0) * 0.25)
}

function optionsPart(price: number, o?: OptionsContext): number | undefined {
  if (!o) return undefined
  let s = 0
  let any = false
  const near = (lvl: number) => Math.abs((price / lvl - 1) * 100) <= nearPct(o)
  if (fin(o.gammaFlip)) {
    any = true
    s += price >= o.gammaFlip ? 0.35 : -0.35
  }
  if (fin(o.callWall) && near(o.callWall)) {
    any = true
    s -= 0.4
  }
  if (fin(o.putWall) && near(o.putWall)) {
    any = true
    s += 0.4
  }

  return any ? clamp(s) : undefined
}

function scoreOf(
  st: State,
  data: IntradayData,
  phase: SessionPhase,
  ext: { breadth?: Breadth; breadthRead?: BreadthRead; options?: OptionsContext; study?: SessionStudy },
): { score: number; confidence: number; parts: Parts; agreement: number } {
  const broad = BROAD.has(data.symbol)
  const price = st.price
  const atrPct = data.dailyAtr ? (data.dailyAtr / data.prev.close) * 100 : 1
  const p: Parts = { vwap: undefined, range: undefined, openType: undefined, gap: undefined, breadth: undefined, relative: undefined, vix: undefined, options: undefined, study: undefined }
  const v = st.vwap
  if (v) {
    const sd = v.upper1 - v.value
    const z = sd > 0 ? (st.regPrice - v.value) / sd : sign(st.regPrice - v.value)
    p.vwap = clamp(0.5 * clamp(z / 1.5) + 0.3 * clamp(v.slopePctPerHour / (0.15 * atrPct)) + 0.2 * ((v.pctTimeAbove - 50) / 50))
  }
  const r = mainRange(st)
  if (r) {
    const mid = (r.high + r.low) / 2
    const half = (r.high - r.low) / 2
    const base: Record<RangeStatus, number> = {
      forming: 0,
      inside: half > 0 ? clamp((st.regPrice - mid) / half) * 0.3 : 0,
      above: 1,
      below: -1,
      'failed above': -0.6,
      'failed below': 0.6,
    }
    p.range = base[r.status] * ({ 5: 0.5, 15: 0.7, 30: 0.85, 60: 1 } as const)[r.minutes]
  }
  const ot = OPEN_TYPE_SCORE[st.openType]
  if (ot !== undefined) p.openType = ot * (st.elapsed > 120 ? 0.6 : 1)
  if (st.gap.direction !== 'flat') {
    const d = st.gap.direction === 'up' ? 1 : -1
    if (st.open === undefined) p.gap = 0.3 * d
    else if (st.gap.filled) p.gap = -0.5 * d
    else p.gap = (st.regPrice - st.open) * d > 0 ? 0.6 * d : -0.2 * d
  }
  const b = ext.breadth
  if (b && (b.sectors.length || b.rspMinusSpy !== undefined)) {
    const n = b.sectors.length || 11
    const rsp = b.benchmarks.find(x => x.symbol === 'RSP')?.changePct
    const parts = [b.sectors.length ? (b.sectorsUp - n / 2) / (n / 2) : undefined, rsp !== undefined ? clamp(rsp / 0.8) : undefined].filter(fin)
    if (parts.length) p.breadth = mean(parts)
    const spy = b.benchmarks.find(x => x.symbol === 'SPY')?.changePct
    if (!broad && spy !== undefined) p.relative = clamp(((price / data.prev.close - 1) * 100 - spy) / 1.5)
    if (b.vix) p.vix = -clamp((b.vix.vsOpenPct !== undefined ? 0.5 * b.vix.changePct + 0.5 * b.vix.vsOpenPct : b.vix.changePct) / 8)
  }
  p.options = optionsPart(price, ext.options)
  const s = ext.study
  if (s && s.n >= 3) p.study = clamp((s.closeAboveNow - s.baseline.closeAboveNow) / 25)
  const w: Record<keyof Parts, number> = {
    vwap: 22,
    range: 20,
    openType: 14,
    gap: 10,
    breadth: broad ? 12 : 6,
    relative: 8,
    vix: 6,
    options: 8,
    study: s ? 8 * Math.min(1, s.n / 30) : 0,
  }
  let sum = 0
  let abs = 0
  let weight = 0
  for (const k of Object.keys(p) as (keyof Parts)[]) {
    const x = p[k]
    if (!fin(x) || w[k] <= 0) continue
    sum += w[k] * x
    abs += w[k] * Math.abs(x)
    weight += w[k]
  }
  let raw = weight > 0 ? sum / weight : 0
  const agreement = abs > 0 ? Math.abs(sum) / abs : 0
  const rv = st.rvol?.value
  if (fin(rv)) raw *= rv >= 1.2 ? 1 + Math.min(0.25, (rv - 1) * 0.25) : rv < 0.8 ? 0.85 : 1
  const br = ext.breadthRead
  if (broad && br && br.narrowSide !== 0 && br.narrowSide === sign(raw)) raw *= 0.85
  const score = clampScore(raw * 100)

  let c = 0.2 + 0.45 * agreement
  if (st.elapsed < 0) c = Math.min(c, 0.2)
  else if (st.elapsed < 30) c = Math.min(c, 0.35)
  else if (st.elapsed < 60) c = Math.min(c, 0.5)
  else c += 0.1
  if (fin(rv)) c += rv >= 1.2 ? 0.05 : rv < 0.8 ? -0.05 : 0
  if (s && s.n >= 20) c += 0.05
  if (weight < 40) c -= 0.1
  if (v && v.upper1 > v.value && Math.abs(st.regPrice - v.value) / (v.upper1 - v.value) >= 2) c -= 0.1 // stretched: snap-backs to VWAP are common
  if (st.elapsed > 330 && st.elapsed < 390) c *= 0.8
  if (phase === 'after hours' || phase === 'closed') c *= 0.5

  return { score, confidence: rnd(clamp(c, 0.05, 0.85), 2), parts: p, agreement }
}

// ---------------------------------------------------------------- words

const PHASE_ZH: Record<SessionPhase, string> = {
  'pre-market': '盘前',
  'opening range': '开盘区间（前 30 分钟）',
  'first hour': '首小时',
  regular: '常规交易时段',
  'after hours': '盘后',
  closed: '已收盘',
}
export function phaseText(p: SessionPhase): Text {
  return bi(p, PHASE_ZH[p])
}

const OPEN_TYPE_ZH: Record<OpenType, string> = {
  'too early': '为时尚早（09:45 后判断）',
  'open-drive up': '开盘驱动上行（open-drive）',
  'open-drive down': '开盘驱动下行（open-drive）',
  'open-test-drive up': '开盘试探后上行（open-test-drive）',
  'open-test-drive down': '开盘试探后下行（open-test-drive）',
  'open-rejection-reverse up': '开盘先跌后反转上行（open-rejection-reverse）',
  'open-rejection-reverse down': '开盘先涨后反转下行（open-rejection-reverse）',
  'open-auction': '开盘双向拍卖（open-auction）',
}
export function openTypeText(t: OpenType): Text {
  return bi(t, OPEN_TYPE_ZH[t])
}

const RANGE_STATUS_ZH: Record<RangeStatus, string> = {
  forming: '形成中',
  inside: '区间内',
  above: '区间上方',
  below: '区间下方',
  'failed above': '向上突破失败',
  'failed below': '向下跌破失败',
}
export function rangeStatusText(s: RangeStatus): Text {
  return bi(s, RANGE_STATUS_ZH[s])
}

const LEVEL_ZH: Record<IntradayLevel['kind'], string> = {
  'prior close': '昨收',
  'prior high': '昨日高点',
  'prior low': '昨日低点',
  'pre-market high': '盘前高点',
  'pre-market low': '盘前低点',
  open: '开盘价',
  'opening range high': '开盘区间高点',
  'opening range low': '开盘区间低点',
  'initial balance high': '初始平衡区高点',
  'initial balance low': '初始平衡区低点',
  VWAP: 'VWAP（成交量加权均价）',
  'VWAP +1σ': 'VWAP +1σ 带',
  'VWAP −1σ': 'VWAP −1σ 带',
  'gamma flip': '伽马翻转点（gamma flip）',
  'call wall': '看涨墙（call wall）',
  'put wall': '看跌墙（put wall）',
  'daily resistance': '日线阻力',
  'daily support': '日线支撑',
}
export function levelKindTextIntraday(k: IntradayLevel['kind']): Text {
  return bi(k, LEVEL_ZH[k])
}

const rangeName = (minutes: number): Text =>
  minutes === 60 ? bi('initial balance (first hour)', '初始平衡区（initial balance，首小时区间）') : bi(`${minutes}-min opening range`, `${minutes} 分钟开盘区间（opening range）`)
const rangeShort = (minutes: number): Text => (minutes === 60 ? bi('initial balance', '初始平衡区') : bi(`${minutes}-min range`, `${minutes} 分钟开盘区间`))
/** A space before a zh phrase that starts with a digit or Latin letter ("位于 30 分钟…", "位于初始平衡区"). */
const zs = (z: string) => (/^[0-9A-Za-z]/.test(z) ? ` ${z}` : z)

function statusPhrase(r: OpeningRange): Text {
  const n = rangeShort(r.minutes)
  switch (r.status) {
    case 'above':
      return bi(`above the ${n.en}`, `位于${zs(n.zh)}上方`)
    case 'below':
      return bi(`below the ${n.en}`, `位于${zs(n.zh)}下方`)
    case 'failed above':
      return bi(`back inside the ${n.en} after a failed breakout`, `向上突破失败，回到${zs(n.zh)}内`)
    case 'failed below':
      return bi(`back inside the ${n.en} after a failed breakdown`, `向下跌破失败，回到${zs(n.zh)}内`)
    case 'inside':
      return bi(`inside the ${n.en}`, `位于${zs(n.zh)}内`)
    default:
      return bi(`the ${n.en} still forming`, `${n.zh}仍在形成`)
  }
}

function gapPhrase(st: State): Text {
  const g = Math.abs(st.gap.pct).toFixed(2)
  if (st.gap.direction === 'flat') return bi('flat open', '平开')
  const up = st.gap.direction === 'up'
  if (st.open === undefined) return up ? bi(`indicated gap up ${g}%`, `预计高开 ${g}%`) : bi(`indicated gap down ${g}%`, `预计低开 ${g}%`)
  if (st.gap.filled) return up ? bi(`gap up ${g}% filled`, `高开 ${g}% 已回补`) : bi(`gap down ${g}% filled`, `低开 ${g}% 已回补`)

  return up ? bi(`gap up ${g}% unfilled`, `高开 ${g}% 未回补`) : bi(`gap down ${g}% unfilled`, `低开 ${g}% 未回补`)
}

function vwapPhrase(v: Vwap): Text {
  return v.vsPct >= 0 ? bi(`above VWAP (${pctTxt(v.vsPct)})`, `位于 VWAP 上方（${pctTxt(v.vsPct)}）`) : bi(`below VWAP (${pctTxt(v.vsPct)})`, `位于 VWAP 下方（${pctTxt(v.vsPct)}）`)
}

function checkpointNote(st: State): Text {
  const bits: Text[] = []
  if (st.vwap) bits.push(st.vwap.vsPct >= 0 ? VWAP_SIDE.above : VWAP_SIDE.below)
  const r = mainRange(st)
  if (r) bits.push(statusPhrase(r))
  if (st.openType !== 'too early') bits.push(openTypeText(st.openType))
  if (!bits.length) bits.push(gapPhrase(st))

  return joinText(bits, ', ', '，')
}

// ---------------------------------------------------------------- levels and scenarios

const roundPrice = (p: number) => (p >= 1 ? rnd(p, 2) : rnd(p, 4))

function levelsOf(st: State, data: IntradayData, o?: OptionsContext, daily?: { supports: number[]; resistances: number[] }): IntradayLevel[] {
  const cand: { price: number; kind: IntradayLevel['kind']; label: Text; pri: number }[] = []
  const add = (price: number | undefined, kind: IntradayLevel['kind'], pri: number, label: Text = levelKindTextIntraday(kind)) => {
    if (fin(price) && price > 0) cand.push({ price: roundPrice(price), kind, label, pri })
  }
  add(data.prev.close, 'prior close', 1)
  add(st.open, 'open', 2)
  const ib = st.ranges.find(r => r.minutes === 60 && r.complete)
  if (ib) {
    add(ib.high, 'initial balance high', 3)
    add(ib.low, 'initial balance low', 3)
  }
  const or = [...st.ranges].reverse().find(r => r.minutes < 60 && r.complete)
  if (or) {
    add(or.high, 'opening range high', 4, bi(`${or.minutes}-min opening range high`, `${or.minutes} 分钟开盘区间高点`))
    add(or.low, 'opening range low', 4, bi(`${or.minutes}-min opening range low`, `${or.minutes} 分钟开盘区间低点`))
  }
  if (st.vwap) {
    add(st.vwap.value, 'VWAP', 5)
    add(st.vwap.upper1, 'VWAP +1σ', 7)
    add(st.vwap.lower1, 'VWAP −1σ', 7)
  }
  add(o?.gammaFlip, 'gamma flip', 6)
  add(o?.callWall, 'call wall', 6)
  add(o?.putWall, 'put wall', 6)
  add(st.premarket?.high, 'pre-market high', 8)
  add(st.premarket?.low, 'pre-market low', 8)
  add(data.prev.high, 'prior high', 9)
  add(data.prev.low, 'prior low', 9)
  for (const r of (daily?.resistances ?? []).slice(0, 2)) add(r, 'daily resistance', 10)
  for (const s of (daily?.supports ?? []).slice(0, 2)) add(s, 'daily support', 10)
  const kept: IntradayLevel[] = []
  for (const c of cand.sort((a, b) => a.pri - b.pri)) {
    // Within 0.05% of a more important level: one row, both names.
    const k = kept.find(x => Math.abs(x.price / c.price - 1) <= 0.0005)
    if (k) k.label = joinText([k.label, c.label], ' / ', ' / ')
    else kept.push({ price: c.price, kind: c.kind, label: c.label })
  }

  return kept.sort((a, b) => b.price - a.price)
}

/**
 * Scenario levels: the initial balance once it is complete, before that the
 * session's range so far (the pre-market range before the open). Targets are
 * the next level beyond both the reference edge and the price (one range
 * width further when there is none).
 */
function scenariosOf(st: State, data: IntradayData, levels: IntradayLevel[], score: number, o?: OptionsContext): IntradayScenario[] {
  const ib = st.ranges.find(r => r.minutes === 60 && r.complete)
  const pm = st.premarket
  const upper = ib?.high ?? st.hod ?? pm?.high ?? data.prev.high
  const lower = ib?.low ?? st.lod ?? pm?.low ?? data.prev.low
  const refName: Text = ib ? rangeShort(60) : st.hod !== undefined ? bi("today's range so far", '今日目前区间') : pm ? bi('pre-market range', '盘前区间') : bi("prior session's range", '昨日区间')
  const pivot = st.vwap?.value ?? st.open ?? data.prev.close
  const pivotName: Text = st.vwap ? bi('VWAP', 'VWAP') : st.open !== undefined ? bi('the open', '开盘价') : bi('the prior close', '昨收')
  const f = fmtPrice
  const px = st.regPrice
  const width = Math.max(upper - lower, upper * 0.001)
  const prices = levels.map(l => l.price)
  if (o?.todayMove) prices.push(o.todayMove.hi, o.todayMove.lo)
  const top = Math.max(upper, px)
  const bottom = Math.min(lower, px)
  const above = prices.filter(p => p > top * 1.001).sort((a, b) => a - b)[0] ?? top + width
  const below = prices.filter(p => p < bottom * 0.999).sort((a, b) => b - a)[0] ?? bottom - width
  const trendUp: IntradayScenario = {
    name: 'trend up',
    label: bi('Trend up', '趋势上行'),
    trigger:
      px > upper
        ? bi(`holds above the ${refName.en} high ${f(upper)} (already broken) and above ${pivotName.en} ${f(pivot)}`, `守住已突破的${zs(refName.zh)}高点 ${f(upper)} 及 ${pivotName.zh} ${f(pivot)} 上方`)
        : bi(`holds above ${pivotName.en} ${f(pivot)} and breaks above the ${refName.en} high ${f(upper)}`, `守住 ${pivotName.zh} ${f(pivot)} 上方并突破${zs(refName.zh)}高点 ${f(upper)}`),
    target: roundPrice(above),
    invalidation: bi(`a 5-minute close back below ${pivotName.en} ${f(pivot)}`, `5 分钟收盘重新跌回 ${pivotName.zh} ${f(pivot)} 下方`),
  }
  const trendDown: IntradayScenario = {
    name: 'trend down',
    label: bi('Trend down', '趋势下行'),
    trigger:
      px < lower
        ? bi(`stays below the ${refName.en} low ${f(lower)} (already broken) and below ${pivotName.en} ${f(pivot)}`, `受制于已跌破的${zs(refName.zh)}低点 ${f(lower)} 及 ${pivotName.zh} ${f(pivot)} 下方`)
        : bi(`stays below ${pivotName.en} ${f(pivot)} and breaks below the ${refName.en} low ${f(lower)}`, `受制于 ${pivotName.zh} ${f(pivot)} 下方并跌破${zs(refName.zh)}低点 ${f(lower)}`),
    target: roundPrice(below),
    invalidation: bi(`a 5-minute close back above ${pivotName.en} ${f(pivot)}`, `5 分钟收盘重新站回 ${pivotName.zh} ${f(pivot)} 上方`),
  }
  const range: IntradayScenario = {
    name: 'range',
    label: bi('Range', '区间震荡'),
    trigger: bi(`stays inside ${f(lower)}–${f(upper)} (the ${refName.en}), rotating around ${pivotName.en} ${f(pivot)}`, `维持在${zs(refName.zh)} ${f(lower)}–${f(upper)} 内，围绕 ${pivotName.zh} ${f(pivot)} 来回`),
    target: roundPrice(pivot),
    invalidation: bi(`a 5-minute close outside ${f(lower)}–${f(upper)}`, `5 分钟收盘突破 ${f(lower)}–${f(upper)} 任一侧`),
  }
  const pc = data.prev.close
  const hod = st.hod ?? upper
  const lod = st.lod ?? lower
  // The first step of a reversal: fail at the upper edge (or, already above it, fall back inside), then lose the pivot.
  const downStep = px > upper ? bi(`falls back below ${f(upper)}`, `跌回 ${f(upper)} 下方`) : bi(`fails at ${f(upper)}`, `在 ${f(upper)} 受阻`)
  const upStep = px < lower ? bi(`climbs back above ${f(lower)}`, `重新站上 ${f(lower)}`) : bi(`holds ${f(lower)}`, `守住 ${f(lower)}`)
  const fillDown = st.gap.direction === 'up' && !st.gap.filled
  const fillUp = st.gap.direction === 'down' && !st.gap.filled
  const reversal: IntradayScenario =
    px >= pivot
      ? {
          name: 'reversal down',
          label: bi('Reversal down', '反转下行'),
          trigger: bi(
            `${downStep.en} and loses ${pivotName.en} ${f(pivot)}${fillDown ? `, heading for the gap fill at the prior close ${f(pc)}` : ''}`,
            `${downStep.zh}并跌破 ${pivotName.zh} ${f(pivot)}${fillDown ? `，向昨收 ${f(pc)} 回补缺口` : ''}`,
          ),
          target: roundPrice(fillDown ? pc : Math.min(lower, pivot)),
          invalidation: bi(`a new session high above ${f(hod)}`, `创出日内新高（高于 ${f(hod)}）`),
        }
      : {
          name: 'reversal up',
          label: bi('Reversal up', '反转上行'),
          trigger: bi(
            `${upStep.en} and reclaims ${pivotName.en} ${f(pivot)}${fillUp ? `, heading for the gap fill at the prior close ${f(pc)}` : ''}`,
            `${upStep.zh}并收复 ${pivotName.zh} ${f(pivot)}${fillUp ? `，向昨收 ${f(pc)} 回补缺口` : ''}`,
          ),
          target: roundPrice(fillUp ? pc : Math.max(upper, pivot)),
          invalidation: bi(`a new session low below ${f(lod)}`, `创出日内新低（低于 ${f(lod)}）`),
        }

  return score >= 0 ? [trendUp, range, reversal, trendDown] : [trendDown, range, reversal, trendUp]
}

// ---------------------------------------------------------------- analysis

const CHECKPOINTS = [575, 585, 600, 630] // 09:35, 09:45, 10:00, 10:30

export function analyzeIntraday(
  data: IntradayData,
  ctx: { breadth?: Breadth; options?: OptionsContext; daily?: { supports: number[]; resistances: number[] }; archive?: DaySummary[]; now?: number } = {},
): IntradayRead {
  const now = ctx.now ?? Date.now()
  const sameDay = etParts(now).date === data.sessionDate
  const clock = sameDay ? (now - etInstant(data.sessionDate, 0, 0)) / MIN : EXT_END
  const profile = volumeProfile(data.history)
  const st = stateAt(data, sameDay ? now : Infinity, clock, profile)
  const phase = phaseOf(clock, sameDay)
  const study = st.elapsed >= 15 && st.elapsed < 390 && st.reg.length ? sessionStudy(data, st, ctx.archive ?? []) : undefined
  const breadth = ctx.breadth
  const br = breadth ? readBreadth(breadth) : undefined
  const o = ctx.options
  const { score, confidence } = scoreOf(st, data, phase, { breadth, breadthRead: br, options: o, study })
  const bias = biasOf(score)
  const pc = data.prev.close
  const price = st.price
  const changePct = rnd((price / pc - 1) * 100)
  const sym = data.symbol
  const f = fmtPrice
  const atr = data.dailyAtr
  const lastBar = last(data.bars.filter(b => b.t < (sameDay ? now : Infinity)))
  const asOf = `${data.sessionDate} ${sameDay ? hhmm(Math.floor(clock)) : (lastBar?.time ?? '16:00')} ET`

  // ---- timeline: the read as it stood at each first-hour checkpoint reached
  const timeline: Checkpoint[] = []
  if (st.reg.length)
    for (const cp of CHECKPOINTS) {
      if (st.elapsed < cp - OPEN) break
      const s = stateAt(data, etInstant(data.sessionDate, Math.floor(cp / 60), cp % 60), cp, profile)
      if (!s.reg.length) continue
      const sc = scoreOf(s, data, phaseOf(cp, true), { options: o })
      timeline.push({
        time: hhmm(cp),
        price: roundPrice(s.regPrice),
        vsOpenPct: s.open ? rnd((s.regPrice / s.open - 1) * 100) : 0,
        vsVwapPct: s.vwap?.vsPct,
        score: sc.score,
        bias: biasOf(sc.score),
        note: checkpointNote(s),
      })
    }

  const levels = levelsOf(st, data, o, ctx.daily)
  const scenarios = scenariosOf(st, data, levels, score, o)
  const r = mainRange(st)
  const v = st.vwap
  const or30 = st.ranges.find(x => x.minutes === 30)

  // ---- verdict
  const biasT = biasText(bias)
  const tail = bi(`score ${sg(score, 0)}, confidence ${confidence.toFixed(2)}`, `评分 ${sg(score, 0)}，置信度 ${confidence.toFixed(2)}`)
  let verdict: Text
  if (phase === 'pre-market' || !st.reg.length) {
    const pm = st.premarket
    verdict = bi(
      `${sym} pre-market ${f(price)} (${pctTxt(changePct)} vs the prior close ${f(pc)})${pm ? `, range ${f(pm.low)}–${f(pm.high)}` : ''}; the read firms up after the 09:30 open: ${biasT.en} for now (${tail.en}).`,
      `${sym} 盘前 ${f(price)}（较昨收 ${f(pc)} ${pctTxt(changePct)}）${pm ? `，盘前区间 ${f(pm.low)}–${f(pm.high)}` : ''}；09:30 开盘后判断才更可靠：目前${biasT.zh}（${tail.zh}）。`,
    )
  } else {
    const bits: Text[] = [gapPhrase(st)]
    if (st.openType !== 'too early') bits.push(openTypeText(st.openType))
    if (v) bits.push(vwapPhrase(v))
    if (r) bits.push(statusPhrase(r))
    if (br) bits.push(br.label)
    const d = joinText(bits, ', ', '，')
    const done = phase === 'after hours' || phase === 'closed'
    verdict = done
      ? bi(`${sym} ${pctTxt(changePct)} on the session (${d.en}); the session has closed, so this is the day's read: ${biasT.en} (${tail.en}).`, `${sym} 本交易日 ${pctTxt(changePct)}（${d.zh}）；已收盘，以下为当日总结：${biasT.zh}（${tail.zh}）。`)
      : bi(`${sym} ${pctTxt(changePct)}: ${d.en}; ${biasT.en} for the rest of the session (${tail.en}).`, `${sym} ${pctTxt(changePct)}：${d.zh}；对本交易日剩余时段${biasT.zh}（${tail.zh}）。`)
  }

  // ---- readings
  const readings: Reading[] = [
    { name: bi('Price', '价格'), value: f(price), note: bi(`${pctTxt(changePct)} vs the prior close ${f(pc)} (${data.prev.date})`, `较昨收 ${f(pc)}（${data.prev.date}）${pctTxt(changePct)}`) },
  ]
  if (st.open !== undefined) readings.push({ name: bi('Open', '开盘价'), value: f(st.open), note: bi(`price ${pctTxt((st.regPrice / st.open - 1) * 100)} from the open`, `价格较开盘 ${pctTxt((st.regPrice / st.open - 1) * 100)}`) })
  readings.push({
    name: bi('Gap', '跳空'),
    value: pctTxt(st.gap.pct),
    note: joinText([gapPhrase(st), ...(st.gap.vsAtr !== undefined ? [bi(`${st.gap.vsAtr.toFixed(2)}× daily ATR ${f(atr!)}`, `为日线 ATR ${f(atr!)} 的 ${st.gap.vsAtr.toFixed(2)} 倍`)] : [])], ', ', '，'),
  })
  if (st.premarket)
    readings.push({
      name: bi('Pre-market', '盘前'),
      value: `${f(st.premarket.low)}–${f(st.premarket.high)}`,
      note: bi(`last ${f(st.premarket.last)}, volume ${fmtVol(st.premarket.volume)}`, `盘前最新 ${f(st.premarket.last)}，成交量 ${fmtVol(st.premarket.volume)}`),
    })
  for (const x of st.ranges)
    readings.push({
      name: rangeName(x.minutes),
      value: `${f(x.low)}–${f(x.high)}`,
      note: joinText([rangeStatusText(x.status), ...(x.widthVsAtr !== undefined ? [bi(`width ${x.widthVsAtr.toFixed(2)} ATR`, `宽度 ${x.widthVsAtr.toFixed(2)} 个 ATR`)] : [])], ', ', '，'),
    })
  if (v)
    readings.push({
      name: bi('VWAP', 'VWAP（成交量加权均价）'),
      value: f(v.value),
      note: bi(
        `price ${pctTxt(v.vsPct)}; ±1σ ${f(v.lower1)}–${f(v.upper1)}, ±2σ ${f(v.lower2)}–${f(v.upper2)}; slope ${sg(v.slopePctPerHour, 2)}%/h; ${v.pctTimeAbove.toFixed(0)}% of minutes above`,
        `价格 ${pctTxt(v.vsPct)}；±1σ 带 ${f(v.lower1)}–${f(v.upper1)}，±2σ 带 ${f(v.lower2)}–${f(v.upper2)}；斜率 ${sg(v.slopePctPerHour, 2)}%/小时；${v.pctTimeAbove.toFixed(0)}% 的分钟收在其上方`,
      ),
    })
  if (st.rvol)
    readings.push({
      name: bi('Relative volume', '相对成交量（RVOL）'),
      value: `${st.rvol.value.toFixed(2)}×`,
      note: bi(`volume since the open vs the same minutes of the last ${st.rvol.sessions} sessions`, `开盘以来成交量对比过去 ${st.rvol.sessions} 个交易日同一时段`),
    })
  readings.push({ name: bi('Open type', '开盘类型'), value: openTypeText(st.openType) })
  if (br && breadth) {
    readings.push({ name: bi('Breadth', '市场广度'), value: br.label, note: br.detail })
    const lead: string[] = []
    if (breadth.rspMinusSpy !== undefined) lead.push(`RSP−SPY ${sg(breadth.rspMinusSpy)}`)
    if (breadth.qqqMinusSpy !== undefined) lead.push(`QQQ−SPY ${sg(breadth.qqqMinusSpy)}`)
    if (breadth.iwmMinusSpy !== undefined) lead.push(`IWM−SPY ${sg(breadth.iwmMinusSpy)}`)
    if (lead.length) readings.push({ name: bi('Leadership (pts vs SPY)', '风格强弱（相对 SPY 的百分点）'), value: lead.join(', ') })
    if (breadth.vix) {
      const vo = breadth.vix.vsOpenPct
      readings.push({
        name: bi('VIX', 'VIX 恐慌指数'),
        value: breadth.vix.last.toFixed(2),
        note: bi(`${pctTxt(breadth.vix.changePct, 1)} on the day${vo !== undefined ? `, ${pctTxt(vo, 1)} since the open` : ''}`, `较昨收 ${pctTxt(breadth.vix.changePct, 1)}${vo !== undefined ? `，较开盘 ${pctTxt(vo, 1)}` : ''}`),
      })
    }
  }
  if (o && (o.gammaFlip !== undefined || o.callWall !== undefined || o.putWall !== undefined || o.todayMove)) {
    const en: string[] = []
    const zh: string[] = []
    if (fin(o.gammaFlip)) {
      en.push(`gamma flip ${f(o.gammaFlip)} (price ${price >= o.gammaFlip ? 'above' : 'below'})`)
      zh.push(`伽马翻转点 ${f(o.gammaFlip)}（价格在其${price >= o.gammaFlip ? '上方' : '下方'}）`)
    }
    if (fin(o.callWall)) {
      en.push(`call wall ${f(o.callWall)}`)
      zh.push(`看涨墙 ${f(o.callWall)}`)
    }
    if (fin(o.putWall)) {
      en.push(`put wall ${f(o.putWall)}`)
      zh.push(`看跌墙 ${f(o.putWall)}`)
    }
    if (o.todayMove) {
      en.push(`${o.todayMove.expiry} straddle ±${o.todayMove.pct.toFixed(2)}% (${f(o.todayMove.lo)}–${f(o.todayMove.hi)})`)
      zh.push(`${o.todayMove.expiry} 跨式组合 ±${o.todayMove.pct.toFixed(2)}%（${f(o.todayMove.lo)}–${f(o.todayMove.hi)}）`)
    }
    readings.push({ name: bi('Options levels', '期权关键位'), value: bi(en.join('; '), zh.join('；')) })
  }
  if (study)
    readings.push({
      name: bi(`Similar sessions at ${study.at}`, `${study.at} 时的相似交易日`),
      value: `${study.closeAboveNow.toFixed(0)}% / ${study.baseline.closeAboveNow.toFixed(0)}%`,
      note: bi(`closed above the ${study.at} price, matched (n=${study.n}: ${study.matchedOn.en}) vs all sessions`, `收盘高于 ${study.at} 价格的比例：匹配样本（n=${study.n}：${study.matchedOn.zh}）对全部交易日`),
    })

  // ---- flags, most important first
  const flags: Text[] = []
  const g = Math.abs(st.gap.pct).toFixed(2)
  if (st.open !== undefined && st.gap.direction !== 'flat') {
    const up = st.gap.direction === 'up'
    if (st.gap.filled) flags.push(up ? bi(`Gap up of ${g}% filled: the gap-and-go failed`, `高开 ${g}% 已回补：跳空延续失败`) : bi(`Gap down of ${g}% filled: sellers could not hold it`, `低开 ${g}% 已回补：空方未能守住缺口`))
    else if ((st.regPrice - st.open) * (up ? 1 : -1) > 0)
      flags.push(up ? bi(`Gap up of ${g}% holding above the open (gap-and-go)`, `高开 ${g}% 后守在开盘价上方（跳空延续）`) : bi(`Gap down of ${g}% holding below the open (gap-and-go)`, `低开 ${g}% 后受制于开盘价下方（跳空延续）`))
    else flags.push(up ? bi(`Gap up of ${g}% fading toward the prior close ${f(pc)}`, `高开 ${g}% 后回落，正向昨收 ${f(pc)} 回补`) : bi(`Gap down of ${g}% recovering toward the prior close ${f(pc)}`, `低开 ${g}% 后回升，正向昨收 ${f(pc)} 回补`))
    if (st.gap.vsAtr !== undefined && Math.abs(st.gap.vsAtr) >= 1) flags.push(bi(`The gap is ${Math.abs(st.gap.vsAtr).toFixed(1)}× the daily ATR: an outsized open`, `缺口为日线 ATR 的 ${Math.abs(st.gap.vsAtr).toFixed(1)} 倍：开盘幅度异常`))
  }
  for (const x of [...st.ranges].reverse()) {
    if (!x.complete || x.minutes < 15) continue
    const n = rangeShort(x.minutes)
    if (x.status === 'failed above') flags.push(bi(`Failed breakout above the ${n.en} high ${f(x.high)}: back inside`, `向上突破${zs(n.zh)}高点 ${f(x.high)} 失败，已回到区间内`))
    if (x.status === 'failed below') flags.push(bi(`Failed breakdown below the ${n.en} low ${f(x.low)}: back inside`, `跌破${zs(n.zh)}低点 ${f(x.low)} 失败，已回到区间内`))
    if (x.minutes === 60 && x.status === 'above') flags.push(bi(`Above the initial balance high ${f(x.high)}: range extension up`, `站上初始平衡区高点 ${f(x.high)}：区间向上扩展`))
    if (x.minutes === 60 && x.status === 'below') flags.push(bi(`Below the initial balance low ${f(x.low)}: range extension down`, `跌破初始平衡区低点 ${f(x.low)}：区间向下扩展`))
  }
  if (st.openType.startsWith('open-drive')) flags.push(bi(`${st.openType}: the open has not been revisited, the strongest opening type`, `${OPEN_TYPE_ZH[st.openType]}：未回到开盘价，最强的开盘类型`))
  if (st.rvol && st.rvol.value >= 1.5) flags.push(bi(`Heavy volume: ${st.rvol.value.toFixed(2)}× the usual for this time of day`, `放量：成交量为同时段常态的 ${st.rvol.value.toFixed(2)} 倍`))
  if (st.rvol && st.rvol.value <= 0.7) flags.push(bi(`Light volume: ${st.rvol.value.toFixed(2)}× the usual for this time of day; moves are less trustworthy`, `缩量：成交量仅为同时段常态的 ${st.rvol.value.toFixed(2)} 倍，走势可信度较低`))
  if (br && br.narrowSide !== 0 && breadth)
    flags.push(
      bi(
        `${br.label.en[0]!.toUpperCase()}${br.label.en.slice(1)}: RSP ${sg(breadth.rspMinusSpy ?? 0)} pts vs SPY, ${breadth.sectorsUp}/${breadth.sectors.length} sectors up${BROAD.has(sym) && sign(score) === br.narrowSide ? '; the index move is discounted' : ''}`,
        `${br.label.zh}：RSP 相对 SPY ${sg(breadth.rspMinusSpy ?? 0)} 个百分点，${breadth.sectors.length} 个板块中 ${breadth.sectorsUp} 个上涨${BROAD.has(sym) && sign(score) === br.narrowSide ? '；指数涨跌的可信度打折' : ''}`,
      ),
    )
  if (breadth?.vix) {
    const { last: vl, changePct: vc, vsOpenPct: vo } = breadth.vix
    if (Math.abs(vc) >= 5) flags.push(bi(`VIX ${pctTxt(vc, 1)} to ${vl.toFixed(2)}`, `VIX ${pctTxt(vc, 1)} 至 ${vl.toFixed(2)}`))
    else if (vo !== undefined && Math.abs(vo) >= 5)
      flags.push(bi(`VIX ${pctTxt(vo, 1)} since the open to ${vl.toFixed(2)}: ${vo > 0 ? 'fear building intraday' : 'fear easing intraday'}`, `VIX 较开盘 ${pctTxt(vo, 1)} 至 ${vl.toFixed(2)}：${vo > 0 ? '日内避险情绪升温' : '日内避险情绪消退'}`))
  }
  if (v) {
    const sd = v.upper1 - v.value
    const z = sd > 0 ? (st.regPrice - v.value) / sd : 0
    if (Math.abs(z) >= 2) flags.push(bi(`Stretched: ${Math.abs(z).toFixed(1)}σ ${z > 0 ? 'above' : 'below'} VWAP`, `偏离过大：位于 VWAP ${z > 0 ? '上方' : '下方'} ${Math.abs(z).toFixed(1)}σ`))
  }
  if (o) {
    if (fin(o.gammaFlip))
      flags.push(
        price >= o.gammaFlip
          ? bi(`Above the gamma flip ${f(o.gammaFlip)}: dealers long gamma, moves tend to be damped`, `位于伽马翻转点（gamma flip）${f(o.gammaFlip)} 上方：做市商正伽马，波动倾向被抑制`)
          : bi(`Below the gamma flip ${f(o.gammaFlip)}: dealers short gamma, moves can extend`, `位于伽马翻转点（gamma flip）${f(o.gammaFlip)} 下方：做市商负伽马，波动容易被放大`),
      )
    const near = (lvl: number) => Math.abs((price / lvl - 1) * 100) <= nearPct(o)
    if (fin(o.callWall) && near(o.callWall)) flags.push(bi(`At the call wall ${f(o.callWall)}: resistance from dealer hedging`, `接近看涨墙（call wall）${f(o.callWall)}：做市商对冲形成阻力`))
    if (fin(o.putWall) && near(o.putWall)) flags.push(bi(`At the put wall ${f(o.putWall)}: support from dealer hedging`, `接近看跌墙（put wall）${f(o.putWall)}：做市商对冲形成支撑`))
    if (o.todayMove && o.todayMove.pct > 0) {
      const used = (Math.abs(price / pc - 1) * 100) / o.todayMove.pct
      if (used >= 0.8)
        flags.push(
          bi(`${(used * 100).toFixed(0)}% of today's straddle-implied move (±${o.todayMove.pct.toFixed(2)}%) is already done`, `今日跨式组合隐含波幅（±${o.todayMove.pct.toFixed(2)}%）已走完 ${(used * 100).toFixed(0)}%`),
        )
    }
  }
  if (or30?.complete && or30.widthVsAtr !== undefined) {
    if (or30.widthVsAtr < 0.25) flags.push(bi(`Tight 30-min range (${or30.widthVsAtr.toFixed(2)} ATR): room for a breakout`, `30 分钟开盘区间很窄（${or30.widthVsAtr.toFixed(2)} 个 ATR）：有突破空间`))
    else if (or30.widthVsAtr > 0.6) flags.push(bi(`Wide 30-min range (${or30.widthVsAtr.toFixed(2)} ATR): much of the day's range may be in`, `30 分钟开盘区间很宽（${or30.widthVsAtr.toFixed(2)} 个 ATR）：当日波幅可能已大半走完`))
  }
  if (study && study.n >= 8 && Math.abs(study.closeAboveNow - study.baseline.closeAboveNow) >= 15)
    flags.push(
      bi(
        `Sessions like this one (${study.matchedOn.en}) closed above the ${study.at} price ${study.closeAboveNow.toFixed(0)}% of the time vs ${study.baseline.closeAboveNow.toFixed(0)}% overall (n=${study.n})`,
        `与今天相似的交易日（${study.matchedOn.zh}）收盘高于 ${study.at} 价格的比例为 ${study.closeAboveNow.toFixed(0)}%，全部交易日为 ${study.baseline.closeAboveNow.toFixed(0)}%（n=${study.n}）`,
      ),
    )

  // ---- notes
  const notes: Text[] = [
    bi(
      'Breadth comes from the 11 sector ETFs and RSP vs SPY: no NYSE TICK or advance/decline (ADD) feed is available.',
      '市场广度来自 11 只板块 ETF 及 RSP 相对 SPY 的强弱：没有 NYSE TICK 或涨跌家数（ADD）数据源。',
    ),
    bi('Bars: CNBC real-time 1-minute bars today, 5-minute bars for past sessions; New York time. VWAP and the ranges use the regular session from 09:30.', 'K 线：今日为 CNBC 实时 1 分钟线，历史为 5 分钟线；均为美东时间。VWAP 与开盘区间只用 09:30 起的常规时段。'),
  ]
  if (!profile.length) notes.push(bi('No full past sessions in the 5-minute history: no relative volume.', '5 分钟历史中没有完整交易日：无法计算相对成交量。'))
  if (phase === 'pre-market') notes.push(bi('Before the open the gap is indicated from the latest pre-market print.', '开盘前的跳空按最新盘前成交价估算。'))

  return {
    symbol: sym,
    phase,
    sessionDate: data.sessionDate,
    asOf,
    minutesSinceOpen: Math.round(st.elapsed),
    price: roundPrice(price),
    open: st.open,
    changePct,
    gap: st.gap,
    premarket: st.premarket,
    ranges: st.ranges,
    vwap: v,
    rvol: st.rvol,
    openType: st.openType,
    breadth,
    options: o,
    study,
    score,
    bias,
    confidence,
    verdict,
    readings,
    flags,
    scenarios,
    levels,
    timeline,
    notes,
    errors: [],
  }
}

/** The session's summary for the archive. Needs bars through 15:55 (so early-close days are skipped). */
export function summarizeDay(data: IntradayData): DaySummary | undefined {
  const reg = data.bars.filter(b => b.date === data.sessionDate && b.v > 0 && isRegular(b))
  if (!reg.length || minuteOf(reg[0]!) > OPEN + 4 || minuteOf(last(reg)!) < 955) return undefined
  const ib = reg.filter(b => minuteOf(b) < IB_END)
  const or30 = reg.filter(b => minuteOf(b) < OR_END)
  const at = (m: number) => {
    const before = reg.filter(b => minuteOf(b) < m)
    const price = last(before)!.c

    return { price, vwap: vwapOf(before, price)!.value, or30High: hi(or30), or30Low: lo(or30) }
  }

  return {
    date: data.sessionDate,
    symbol: data.symbol,
    prevClose: data.prev.close,
    open: reg[0]!.o,
    high: hi(reg),
    low: lo(reg),
    close: last(reg)!.c,
    ibHigh: hi(ib),
    ibLow: lo(ib),
    at: { '10:00': at(OR_END), '10:30': at(IB_END) },
  }
}

// ---------------------------------------------------------------- markdown

const en = (t: Text | string | number | undefined) => (t === undefined ? '' : typeof t === 'object' ? t.en : String(t))
const cell = (s: string) => s.replace(/\|/g, '\\|')

/** Readings and notes about the whole market (breadth, leadership, VIX, the data sources): the same in every ticker's read. */
const SHARED_READINGS = new Set(['Breadth', 'Leadership (pts vs SPY)', 'VIX'])
const isSharedNote = (n: Text) => n.en.startsWith('Breadth comes from') || n.en.startsWith('Bars: CNBC')
const readingLine = (r: Reading) => `- ${en(r.name)}: ${typeof r.value === 'number' ? +r.value.toFixed(4) : en(r.value)}${r.note && r.note.en ? ` (${r.note.en})` : ''}`

/** `shared: false` leaves out the market-wide readings and notes, for a read printed next to another that carries them. */
export function intradayMarkdown(read: IntradayRead, opts: { shared?: boolean } = {}): string {
  const shared = opts.shared !== false
  const f = fmtPrice
  const vs = (p: number) => `${sg((p / read.price - 1) * 100, 2)}%`
  const out: string[] = [
    `# ${read.symbol} intraday — ${read.bias}, score ${sg(read.score, 0)} (confidence ${read.confidence.toFixed(2)}), ${read.phase}, ${read.asOf}`,
    `Price ${f(read.price)} (${pctTxt(read.changePct)} vs prior close)${read.open !== undefined ? ` · open ${f(read.open)}` : ''} · ${read.minutesSinceOpen >= 0 ? `${Math.min(read.minutesSinceOpen, 390)} min since the open` : `${-read.minutesSinceOpen} min to the open`} · open type ${read.openType}`,
    `**${en(read.verdict)}**`,
    read.readings
      .filter(r => shared || !SHARED_READINGS.has(r.name.en))
      .map(readingLine)
      .join('\n'),
  ]
  if (read.flags.length) out.push(read.flags.map(x => `- ⚑ ${x.en}`).join('\n'))
  if (read.levels.length)
    out.push(`Levels (highest first):\n\n| Level | Price | vs price |\n|---|---|---|\n${read.levels.map(l => `| ${cell(l.label.en)} | ${f(l.price)} | ${vs(l.price)} |`).join('\n')}`)
  out.push(
    `Scenarios for the rest of the session:\n\n| Case | Trigger | Target | Invalidation |\n|---|---|---|---|\n${read.scenarios
      .map(s => `| ${s.label.en} | ${cell(s.trigger.en)} | ${s.target !== undefined ? f(s.target) : '—'} | ${cell(s.invalidation.en)} |`)
      .join('\n')}`,
  )
  if (read.timeline.length)
    out.push(
      `First-hour timeline (bar-based read at each checkpoint, without breadth or the study):\n\n| Time | Price | vs open | vs VWAP | Score | Bias | Read |\n|---|---|---|---|---|---|---|\n${read.timeline
        .map(c => `| ${c.time} | ${f(c.price)} | ${pctTxt(c.vsOpenPct)} | ${c.vsVwapPct !== undefined ? pctTxt(c.vsVwapPct) : '—'} | ${sg(c.score, 0)} | ${c.bias} | ${cell(c.note.en)} |`)
        .join('\n')}`,
    )
  const s = read.study
  if (s)
    out.push(
      `Session study at ${s.at} — matched on ${s.matchedOn.en}: n=${s.n} of ${s.baseline.n}. Closed above the open ${s.closeAboveOpen}%, above the ${s.at} price ${s.closeAboveNow}% (baseline ${s.baseline.closeAboveNow}%), ` +
        `extended above the IB high ${s.extendedHigh}%, below the IB low ${s.extendedLow}%; rest of day mean ${pctTxt(s.meanRestOfDay)} / median ${pctTxt(s.medianRestOfDay)} (baseline mean ${pctTxt(s.baseline.meanRestOfDay)}).` +
        `${s.dates.length ? ` Dates: ${s.dates.slice(0, 12).join(', ')}${s.dates.length > 12 ? ', …' : ''}.` : ''} ${s.note.en}`,
    )
  else out.push('Session study: from 09:45 during the regular session.')
  out.push(...read.notes.filter(n => shared || !isSharedNote(n)).map(n => `⚠ ${n.en}`))
  out.push(read.errors.length ? `Data gaps: ${read.errors.join('; ')}` : 'All sources answered.')

  return out.join('\n\n')
}

// ---------------------------------------------------------------- two indexes side by side

/** The nearest level above and below the price, for a compact row. */
export function nearestLevels(read: IntradayRead): { above?: IntradayLevel; below?: IntradayLevel } {
  const above = read.levels.filter(l => l.price > read.price).sort((a, b) => a.price - b.price)[0]
  const below = read.levels.filter(l => l.price < read.price).sort((a, b) => b.price - a.price)[0]

  return { above, below }
}

/** How two intraday leans relate, and which index is moving more. */
export function intradayAgreement(a: IntradayRead, b: IntradayRead): Text {
  const side = (s: number) => (s >= 15 ? 1 : s <= -15 ? -1 : 0)
  const spread = b.changePct - a.changePct
  const lead = Math.abs(spread) < 0.25 ? undefined : spread > 0 ? b.symbol : a.symbol
  const leadText = lead
    ? bi(` ${lead} is the stronger index today (${b.symbol} − ${a.symbol} ${sg(spread, 2)} pts).`, `今天 ${lead} 更强（${b.symbol} − ${a.symbol} ${sg(spread, 2)} 个百分点）。`)
    : bi(` They move together (${b.symbol} − ${a.symbol} ${sg(spread, 2)} pts).`, `两者同步（${b.symbol} − ${a.symbol} ${sg(spread, 2)} 个百分点）。`)
  const sa = side(a.score)
  const sb = side(b.score)
  let lean: Text
  if (sa === 0 && sb === 0) lean = bi('Both leans are neutral.', '两者的倾向都是中性。')
  else if (sa === sb) lean = sa > 0 ? bi('Both lean up for the rest of the day.', '两者在剩余时段都偏多。') : bi('Both lean down for the rest of the day.', '两者在剩余时段都偏空。')
  else
    lean = bi(
      `The leans differ: ${a.symbol} ${a.bias} (${sg(a.score, 0)}), ${b.symbol} ${b.bias} (${sg(b.score, 0)}): a split tape, so trust neither index's breakout alone.`,
      `两者倾向不同：${a.symbol} ${biasText(a.bias).zh}（${sg(a.score, 0)}），${b.symbol} ${biasText(b.bias).zh}（${sg(b.score, 0)}）：走势分化，单一指数的突破都不要轻信。`,
    )

  return bi(lean.en + leadText.en, lean.zh + leadText.zh)
}

/** SPY and QQQ (or ES and NQ) read side by side: a comparison table, the market-wide context once, then each read without it. */
export function marketIntradayMarkdown(reads: IntradayRead[]): string {
  if (reads.length === 0) return 'No intraday reads.'
  if (reads.length === 1) return intradayMarkdown(reads[0]!)
  const [a, b] = reads as [IntradayRead, IntradayRead]
  const f = fmtPrice
  const col = (fn: (r: IntradayRead) => string) => `${cell(fn(a))} | ${cell(fn(b))}`
  const range = (r: IntradayRead, minutes: 30 | 60) => {
    const x = r.ranges.find(y => y.minutes === minutes)

    return x ? `${f(x.low)}–${f(x.high)} (${x.status})` : '—'
  }
  const level = (l?: IntradayLevel) => (l ? `${f(l.price)} ${l.label.en}` : '—')
  const rows: [string, string][] = [
    ['Price', col(r => `${f(r.price)} (${pctTxt(r.changePct)})`)],
    ['Phase', col(r => `${r.phase}, ${r.minutesSinceOpen >= 0 ? `${Math.min(r.minutesSinceOpen, 390)} min in` : `${-r.minutesSinceOpen} min to the open`}`)],
    ['Gap', col(r => `${pctTxt(r.gap.pct)}${r.gap.vsAtr !== undefined ? ` (${r.gap.vsAtr.toFixed(2)}× ATR)` : ''}${r.gap.direction === 'flat' ? '' : r.gap.filled ? ', filled' : ', open'}`)],
    ['Open type', col(r => r.openType)],
    ['vs VWAP', col(r => (r.vwap ? `${pctTxt(r.vwap.vsPct)} (VWAP ${f(r.vwap.value)})` : '—'))],
    ['30-min range', col(r => range(r, 30))],
    ['First hour (IB)', col(r => range(r, 60))],
    ['Relative volume', col(r => (r.rvol ? `${r.rvol.value.toFixed(2)}×` : '—'))],
    ['Lean, rest of day', col(r => `${r.bias} ${sg(r.score, 0)} (conf ${r.confidence.toFixed(2)})`)],
    ['Sessions like today', col(r => (r.study ? `${r.study.closeAboveNow.toFixed(0)}% closed higher vs ${r.study.baseline.closeAboveNow.toFixed(0)}% (n ${r.study.n})` : '—'))],
    ['Nearest level above', col(r => level(nearestLevels(r).above))],
    ['Nearest level below', col(r => level(nearestLevels(r).below))],
  ]
  const shared = a.readings.filter(r => SHARED_READINGS.has(r.name.en))

  return [
    `# Market intraday — ${a.symbol} and ${b.symbol}, ${a.asOf}`,
    `| | ${a.symbol} | ${b.symbol} |\n|---|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}`,
    `**${intradayAgreement(a, b).en}**`,
    shared.length ? `Market-wide (both reads):\n${shared.map(readingLine).join('\n')}` : '',
    ...a.notes.filter(isSharedNote).map(n => `⚠ ${n.en}`),
    `---\n\n${intradayMarkdown(a, { shared: false })}`,
    `---\n\n${intradayMarkdown(b, { shared: false })}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ---------------------------------------------------------------- everything for one ticker

export async function buildIntraday(
  fetch: Fetch,
  symbol: string,
  opts: { breadth?: Breadth; options?: OptionsContext; daily?: { supports: number[]; resistances: number[] }; archive?: DaySummary[]; now?: number } = {},
): Promise<IntradayRead> {
  const errors: string[] = []
  const [data, breadth] = await Promise.all([
    loadIntraday(fetch, symbol, { now: opts.now }),
    opts.breadth
      ? Promise.resolve(opts.breadth)
      : loadBreadth(fetch).catch((e: unknown) => {
          errors.push(`breadth: ${errMsg(e)}`)

          return undefined
        }),
  ])
  const read = analyzeIntraday(data, { ...opts, breadth })
  read.errors.push(...errors)

  return read
}
