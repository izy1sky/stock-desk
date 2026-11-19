import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CalCategory, Calendar, EarningsRow, Group, Horizon, MyEvent, Portfolio, Prefs, Range, Rules, Tab, TickerData } from '../types'
import { analyze, RANGE_BARS } from './analysis'
import type { Analysis, Tone } from './analysis'
import { candleChart, MA_COLORS } from './chart'
import { isIncident, loadCalendar, loadTicker, marketToday } from './data'
import { buildEvents, CATEGORY, categoryLabel, myEventHint, parseMyEvent } from './events'
import type { CalEvent } from './events'
import { levelRows, sessionsMarkdown, statRows } from './levels'
import type { Row } from './levels'
import { betaMarkdown, buildBetaMap, buildMarket, buildOptions, buildProbabilities, buildReport, loadMarketContext, marketMarkdown, moduleLabel, optionsReportMarkdown, probabilitiesMarkdown, reportMarkdown, scoreBar } from './engine/report'
import type { MarketContext, Report } from './engine/report'
import { skewReadText } from './engine/options'
import type { SkewRead } from './engine/options'
import { fmtPrice, levelKindText } from './engine/technicals'
import { agoText, biasText, dayLabel as dayLabelIn, etTime, LANGS, pick, relativeDays, tr } from './i18n'
import type { Lang } from './i18n'
import { analyzeIntraday, buildIntraday, intradayMarkdown, levelKindTextIntraday, loadBreadth, loadIntraday, openTypeText, phaseText, rangeStatusText, summarizeDay } from './engine/intraday'
import type { Breadth, DaySummary, IntradayData, IntradayRead, OptionsContext } from './engine/intraday'
import { intradayChart } from './intraday-chart'
import { chartPage } from './page'
import { applyCommand, EMPTY_PORTFOLIO, parseCommand, RULE_LABELS, ruleText as ruleTextIn, runChecks, sizePosition, valuePortfolio } from './portfolio'

const PANE = 'stock-desk'
const CHART = 'stock-desk-chart'
const CAL = 'stock-desk-calendar'
const PORT = 'stock-desk-portfolio'
const TICKER_TTL = 5 * 60_000
const REPORT_TTL = 10 * 60_000
const MARKET_TTL = 2 * 60_000
const HORIZONS_DAYS: [number, string, string][] = [
  [5, '1 week', '1 周'],
  [10, '2 weeks', '2 周'],
  [21, '1 month', '1 个月'],
  [63, '3 months', '3 个月'],
]
const CALENDAR_TTL = 6 * 3600_000
const ALL_CATEGORIES: CalCategory[] = ['watchlist', 'big-earnings', 'economy', 'fed', 'politics', 'market', 'mine']
const DEFAULT_PREFS: Prefs = {
  watchlist: ['AAPL', 'NVDA', 'MSFT', 'SPY'],
  groups: [],
  group: '',
  selected: 'AAPL',
  range: '3M',
  bigRange: '6M',
  tab: 'analysis',
  colors: 'green-up',
  horizon: 10,
  calHorizon: 30,
  calCategories: ALL_CATEGORIES,
}
const EMPTY_CALENDAR: Calendar = { earnings: {}, econ: [], fetchedAt: 0 }

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const prefs = atom({ plugin: 'stock-desk', key: 'prefs' } as const, DEFAULT_PREFS, { shape: 'prefs-3' })
const tickers = atom({ plugin: 'stock-desk', key: 'tickers' } as const, {}, { shape: 'tickers-2' })
const calendar = atom({ plugin: 'stock-desk', key: 'calendar' } as const, EMPTY_CALENDAR, { shape: 'calendar-2' })
const myEvents = atom({ plugin: 'stock-desk', key: 'myEvents' } as const, [], { shape: 'my-events-1' })
const portfolio = atom({ plugin: 'stock-desk', key: 'portfolio' } as const, EMPTY_PORTFOLIO, { shape: 'portfolio-1' })
const sizer = atom({ plugin: 'stock-desk', key: 'sizer' } as const, '')
const busy = atom({ plugin: 'stock-desk', key: 'busy' } as const, [])
// reports-2: verdicts, readings, flags and scenario text are { en, zh } pairs.
const reports = atom({ plugin: 'stock-desk', key: 'reports' } as const, {}, { shape: 'reports-2' })
const reportErrors = atom({ plugin: 'stock-desk', key: 'reportErrors' } as const, {})
const intraday = atom({ plugin: 'stock-desk', key: 'intraday' } as const, {}, { shape: 'intraday-1' })
const intradayErrors = atom({ plugin: 'stock-desk', key: 'intradayErrors' } as const, {})

type $ = EngineInterface

// ---------- formatting ----------

const money = (n: number | undefined) => (n === undefined ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const signed = (n: number, digits = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const TONE_COLOR: Record<Tone, 'success' | 'subtle' | 'warning' | 'error'> = { good: 'success', info: 'subtle', warn: 'warning', risk: 'error' }
const TONE_MARK: Record<Tone, string> = { good: '●', info: '○', warn: '▲', risk: '■' }
const STARS = { 1: '★', 2: '★★', 3: '★★★' } as const
const HORIZONS: [Horizon, string, string][] = [
  [14, '2 weeks', '2 周'],
  [30, '1 month', '1 个月'],
  [90, '3 months', '3 个月'],
]

const langOf = (p: Prefs): Lang => p.lang ?? 'en'
const langNow = async ($: $): Promise<Lang> => langOf(await read($, prefs))

function ago(ms: number, lang: Lang = 'en'): string {
  return agoText(lang, ms)
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86_400_000)
}

function dayLabel(iso: string, lang: Lang = 'en'): string {
  return dayLabelIn(lang, iso)
}

function relative(today: string, iso: string, lang: Lang = 'en'): string {
  return relativeDays(lang, daysBetween(today, iso))
}

function nextEarnings(cal: Calendar, symbol: string): EarningsRow | undefined {
  for (const date of Object.keys(cal.earnings).sort()) {
    const row = cal.earnings[date]?.find(r => r.symbol === symbol)
    if (row) return row
  }

  return undefined
}

const upColor = (p: Prefs) => (p.colors === 'red-up' ? 'error' : 'success')
const downColor = (p: Prefs) => (p.colors === 'red-up' ? 'success' : 'error')

// ---------- loading and actions ----------

const fetcher = ($: $) => (url: string, init?: Parameters<$['http']['fetch']>[1]) => $.http.fetch(url, init)

async function setPrefs($: $, fn: (p: Prefs) => Prefs): Promise<void> {
  const next = await update($, prefs, fn)
  await $.store.set('prefs', next)
}

// A failed source is reported as "<source>: <technical detail>"; in Chinese
// only the source is named, in Chinese (the detail is an English server or
// parser message, and the English view keeps it).
const SOURCE_ZH: [RegExp, string][] = [
  [/^Options chain$/, '期权链'],
  [/^Futures quotes$/, '期货报价'],
  [/^Cash indexes$/, '现货指数'],
  [/^COT (\w+)$/, 'COT 持仓 $1'],
  [/^VIX indexes$/, 'VIX 系列指数'],
  [/^SPY report$/, 'SPY 分析'],
]

function sourceError(err: string, lang: Lang): string {
  if (lang === 'en') return err
  const i = err.indexOf(': ')
  const source = i > 0 ? err.slice(0, i) : err
  const detail = i > 0 ? err.slice(i + 2) : ''
  const hit = SOURCE_ZH.find(([re]) => re.test(source))

  return hit ? source.replace(hit[0], hit[1]) : `${source}${detail ? '（来源报错）' : ''}`
}

/** A calendar category's label in the language asked. */
function catLabel(c: CalCategory, lang: Lang): string {
  return categoryLabel(c, lang)
}

/** A portfolio rule's input label and explanation in the language asked. */
function ruleText(r: (typeof RULE_LABELS)[number], lang: Lang): { title: string; meaning: string } {
  const t = ruleTextIn(r, lang)

  return { title: tr(lang, `${t.label} (${t.unit})`, `${t.label}（${t.unit}）`), meaning: t.meaning }
}

/** Switches English ↔ 中文 for every pane; the main pane's title follows at once. */
async function switchLang($: $): Promise<void> {
  await setPrefs($, p => ({ ...p, lang: langOf(p) === 'zh' ? 'en' : 'zh' }))
  await $.ui.open({ id: PANE, title: tr(await langNow($), 'Stocks', '股票'), columns: 100 })
}

async function setMyEvents($: $, fn: (list: MyEvent[]) => MyEvent[]): Promise<void> {
  const next = await update($, myEvents, fn)
  await $.store.set('myEvents', next)
}

async function setPortfolio($: $, fn: (pf: Portfolio) => Portfolio): Promise<Portfolio> {
  const next = await update($, portfolio, fn)
  await $.store.set('portfolio', next)

  return next
}

/** The watchlist plus everything held: whose earnings and dividends the calendar shows. */
const followed = (p: Prefs, pf: Portfolio) => [...new Set([...p.watchlist, ...pf.positions.map(x => x.symbol)])]

async function refreshTicker($: $, symbol: string, force = false): Promise<void> {
  const have = (await read($, tickers))[symbol]
  if (!force && have && !have.error && Date.now() - have.fetchedAt < TICKER_TTL) return
  if ((await read($, busy)).includes(symbol)) return
  await update($, busy, list => [...list, symbol])
  try {
    const data = await loadTicker(fetcher($), symbol, have?.assetClass)
    await update($, tickers, all => ({ ...all, [symbol]: data }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const lang = await langNow($)
    const failed: TickerData = have
      ? { ...have, error: tr(lang, `Refresh failed (${message}); showing data from ${ago(have.fetchedAt, lang)}`, `刷新失败（${message}），显示的是${ago(have.fetchedAt, lang)}的数据`) }
      : { symbol, name: symbol, assetClass: 'stocks', bars: [], summary: {}, news: [], fetchedAt: Date.now(), error: tr(lang, `Could not load ${symbol}: ${message}`, `无法加载 ${symbol}：${message}`) }
    await update($, tickers, all => ({ ...all, [symbol]: failed }))
  } finally {
    await update($, busy, list => list.filter(s => s !== symbol))
  }
}

async function refreshCalendar($: $, force = false): Promise<void> {
  const have = await read($, calendar)
  if (!force && Date.now() - have.fetchedAt < CALENDAR_TTL) return
  if ((await read($, busy)).includes('#calendar')) return
  await update($, busy, list => [...list, '#calendar'])
  try {
    const cal = await loadCalendar(fetcher($))
    await update($, calendar, () => cal)
  } catch (error) {
    const lang = await langNow($)
    await update($, calendar, c => ({ ...c, error: tr(lang, 'Calendar failed: ', '日历加载失败：') + (error instanceof Error ? error.message : String(error)) }))
  } finally {
    await update($, busy, list => list.filter(s => s !== '#calendar'))
  }
}

// The market context (futures, cash, COT, VIX family) is the same for every
// ticker: one load serves every report for a couple of minutes.
let marketCache: MarketContext | undefined

async function marketContext($: $): Promise<MarketContext> {
  if (marketCache && Date.now() - marketCache.fetchedAt < MARKET_TTL) return marketCache
  marketCache = await loadMarketContext(fetcher($))

  return marketCache
}

/** Weekdays from today to `iso`: trading days to an event, holidays aside. */
function tradingDaysTo(today: string, iso: string): number {
  let n = 0
  for (let d = new Date(`${today}T12:00:00Z`); d.toISOString().slice(0, 10) < iso; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) n++
  }

  return n
}

const horizonOf = (p: Prefs) => p.horizon ?? 10

/** The stored report of a ticker (state keeps it as `StoredReport`; it is always a `Report`). */
const reportOf = async ($: $, symbol: string) => (await read($, reports))[symbol] as Report | undefined

/** Builds (or reuses, when fresh and for the same horizon) the analysis report of one ticker. */
async function refreshReport($: $, symbol: string, horizon: number, force = false): Promise<Report | undefined> {
  const have = await reportOf($, symbol)
  if (!force && have && have.horizonDays === horizon && Date.now() - have.fetchedAt < REPORT_TTL) return have
  const key = `#report:${symbol}`
  if ((await read($, busy)).includes(key)) return have
  await update($, busy, list => [...list, key])
  try {
    const earnings = nextEarnings(await read($, calendar), symbol)
    const known = (await read($, tickers))[symbol]?.assetClass
    const report = await buildReport(fetcher($), symbol, {
      horizonDays: horizon,
      assetClass: known,
      market: await marketContext($),
      earningsInDays: earnings ? tradingDaysTo(marketToday(), earnings.date) : undefined,
    })
    await update($, reports, all => ({ ...all, [symbol]: report }))
    await update($, reportErrors, all => {
      const { [symbol]: _gone, ...rest } = all

      return rest
    })

    return report
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    await update($, reportErrors, all => ({ ...all, [symbol]: text }))
    throw error
  } finally {
    await update($, busy, list => list.filter(s => s !== key))
  }
}

/** Refreshes the selected ticker's report when the Analysis tab shows it. */
async function refreshShownReport($: $, force = false): Promise<void> {
  const p = await read($, prefs)
  if (p.tab === 'analysis' && p.selected) await refreshReport($, p.selected, horizonOf(p), force).catch(() => undefined)
}

// A registered tool answers with its text as `result`; `isError` sits beside it.
// ---------- intraday ----------

/** What the intraday tab keeps per ticker: the read and the minute bars the chart draws. */
type IntradayEntry = { symbol: string; fetchedAt: number; read: IntradayRead; bars: IntradayData['bars'] }

const intradayOf = async ($: $, symbol: string) => (await read($, intraday))[symbol] as IntradayEntry | undefined

let breadthCache: Breadth | undefined
let breadthAt = 0
const optionsCache = new Map<string, { at: number; ctx?: OptionsContext }>()
const ARCHIVE_KEY = 'intradayArchive'
const ARCHIVE_DAYS = 400

/** Minutes since midnight in New York, and whether it is a weekday. */
function nyClock(now = Date.now()): { minutes: number; weekday: boolean } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date(now))
    const get = (type: string) => parts.find(x => x.type === type)?.value ?? ''
    const day = get('weekday')

    return { minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')), weekday: day !== 'Sat' && day !== 'Sun' }
  } catch {
    const d = new Date(now - 5 * 3600_000)

    return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() !== 0 && d.getUTCDay() !== 6 }
  }
}

/** How often the intraday read refreshes now: every minute in the first hour, then every 3; 5 pre-market; 15 after hours. */
function intradayCadenceMs(now = Date.now()): number | undefined {
  const { minutes, weekday } = nyClock(now)
  if (!weekday) return undefined
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 5 * 60_000
  if (minutes >= 9 * 60 + 30 && minutes < 10 * 60 + 30) return 60_000
  if (minutes >= 10 * 60 + 30 && minutes < 16 * 60) return 3 * 60_000
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 15 * 60_000

  return undefined
}

async function breadthNow($: $): Promise<Breadth | undefined> {
  if (breadthCache && Date.now() - breadthAt < 60_000) return breadthCache
  try {
    breadthCache = await loadBreadth(fetcher($))
    breadthAt = Date.now()
  } catch {
    // Breadth is context: the read goes on without it and says so.
  }

  return breadthCache
}

/** Gamma flip, walls, max pain and today's straddle move: the option chain is large, so it reloads every 10 minutes at most. */
async function optionsContext($: $, symbol: string): Promise<OptionsContext | undefined> {
  const have = optionsCache.get(symbol)
  if (have && Date.now() - have.at < 10 * 60_000) return have.ctx
  try {
    const { summary } = await buildOptions(fetcher($), symbol, marketCache?.vol)
    const m = summary.moves[0]
    const ctx: OptionsContext = {
      gammaFlip: summary.levels.gammaFlip,
      callWall: summary.levels.callWall,
      putWall: summary.levels.putWall,
      maxPain: summary.maxPainNearest?.strike,
      todayMove: m ? { expiry: m.expiry, pct: m.pct, lo: m.lo, hi: m.hi } : undefined,
    }
    optionsCache.set(symbol, { at: Date.now(), ctx })

    return ctx
  } catch {
    optionsCache.set(symbol, { at: Date.now(), ctx: undefined })

    return undefined
  }
}

async function readArchive($: $): Promise<Record<string, DaySummary[]>> {
  // The archive only adds sessions to the study: an unreadable store never blocks the read.
  try {
    const saved = (await $.store.get(ARCHIVE_KEY)) as Record<string, DaySummary[]> | undefined

    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

/** After the close, keeps the session's summary so the session study grows past what the feed keeps. */
async function archiveDay($: $, symbol: string, data: IntradayData): Promise<void> {
  const day = summarizeDay(data)
  if (!day) return
  const archive = await readArchive($)
  const list = archive[symbol] ?? []
  if (list.some(d => d.date === day.date)) return
  archive[symbol] = [...list, day].slice(-ARCHIVE_DAYS)
  await $.store.set(ARCHIVE_KEY, archive)
}

/** Toasts for the moments that change the day's read, when the person turned alerts on. */
async function intradayAlerts($: $, before: IntradayRead | undefined, now: IntradayRead): Promise<void> {
  const p = await read($, prefs)
  if (!p.intradayAlerts || !before || before.sessionDate !== now.sessionDate) return
  const lang = langOf(p)
  const L = (en: string, zh: string) => tr(lang, en, zh)
  const s = now.symbol
  const ib = (r: IntradayRead) => r.ranges.find(x => x.minutes === 60)
  const out: string[] = []
  const ibBefore = ib(before)
  const ibNow = ib(now)
  if (ibNow?.complete && !ibBefore?.complete)
    out.push(L(`${s} first hour done: range ${fmtPrice(ibNow.low)}–${fmtPrice(ibNow.high)}, ${pick('en', now.verdict)}`, `${s} 首小时结束：区间 ${fmtPrice(ibNow.low)}–${fmtPrice(ibNow.high)}，${pick('zh', now.verdict)}`))
  if (ibNow?.complete && ibBefore?.complete && ibNow.status !== ibBefore.status && (ibNow.status === 'above' || ibNow.status === 'below'))
    out.push(L(`${s} broke ${ibNow.status === 'above' ? 'above' : 'below'} the first-hour range at ${fmtPrice(now.price)}`, `${s} ${ibNow.status === 'above' ? '向上突破' : '向下跌破'}首小时区间，现价 ${fmtPrice(now.price)}`))
  if (before.vwap && now.vwap && Math.sign(before.vwap.vsPct) !== Math.sign(now.vwap.vsPct) && Math.abs(now.vwap.vsPct) >= 0.05)
    out.push(L(`${s} crossed ${now.vwap.vsPct > 0 ? 'above' : 'below'} VWAP (${fmtPrice(now.vwap.value)})`, `${s} ${now.vwap.vsPct > 0 ? '上穿' : '下穿'} VWAP（${fmtPrice(now.vwap.value)}）`))
  const flip = now.options?.gammaFlip
  if (flip !== undefined && Math.sign(before.price - flip) !== Math.sign(now.price - flip))
    out.push(L(`${s} crossed the gamma flip ${fmtPrice(flip)}: dealer hedging now ${now.price > flip ? 'damps' : 'amplifies'} moves`, `${s} 穿越伽马翻转点 ${fmtPrice(flip)}：做市商对冲现在会${now.price > flip ? '抑制' : '放大'}波动`))
  for (const text of out) await $.ui.toast(text, { timeoutMs: 12_000 })
}

/** Loads and analyses one ticker's session; keeps the read and the bars for the tab. */
async function refreshIntraday($: $, symbol: string, force = false): Promise<IntradayEntry | undefined> {
  const have = await intradayOf($, symbol)
  const cadence = intradayCadenceMs() ?? 30 * 60_000
  if (!force && have && Date.now() - have.fetchedAt < cadence - 5_000) return have
  const key = `#intraday:${symbol}`
  if ((await read($, busy)).includes(key)) return have
  await update($, busy, list => [...list, key])
  try {
    const f = fetcher($)
    const [data, breadth, options, archive] = await Promise.all([loadIntraday(f, symbol), breadthNow($), optionsContext($, symbol), readArchive($)])
    const daily = await reportOf($, symbol)
    const readNow = analyzeIntraday(data, {
      breadth,
      options,
      daily: daily ? { supports: daily.supports.map(x => x.price), resistances: daily.resistances.map(x => x.price) } : undefined,
      archive: archive[symbol],
    })
    const entry: IntradayEntry = { symbol, fetchedAt: Date.now(), read: readNow, bars: data.bars }
    await update($, intraday, all => ({ ...all, [symbol]: entry }))
    await update($, intradayErrors, all => {
      const { [symbol]: _gone, ...rest } = all

      return rest
    })
    if (readNow.phase === 'after hours' || readNow.phase === 'closed') await archiveDay($, symbol, data)
    await intradayAlerts($, have?.read, readNow)

    return entry
  } catch (error) {
    await update($, intradayErrors, all => ({ ...all, [symbol]: errorText(error) }))
    throw error
  } finally {
    await update($, busy, list => list.filter(s => s !== key))
  }
}

/** Refreshes the shown ticker when the Intraday tab is open (and, with alerts on, the tickers whose reads are kept). */
async function refreshShownIntraday($: $, force = false): Promise<void> {
  const p = await read($, prefs)
  const symbols = new Set<string>()
  if (p.tab === 'intraday' && p.selected) symbols.add(p.selected)
  if (p.intradayAlerts) for (const sym of Object.keys(await read($, intraday))) symbols.add(sym)
  await Promise.all([...symbols].map(sym => refreshIntraday($, sym, force).catch(() => undefined)))
}

const toolText = (text: string, isError = false) => (isError ? { result: text, isError: true as const } : { result: text })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function parseSymbols(text: string): string[] {
  return text
    .toUpperCase()
    .split(/[\s,;]+/)
    .map(s => s.replace(/^\$/, ''))
    .filter(s => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s))
}

const merge = (list: string[], add: string[]) => [...list, ...add.filter(s => !list.includes(s))]
const activeGroup = (p: Prefs): Group | undefined => p.groups.find(g => g.name === p.group)
/** The tickers the top row shows: the active group's, or all of them. */
const shown = (p: Prefs) => activeGroup(p)?.symbols ?? p.watchlist

/** Adds tickers to All, and to the active group when one is chosen. */
async function addSymbols($: $, text: string): Promise<string[]> {
  const symbols = parseSymbols(text)
  if (symbols.length === 0) return []
  await setPrefs($, p => ({
    ...p,
    watchlist: merge(p.watchlist, symbols),
    groups: p.groups.map(g => (g.name === p.group ? { ...g, symbols: merge(g.symbols, symbols) } : g)),
    selected: symbols[0]!,
  }))
  await Promise.all(symbols.map(s => refreshTicker($, s)))

  return symbols
}

async function select($: $, symbol: string): Promise<void> {
  await setPrefs($, p => ({ ...p, selected: symbol }))
  await refreshTicker($, symbol)
  await Promise.all([refreshShownReport($), refreshShownIntraday($)])
}

/** In a group, takes the ticker out of that group only; in All, out of everything. */
async function remove($: $, symbol: string): Promise<void> {
  await setPrefs($, p => {
    const inGroup = !!activeGroup(p)
    const next = {
      ...p,
      watchlist: inGroup ? p.watchlist : p.watchlist.filter(s => s !== symbol),
      groups: p.groups.map(g => (!inGroup || g.name === p.group ? { ...g, symbols: g.symbols.filter(s => s !== symbol) } : g)),
    }

    return { ...next, selected: p.selected === symbol ? (shown(next)[0] ?? next.watchlist[0] ?? '') : p.selected }
  })
  const p = await read($, prefs)
  if (p.selected) await refreshTicker($, p.selected)
}

async function selectGroup($: $, name: string): Promise<void> {
  await setPrefs($, p => {
    const next = { ...p, group: name }
    const list = shown(next)

    return { ...next, selected: list.includes(p.selected) || list.length === 0 ? p.selected : list[0]! }
  })
  const p = await read($, prefs)
  if (p.selected) await refreshTicker($, p.selected)
}

/** "Chips: NVDA AMD TSM" makes a group named Chips holding those tickers; "Chips" an empty one. */
async function createGroup($: $, text: string): Promise<void> {
  const [rawName = '', rest = ''] = text.includes(':') ? [text.slice(0, text.indexOf(':')), text.slice(text.indexOf(':') + 1)] : [text]
  const name = rawName.trim().slice(0, 24)
  if (!name) return
  const symbols = parseSymbols(rest)
  const p = await read($, prefs)
  if (p.groups.some(g => g.name.toLowerCase() === name.toLowerCase())) {
    await $.ui.toast(tr(langOf(p), `There is already a group named ${name}.`, `已经有名为 ${name} 的分组。`))
    return
  }
  await setPrefs($, x => ({
    ...x,
    watchlist: merge(x.watchlist, symbols),
    groups: [...x.groups, { name, symbols }],
    group: name,
    selected: symbols[0] ?? x.selected,
  }))
  await Promise.all(symbols.map(s => refreshTicker($, s)))
}

async function renameGroup($: $, text: string): Promise<void> {
  const name = text.trim().slice(0, 24)
  const p = await read($, prefs)
  if (!name || !activeGroup(p) || name === p.group) return
  if (p.groups.some(g => g.name.toLowerCase() === name.toLowerCase() && g.name !== p.group)) {
    await $.ui.toast(tr(langOf(p), `There is already a group named ${name}.`, `已经有名为 ${name} 的分组。`))
    return
  }
  await setPrefs($, x => ({ ...x, groups: x.groups.map(g => (g.name === x.group ? { ...g, name } : g)), group: name }))
}

/** Deletes the active group; its tickers stay in All. */
async function deleteGroup($: $): Promise<void> {
  await setPrefs($, p => ({ ...p, groups: p.groups.filter(g => g.name !== p.group), group: '' }))
}

async function moveGroup($: $, by: -1 | 1): Promise<void> {
  await setPrefs($, p => {
    const i = p.groups.findIndex(g => g.name === p.group)
    const j = i + by
    if (i < 0 || j < 0 || j >= p.groups.length) return p
    const groups = [...p.groups]
    ;[groups[i], groups[j]] = [groups[j]!, groups[i]!]

    return { ...p, groups }
  })
}

async function toggleMember($: $, name: string, symbol: string): Promise<void> {
  await setPrefs($, p => ({
    ...p,
    groups: p.groups.map(g => (g.name !== name ? g : { ...g, symbols: g.symbols.includes(symbol) ? g.symbols.filter(s => s !== symbol) : [...g.symbols, symbol] })),
  }))
}

async function openMain($: $): Promise<void> {
  await $.ui.open({ id: PANE, title: tr(await langNow($), 'Stocks', '股票'), columns: 100 })
  const p = await read($, prefs)
  await Promise.all([p.selected ? refreshTicker($, p.selected) : undefined, refreshCalendar($)])
  await Promise.all([refreshShownReport($), refreshShownIntraday($)])
}

async function openChart($: $): Promise<void> {
  const p = await read($, prefs)
  await $.ui.open({ id: CHART, title: tr(langOf(p), `${p.selected} chart`, `${p.selected} K 线图`), focus: true, closeOnEscape: true, columns: 220, rows: 60 })
}

async function openCalendar($: $): Promise<void> {
  await $.ui.open({ id: CAL, title: tr(await langNow($), 'Market calendar', '市场日历'), columns: 120, rows: 50 })
  const p = await read($, prefs)
  // Each stock's dividend dates come with its quote.
  await Promise.all([refreshCalendar($), ...followed(p, await read($, portfolio)).map(s => refreshTicker($, s))])
}

async function openPortfolio($: $): Promise<void> {
  await $.ui.open({ id: PORT, title: tr(await langNow($), 'My portfolio', '我的持仓'), columns: 120, rows: 50 })
  const pf = await read($, portfolio)
  await Promise.all([refreshCalendar($), ...pf.positions.map(x => refreshTicker($, x.symbol))])
}

async function enterTrade($: $, text: string): Promise<void> {
  const command = parseCommand(text)
  const lang = await langNow($)
  if (!command) {
    await $.ui.toast(tr(lang, 'Try "NVDA 50 @ 120.5 stop 110", "sell NVDA 10 @ 140" or "cash 5000".', '试试 "NVDA 50 @ 120.5 stop 110"、"sell NVDA 10 @ 140" 或 "cash 5000"。'))

    return
  }
  let message = ''
  await setPortfolio($, pf => {
    const out = applyCommand(pf, command, marketToday(), lang)
    message = out.message

    return out.pf
  })
  if (command.kind !== 'cash') await refreshTicker($, command.symbol)
  await $.ui.toast(message)
}

async function editPosition($: $, symbol: string, field: 'shares' | 'cost' | 'stop' | 'target' | 'note', value: string): Promise<void> {
  const text = value.trim().replace(/[$,]/g, '')
  const n = Number(text)
  const lang = await langNow($)
  if ((field === 'shares' || field === 'cost') && !(n > 0)) {
    await $.ui.toast(tr(lang, `${field === 'shares' ? 'Shares' : 'Average cost'} must be a number above 0.`, `${field === 'shares' ? '股数' : '平均成本'}必须是大于 0 的数字。`))

    return
  }
  if ((field === 'stop' || field === 'target') && text !== '' && !(n > 0)) {
    await $.ui.toast(tr(lang, 'Enter a price, or leave it empty to clear it.', '请输入价格，留空则清除。'))

    return
  }
  await setPortfolio($, pf => ({
    ...pf,
    positions: pf.positions.map(x => {
      if (x.symbol !== symbol) return x
      if (field === 'note') return { ...x, note: value.trim() || undefined }
      if (field === 'stop' || field === 'target') return { ...x, [field]: text === '' ? undefined : n }

      return { ...x, [field]: n }
    }),
  }))
}

async function setRule($: $, key: keyof Rules, value: string): Promise<void> {
  const n = Number(value.trim().replace(/%/g, ''))
  if (!(n > 0)) {
    await $.ui.toast(tr(await langNow($), 'Enter a number above 0.', '请输入大于 0 的数字。'))

    return
  }
  await setPortfolio($, pf => ({ ...pf, rules: { ...pf.rules, [key]: n } }))
}

/** Writes the chart as a page and opens it in the default browser, where it can go full screen. */
async function openInBrowser($: $): Promise<void> {
  const p = await read($, prefs)
  const lang = langOf(p)
  const data = (await read($, tickers))[p.selected]
  const a = data ? analyze(data.bars, p.bigRange, undefined, lang) : undefined
  if (!data || !a) {
    await $.ui.toast(tr(lang, 'No chart data yet.', '还没有图表数据。'))

    return
  }
  const from = Math.max(0, data.bars.length - RANGE_BARS[p.bigRange])
  const svg = candleChart({ bars: data.bars, from, a, width: 1500, height: 760, colors: p.colors, lang })
  const html = chartPage({ data, a, svg, levels: levelRows(a, p.bigRange, lang), stats: statRows(a, data, lang), range: p.bigRange, lang })
  const path = `/tmp/stock-desk-${data.symbol}.html`
  try {
    await $.fs.write(path, html)
    const run = await $.process.run(['open', path])
    await $.ui.toast(run.exitCode === 0 ? tr(lang, `Opened ${data.symbol} in your browser.`, `已在浏览器中打开 ${data.symbol}。`) : tr(lang, `Saved the chart to ${path}`, `图表已保存到 ${path}`))
  } catch (error) {
    await $.ui.toast(tr(lang, 'Could not open the chart: ', '无法打开图表：') + (error instanceof Error ? error.message : String(error)))
  }
}

async function addMyEvent($: $, text: string): Promise<void> {
  const parsed = parseMyEvent(text, marketToday())
  if (!parsed) {
    await $.ui.toast(myEventHint(await langNow($)))

    return
  }
  const event: MyEvent = { id: `you-${Date.now()}`, date: parsed.date, title: parsed.title, category: 'mine', importance: 2, addedBy: 'you' }
  await setMyEvents($, list => [...list, event])
}

function eventsText(events: CalEvent[], today: string): string {
  if (events.length === 0) return 'No events in that window.'

  return events
    .map(e => `${e.date} (${relative(today, e.date)})${e.time ? ` ${e.time} ET` : ''} [${CATEGORY[e.category].label}] ${STARS[e.importance]} ${e.title}${e.detail ? ` — ${e.detail}` : ''}`)
    .join('\n')
}

// ---------- the plugin ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('prefs')) as Partial<Prefs> | undefined
    if (saved && Array.isArray(saved.watchlist)) {
      const groups = Array.isArray(saved.groups) ? saved.groups : []
      await update($, prefs, () => ({ ...DEFAULT_PREFS, ...saved, groups, group: groups.some(g => g.name === saved.group) ? saved.group! : '' }))
    }
    // The pane leads with the analysis now: show it once to people who used the old Overview.
    if (!(await read($, prefs)).seenAnalysis) await setPrefs($, p => ({ ...p, tab: 'analysis', seenAnalysis: true }))
    const mine = (await $.store.get('myEvents')) as MyEvent[] | undefined
    if (Array.isArray(mine)) await update($, myEvents, () => mine)
    const savedPortfolio = (await $.store.get('portfolio')) as Partial<Portfolio> | undefined
    if (savedPortfolio && Array.isArray(savedPortfolio.positions))
      await update($, portfolio, () => ({ ...EMPTY_PORTFOLIO, ...savedPortfolio, rules: { ...EMPTY_PORTFOLIO.rules, ...savedPortfolio.rules } }))

    await $.command.register({ name: 'stocks', description: 'Open the stock pane; add tickers with /stocks TSLA AMD', argumentHint: '[TICKER ...]' })
    await $.command.register({ name: 'stock-calendar', description: 'Open the market calendar: earnings, economic data, Fed, elections, holidays' })
    await $.command.register({ name: 'portfolio', description: 'Open your portfolio: positions, profit and loss, and checks against your own rules' })
    await $.tool.register({
      name: 'portfolio_get',
      description:
        "Read the person's portfolio from the stock-desk pane: positions (shares, average cost, stop, target), current value, profit and loss, weights, their rules and the checks those rules raise. Read-only.",
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'calendar_add',
      description:
        'Put an event on the market calendar pane the person sees (stock-desk): a political event (election, debt-ceiling or government-funding deadline, major court ruling, tariff deadline), a central-bank meeting abroad, an investor day or product launch. Only add dates you have verified from a reliable source, and name the source in `detail`.',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD (US Eastern date)' },
          title: { type: 'string', description: 'Short title, e.g. "Government funding deadline"' },
          detail: { type: 'string', description: 'Why it matters for markets, and the source' },
          category: { type: 'string', enum: ['politics', 'economy', 'fed', 'market', 'watchlist', 'mine'] },
          importance: { type: 'integer', minimum: 1, maximum: 3, description: '3 moves the whole market, 2 notable, 1 minor' },
        },
        required: ['date', 'title', 'category', 'importance'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'calendar_list',
      description: 'List what the stock-desk market calendar shows for the coming days: watchlist earnings and dividends, big earnings, US economic releases, Fed meetings, elections, market holidays, options expiry and added events.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, description: 'How many days ahead (default 30)' } } },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show_tickers',
      description: 'Add tickers to the stock-desk pane the person sees and select the first one, e.g. when they ask to look at a stock.',
      inputSchema: { type: 'object', properties: { symbols: { type: 'string', description: 'Space-separated US tickers, e.g. "TSLA AMD"' } }, required: ['symbols'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'analyze_ticker',
      description:
        'Full data analysis of one US stock, ETF or index (SPX, NDX, RUT also work): trend (MA 5/10/20/50/200 stack, slopes, ADX, swing structure, weekly), volatility (realized vs implied, percentile, squeeze), volume and flow (OBV, up/down volume, distribution days), options positioning (put/call, ATM term structure, 25-delta skew, dealer gamma and the gamma flip, call/put walls, max pain, straddle-implied moves, unusual volume), index futures and COT, combined into a composite bias for the horizon, plus key levels, expected moves, bull/base/bear scenarios with model odds and a 10-year historical-analog study. Also shows the result in the stock-desk pane. Load the stock-desk analyze skill before interpreting it.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'US ticker, e.g. "NVDA", "SPY", "SOXL", "SPX"' },
          horizon_days: { type: 'integer', minimum: 1, maximum: 120, description: 'Horizon in trading days (default 10): 1-5 leans on futures/options/volume, 6-30 on trend, longer on trend more' },
        },
        required: ['symbol'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'market_overview',
      description:
        'The US market read: ES/NQ/YM/RTY futures with the cash index level they imply (pre-market too), the VIX / VIX9D / VIX3M / VVIX / SKEW term structure, CFTC COT positioning of leveraged funds, asset managers and dealers in ES and NQ, and a full SPY analysis. Use for questions about the market as a whole, the pre-market, or as context before analysing a single stock.',
      inputSchema: { type: 'object', properties: { horizon_days: { type: 'integer', minimum: 1, maximum: 120, description: 'Horizon for the SPY analysis (default 5)' } } },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'options_positioning',
      description:
        "One ticker's options market in detail, from CBOE's delayed chain with greeks: put/call by volume and open interest, ATM implied-vol term structure, 25-delta skew, dealer gamma exposure with the gamma flip, call and put walls, max pain per expiry, straddle-implied moves, largest open interest and unusual volume.",
      inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'US ticker or index, e.g. "SPY", "SPX", "NVDA"' } }, required: ['symbol'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'beta_map',
      description:
        'Where other tickers would be if a base moved to a level or by a percent, e.g. "SPX to 7500: SOXL and TQQQ?" — regression beta of daily returns with correlation and a ±1 residual-sigma band per target. An index base (SPX, NDX, DJI, RUT) is measured from its cash close.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'The base: "SPX" (default), "NDX", "SPY", "QQQ", a stock…' },
          targets: { type: 'string', description: 'Space-separated tickers, e.g. "SOXL TQQQ NVDA"' },
          base_target: { type: 'number', description: 'The base price to map, e.g. 7500' },
          base_move_pct: { type: 'number', description: 'Or the base move in percent, e.g. 2.4 (used when base_target is not given)' },
          lookback: { type: 'integer', minimum: 20, maximum: 250, description: 'Trading days of returns for the regression (default 60)' },
        },
        required: ['targets'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'intraday_read',
      description:
        "Real-time read of today's session for one US stock or ETF (also '@SP.1' / '@ND.1' futures): the gap and pre-market range, the 5/15/30-minute opening ranges and the initial balance (first hour) with breakout status, VWAP and its bands, relative volume by time of day, the opening type (open-drive, test-drive, rejection-reverse, auction), breadth and leadership from sector ETFs and equal- vs cap-weight, VIX, the options levels that matter today (gamma flip, walls, straddle move), past sessions that looked like today at the same clock time and what they did next, and a lean for the rest of the day with scenarios and every intraday level. Real-time 1-minute data. Shows it in the stock-desk pane's Intraday tab. Use for 'how is today going', the open, the first hour, or intraday levels.",
      inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'US ticker, e.g. "SPY", "QQQ", "NVDA"' } }, required: ['symbol'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'probability',
      description:
        'Model probability that a ticker closes above / below, or touches, each given price level within N trading days: zero-drift lognormal on the implied vol of the expiry nearest the horizon (realized vol when there are no options).',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'US ticker or index' },
          levels: { type: 'array', items: { type: 'number' }, description: 'Price levels, e.g. [7400, 7500]' },
          days: { type: 'integer', minimum: 1, maximum: 252, description: 'Trading days ahead' },
        },
        required: ['symbol', 'levels', 'days'],
      },
      isDeferred: false,
    })

    $.clock.after(50, () => void openMain($))
    $.clock.every(TICKER_TTL, () => {
      void read($, prefs).then(p => (p.selected ? refreshTicker($, p.selected, true) : undefined))
      void read($, portfolio).then(pf => Promise.all(pf.positions.map(x => refreshTicker($, x.symbol))))
      void refreshCalendar($)
      void refreshShownReport($)
    })
    // The intraday tab follows the session: refreshIntraday skips until its cadence (1 min in the first hour) is due.
    $.clock.every(60_000, () => {
      if (intradayCadenceMs() !== undefined) void refreshShownIntraday($)
    })

    return next(e)
  })

  on('command.run', { command: 'stocks' }, async ($, e) => {
    const added = await addSymbols($, e.args)
    await openMain($)

    return { text: added.length ? `Stock pane opened with ${added.join(', ')}.` : 'Stock pane opened.' }
  })

  on('command.run', { command: 'portfolio' }, async $ => {
    await openPortfolio($)

    return { text: 'Portfolio opened.' }
  })

  on('tool.call', { tool: 'mcp__stock-desk__portfolio_get' }, async $ => {
    const pf = await read($, portfolio)
    const all = await read($, tickers)
    const { holdings, totals, sectors } = valuePortfolio(pf, all)
    const checks = runChecks(pf, all, await read($, calendar), marketToday())
    const text = JSON.stringify(
      {
        totals,
        holdings: holdings.map(pos => ({ symbol: pos.symbol, shares: pos.shares, avgCost: pos.cost, price: pos.price, value: Math.round(pos.value), weightPct: +pos.weight.toFixed(1), pnl: Math.round(pos.pnl), pnlPct: +pos.pnlPct.toFixed(1), stop: pos.stop, target: pos.target, note: pos.note, sector: pos.sector })),
        sectors: sectors.map(([name, pct]) => ({ name, pct: +pct.toFixed(1) })),
        rules: pf.rules,
        checks: checks.map(c => c.text),
        recentTrades: pf.trades.slice(-20),
      },
      null,
      1,
    )

    return toolText(text)
  })

  on('command.run', { command: 'stock-calendar' }, async $ => {
    await openCalendar($)

    return { text: 'Market calendar opened.' }
  })

  on('tool.call', { tool: 'mcp__stock-desk__calendar_add' }, async ($, e) => {
    const args = e as unknown as { date?: string; title?: string; detail?: string; category?: string; importance?: number }
    const date = String(args.date ?? '')
    const category = (ALL_CATEGORIES as string[]).includes(String(args.category)) ? (args.category as CalCategory) : 'mine'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !args.title) return { deny: 'Give `date` as YYYY-MM-DD and a `title`.' }
    const event: MyEvent = {
      id: `claude-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      date,
      title: String(args.title),
      detail: args.detail ? String(args.detail) : undefined,
      category,
      importance: args.importance === 3 ? 3 : args.importance === 1 ? 1 : 2,
      addedBy: 'claude',
    }
    await setMyEvents($, list => [...list.filter(m => !(m.date === event.date && m.title === event.title)), event])
    await openCalendar($)

    return toolText(`Added to the calendar: ${date} ${event.title} (${CATEGORY[category].label}).`)
  })

  on('tool.call', { tool: 'mcp__stock-desk__calendar_list' }, async ($, e) => {
    const days = Math.max(1, Math.min(90, Number((e as unknown as { days?: number }).days ?? 30)))
    await refreshCalendar($)
    const p = await read($, prefs)
    const today = marketToday()
    const events = buildEvents({ today, horizon: days, calendar: await read($, calendar), tickers: await read($, tickers), watchlist: followed(p, await read($, portfolio)), mine: await read($, myEvents) })

    return toolText(eventsText(events, today))
  })

  on('tool.call', { tool: 'mcp__stock-desk__show_tickers' }, async ($, e) => {
    const added = await addSymbols($, String((e as unknown as { symbols?: string }).symbols ?? ''))
    await openMain($)

    return toolText(added.length ? `Showing ${added.join(', ')} in the stock pane.` : 'No valid tickers given.', !added.length)
  })

  on('tool.call', { tool: /^mcp__stock-desk__analyze_ticker$/ }, async ($, e) => {
    const args = e as unknown as { symbol?: string; horizon_days?: number }
    const symbol = parseSymbols(String(args.symbol ?? ''))[0]
    if (!symbol) return toolText('Give one US ticker as `symbol`.', true)
    const horizon = Math.max(1, Math.min(120, Math.round(Number(args.horizon_days ?? 10)) || 10))
    try {
      await refreshCalendar($)
      const report = await refreshReport($, symbol, horizon)
      if (!report) return toolText(`${symbol} is already being analysed; try again in a few seconds.`, true)
      await addSymbols($, symbol)
      await setPrefs($, p => ({ ...p, selected: symbol, tab: 'analysis', horizon }))
      await openMain($)

      return toolText(reportMarkdown(report))
    } catch (error) {
      return toolText(`Could not analyse ${symbol}: ${errorText(error)}`, true)
    }
  })

  on('tool.call', { tool: /^mcp__stock-desk__intraday_read$/ }, async ($, e) => {
    const symbol = String((e as unknown as { symbol?: string }).symbol ?? '').trim().toUpperCase().replace(/^\$/, '')
    if (!/^@?[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) return toolText('Give one US ticker as `symbol`, e.g. "SPY".', true)
    try {
      const entry = await refreshIntraday($, symbol, true)
      if (!entry) return toolText(`${symbol} is already loading; try again in a few seconds.`, true)
      if (!symbol.startsWith('@')) {
        await addSymbols($, symbol)
        await setPrefs($, p => ({ ...p, selected: symbol, tab: 'intraday' }))
        await openMain($)
      }

      return toolText(intradayMarkdown(entry.read))
    } catch (error) {
      return toolText(`Intraday read of ${symbol} failed: ${errorText(error)}`, true)
    }
  })

  on('tool.call', { tool: /^mcp__stock-desk__market_overview$/ }, async ($, e) => {
    const horizon = Math.max(1, Math.min(120, Math.round(Number((e as unknown as { horizon_days?: number }).horizon_days ?? 5)) || 5))
    try {
      const market = await buildMarket(fetcher($), horizon)
      marketCache = market.context
      if (market.spy) await update($, reports, all => ({ ...all, SPY: market.spy! }))

      return toolText(marketMarkdown(market))
    } catch (error) {
      return toolText(`Market overview failed: ${errorText(error)}`, true)
    }
  })

  on('tool.call', { tool: /^mcp__stock-desk__options_positioning$/ }, async ($, e) => {
    const symbol = parseSymbols(String((e as unknown as { symbol?: string }).symbol ?? ''))[0]
    if (!symbol) return toolText('Give one US ticker as `symbol`.', true)
    try {
      return toolText(optionsReportMarkdown(symbol, await buildOptions(fetcher($), symbol, marketCache?.vol)))
    } catch (error) {
      return toolText(`No options data for ${symbol}: ${errorText(error)}`, true)
    }
  })

  on('tool.call', { tool: /^mcp__stock-desk__beta_map$/ }, async ($, e) => {
    const args = e as unknown as { base?: string; targets?: string | string[]; base_target?: number; base_move_pct?: number; lookback?: number }
    const targets = parseSymbols(Array.isArray(args.targets) ? args.targets.join(' ') : String(args.targets ?? ''))
    const base = parseSymbols(String(args.base ?? 'SPX'))[0] ?? 'SPX'
    if (!targets.length) return toolText('Give the tickers to map as `targets`, e.g. "SOXL TQQQ".', true)
    if (args.base_target === undefined && args.base_move_pct === undefined) return toolText('Give `base_target` (a price) or `base_move_pct` (a percent).', true)
    try {
      return toolText(betaMarkdown(await buildBetaMap(fetcher($), { base, targets, baseTarget: args.base_target, baseMovePct: args.base_move_pct, lookback: args.lookback })))
    } catch (error) {
      return toolText(`Beta map failed: ${errorText(error)}`, true)
    }
  })

  on('tool.call', { tool: /^mcp__stock-desk__probability$/ }, async ($, e) => {
    const args = e as unknown as { symbol?: string; levels?: unknown; days?: number }
    const symbol = parseSymbols(String(args.symbol ?? ''))[0]
    const raw = Array.isArray(args.levels) ? args.levels : String(args.levels ?? '').split(/[\s,;]+/)
    const levels = raw.map(Number).filter(n => Number.isFinite(n) && n > 0)
    if (!symbol || !levels.length || !args.days) return toolText('Give `symbol`, `levels` (prices) and `days` (trading days).', true)
    try {
      return toolText(probabilitiesMarkdown(await buildProbabilities(fetcher($), { symbol, levels, days: Number(args.days) })))
    } catch (error) {
      return toolText(`Probability failed: ${errorText(error)}`, true)
    }
  })

  // ---------- the main pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Link } = t
    // Every table names every element; the surface decides what draws.
    const Input = e.surface !== 'mobile' && 'Input' in t ? t.Input : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in t ? t.Svg : undefined
    const p = await read($, prefs)
    const lang = langOf(p)
    const L = (en: string, zh: string) => tr(lang, en, zh)
    const all = await read($, tickers)
    const cal = await read($, calendar)
    const loading = await read($, busy)
    const cols = e.props.bodyColumns ?? 60
    const data = p.selected ? all[p.selected] : undefined
    const today = marketToday()
    const earnings = p.selected ? nextEarnings(cal, p.selected) : undefined
    const a: Analysis | undefined = data ? analyze(data.bars, p.range, earnings ? daysBetween(today, earnings.date) : undefined, lang) : undefined
    const newsAlerts = data?.news.filter(n => isIncident(n.title)).length ?? 0

    /** Rows whose underlined names show what they mean on hover. */
    const explained = (rows: Row[], head: [string, string, string], prefix: string) => (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box width={20}>
            <Text dimColor size="footnote">{head[0]}</Text>
          </Box>
          <Box width={13}>
            <Text dimColor size="footnote">{head[1]}</Text>
          </Box>
          <Text dimColor size="footnote">{head[2]}</Text>
        </Box>
        {rows.map((r, i) => {
          const scope = `${prefix}-${i}`

          return (
            <Box key={`${prefix}-row-${i}`} flexDirection="row">
              <Box width={20}>
                <Text underline hover={{ scope, color: 'claude' }}>
                  {r.label}
                </Text>
              </Box>
              <Box width={13}>
                <Text tabular>{r.value}</Text>
              </Box>
              <Box flexShrink={1}>
                <Text dimColor>{r.note}</Text>
              </Box>
              <Box position="absolute" top={1} left={2} display="none" hover={{ scope, display: 'flex' }} width={Math.min(64, cols - 4)} paddingX={1} backgroundColor="#1f2328" borderStyle="round" borderColor="#3b4048">
                <Text color="#f3f4f6">{r.meaning}</Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )

    const group = activeGroup(p)
    const list = shown(p)

    // Group tabs: All, each group, and the switch for the group tools.
    const groupTabs = (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {[{ name: '', label: L('All', '全部'), count: p.watchlist.length }, ...p.groups.map(g => ({ name: g.name, label: g.name, count: g.symbols.length }))].map((g, i) => (
          <Button key={i === 0 ? 'group-all' : `group-${i - 1}`} plain={p.group === g.name ? undefined : true} variant={p.group === g.name ? 'primary' : undefined} onPress={() => void selectGroup($, g.name)}>
            {g.label} <Text dimColor>{g.count}</Text>
          </Button>
        ))}
        <Button key="manage-groups" plain dimColor={p.manageGroups ? undefined : true} onPress={() => void setPrefs($, x => ({ ...x, manageGroups: !x.manageGroups }))}>
          {p.manageGroups ? L('Done', '完成') : p.groups.length ? L('⚙ Groups', '⚙ 分组') : L('+ Group', '+ 分组')}
        </Button>
      </Box>
    )

    const groupTools = p.manageGroups && (
      <Box flexDirection="column" gap={1} paddingX={1} borderStyle="round" borderColor="#3b4048">
        {Input && <Input key="new-group" placeholder={L('New group, e.g. Chips: NVDA AMD TSM', '新分组，例如 芯片: NVDA AMD TSM')} submitLabel={L('Create', '创建')} onSubmit={value => void createGroup($, value)} />}
        {group && (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {Input && <Input key="rename-group" label={L('Rename', '重命名')} value={group.name} submitLabel={L('Rename', '重命名')} onSubmit={value => void renameGroup($, value)} />}
            <Button key="group-left" plain onPress={() => void moveGroup($, -1)}>
              {L('← Move', '← 左移')}
            </Button>
            <Button key="group-right" plain onPress={() => void moveGroup($, 1)}>
              {L('Move →', '右移 →')}
            </Button>
            <Button key="delete-group" plain dimColor onPress={() => void deleteGroup($)}>
              {L(`Delete group ${group.name}`, `删除分组 ${group.name}`)}
            </Button>
          </Box>
        )}
        {p.selected && p.groups.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Text>{L(`${p.selected} is in:`, `${p.selected} 所在分组：`)}</Text>
            {p.groups.map((g, i) => {
              const isIn = g.symbols.includes(p.selected)

              return (
                <Button key={`member-${i}`} plain={isIn ? undefined : true} variant={isIn ? 'primary' : undefined} onPress={() => void toggleMember($, g.name, p.selected)}>
                  {isIn ? `✓ ${g.name}` : `+ ${g.name}`}
                </Button>
              )
            })}
          </Box>
        )}
        <Text dimColor size="footnote">
          {L(
            'A stock can be in several groups. Tickers added while a group is open go into it too. Deleting a group, or removing a stock from one, keeps the stock in All.',
            '一只股票可以属于多个分组。打开某个分组时添加的代码也会放进该分组。删除分组或从分组中移除股票，股票仍保留在“全部”里。',
          )}
        </Text>
      </Box>
    )

    const watchlist = (
      <Box flexDirection="column" gap={1}>
        {groupTabs}
        {groupTools}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {list.length === 0 && (
            <Text dimColor>
              {group
                ? L(`No stocks in ${group.name} yet. Add tickers below, or pick a stock in All and use ⚙ Groups to put it here.`, `${group.name} 里还没有股票。在下方添加代码，或在“全部”里选中一只股票，用 ⚙ 分组 放进来。`)
                : L('No stocks yet.', '还没有股票。')}
            </Text>
          )}
          {list.map(sym => {
            const q = all[sym]?.quote

            return (
              <Button key={`sym-${sym}`} variant={sym === p.selected ? 'primary' : 'secondary'} onPress={() => void select($, sym)}>
                {sym}
                {q ? <Text color={q.change >= 0 ? upColor(p) : downColor(p)}> {signed(q.changePct)}%</Text> : ''}
              </Button>
            )
          })}
        </Box>
      </Box>
    )

    const addField = Input && (
      <Input key="add" placeholder={group ? L(`Add tickers to ${group.name}, e.g. TSLA AMD`, `向 ${group.name} 添加代码，例如 TSLA AMD`) : L('Add tickers, e.g. TSLA AMD', '添加代码，例如 TSLA AMD')} submitLabel={L('Add', '添加')} onSubmit={value => void addSymbols($, value)} />
    )

    if (!p.selected || !data) {
      return (
        <Box flexDirection="column" gap={1}>
          {watchlist}
          {addField}
          <Text dimColor>{p.selected ? L(`Loading ${p.selected}…`, `正在加载 ${p.selected}…`) : L('Add a ticker to start.', '添加一个代码开始。')}</Text>
        </Box>
      )
    }

    const q = data.quote
    const isUp = (q?.change ?? a?.change ?? 0) >= 0

    const header = (
      <Box flexDirection="column">
        <Text size="heading" weight="semibold">
          {data.name} <Text dimColor>{data.symbol}{data.summary.sector ? ` · ${data.summary.sector}` : ''}</Text>
        </Text>
        {q && (
          <Text size="title" weight="bold" tabular>
            {money(q.price)} <Text color={isUp ? upColor(p) : downColor(p)}>{signed(q.change)} ({signed(q.changePct)}%)</Text>
          </Text>
        )}
        <Text dimColor size="footnote">
          {q ? `${q.asOf} · ${q.marketStatus || L('Market', '市场')} · ${L('15-min delayed', '延迟约 15 分钟')}` : ''}
          {q?.extended ? ` · ${q.extended.label}: ${money(q.extended.price)} (${signed(q.extended.changePct)}%)` : ''}
        </Text>
        {a && (
          <Text>
            <Text color={TONE_COLOR[a.trend.tone]} weight="semibold">{TONE_MARK[a.trend.tone]} {a.trend.label}</Text>
            <Text dimColor> — {a.trend.detail}</Text>
          </Text>
        )}
        {data.error && <Text color="warning">{data.error}</Text>}
      </Box>
    )

    const tabs = (
      <Box flexDirection="row" gap={1}>
        {(
          [
            ['analysis', L('Analysis', '分析')],
            ['intraday', L('Intraday', '盘中')],
            ['overview', L('Chart & levels', 'K 线与关键价位')],
            ['news', newsAlerts ? L(`News · ${newsAlerts} alert${newsAlerts === 1 ? '' : 's'}`, `新闻 · ${newsAlerts} 条提醒`) : L('News', '新闻')],
            ['calendar', L('Calendar', '日历')],
          ] as [Tab, string][]
        ).map(([tab, label]) => (
          <Button key={`tab-${tab}`} plain={p.tab === tab ? undefined : true} variant={p.tab === tab ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, tab })).then(() => Promise.all([refreshShownReport($), refreshShownIntraday($)]))}>
            {label}
          </Button>
        ))}
      </Box>
    )

    let body
    if (p.tab === 'analysis') {
      const report = await reportOf($, data.symbol)
      const failed = (await read($, reportErrors))[data.symbol]
      const working = loading.includes(`#report:${data.symbol}`)
      const horizon = horizonOf(p)
      const scoreColor = (n: number) => (n >= 15 ? upColor(p) : n <= -15 ? downColor(p) : 'subtle')
      const pct = (n: number, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`

      const horizonRow = (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Text dimColor>{L('Horizon:', '周期：')}</Text>
          {HORIZONS_DAYS.map(([days, en, zh]) => (
            <Button key={`hz-${days}`} plain={horizon === days ? undefined : true} variant={horizon === days ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, horizon: days })).then(() => refreshShownReport($))}>
              {L(en, zh)}
            </Button>
          ))}
          <Button key="report-refresh" plain onPress={() => void refreshShownReport($, true)}>
            {working ? L('Analysing…', '分析中…') : L('Re-run analysis', '重新分析')}
          </Button>
        </Box>
      )

      if (!report) {
        body = (
          <Box flexDirection="column" gap={1}>
            {horizonRow}
            {failed && !working ? (
              <Text color="warning">
                {L('Analysis failed: ', '分析失败：')}
                {failed}
              </Text>
            ) : (
              <Text dimColor>
                {working
                  ? L(`Analysing ${data.symbol}: ten years of prices, the option chain, futures and positioning…`, `正在分析 ${data.symbol}：十年价格、期权链、期货与持仓…`)
                  : L('Press Re-run analysis to analyse this ticker.', '点击“重新分析”来分析这个代码。')}
              </Text>
            )}
          </Box>
        )
      } else {
        const c = report.composite
        const o = report.options
        const levelRowsMd = [
          ...report.resistances.map(l => ({ price: l.price, what: `${L('Resistance', '阻力')} · ${pick(lang, levelKindText(l.kind))}${l.date ? ` ${l.date}` : ''}` })),
          ...report.supports.map(l => ({ price: l.price, what: `${L('Support', '支撑')} · ${pick(lang, levelKindText(l.kind))}${l.date ? ` ${l.date}` : ''}` })),
          ...(o?.levels.callWall !== undefined ? [{ price: o.levels.callWall, what: L('Options · call wall (largest call gamma)', '期权 · 看涨墙（call wall，看涨伽马最大）') }] : []),
          ...(o?.levels.putWall !== undefined ? [{ price: o.levels.putWall, what: L('Options · put wall (largest put gamma)', '期权 · 看跌墙（put wall，看跌伽马最大）') }] : []),
          ...(o?.levels.gammaFlip !== undefined ? [{ price: o.levels.gammaFlip, what: L('Options · gamma flip (dealers short gamma below)', '期权 · 伽马翻转点（gamma flip，其下做市商为负伽马）') }] : []),
          ...(o?.maxPainMonthly ? [{ price: o.maxPainMonthly.strike, what: L(`Options · max pain ${o.maxPainMonthly.expiry}`, `期权 · 最大痛点（max pain）${o.maxPainMonthly.expiry}`) }] : []),
        ].sort((a, b) => b.price - a.price)
        const flags = report.modules.flatMap(m => m.flags.slice(0, 2).map(f => ({ key: m.key, f }))).slice(0, 8)
        const scen = report.scenarios.rows
          .map(sc => {
            const where = sc.target !== undefined ? fmtPrice(sc.target) : sc.range ? `${fmtPrice(sc.range[0])}–${fmtPrice(sc.range[1])}` : '—'

            const name = { bull: L('bull', '乐观'), base: L('base', '基准'), bear: L('bear', '悲观') }[sc.name]
            const kind = sc.probKind === 'touch' ? L('touch', '触及') : L('finish inside', '收在区间内')

            return `| **${name}** | ${where} | ${(sc.probability * 100).toFixed(0)}% ${kind} | ${pick(lang, sc.trigger).replace(/\|/g, '/')} | ${pick(lang, sc.invalidation).replace(/\|/g, '/')} |`
          })
          .join('\n')
        const moves = report.moves.map(m => `| ${pick(lang, m.label)} | ±${m.pct1.toFixed(2)}% | ${fmtPrice(m.lower1)}–${fmtPrice(m.upper1)} | ${fmtPrice(m.lower2)}–${fmtPrice(m.upper2)} |`).join('\n')
        const a = report.analogs

        body = (
          <Box flexDirection="column" gap={1}>
            {horizonRow}
            <Box flexDirection="column">
              <Text size="title" weight="bold" color={scoreColor(c.score)}>
                {lang === 'zh' ? pick('zh', biasText(c.bias)) : c.bias.toUpperCase()} <Text tabular>{c.score >= 0 ? '+' : ''}{c.score}</Text>
              </Text>
              <Text>
                {L(
                  `Confidence ${c.confidence.toFixed(2)} · ${c.agree}/${c.total} modules agree · next ${report.horizonDays} sessions`,
                  `置信度 ${c.confidence.toFixed(2)} · ${c.agree}/${c.total} 个模块同向 · 未来 ${report.horizonDays} 个交易日`,
                )}
              </Text>
              <Text dimColor size="footnote">
                {L(`From the ${report.asOf} close ${fmtPrice(report.spot)}`, `基于 ${report.asOf} 收盘价 ${fmtPrice(report.spot)}`)}
                {report.indicated ? L(` · latest print ${fmtPrice(report.indicated.price)} (${pct(report.indicated.changePct, 2)})`, ` · 最新成交 ${fmtPrice(report.indicated.price)}（${pct(report.indicated.changePct, 2)}）`) : ''} · σ {(report.sigma * 100).toFixed(1)}%{' '}
                {report.sigmaSource === 'implied' ? L('implied', '隐含') : L('realized', '已实现')} · {L('analysed', '分析于')} {ago(report.fetchedAt, lang)}
              </Text>
            </Box>
            <Text weight="semibold">
              {L('Modules', '分析模块')} <Text dimColor size="footnote">{L('· hover a name for its readings', '· 悬停名称查看读数')}</Text>
            </Text>
            <Box flexDirection="column">
              {report.modules.map(m => {
                const scope = `mod-${m.key}`

                return (
                  <Box key={scope} flexDirection="column">
                    <Box flexDirection="row">
                      <Box width={16}>
                        <Text underline hover={{ scope, color: 'claude' }}>
                          {moduleLabel(m.key, lang)}
                        </Text>
                      </Box>
                      <Box width={14}>
                        <Text color={scoreColor(m.score)}>{scoreBar(m.score)}</Text>
                      </Box>
                      <Box width={7}>
                        <Text tabular color={scoreColor(m.score)}>
                          {m.score >= 0 ? '+' : ''}
                          {m.score}
                        </Text>
                      </Box>
                      <Text dimColor tabular>
                        {L('conf', '置信')} {m.confidence.toFixed(2)} · {L('weight', '权重')} {(c.weights[m.key] ?? 0).toFixed(2)}
                      </Text>
                      <Box position="absolute" top={1} left={2} display="none" hover={{ scope, display: 'flex' }} flexDirection="column" width={Math.min(76, cols - 4)} paddingX={1} backgroundColor="#1f2328" borderStyle="round" borderColor="#3b4048">
                        {m.readings.map(r => (
                          <Text color="#f3f4f6">
                            {pick(lang, r.name)}
                            {L(': ', '：')}
                            {typeof r.value === 'number' ? +r.value.toFixed(4) : pick(lang, r.value)}
                            {r.note ? <Text color="#9ca3af">{L(` (${pick(lang, r.note)})`, `（${pick(lang, r.note)}）`)}</Text> : ''}
                          </Text>
                        ))}
                      </Box>
                    </Box>
                    <Box paddingLeft={2}>
                      <Text dimColor>{pick(lang, m.verdict)}</Text>
                    </Box>
                  </Box>
                )
              })}
            </Box>
            {flags.length > 0 && (
              <Box flexDirection="column">
                <Text weight="semibold">{L('What stands out', '值得注意')}</Text>
                {flags.map(({ key, f }) => (
                  <Text>
                    <Text color="warning">▲ </Text>
                    <Text dimColor>
                      {moduleLabel(key, lang)}
                      {L(':', '：')}
                    </Text>{' '}
                    {pick(lang, f)}
                  </Text>
                ))}
              </Box>
            )}
            {report.notes.map(n => (
              <Text color="warning">⚠ {pick(lang, n)}</Text>
            ))}
            <Text weight="semibold">{L('Key levels', '关键价位')}</Text>
            <Markdown text={`| ${L('Price', '价格')} | ${L('vs close', '较收盘')} | ${L('Level', '价位')} |\n|---|---|---|\n${levelRowsMd.map(l => `| ${fmtPrice(l.price)} | ${pct(((l.price - report.spot) / report.spot) * 100)} | ${l.what} |`).join('\n')}`} />
            {o && (
              <Text dimColor size="footnote">
                {L('Options: P/C volume ', '期权：P/C 成交量 ')}
                {o.pcVolume?.toFixed(2) ?? '—'}
                {L(', OI ', '，OI ')}
                {o.pcOi?.toFixed(2) ?? '—'} · {L('ATM IV 30d', '平值 IV 30 日')} {o.ivAtm30 !== undefined ? `${(o.ivAtm30 * 100).toFixed(1)}%` : '—'} · {L('25Δ skew', '25Δ 偏斜')}{' '}
                {o.skew ? L(`${(o.skew.skew * 100).toFixed(1)} pts (${pick('en', skewReadText(o.skew.read as SkewRead))})`, `${(o.skew.skew * 100).toFixed(1)} 个波动率点（${pick('zh', skewReadText(o.skew.read as SkewRead))}）`) : '—'} · {L('straddle to', '跨式组合至')} {o.moves[0]?.expiry ?? '—'} ±{o.moves[0]?.pct.toFixed(2) ?? '—'}%
              </Text>
            )}
            <Text weight="semibold">
              {L('Scenarios', '情景')} <Text dimColor size="footnote">{L('· model odds from σ, not a direction call', '· 基于 σ 的模型概率，不是方向判断')}</Text>
            </Text>
            <Markdown text={`| ${L('Case', '情景')} | ${L('Target', '目标')} | ${L('Odds', '概率')} | ${L('Trigger', '触发条件')} | ${L('Invalidation', '失效条件')} |\n|---|---|---|---|---|\n${scen}`} />
            <Text weight="semibold">{L('Expected moves', '预期波幅')}</Text>
            <Markdown text={`| ${L('Horizon', '周期')} | 1σ | ${L('1σ range', '1σ 区间')} | ${L('2σ range', '2σ 区间')} |\n|---|---|---|---|\n${moves}`} />
            <Text weight="semibold">{L('Historical analogs', '历史相似样本')}</Text>
            {a.ok ? (
              <Box flexDirection="column">
                <Markdown
                  text={`| ${L('Horizon', '周期')} | ${L('Analog win', '相似样本胜率')} | ${L('Mean', '均值')} | p10 / p90 | ${L('All days win', '全部交易日胜率')} | ${L('All days mean', '全部交易日均值')} |\n|---|---|---|---|---|---|\n${a.horizons
                    .map(h => `| ${L(`${h.days} days`, `${h.days} 日`)} | ${h.analogs.winRate.toFixed(0)}% | ${pct(h.analogs.mean, 2)} | ${pct(h.analogs.p10)} / ${pct(h.analogs.p90)} | ${h.baseline.winRate.toFixed(0)}% | ${pct(h.baseline.mean, 2)} |`)
                    .join('\n')}`}
                />
                <Text dimColor size="footnote">
                  {L(
                    `The ${a.k} past days most like today (trend, momentum, volatility, volume), from ${a.eligibleDays} days; closest ${a.closest.slice(0, 3).map(x => x.date).join(', ')}. Overlapping, small samples: context, not a forecast.`,
                    `从 ${a.eligibleDays} 个交易日中找出与今天最相似的 ${a.k} 天（趋势、动量、波动率、成交量）；最接近的是 ${a.closest.slice(0, 3).map(x => x.date).join('、')}。样本有重叠且数量少：仅作参考，不是预测。`,
                  )}
                </Text>
              </Box>
            ) : (
              <Text dimColor>{pick(lang, a.note)}</Text>
            )}
            {report.errors.length > 0 && (
              <Text color="warning" size="footnote">
                {L('Data gaps: ', '数据缺失：')}
                {report.errors.map(err => sourceError(err, lang)).join(L('; ', '；'))}
              </Text>
            )}
            <Button
              key="ask-read"
              variant="primary"
              onPress={() =>
                void $.prompt.submit({
                  text: L(
                    `Use the stock-desk analyze skill to give me a full data-driven read on ${data.symbol} for the next ${report.horizonDays} trading days: bias and confidence, the readings behind it, key levels, scenarios, what would change the view, and the risks.`,
                    `用 stock-desk analyze 技能，基于数据分析 ${data.symbol} 未来 ${report.horizonDays} 个交易日：倾向与置信度、背后的读数、关键价位、情景、什么会改变判断，以及风险。`,
                  ),
                  asUser: true,
                })
              }
            >
              {L('Ask Claude for a written read', '让 Claude 写一份解读')}
            </Button>
          </Box>
        )
      }
    } else if (p.tab === 'intraday') {
      const entry = await intradayOf($, data.symbol)
      const failed = (await read($, intradayErrors))[data.symbol]
      const working = loading.includes(`#intraday:${data.symbol}`)
      const scoreColor = (n: number) => (n >= 15 ? upColor(p) : n <= -15 ? downColor(p) : 'subtle')
      const pct = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`
      const cadence = intradayCadenceMs()
      const controls = (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="intra-refresh" plain onPress={() => void refreshIntraday($, data.symbol, true).catch(() => undefined)}>
            {working ? L('Loading…', '加载中…') : L('Refresh now', '立即刷新')}
          </Button>
          <Button key="intra-premarket" plain={p.showPremarket === false ? true : undefined} variant={p.showPremarket === false ? undefined : 'primary'} onPress={() => void setPrefs($, x => ({ ...x, showPremarket: x.showPremarket === false }))}>
            {L('Pre-market', '盘前')}
          </Button>
          <Button key="intra-alerts" plain={p.intradayAlerts ? undefined : true} variant={p.intradayAlerts ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, intradayAlerts: !x.intradayAlerts }))}>
            {p.intradayAlerts ? L('Alerts: on', '提醒：开') : L('Alerts: off', '提醒：关')}
          </Button>
          <Text dimColor size="footnote">
            {cadence ? L(`auto-refresh every ${Math.round(cadence / 60_000)} min`, `每 ${Math.round(cadence / 60_000)} 分钟自动刷新`) : L('market closed: no auto-refresh', '休市：不自动刷新')}
          </Text>
        </Box>
      )

      if (!entry) {
        body = (
          <Box flexDirection="column" gap={1}>
            {controls}
            {failed && !working ? (
              <Text color="warning">
                {L('Intraday read failed: ', '盘中分析失败：')}
                {failed}
              </Text>
            ) : (
              <Text dimColor>{working ? L(`Loading ${data.symbol}'s session…`, `正在加载 ${data.symbol} 的盘中数据…`) : L('Press Refresh now to load today’s session.', '点击“立即刷新”加载今天的盘中数据。')}</Text>
            )}
          </Box>
        )
      } else {
        const r = entry.read
        const width = clamp(cols * 7.5, 320, 900)
        const ranges = r.ranges
          .map(x => `| ${x.minutes === 60 ? L('First hour (IB)', '首小时（IB）') : L(`${x.minutes} min`, `${x.minutes} 分钟`)} | ${fmtPrice(x.low)}–${fmtPrice(x.high)} | ${pick(lang, rangeStatusText(x.status))}${x.widthVsAtr !== undefined ? L(` · ${x.widthVsAtr.toFixed(2)}× ATR`, ` · ${x.widthVsAtr.toFixed(2)}× ATR`) : ''} |`)
          .join('\n')
        const timeline = r.timeline
          .map(c => `| ${c.time} | ${fmtPrice(c.price)} | ${pct(c.vsOpenPct)} | ${c.vsVwapPct === undefined ? '—' : pct(c.vsVwapPct)} | ${c.score >= 0 ? '+' : ''}${c.score} ${pick(lang, biasText(c.bias))} | ${pick(lang, c.note).replace(/\|/g, '/')} |`)
          .join('\n')
        const levels = r.levels.map(l => `| ${fmtPrice(l.price)} | ${pct(((l.price - r.price) / r.price) * 100)} | ${pick(lang, l.label).replace(/\|/g, '/')} |`).join('\n')
        const scen = r.scenarios
          .map(sc => `| **${pick(lang, sc.label)}** | ${sc.target !== undefined ? fmtPrice(sc.target) : '—'} | ${pick(lang, sc.trigger).replace(/\|/g, '/')} | ${pick(lang, sc.invalidation).replace(/\|/g, '/')} |`)
          .join('\n')
        const b = r.breadth
        const st = r.study

        body = (
          <Box flexDirection="column" gap={1}>
            {controls}
            <Box flexDirection="column">
              <Text size="title" weight="bold" color={scoreColor(r.score)}>
                {lang === 'zh' ? pick('zh', biasText(r.bias)) : r.bias.toUpperCase()} <Text tabular>{r.score >= 0 ? '+' : ''}{r.score}</Text>
                <Text dimColor size="footnote" weight="regular">
                  {'  '}
                  {L('rest of the session · confidence', '本交易日剩余时段 · 置信度')} {r.confidence.toFixed(2)}
                </Text>
              </Text>
              <Text>{pick(lang, r.verdict)}</Text>
              <Text dimColor size="footnote">
                {pick(lang, phaseText(r.phase))} · {r.sessionDate} {r.asOf.slice(11, 16)} {L('ET', '美东')} · {fmtPrice(r.price)} ({pct(r.changePct)}) · {L('gap', '跳空')} {pct(r.gap.pct)}
                {r.gap.vsAtr !== undefined ? ` (${r.gap.vsAtr.toFixed(2)}× ATR)` : ''}
                {r.gap.direction !== 'flat' ? (r.gap.filled ? L(' · gap filled', ' · 缺口已回补') : L(' · gap open', ' · 缺口未回补')) : ''} · {L('updated', '更新于')} {ago(entry.fetchedAt, lang)}
              </Text>
            </Box>
            {Svg ? (
              <Svg
                source={intradayChart({ read: r, bars: entry.bars, width, colors: p.colors, lang, showPremarket: p.showPremarket !== false })}
                alt={L(`${data.symbol} intraday chart with VWAP, opening range and first-hour range`, `${data.symbol} 盘中走势图，含 VWAP、开盘区间与首小时区间`)}
              />
            ) : (
              <Text dimColor>{L('The intraday chart draws in the desktop app.', '盘中图表在桌面应用中显示。')}</Text>
            )}
            <Text dimColor size="footnote">
              <Text color="#f59e0b">VWAP ±1σ</Text> · <Text color="#facc15">{L('opening range 30 min', '开盘区间 30 分钟')}</Text> · <Text color="#38bdf8">{L('first hour (initial balance)', '首小时（初始平衡区）')}</Text> · <Text color="#a855f7">{L('gamma flip', '伽马翻转点')}</Text> ·{' '}
              <Text color="#22c55e">{L('call wall', '看涨墙')}</Text> · <Text color="#ef4444">{L('put wall', '看跌墙')}</Text> · {L('dashed grey: prior close', '灰色虚线：昨收')}
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
              <Text>
                <Text dimColor>{L('Open type ', '开盘类型 ')}</Text>
                {pick(lang, openTypeText(r.openType))}
              </Text>
              {r.vwap && (
                <Text>
                  <Text dimColor>VWAP </Text>
                  {fmtPrice(r.vwap.value)} ({pct(r.vwap.vsPct)}) <Text dimColor>{L(`· ${r.vwap.pctTimeAbove.toFixed(0)}% of minutes above`, `· ${r.vwap.pctTimeAbove.toFixed(0)}% 的分钟在其上方`)}</Text>
                </Text>
              )}
              {r.rvol && (
                <Text>
                  <Text dimColor>{L('Rel. volume ', '相对成交量 ')}</Text>
                  {r.rvol.value.toFixed(2)}×
                </Text>
              )}
            </Box>
            {b && (
              <Text dimColor size="footnote">
                {L(`Breadth: ${b.sectorsUp}/${b.sectors.length} sectors up, ${b.sectorsAboveOpen}/${b.sectors.length} above their open`, `广度：${b.sectors.length} 个板块中 ${b.sectorsUp} 个上涨、${b.sectorsAboveOpen} 个高于开盘价`)}
                {b.rspMinusSpy !== undefined ? L(` · equal minus cap weight ${b.rspMinusSpy >= 0 ? '+' : ''}${b.rspMinusSpy.toFixed(2)} pp`, ` · 等权减市值加权 ${b.rspMinusSpy >= 0 ? '+' : ''}${b.rspMinusSpy.toFixed(2)} 个百分点`) : ''}
                {b.qqqMinusSpy !== undefined ? ` · QQQ−SPY ${b.qqqMinusSpy >= 0 ? '+' : ''}${b.qqqMinusSpy.toFixed(2)}` : ''}
                {b.iwmMinusSpy !== undefined ? ` · IWM−SPY ${b.iwmMinusSpy >= 0 ? '+' : ''}${b.iwmMinusSpy.toFixed(2)}` : ''}
                {b.vix ? ` · VIX ${b.vix.last.toFixed(2)} (${pct(b.vix.changePct, 1)})` : ''}
              </Text>
            )}
            {r.flags.length > 0 && (
              <Box flexDirection="column">
                <Text weight="semibold">{L('What stands out', '值得注意')}</Text>
                {r.flags.slice(0, 8).map(f => (
                  <Text>
                    <Text color="warning">▲ </Text>
                    {pick(lang, f)}
                  </Text>
                ))}
              </Box>
            )}
            <Text weight="semibold">{L('Opening ranges', '开盘区间')}</Text>
            <Markdown text={`| ${L('Range', '区间')} | ${L('Low–high', '低–高')} | ${L('Status', '状态')} |\n|---|---|---|\n${ranges}`} />
            {r.timeline.length > 0 && (
              <Box flexDirection="column">
                <Text weight="semibold">
                  {L('First-hour timeline', '首小时时间线')} <Text dimColor size="footnote">{L('· how the read formed', '· 判断是怎样形成的')}</Text>
                </Text>
                <Markdown text={`| ${L('Time', '时间')} | ${L('Price', '价格')} | ${L('vs open', '较开盘')} | ${L('vs VWAP', '较 VWAP')} | ${L('Read', '判断')} | ${L('Note', '说明')} |\n|---|---|---|---|---|---|\n${timeline}`} />
              </Box>
            )}
            <Text weight="semibold">{L('Scenarios for the rest of the day', '今日剩余时段情景')}</Text>
            <Markdown text={`| ${L('Case', '情景')} | ${L('Target', '目标')} | ${L('Trigger', '触发条件')} | ${L('Invalidation', '失效条件')} |\n|---|---|---|---|\n${scen}`} />
            <Text weight="semibold">{L("Today's levels", '今日关键价位')}</Text>
            <Markdown text={`| ${L('Price', '价格')} | ${L('vs now', '较现价')} | ${L('Level', '价位')} |\n|---|---|---|\n${levels}`} />
            {st && (
              <Box flexDirection="column">
                <Text weight="semibold">
                  {L('Sessions like today', '与今天相似的交易日')} <Text dimColor size="footnote">{L(`· at ${st.at} ET, n = ${st.n}`, `· 美东 ${st.at}，样本 ${st.n} 个`)}</Text>
                </Text>
                <Markdown
                  text={
                    `| ${L('Matched on', '匹配条件')} | ${L('Closed above now', '收盘高于现价')} | ${L('Rest-of-day mean', '剩余时段均值')} | ${L('Broke IB high / low', '突破首小时高 / 低')} | ${L('All sessions', '全部交易日')} |\n|---|---|---|---|---|\n` +
                    `| ${pick(lang, st.matchedOn).replace(/\|/g, '/')} | ${st.closeAboveNow.toFixed(0)}% | ${pct(st.meanRestOfDay)} | ${st.extendedHigh.toFixed(0)}% / ${st.extendedLow.toFixed(0)}% | ${st.baseline.closeAboveNow.toFixed(0)}% · ${pct(st.baseline.meanRestOfDay)} (n ${st.baseline.n}) |`
                  }
                />
                <Text dimColor size="footnote">{pick(lang, st.note)}</Text>
              </Box>
            )}
            {r.notes.map(n => (
              <Text dimColor size="footnote">
                {pick(lang, n)}
              </Text>
            ))}
            {r.errors.length > 0 && (
              <Text color="warning" size="footnote">
                {L('Data gaps: ', '数据缺失：')}
                {r.errors.map(err => sourceError(err, lang)).join(L('; ', '；'))}
              </Text>
            )}
            <Button
              key="ask-intraday"
              variant="primary"
              onPress={() =>
                void $.prompt.submit({
                  text: L(
                    `Use the stock-desk analyze skill and the intraday read to tell me how ${data.symbol}'s session is shaping up: the lean for the rest of the day, the levels that matter, what would change it, and the risks.`,
                    `用 stock-desk analyze 技能和盘中分析，告诉我 ${data.symbol} 今天的走势：剩余时段的倾向、关键价位、什么会改变判断，以及风险。`,
                  ),
                  asUser: true,
                })
              }
            >
              {L('Ask Claude about today', '问 Claude 今天的走势')}
            </Button>
          </Box>
        )
      }
    } else if (p.tab === 'overview') {
      if (!a) {
        body = <Text dimColor>{L(`No price history for ${data.symbol}.`, `${data.symbol} 没有价格历史。`)}</Text>
      } else {
        const from = Math.max(0, data.bars.length - RANGE_BARS[p.range])
        const width = clamp(cols * 7.5, 320, 900)
        const last = a.last.c

        body = (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {(['1M', '3M', '6M', '1Y'] as Range[]).map(range => (
                <Button key={`range-${range}`} plain={p.range === range ? undefined : true} variant={p.range === range ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, range }))}>
                  {range}
                </Button>
              ))}
              <Button key="expand" onPress={() => void setPrefs($, x => ({ ...x, bigRange: x.range })).then(() => openChart($))}>
                {L('⤢ Expand chart', '⤢ 放大图表')}
              </Button>
              <Button key="browser" plain onPress={() => void setPrefs($, x => ({ ...x, bigRange: x.range })).then(() => openInBrowser($))}>
                {L('Open in browser (full screen)', '在浏览器中打开（全屏）')}
              </Button>
            </Box>
            {Svg ? (
              <Svg
                source={candleChart({ bars: data.bars, from, a, width, colors: p.colors, lang })}
                alt={L(
                  `${data.symbol} daily candlestick chart, ${p.range}: high ${money(a.rangeHigh.price)} on ${a.rangeHigh.date}, low ${money(a.rangeLow.price)} on ${a.rangeLow.date}, last close ${money(last)}`,
                  `${data.symbol} 日 K 线图，${p.range}：最高 ${money(a.rangeHigh.price)}（${a.rangeHigh.date}），最低 ${money(a.rangeLow.price)}（${a.rangeLow.date}），最新收盘 ${money(last)}`,
                )}
              />
            ) : (
              <Text dimColor>
                {L(
                  `The chart draws in the desktop app. ${p.range}: high ${money(a.rangeHigh.price)} (${a.rangeHigh.date}), low ${money(a.rangeLow.price)} (${a.rangeLow.date}).`,
                  `图表在桌面应用中显示。${p.range}：最高 ${money(a.rangeHigh.price)}（${a.rangeHigh.date}），最低 ${money(a.rangeLow.price)}（${a.rangeLow.date}）。`,
                )}
              </Text>
            )}
            <Text dimColor size="footnote">
              {L("For each candle's open, high, low, close and volume, use ⤢ Expand chart or Open in browser. ", '要查看每根 K 线的开高低收和成交量，请用 ⤢ 放大图表 或 在浏览器中打开。')}
              <Text color={MA_COLORS.ma20}>MA20</Text> · <Text color={MA_COLORS.ma50}>MA50</Text> · <Text color={MA_COLORS.ma200}>MA200</Text> · {L('dashed lines are support and resistance.', '虚线为支撑与阻力。')}
            </Text>
            <Text weight="semibold">
              {L('Key levels', '关键价位')} <Text dimColor size="footnote">{L('· hover an underlined name for what it means', '· 悬停带下划线的名称查看含义')}</Text>
            </Text>
            {explained(levelRows(a, p.range, lang), [L('Level', '价位'), L('Price', '价格'), L('vs. now', '较现价')], 'level')}
            <Text weight="semibold">{L('Indicators', '指标')}</Text>
            {explained(statRows(a, data, lang), [L('Measure', '指标'), L('Value', '数值'), L('Reading', '解读')], 'stat')}
            <Text weight="semibold">{L('Price-drop check', '下跌检查')}</Text>
            <Box flexDirection="column">
              {a.insights.map(i => (
                <Text>
                  <Text color={TONE_COLOR[i.tone]}>{TONE_MARK[i.tone]} </Text>
                  {i.text}
                </Text>
              ))}
            </Box>
            <Markdown
              dimColor
              text={L(
                '**Before acting on a drop, ask:** 1) Why did it fall? (News tab) 2) Is the 200-day trend still up? ' +
                  '3) Where is the next support, and how much would you lose if it breaks? 4) Is earnings or a big data release coming? ' +
                  '5) Would a loss to your exit level stay within the risk you set per trade (often 1–2% of the account)?',
                '**面对下跌，先问自己：** 1）为什么跌？（看新闻页）2）200 日均线的趋势还向上吗？' +
                  '3）下一个支撑在哪里，跌破会亏多少？4）是否临近财报或重要数据发布？' +
                  '5）跌到你的离场价时，亏损是否仍在你设定的单笔风险之内（通常为账户的 1–2%）？',
              )}
            />
          </Box>
        )
      }
    } else if (p.tab === 'news') {
      const sym = encodeURIComponent(data.symbol)
      body = (
        <Box flexDirection="column" gap={1}>
          {data.news.length === 0 && <Text dimColor>{L('No recent headlines from Nasdaq.', 'Nasdaq 暂无近期新闻。')}</Text>}
          {data.news.map(n => (
            <Box flexDirection="column">
              <Text>
                {isIncident(n.title) ? <Text color="warning">⚠ </Text> : ''}
                <Link href={n.url} label={n.title} />
              </Text>
              <Text dimColor size="footnote">
                {n.publisher} · {n.ago}
              </Text>
            </Box>
          ))}
          <Text dimColor size="footnote">
            {L(
              '⚠ marks headlines with words like lawsuit, probe, downgrade, recall or guidance cut: possible incidents worth reading first.',
              '⚠ 标出含有诉讼、调查、降级、召回、下调指引等字眼的标题：可能的突发事件，建议先读。',
            )}
          </Text>
          <Text>
            {L('More: ', '更多：')}
            <Link href={`https://finance.yahoo.com/quote/${sym}/news`} label="Yahoo Finance" /> · <Link href={`https://news.google.com/search?q=${sym}%20stock`} label="Google News" /> ·{' '}
            <Link href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${sym}&type=8-K`} label={L('SEC filings (8-K)', 'SEC 公告（8-K）')} />
          </Text>
        </Box>
      )
    } else {
      const upcoming = buildEvents({ today, horizon: 14, calendar: cal, tickers: all, watchlist: followed(p, await read($, portfolio)), mine: await read($, myEvents), lang }).filter(ev => ev.importance === 3)
      body = (
        <Box flexDirection="column" gap={1}>
          <Button key="open-cal" variant="primary" onPress={() => void openCalendar($)}>
            {L('Open the full market calendar', '打开完整市场日历')}
          </Button>
          {cal.fetchedAt === 0 && <Text dimColor>{L('Loading the calendar…', '正在加载日历…')}</Text>}
          <Text weight="semibold">{L('Most important, next two weeks', '未来两周最重要')}</Text>
          {upcoming.length === 0 && <Text dimColor>{L('Nothing marked ★★★.', '没有 ★★★ 事件。')}</Text>}
          {upcoming.map(ev => (
            <Text>
              <Text color={CATEGORY[ev.category].color}>● </Text>
              {dayLabel(ev.date, lang)}
              {ev.time ? ` ${etTime(lang, ev.time)}` : ''} · {ev.title}
            </Text>
          ))}
        </Box>
      )
    }

    const isLoading =
      loading.includes(p.selected) ||
      (p.tab === 'calendar' && loading.includes('#calendar')) ||
      (p.tab === 'analysis' && loading.includes(`#report:${p.selected}`)) ||
      (p.tab === 'intraday' && loading.includes(`#intraday:${p.selected}`))

    return (
      <Box flexDirection="column" gap={1}>
        {watchlist}
        {addField}
        {header}
        {tabs}
        {body}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="refresh" onPress={() => void Promise.all([refreshTicker($, p.selected, true), refreshCalendar($, true), refreshShownReport($, true), refreshShownIntraday($, true)])}>
            {isLoading ? L('Refreshing…', '刷新中…') : L('Refresh', '刷新')}
          </Button>
          <Button
            key="ask"
            onPress={() =>
              void $.prompt.submit({
                text: L(
                  `Use the stock-desk analyze skill for a full read on ${data.symbol} over the next ${horizonOf(p)} trading days, and check the latest news and upcoming catalysts.`,
                  `用 stock-desk analyze 技能全面分析 ${data.symbol} 未来 ${horizonOf(p)} 个交易日，并查看最新新闻和即将到来的催化剂。`,
                ),
                asUser: true,
              })
            }
          >
            {L(`Ask Claude about ${data.symbol}`, `问 Claude 关于 ${data.symbol}`)}
          </Button>
          <Button key="open-portfolio" onPress={() => void openPortfolio($)}>
            {L('My portfolio', '我的持仓')}
          </Button>
          <Button key="colors" plain onPress={() => void setPrefs($, x => ({ ...x, colors: x.colors === 'red-up' ? 'green-up' : 'red-up' }))}>
            {p.colors === 'red-up' ? L('Colors: red up (红涨绿跌)', '颜色：红涨绿跌') : L('Colors: green up', '颜色：绿涨红跌')}
          </Button>
          <Button key="lang" plain onPress={() => void switchLang($)}>
            {L('Language: English', '语言：中文')} <Text dimColor>· {LANGS.find(([l]) => l !== lang)?.[1]}</Text>
          </Button>
          <Button key="remove" plain dimColor onPress={() => void remove($, data.symbol)}>
            {group ? L(`Remove ${data.symbol} from ${group.name}`, `从 ${group.name} 移除 ${data.symbol}`) : L(`Remove ${data.symbol}`, `移除 ${data.symbol}`)}
          </Button>
        </Box>
        <Text dimColor size="footnote">
          {L(
            `Updated ${ago(data.fetchedAt, lang)} · data: Nasdaq, CBOE (options, VIX), CNBC (futures), CFTC (COT) · auto-refresh every 5 min. Analysis of market data, not investment advice.`,
            `更新于${ago(data.fetchedAt, lang)} · 数据：Nasdaq、CBOE（期权、VIX）、CNBC（期货）、CFTC（COT）· 每 5 分钟自动刷新。基于市场数据的分析，不构成投资建议。`,
          )}
        </Text>
      </Box>
    )
  })

  // ---------- the expanded chart ----------

  on('ui.render', { component: 'Pane', requestId: CHART }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = t
    const Svg = e.surface !== 'terminal' && 'Svg' in t ? t.Svg : undefined
    const p = await read($, prefs)
    const lang = langOf(p)
    const L = (en: string, zh: string) => tr(lang, en, zh)
    const all = await read($, tickers)
    const data = all[p.selected]
    const a = data ? analyze(data.bars, p.bigRange, undefined, lang) : undefined
    if (!data || !a) return <Text dimColor>{L(`Loading ${p.selected}…`, `正在加载 ${p.selected}…`)}</Text>

    const cols = e.props.bodyColumns ?? 120
    const width = clamp(cols * 8, 560, 1600)
    const rows = e.viewport?.rows
    const height = rows ? clamp(rows * 17 - 240, 320, 900) : Math.round(width * 0.55)
    const from = Math.max(0, data.bars.length - RANGE_BARS[p.bigRange])
    const q = data.quote

    return (
      <Box flexDirection="column" gap={1}>
        <Text size="heading" weight="semibold">
          {data.name} <Text dimColor>{data.symbol}</Text>
          {q ? <Text color={q.change >= 0 ? upColor(p) : downColor(p)}>  {money(q.price)} {signed(q.changePct)}%</Text> : ''}
        </Text>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {(shown(p).length ? shown(p) : p.watchlist).map(sym => (
            <Button key={`big-sym-${sym}`} plain={sym === p.selected ? undefined : true} variant={sym === p.selected ? 'primary' : undefined} onPress={() => void select($, sym)}>
              {sym}
            </Button>
          ))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {(['1M', '3M', '6M', '1Y', '2Y'] as Range[]).map(range => (
            <Button key={`big-range-${range}`} plain={p.bigRange === range ? undefined : true} variant={p.bigRange === range ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, bigRange: range }))}>
              {range}
            </Button>
          ))}
          <Button key="big-browser" onPress={() => void openInBrowser($)}>
            {L('Open in browser (full screen)', '在浏览器中打开（全屏）')}
          </Button>
          <Button key="hover-candles" plain={p.hoverCandles ? undefined : true} variant={p.hoverCandles ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, hoverCandles: !x.hoverCandles }))}>
            {p.hoverCandles ? L('Candle details on hover: on', '悬停显示 K 线详情：开') : L('Candle details on hover: off', '悬停显示 K 线详情：关')}
          </Button>
        </Box>
        {Svg ? (
          // An interactive SVG is drawn in a frame of its own, which keeps the
          // scroll wheel while the pointer is over it; it is opt-in for that.
          <Svg
            source={candleChart({ bars: data.bars, from, a, width, height, colors: p.colors, lang })}
            alt={L(`${data.symbol} daily candlestick chart, ${p.bigRange}`, `${data.symbol} 日 K 线图，${p.bigRange}`)}
            isInteractive={p.hoverCandles ? true : undefined}
          />
        ) : (
          <Text dimColor>{L('The chart draws in the desktop app; use Open in browser here.', '图表在桌面应用中显示；这里请用“在浏览器中打开”。')}</Text>
        )}
        <Text dimColor size="footnote">
          {p.hoverCandles
            ? L('Hover any candle for its numbers. While this is on, scroll with the pointer beside the chart, not over it. ', '悬停任意 K 线查看数值。开启时，请把指针放在图表旁边滚动，不要放在图上。')
            : L('Turn on candle details to hover each candle, or see the last sessions below. ', '开启 K 线详情后可悬停查看每根 K 线，或看下方最近的交易日。')}
          <Text color={MA_COLORS.ma20}>MA20</Text> · <Text color={MA_COLORS.ma50}>MA50</Text> · <Text color={MA_COLORS.ma200}>MA200</Text> · {L('Esc closes this pane.', '按 Esc 关闭此面板。')}
        </Text>
        <Text weight="semibold">{L('Last 10 sessions', '最近 10 个交易日')}</Text>
        <Markdown text={sessionsMarkdown(data.bars, 10, lang)} />
      </Box>
    )
  })

  // ---------- the calendar pane ----------

  on('ui.render', { component: 'Pane', requestId: CAL }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Input = e.surface !== 'mobile' && 'Input' in t ? t.Input : undefined
    const p = await read($, prefs)
    const lang = langOf(p)
    const L = (en: string, zh: string) => tr(lang, en, zh)
    const cal = await read($, calendar)
    const loading = await read($, busy)
    const today = marketToday()
    const events = buildEvents({ today, horizon: p.calHorizon, calendar: cal, tickers: await read($, tickers), watchlist: followed(p, await read($, portfolio)), mine: await read($, myEvents), lang })
    const shown = events.filter(ev => p.calCategories.includes(ev.category))
    const days = [...new Set(shown.map(ev => ev.date))]
    const counts = new Map<CalCategory, number>()
    for (const ev of events) counts.set(ev.category, (counts.get(ev.category) ?? 0) + 1)

    const toggle = (c: CalCategory) =>
      void setPrefs($, x => ({ ...x, calCategories: x.calCategories.includes(c) ? x.calCategories.filter(y => y !== c) : [...x.calCategories, c] }))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {HORIZONS.map(([span, en, zh]) => (
            <Button key={`h-${span}`} plain={p.calHorizon === span ? undefined : true} variant={p.calHorizon === span ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, calHorizon: span }))}>
              {L(en, zh)}
            </Button>
          ))}
          <Button key="cal-refresh" plain onPress={() => void refreshCalendar($, true)}>
            {loading.includes('#calendar') ? L('Refreshing…', '刷新中…') : L('Refresh', '刷新')}
          </Button>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {ALL_CATEGORIES.map(c => {
            const isOn = p.calCategories.includes(c)

            return (
              <Button key={`cat-${c}`} plain={isOn ? undefined : true} variant={isOn ? 'primary' : undefined} onPress={() => toggle(c)}>
                <Text color={isOn ? undefined : CATEGORY[c].color}>●</Text> {catLabel(c, lang)} <Text dimColor>{counts.get(c) ?? 0}</Text>
              </Button>
            )
          })}
        </Box>
        {Input && <Input key="add-event" placeholder={L('Add your own: 2026-11-20 Nvidia GTC', '添加自己的事件：2026-11-20 Nvidia GTC')} submitLabel={L('Add', '添加')} onSubmit={value => void addMyEvent($, value)} />}
        {cal.fetchedAt === 0 && <Text dimColor>{L('Loading earnings and economic data…', '正在加载财报与经济数据…')}</Text>}
        {cal.error && <Text color="warning">{cal.error}</Text>}
        {shown.length === 0 && cal.fetchedAt > 0 && <Text dimColor>{L('Nothing in this window for the kinds you picked.', '所选类别在这段时间内没有事件。')}</Text>}
        {days.map(day => (
          <Box flexDirection="column">
            <Text weight="semibold">
              {dayLabel(day, lang)} <Text dimColor>· {relative(today, day, lang)}</Text>
            </Text>
            {shown
              .filter(ev => ev.date === day)
              .map(ev => (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text>
                    <Text color={CATEGORY[ev.category].color}>● {catLabel(ev.category, lang)}</Text>{' '}
                    <Text color={ev.importance === 3 ? 'warning' : 'subtle'}>{STARS[ev.importance]}</Text> {ev.time ? `${etTime(lang, ev.time)} · ` : ''}
                    <Text weight={ev.importance === 3 ? 'semibold' : undefined}>{ev.title}</Text>
                  </Text>
                  {ev.detail && (
                    <Text dimColor size="footnote">
                      {ev.detail}
                    </Text>
                  )}
                  {ev.myId && (
                    <Button key={`del-${ev.myId}`} plain dimColor onPress={() => void setMyEvents($, list => list.filter(m => m.id !== ev.myId))}>
                      {L('Remove', '移除')}
                    </Button>
                  )}
                </Box>
              ))}
          </Box>
        ))}
        <Text dimColor size="footnote">
          {L(
            "★★★ moves the whole market · ★★ notable · ★ minor. Earnings and economic releases come from Nasdaq and reach four weeks ahead; Fed meetings follow the Fed's 2026 schedule; holidays, options expiry and election day are worked out from exchange and federal rules. Ask Claude to add other events (a funding deadline, a court ruling, a summit) and they appear here. Times are US Eastern.",
            '★★★ 影响整个市场 · ★★ 值得关注 · ★ 次要。财报和经济数据来自 Nasdaq，覆盖未来四周；美联储会议按 2026 年日程；假日、期权到期日和选举日按交易所与联邦规则推算。可以让 Claude 添加其他事件（拨款截止日、法院裁决、峰会），会显示在这里。时间均为美东时间。',
          )}
        </Text>
      </Box>
    )
  })

  // ---------- the portfolio pane ----------

  on('ui.render', { component: 'Pane', requestId: PORT }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = t
    const Input = e.surface !== 'mobile' && 'Input' in t ? t.Input : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in t ? t.Svg : undefined
    const p = await read($, prefs)
    const lang = langOf(p)
    const L = (en: string, zh: string) => tr(lang, en, zh)
    const pf = await read($, portfolio)
    const all = await read($, tickers)
    const sized = await read($, sizer)
    const today = marketToday()
    const cols = e.props.bodyColumns ?? 80
    const { holdings, totals, sectors } = valuePortfolio(pf, all, lang)
    const checks = runChecks(pf, all, await read($, calendar), today, lang)
    const pnlColor = (n: number) => (n >= 0 ? upColor(p) : downColor(p))
    const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

    /** An underlined name that shows what it means on hover. */
    const tip = (label: string, meaning: string, scope: string) => (
      <Box key={`tip-${scope}`}>
        <Text underline hover={{ scope, color: 'claude' }}>
          {label}
        </Text>
        <Box position="absolute" top={1} left={0} display="none" hover={{ scope, display: 'flex' }} width={Math.min(56, cols - 4)} paddingX={1} backgroundColor="#1f2328" borderStyle="round" borderColor="#3b4048">
          <Text color="#f3f4f6">{meaning}</Text>
        </Box>
      </Box>
    )
    const stat = (label: string, meaning: string, value: string, color?: string) => (
      <Box flexDirection="column" minWidth={16}>
        {tip(label, meaning, `sum-${label}`)}
        <Text weight="semibold" tabular color={color}>
          {value}
        </Text>
      </Box>
    )

    const palette = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899', '#84cc16', '#64748b']
    const slices = [
      ...holdings.slice(0, 8).map((pos, i) => ({ label: pos.symbol, pct: pos.weight, color: palette[i]! })),
      ...(holdings.length > 8 ? [{ label: L('Other', '其他'), pct: holdings.slice(8).reduce((s, pos) => s + pos.weight, 0), color: palette[8]! }] : []),
      ...(totals.cash > 0 && totals.value > 0 ? [{ label: L('Cash', '现金'), pct: (totals.cash / totals.value) * 100, color: '#9ca3af' }] : []),
    ]
    const barW = clamp(cols * 7.5, 300, 900)
    let x = 0
    const bar =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${barW} 18" width="${barW}" height="18">` +
      slices
        .map(sl => {
          const w = (sl.pct / 100) * barW
          const rect = `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - 1).toFixed(1)}" height="18" rx="3" fill="${sl.color}"><title>${sl.label} ${sl.pct.toFixed(1)}%</title></rect>`
          x += w

          return rect
        })
        .join('') +
      '</svg>'

    const positionsTable =
      L('| Ticker | Shares | Avg cost | Price | Value | Weight | Today | Profit/loss | Stop / target |', '| 代码 | 股数 | 平均成本 | 现价 | 市值 | 占比 | 今日 | 盈亏 | 止损 / 目标价 |') +
      `\n|---|---|---|---|---|---|---|---|---|\n` +
      holdings
        .map(
          pos =>
            `| **${pos.symbol}** | ${pos.shares} | ${usd(pos.cost)} | ${pos.price === undefined ? '…' : usd(pos.price)} | ${usd(pos.value)} | ${pos.weight.toFixed(1)}% | ${pos.price === undefined ? '—' : `${usd(pos.day)} (${signed(pos.dayPct)}%)`} | ${usd(pos.pnl)} (${signed(pos.pnlPct, 1)}%) | ${pos.stop === undefined ? '—' : usd(pos.stop)} / ${pos.target === undefined ? '—' : usd(pos.target)} |`,
        )
        .join('\n')

    const editing = p.editing ? pf.positions.find(x => x.symbol === p.editing) : undefined

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1}>
          {stat(L('Total value', '总市值'), L('Everything you hold at the latest prices, plus the cash you entered.', '按最新价格计算的全部持仓，加上你录入的现金。'), usd(totals.value))}
          {stat(L("Today's change", '今日变动'), L('How much your holdings moved in the latest session, in dollars.', '持仓在最近一个交易日的变动金额（美元）。'), usd(totals.day), pnlColor(totals.day))}
          {stat(L('Unrealized P/L', '浮动盈亏'), L('Gain or loss on what you still hold: current value minus what you paid. It becomes real only when you sell.', '仍持有部分的盈亏：现值减去成本。卖出后才会实现。'), `${usd(totals.pnl)} (${signed(totals.pnlPct, 1)}%)`, pnlColor(totals.pnl))}
          {stat(L('Realized P/L', '已实现盈亏'), L('Gain or loss already locked in by the sells you entered here.', '你在这里录入的卖出已锁定的盈亏。'), usd(totals.realized), pnlColor(totals.realized))}
          {stat(L('Cash', '现金'), L('Uninvested money, as you entered it ("cash 5000"). Buys and sells here do not change it.', '未投资的资金，按你录入的数（"cash 5000"）。这里的买卖不会改变它。'), usd(totals.cash))}
          {stat(L('Risk to stops', '止损风险'), L('What you would lose if every position fell to its stop. Positions without a stop are not counted.', '如果每个持仓都跌到止损价会亏多少。没有设止损的持仓不计入。'), usd(totals.openRisk))}
        </Box>
        {holdings.length > 0 && (
          <Box flexDirection="column">
            {Svg && <Svg source={bar} alt={`${L('Allocation: ', '配置：')}${slices.map(sl => `${sl.label} ${sl.pct.toFixed(0)}%`).join(', ')}`} />}
            <Text dimColor size="footnote">
              {slices.map(sl => (
                <Text>
                  <Text color={sl.color}>■</Text> {sl.label} {sl.pct.toFixed(1)}%{'   '}
                </Text>
              ))}
            </Text>
            <Text dimColor size="footnote">
              {L('Sectors: ', '行业：')}
              {sectors.map(([name, pct]) => `${name} ${pct.toFixed(0)}%`).join(' · ')}
            </Text>
          </Box>
        )}
        {Input && (
          <Input
            key="trade"
            placeholder={L('Add a trade: "NVDA 50 @ 120.5 stop 110 target 160", "sell NVDA 10 @ 140" or "cash 5000"', '录入交易："NVDA 50 @ 120.5 stop 110 target 160"、"sell NVDA 10 @ 140" 或 "cash 5000"')}
            submitLabel={L('Enter', '录入')}
            onSubmit={value => void enterTrade($, value)}
          />
        )}
        {holdings.length === 0 ? (
          <Text dimColor>{L('No positions yet. Enter one above, e.g. NVDA 50 @ 120.5 stop 110. Your holdings stay on this computer.', '还没有持仓。在上方录入一笔，例如 NVDA 50 @ 120.5 stop 110。持仓只保存在这台电脑上。')}</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Markdown text={positionsTable} />
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Text dimColor>{L('Edit:', '编辑：')}</Text>
              {holdings.map(pos => (
                <Button key={`edit-${pos.symbol}`} plain={p.editing === pos.symbol ? undefined : true} variant={p.editing === pos.symbol ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, editing: x.editing === pos.symbol ? undefined : pos.symbol }))}>
                  {pos.symbol}
                </Button>
              ))}
            </Box>
          </Box>
        )}
        {editing && Input && (
          <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
            <Text weight="semibold">
              {editing.symbol} <Text dimColor>{L('· press Enter in a field to save it', '· 在输入框按回车保存')}</Text>
            </Text>
            <Input key={`pos-shares-${editing.symbol}`} label={L('Shares', '股数')} value={String(editing.shares)} onSubmit={v => void editPosition($, editing.symbol, 'shares', v)} />
            <Input key={`pos-cost-${editing.symbol}`} label={L('Average cost per share', '每股平均成本')} value={String(editing.cost)} onSubmit={v => void editPosition($, editing.symbol, 'cost', v)} />
            <Input
              key={`pos-stop-${editing.symbol}`}
              label={L('Stop (the price where you plan to get out; empty to clear)', '止损（你计划离场的价格；留空则清除）')}
              value={editing.stop === undefined ? '' : String(editing.stop)}
              onSubmit={v => void editPosition($, editing.symbol, 'stop', v)}
            />
            <Input key={`pos-target-${editing.symbol}`} label={L('Target (empty to clear)', '目标价（留空则清除）')} value={editing.target === undefined ? '' : String(editing.target)} onSubmit={v => void editPosition($, editing.symbol, 'target', v)} />
            <Input key={`pos-note-${editing.symbol}`} label={L('Note: why you bought it, what would change your mind', '备注：为什么买、什么会让你改变主意')} value={editing.note ?? ''} rows={2} onSubmit={v => void editPosition($, editing.symbol, 'note', v)} />
            <Box flexDirection="row" gap={1}>
              <Button key="pos-chart" onPress={() => void select($, editing.symbol).then(() => openMain($))}>
                {L('Open its chart', '打开它的图表')}
              </Button>
              <Button key="pos-remove" plain dimColor onPress={() => void setPortfolio($, x => ({ ...x, positions: x.positions.filter(y => y.symbol !== editing.symbol) })).then(() => setPrefs($, x => ({ ...x, editing: undefined })))}>
                {L('Remove position', '删除持仓')}
              </Button>
              <Button key="pos-done" plain onPress={() => void setPrefs($, x => ({ ...x, editing: undefined }))}>
                {L('Done', '完成')}
              </Button>
            </Box>
          </Box>
        )}
        {holdings.length > 0 && (
          <Box flexDirection="column">
            <Text weight="semibold">
              {L('Checks against your rules', '规则检查')}{' '}
              <Text dimColor size="footnote">{L(`· ${checks.filter(c => c.tone === 'risk' || c.tone === 'warn').length} need a look`, `· ${checks.filter(c => c.tone === 'risk' || c.tone === 'warn').length} 项需要关注`)}</Text>
            </Text>
            {checks.length === 0 && <Text color="success">{L('● Nothing crosses your rules.', '● 没有触发你的规则。')}</Text>}
            {checks.map(c => (
              <Text>
                <Text color={TONE_COLOR[c.tone]}>{TONE_MARK[c.tone]} </Text>
                {c.text}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <Text weight="semibold">{L('Position-size calculator', '仓位计算器')}</Text>
          {Input && (
            <Input
              key="sizer"
              placeholder={L('Entry and stop, e.g. "NVDA 180 stop 165"', '入场价和止损，例如 "NVDA 180 stop 165"')}
              submitLabel={L('Size it', '计算')}
              onSubmit={value => void update($, sizer, () => sizePosition(value, totals.value, pf.rules, lang))}
            />
          )}
          <Text dimColor={!sized}>{sized || L(`How many shares keep a stopped-out trade to your ${pf.rules.riskPerTradePct}% risk per trade.`, `买多少股能让止损出局的亏损不超过单笔风险 ${pf.rules.riskPerTradePct}%。`)}</Text>
        </Box>
        <Button key="rules" plain onPress={() => void setPrefs($, x => ({ ...x, showRules: !x.showRules }))}>
          {p.showRules ? L('▾ Your rules', '▾ 你的规则') : L('▸ Your rules', '▸ 你的规则')}{' '}
          {L(
            `(${pf.rules.maxWeightPct}% max position · ${pf.rules.maxLossPct}% loss alert · ${pf.rules.riskPerTradePct}% risk per trade)`,
            `（单只上限 ${pf.rules.maxWeightPct}% · 亏损提醒 ${pf.rules.maxLossPct}% · 单笔风险 ${pf.rules.riskPerTradePct}%）`,
          )}
        </Button>
        {p.showRules &&
          Input &&
          RULE_LABELS.map(r => (
            <Box flexDirection="column">
              <Input key={`rule-${r.key}`} label={ruleText(r, lang).title} value={String(pf.rules[r.key])} onSubmit={v => void setRule($, r.key, v)} />
              <Text dimColor size="footnote">
                {ruleText(r, lang).meaning}
              </Text>
            </Box>
          ))}
        {pf.trades.length > 0 && (
          <Box flexDirection="column">
            <Text weight="semibold">{L('Recent trades', '最近交易')}</Text>
            <Markdown
              text={
                L('| Date | Trade | Price | Realized |', '| 日期 | 交易 | 价格 | 已实现 |') +
                `\n|---|---|---|---|\n` +
                pf.trades
                  .slice(-6)
                  .reverse()
                  .map(row => `| ${row.date} | ${row.side === 'buy' ? L('buy', '买入') : L('sell', '卖出')} ${row.shares} ${row.symbol} | ${usd(row.price)} | ${row.realized === undefined ? '—' : usd(row.realized)} |`)
                  .join('\n')
              }
            />
          </Box>
        )}
        <Text dimColor size="footnote">
          {L(
            'Checks compare your positions with the rules you set; they are not recommendations to buy or sell. Prices are about 15 minutes delayed. Your holdings are kept only on this computer.',
            '检查只是把持仓和你设定的规则做比较，不是买卖建议。价格延迟约 15 分钟。持仓只保存在这台电脑上。',
          )}
        </Text>
      </Box>
    )
  })
}
