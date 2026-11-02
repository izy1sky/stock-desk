import type { CalCategory, Calendar, EconEvent, MyEvent, TickerData } from '../types'

export type CalEvent = {
  date: string
  /** ET, "08:30"; absent for all-day events. */
  time?: string
  category: CalCategory
  title: string
  detail?: string
  importance: 1 | 2 | 3
  /** Set on events the person or Claude added, so they can be removed. */
  myId?: string
}

export const CATEGORY: Record<CalCategory, { label: string; color: string }> = {
  watchlist: { label: 'Your stocks', color: '#22c55e' },
  'big-earnings': { label: 'Big earnings', color: '#f59e0b' },
  economy: { label: 'Economy', color: '#0ea5e9' },
  fed: { label: 'Fed', color: '#a855f7' },
  politics: { label: 'Politics', color: '#ef4444' },
  market: { label: 'Market', color: '#64748b' },
  mine: { label: 'Mine', color: '#ec4899' },
}

// Releases that move the whole market (3) or are worth knowing (2).
const TIER_3 = /^(core )?cpi\b|^(core )?ppi\b|pce price index|^nonfarm payrolls$|^unemployment rate$|^gdp\b|fed interest rate decision|fomc statement|fomc press conference/i
const TIER_2 = /ism (manufacturing|non-manufacturing) pmi|^(core )?retail sales|^initial jobless claims$|jolts job openings|adp nonfarm|michigan consumer sentiment$|consumer confidence$|^durable goods orders|fomc meeting minutes|fed chair|^average hourly earnings|^private nonfarm payrolls$/i

// Index levels and unadjusted series repeat a headline release: leave them out.
const REPEATS = /\bindex\b(?! of)|n\.s\.a|, s\.a|ex\. food\/energy\/transport/i

export function econTier(name: string): 0 | 2 | 3 {
  if (REPEATS.test(name) && !/pce price index/i.test(name)) return 0

  return TIER_3.test(name) ? 3 : TIER_2.test(name) ? 2 : 0
}

// The Fed's published 2026 schedule: the second day of each meeting, when the
// decision comes out at 2:00 pm ET and the chair holds a press conference.
const FOMC_DECISIONS = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09']

// ---------- dates ----------

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay()

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)

  return d.toISOString().slice(0, 10)
}

/** The `n`th given weekday (0 Sunday … 6 Saturday) of a month; `n` −1 is the last. */
function nthWeekday(year: number, month: number, day: number, n: number): string {
  if (n < 0) {
    const last = new Date(Date.UTC(year, month, 0, 12))
    const back = (last.getUTCDay() - day + 7) % 7

    return iso(year, month, last.getUTCDate() - back)
  }
  const first = new Date(Date.UTC(year, month - 1, 1, 12)).getUTCDay()

  return iso(year, month, 1 + ((day - first + 7) % 7) + (n - 1) * 7)
}

/** Easter Sunday (anonymous Gregorian algorithm). */
function easter(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1

  return iso(year, month, day)
}

/** A fixed-date holiday moved off the weekend: Saturday to Friday, Sunday to Monday. */
function observed(date: string): string {
  const w = weekday(date)

  return w === 6 ? shift(date, -1) : w === 0 ? shift(date, 1) : date
}

/** NYSE full closures and 1:00 pm early closes for one year, from the exchange's rules. */
export function marketHolidays(year: number): CalEvent[] {
  const closed = (date: string, name: string): CalEvent => ({ date, category: 'market', title: `Market closed: ${name}`, importance: 2 })
  const early = (date: string, name: string): CalEvent => ({ date, time: '13:00', category: 'market', title: `Early close (1:00 pm ET): ${name}`, importance: 1 })
  const out: CalEvent[] = []
  const newYear = iso(year, 1, 1)
  // NYSE does not close on Friday Dec 31 when New Year's Day is a Saturday.
  if (weekday(newYear) !== 6) out.push(closed(observed(newYear), "New Year's Day"))
  out.push(closed(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day'))
  out.push(closed(nthWeekday(year, 2, 1, 3), "Presidents' Day"))
  out.push(closed(shift(easter(year), -2), 'Good Friday'))
  out.push(closed(nthWeekday(year, 5, 1, -1), 'Memorial Day'))
  out.push(closed(observed(iso(year, 6, 19)), 'Juneteenth'))
  const july4 = observed(iso(year, 7, 4))
  out.push(closed(july4, 'Independence Day'))
  const july3 = iso(year, 7, 3)
  if (july4 === iso(year, 7, 4) && weekday(july3) >= 1 && weekday(july3) <= 4) out.push(early(july3, 'day before Independence Day'))
  out.push(closed(nthWeekday(year, 9, 1, 1), 'Labor Day'))
  const thanksgiving = nthWeekday(year, 11, 4, 4)
  out.push(closed(thanksgiving, 'Thanksgiving'))
  out.push(early(shift(thanksgiving, 1), 'day after Thanksgiving'))
  const christmas = iso(year, 12, 25)
  out.push(closed(observed(christmas), 'Christmas'))
  const eve = iso(year, 12, 24)
  if (weekday(eve) >= 1 && weekday(eve) <= 4) out.push(early(eve, 'Christmas Eve'))

  return out
}

/** Monthly options expiration (third Friday), quarterly "quad witching" in Mar/Jun/Sep/Dec. */
export function optionsExpirations(year: number): CalEvent[] {
  const out: CalEvent[] = []
  for (let month = 1; month <= 12; month++) {
    const isQuad = month % 3 === 0
    out.push({
      date: nthWeekday(year, month, 5, 3),
      category: 'market',
      title: isQuad ? 'Quad witching: quarterly options and futures expire' : 'Monthly options expiration',
      detail: isQuad ? 'Very heavy volume near the close; index rebalances often land the same day.' : 'Volume and price swings can pick up as contracts expire.',
      importance: isQuad ? 2 : 1,
    })
  }

  return out
}

/** US federal elections: the Tuesday after the first Monday of November, in even years. */
export function elections(year: number): CalEvent[] {
  if (year % 2 !== 0) return []
  const date = shift(nthWeekday(year, 11, 1, 1), 1)
  const isPresidential = year % 4 === 0

  return [
    {
      date,
      category: 'politics',
      title: isPresidential ? `US presidential election (${year})` : `US midterm elections (${year}): all House seats, a third of the Senate`,
      detail: 'Results arrive overnight and can move sectors tied to policy (energy, health care, defense, banks) and the dollar.',
      importance: 3,
    },
  ]
}

export function fedMeetings(): CalEvent[] {
  return FOMC_DECISIONS.map(date => ({
    date,
    time: '14:00',
    category: 'fed',
    title: 'Fed rate decision (FOMC), press conference at 2:30 pm',
    detail: 'The single biggest scheduled event for rates, the dollar and growth stocks.',
    importance: 3,
  }))
}

// ---------- the combined calendar ----------

/** "CPI (MoM)" and "Core CPI (YoY)" are one release: group them under "CPI". */
function econEvents(rows: EconEvent[]): CalEvent[] {
  const groups = new Map<string, EconEvent[]>()
  for (const r of rows) {
    if (r.tier === 0) continue
    const family = r.name.replace(/\s*\((MoM|YoY|QoQ)\)\s*/i, '').replace(/^Core /i, '').trim()
    const key = `${r.date}|${r.time}|${family}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }

  return [...groups.entries()].map(([key, list]) => {
    const [date, time, family] = key.split('|') as [string, string, string]
    const isFed = /fed|fomc/i.test(family)
    const parts = list.slice(0, 4).map(r => {
      const isCore = /^Core /i.test(r.name)
      const hasCore = list.some(x => /^Core /i.test(x.name))
      const variant = [isCore ? 'core' : hasCore ? 'headline' : '', /\((MoM|YoY|QoQ)\)/i.exec(r.name)?.[1] ?? ''].filter(Boolean).join(' ')
      const numbers = [r.actual && `actual ${r.actual}`, r.consensus && `forecast ${r.consensus}`, r.previous && `prev ${r.previous}`].filter(Boolean).join(', ')

      return numbers ? `${variant ? `${variant}: ` : ''}${numbers}` : ''
    })

    return {
      date,
      time: /^\d{1,2}:\d{2}$/.test(time) ? time : undefined,
      category: isFed ? 'fed' : 'economy',
      title: family,
      detail: parts.filter(Boolean).join(' · ') || undefined,
      importance: Math.max(...list.map(r => r.tier)) === 3 ? 3 : 2,
    }
  })
}

const WHEN: Record<string, string> = { 'pre-market': 'before the open', 'after-hours': 'after the close', 'not-supplied': 'time not announced' }

export function buildEvents(input: {
  today: string
  horizon: number
  calendar: Calendar
  tickers: Record<string, TickerData>
  watchlist: string[]
  mine: MyEvent[]
}): CalEvent[] {
  const { today, calendar, tickers, watchlist } = input
  const end = shift(today, input.horizon)
  const years = [Number(today.slice(0, 4)), Number(end.slice(0, 4))].filter((y, i, a) => a.indexOf(y) === i)
  const events: CalEvent[] = []

  for (const rows of Object.values(calendar.earnings)) {
    for (const r of rows) {
      const isMine = watchlist.includes(r.symbol)
      if (!isMine && r.marketCap < 200e9) continue
      events.push({
        date: r.date,
        time: r.time === 'pre-market' ? '07:00' : r.time === 'after-hours' ? '16:05' : undefined,
        category: isMine ? 'watchlist' : 'big-earnings',
        title: `${r.symbol} earnings ${WHEN[r.time] ?? ''}`.trim(),
        detail: `${r.name}${r.quarter ? `, quarter ending ${r.quarter}` : ''} · EPS forecast ${r.epsForecast || '—'} (a year ago ${r.lastYearEPS || '—'})`,
        importance: isMine ? 3 : 2,
      })
    }
  }

  for (const symbol of watchlist) {
    const s = tickers[symbol]?.summary
    if (s?.exDividend) events.push({ date: s.exDividend, category: 'watchlist', title: `${symbol} ex-dividend date`, detail: `Buy before this day to receive the dividend${s.dividendYield ? ` (yield ${s.dividendYield})` : ''}; the price usually drops by the dividend amount.`, importance: 1 })
    if (s?.dividendPay) events.push({ date: s.dividendPay, category: 'watchlist', title: `${symbol} dividend paid`, importance: 1 })
  }

  events.push(...econEvents(calendar.econ))
  for (const year of years) events.push(...marketHolidays(year), ...optionsExpirations(year), ...elections(year))
  events.push(...fedMeetings())
  for (const m of input.mine) events.push({ date: m.date, category: m.category, title: m.title, detail: m.detail, importance: m.importance, myId: m.id })

  // The economic feed also lists the Fed decision: keep one.
  const seen = new Set<string>()

  return events
    .filter(e => e.date >= today && e.date <= end)
    .filter(e => {
      const key = e.category === 'fed' && /rate decision/i.test(e.title) ? `${e.date}|fed-decision` : `${e.date}|${e.title}`
      if (seen.has(key)) return false
      seen.add(key)

      return true
    })
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.time ?? '00:00') < (b.time ?? '00:00') ? -1 : 1))
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/**
 * "2026-11-20 Nvidia GTC", "11/20 Nvidia GTC" or "Nov 20 Nvidia GTC" → a date
 * and a title; a month/day already past this year means next year.
 */
export function parseMyEvent(text: string, today: string): { date: string; title: string } | undefined {
  const t = text.trim()
  const year = Number(today.slice(0, 4))
  const pick = (m: number, d: number, y?: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
    const date = iso(y ?? year, m, d)

    return y === undefined && date < today ? iso(year + 1, m, d) : date
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(.+)$/.exec(t)
  if (m) {
    const date = pick(Number(m[2]), Number(m[3]), Number(m[1]))

    return date ? { date, title: m[4]!.trim() } : undefined
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(.+)$/.exec(t)
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined
    const date = pick(Number(m[1]), Number(m[2]), y)

    return date ? { date, title: m[4]!.trim() } : undefined
  }
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(.+)$/.exec(t)
  const month = m ? MONTHS[m[1]!.toLowerCase()] : undefined
  if (m && month) {
    const date = pick(month, Number(m[2]), m[3] ? Number(m[3]) : undefined)

    return date ? { date, title: m[4]!.trim() } : undefined
  }

  return undefined
}
