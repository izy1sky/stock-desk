import type { HttpInit, HttpResponse } from 'claude-code'

import { econTier } from './events'

import type {
  AssetClass,
  Bar,
  Calendar,
  EarningsRow,
  EconEvent,
  NewsItem,
  Quote,
  Summary,
  TickerData,
} from '../types'

// Nasdaq's public JSON API: free, no key, quotes delayed ~15 minutes.
// Yahoo's endpoints answer 429 to scripted requests, so they are not used.
export type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

const API = 'https://api.nasdaq.com/api'
const HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
}

// Words in a headline that often mean trouble rather than routine coverage.
const INCIDENT_WORDS =
  /\b(lawsuit|sued|probe|investigation|subpoena|SEC|DOJ|FTC|antitrust|recall|downgrade[sd]?|cuts? (guidance|outlook|forecast)|warns?|misses?|plunges?|tumbles?|sinks?|halt(ed)?|outage|breach|hack(ed)?|strike|layoffs?|fraud|bankrupt|default|delist|tariffs?|ban(ned)?)\b/i

async function getJson(fetch: Fetch, url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  return JSON.parse(res.text)
}

/** "$1,234.50" → 1234.5; "N/A" → undefined */
export function num(text: unknown): number | undefined {
  if (typeof text === 'number') return text
  if (typeof text !== 'string') return undefined
  const n = Number(text.replace(/[$,%\s]/g, ''))

  return Number.isFinite(n) && text.trim() !== '' ? n : undefined
}

/** "10/30/2026" → "2026-10-30" */
function isoDate(us: string): string {
  const [m, d, y] = us.split('/')

  return `${y}-${m?.padStart(2, '0')}-${d?.padStart(2, '0')}`
}

const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** "Aug 10, 2026" → "2026-08-10"; anything else → undefined */
export function longDate(text: string | undefined): string | undefined {
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(text?.trim() ?? '')
  const month = m ? MONTH_INDEX[m[1]!.toLowerCase()] : undefined
  if (!m || !month) return undefined

  return `${m[3]}-${String(month).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
}

/** Today's date in New York, where the market keeps its calendar. */
export function marketToday(now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now)
  } catch {
    return new Date(now.getTime() - 5 * 3600_000).toISOString().slice(0, 10)
  }
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)

  return d.toISOString().slice(0, 10)
}

export function isWeekday(iso: string): boolean {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay()

  return day !== 0 && day !== 6
}

function nextWeekdays(from: string, count: number): string[] {
  const out: string[] = []
  for (let d = from; out.length < count; d = addDays(d, 1)) if (isWeekday(d)) out.push(d)

  return out
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))

  return out
}

export function parseQuote(data: any): { name: string; quote: Quote } | undefined {
  const p = data?.primaryData
  const price = num(p?.lastSalePrice)
  if (!p || price === undefined) return undefined
  const s = data.secondaryData
  const extPrice = num(s?.lastSalePrice)

  return {
    name: String(data.companyName ?? data.symbol).replace(/ (Common Stock|Class A Common Stock|Common Shares)$/i, ''),
    quote: {
      price,
      change: num(p.netChange) ?? 0,
      changePct: num(p.percentageChange) ?? 0,
      volume: num(p.volume) ?? 0,
      asOf: String(p.lastTradeTimestamp ?? ''),
      marketStatus: String(data.marketStatus ?? ''),
      extended:
        extPrice === undefined
          ? undefined
          : { label: String(s.lastTradeTimestamp ?? 'Extended hours'), price: extPrice, changePct: num(s.percentageChange) ?? 0 },
    },
  }
}

export function parseBars(data: any): Bar[] {
  const rows: any[] = data?.tradesTable?.rows ?? []
  const bars: Bar[] = []
  for (const r of rows) {
    const o = num(r.open)
    const h = num(r.high)
    const l = num(r.low)
    const c = num(r.close)
    if (o === undefined || h === undefined || l === undefined || c === undefined) continue
    bars.push({ t: isoDate(r.date), o, h, l, c, v: num(r.volume) ?? 0 })
  }

  return bars.sort((a, b) => (a.t < b.t ? -1 : 1))
}

export function parseSummary(data: any): Summary {
  const s = data?.summaryData ?? {}
  const v = (key: string) => s[key]?.value as string | undefined

  return {
    sector: v('Sector'),
    industry: v('Industry'),
    marketCap: num(v('MarketCap')),
    avgVolume: num(v('AverageVolume')),
    target1y: num(v('OneYrTarget')),
    dividendYield: v('Yield'),
    exDividend: longDate(v('ExDividendDate')),
    dividendPay: longDate(v('DividendPaymentDate')),
  }
}

export function parseNews(data: any): NewsItem[] {
  const rows: any[] = data?.rows ?? []

  return rows.slice(0, 10).map(r => ({
    title: String(r.title ?? ''),
    publisher: String(r.publisher ?? ''),
    ago: String(r.ago ?? r.created ?? ''),
    url: String(r.url ?? '').startsWith('http') ? String(r.url) : `https://www.nasdaq.com${r.url ?? ''}`,
  }))
}

export function isIncident(title: string): boolean {
  return INCIDENT_WORDS.test(title)
}

/** Quote, two years of daily candles, key stats and headlines for one ticker. */
export async function loadTicker(fetch: Fetch, symbol: string, known?: AssetClass): Promise<TickerData> {
  const sym = symbol.toUpperCase()
  let assetClass: AssetClass = known ?? 'stocks'
  let info: { name: string; quote: Quote } | undefined
  for (const cls of known ? [known] : (['stocks', 'etf'] as const)) {
    info = parseQuote((await getJson(fetch, `${API}/quote/${sym}/info?assetclass=${cls}`)).data)
    if (info) {
      assetClass = cls
      break
    }
  }
  if (!info) return { symbol: sym, name: sym, assetClass, bars: [], summary: {}, news: [], fetchedAt: Date.now(), error: `No quote found for ${sym}` }

  const today = marketToday()
  const [hist, summary, news] = await Promise.all([
    getJson(fetch, `${API}/quote/${sym}/historical?assetclass=${assetClass}&fromdate=${addDays(today, -730)}&todate=${today}&limit=600`),
    getJson(fetch, `${API}/quote/${sym}/summary?assetclass=${assetClass}`).catch(() => undefined),
    getJson(fetch, `https://www.nasdaq.com/api/news/topic/articlebysymbol?q=${sym.toLowerCase()}|${assetClass}&offset=0&limit=10`).catch(() => undefined),
  ])

  return {
    symbol: sym,
    name: info.name,
    assetClass,
    quote: info.quote,
    bars: parseBars(hist?.data),
    summary: parseSummary(summary?.data),
    news: parseNews(news?.data),
    fetchedAt: Date.now(),
  }
}

export function parseEarnings(date: string, data: any): EarningsRow[] {
  const rows: any[] = data?.rows ?? []

  return rows.map(r => ({
    date,
    symbol: String(r.symbol ?? '').toUpperCase(),
    name: String(r.name ?? ''),
    time: String(r.time ?? '').replace(/^time-/, ''),
    epsForecast: String(r.epsForecast ?? ''),
    lastYearEPS: String(r.lastYearEPS ?? ''),
    quarter: String(r.fiscalQuarterEnding ?? ''),
    marketCap: num(r.marketCap) ?? 0,
  }))
}

export function parseEcon(date: string, data: any): EconEvent[] {
  const rows: any[] = data?.rows ?? []
  const seen = new Set<string>()
  const clean = (s: unknown) => String(s ?? '').replace(/&nbsp;/g, '').trim()
  const out: EconEvent[] = []
  for (const r of rows) {
    if (r.country !== 'United States') continue
    const name = clean(r.eventName)
    const key = `${r.gmt}|${name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      date,
      time: clean(r.gmt),
      name,
      consensus: clean(r.consensus),
      previous: clean(r.previous),
      actual: clean(r.actual),
      tier: econTier(name),
    })
  }

  return out
}

/** Earnings and US economic events for the next 20 trading days (four weeks). */
export async function loadCalendar(fetch: Fetch, today = marketToday()): Promise<Calendar> {
  const earningDays = nextWeekdays(today, 20)
  const econDays = nextWeekdays(today, 20)

  const earnings: Record<string, EarningsRow[]> = {}
  await inBatches(earningDays, 5, async date => {
    const json = await getJson(fetch, `${API}/calendar/earnings?date=${date}`).catch(() => undefined)
    earnings[date] = parseEarnings(date, json?.data)
  })

  // Nasdaq files each economic event one day late: events of day D come back
  // for date=D+1 (checked against ADP, jobless claims and payrolls).
  const econ = (
    await inBatches(econDays, 5, async date => {
      const json = await getJson(fetch, `${API}/calendar/economicevents?date=${addDays(date, 1)}`).catch(() => undefined)

      return parseEcon(date, json?.data)
    })
  ).flat()

  return { earnings, econ, fetchedAt: Date.now() }
}
