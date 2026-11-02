import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CalCategory, Calendar, EarningsRow, Group, Horizon, MyEvent, Portfolio, Prefs, Range, Rules, Tab, TickerData } from '../types'
import { analyze, RANGE_BARS } from './analysis'
import type { Analysis, Tone } from './analysis'
import { candleChart, MA_COLORS } from './chart'
import { isIncident, loadCalendar, loadTicker, marketToday } from './data'
import { buildEvents, CATEGORY, parseMyEvent } from './events'
import type { CalEvent } from './events'
import { levelRows, sessionsMarkdown, statRows } from './levels'
import type { Row } from './levels'
import { chartPage } from './page'
import { applyCommand, EMPTY_PORTFOLIO, parseCommand, RULE_LABELS, runChecks, sizePosition, valuePortfolio } from './portfolio'

const PANE = 'stock-desk'
const CHART = 'stock-desk-chart'
const CAL = 'stock-desk-calendar'
const PORT = 'stock-desk-portfolio'
const TICKER_TTL = 5 * 60_000
const CALENDAR_TTL = 6 * 3600_000
const ALL_CATEGORIES: CalCategory[] = ['watchlist', 'big-earnings', 'economy', 'fed', 'politics', 'market', 'mine']
const DEFAULT_PREFS: Prefs = {
  watchlist: ['AAPL', 'NVDA', 'MSFT', 'SPY'],
  groups: [],
  group: '',
  selected: 'AAPL',
  range: '3M',
  bigRange: '6M',
  tab: 'overview',
  colors: 'green-up',
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

type $ = EngineInterface

// ---------- formatting ----------

const money = (n: number | undefined) => (n === undefined ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const signed = (n: number, digits = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const TONE_COLOR: Record<Tone, 'success' | 'subtle' | 'warning' | 'error'> = { good: 'success', info: 'subtle', warn: 'warning', risk: 'error' }
const TONE_MARK: Record<Tone, string> = { good: '●', info: '○', warn: '▲', risk: '■' }
const STARS = { 1: '★', 2: '★★', 3: '★★★' } as const
const HORIZONS: [Horizon, string][] = [
  [14, '2 weeks'],
  [30, '1 month'],
  [90, '3 months'],
]

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`

  return `${Math.round(s / 3600)} h ago`
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86_400_000)
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function relative(today: string, iso: string): string {
  const d = daysBetween(today, iso)

  return d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`
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
    const failed: TickerData = have
      ? { ...have, error: `Refresh failed (${message}); showing data from ${ago(have.fetchedAt)}` }
      : { symbol, name: symbol, assetClass: 'stocks', bars: [], summary: {}, news: [], fetchedAt: Date.now(), error: `Could not load ${symbol}: ${message}` }
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
    await update($, calendar, c => ({ ...c, error: `Calendar failed: ${error instanceof Error ? error.message : String(error)}` }))
  } finally {
    await update($, busy, list => list.filter(s => s !== '#calendar'))
  }
}

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
    await $.ui.toast(`There is already a group named ${name}.`)
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
    await $.ui.toast(`There is already a group named ${name}.`)
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
  await $.ui.open({ id: PANE, title: 'Stocks', columns: 100 })
  const p = await read($, prefs)
  await Promise.all([p.selected ? refreshTicker($, p.selected) : undefined, refreshCalendar($)])
}

async function openChart($: $): Promise<void> {
  const p = await read($, prefs)
  await $.ui.open({ id: CHART, title: `${p.selected} chart`, focus: true, closeOnEscape: true, columns: 220, rows: 60 })
}

async function openCalendar($: $): Promise<void> {
  await $.ui.open({ id: CAL, title: 'Market calendar', columns: 120, rows: 50 })
  const p = await read($, prefs)
  // Each stock's dividend dates come with its quote.
  await Promise.all([refreshCalendar($), ...followed(p, await read($, portfolio)).map(s => refreshTicker($, s))])
}

async function openPortfolio($: $): Promise<void> {
  await $.ui.open({ id: PORT, title: 'My portfolio', columns: 120, rows: 50 })
  const pf = await read($, portfolio)
  await Promise.all([refreshCalendar($), ...pf.positions.map(x => refreshTicker($, x.symbol))])
}

async function enterTrade($: $, text: string): Promise<void> {
  const command = parseCommand(text)
  if (!command) {
    await $.ui.toast('Try "NVDA 50 @ 120.5 stop 110", "sell NVDA 10 @ 140" or "cash 5000".')

    return
  }
  let message = ''
  await setPortfolio($, pf => {
    const out = applyCommand(pf, command, marketToday())
    message = out.message

    return out.pf
  })
  if (command.kind !== 'cash') await refreshTicker($, command.symbol)
  await $.ui.toast(message)
}

async function editPosition($: $, symbol: string, field: 'shares' | 'cost' | 'stop' | 'target' | 'note', value: string): Promise<void> {
  const text = value.trim().replace(/[$,]/g, '')
  const n = Number(text)
  if ((field === 'shares' || field === 'cost') && !(n > 0)) {
    await $.ui.toast(`${field === 'shares' ? 'Shares' : 'Average cost'} must be a number above 0.`)

    return
  }
  if ((field === 'stop' || field === 'target') && text !== '' && !(n > 0)) {
    await $.ui.toast('Enter a price, or leave it empty to clear it.')

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
    await $.ui.toast('Enter a number above 0.')

    return
  }
  await setPortfolio($, pf => ({ ...pf, rules: { ...pf.rules, [key]: n } }))
}

/** Writes the chart as a page and opens it in the default browser, where it can go full screen. */
async function openInBrowser($: $): Promise<void> {
  const p = await read($, prefs)
  const data = (await read($, tickers))[p.selected]
  const a = data ? analyze(data.bars, p.bigRange) : undefined
  if (!data || !a) {
    await $.ui.toast('No chart data yet.')

    return
  }
  const from = Math.max(0, data.bars.length - RANGE_BARS[p.bigRange])
  const svg = candleChart({ bars: data.bars, from, a, width: 1500, height: 760, colors: p.colors })
  const html = chartPage({ data, a, svg, levels: levelRows(a, p.bigRange), stats: statRows(a, data), range: p.bigRange })
  const path = `/tmp/stock-desk-${data.symbol}.html`
  try {
    await $.fs.write(path, html)
    const run = await $.process.run(['open', path])
    await $.ui.toast(run.exitCode === 0 ? `Opened ${data.symbol} in your browser.` : `Saved the chart to ${path}`)
  } catch (error) {
    await $.ui.toast(`Could not open the chart: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function addMyEvent($: $, text: string): Promise<void> {
  const parsed = parseMyEvent(text, marketToday())
  if (!parsed) {
    await $.ui.toast('Start with a date: 2026-11-20 Nvidia GTC, 11/20 Nvidia GTC or Nov 20 Nvidia GTC')

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

    $.clock.after(50, () => void openMain($))
    $.clock.every(TICKER_TTL, () => {
      void read($, prefs).then(p => (p.selected ? refreshTicker($, p.selected, true) : undefined))
      void read($, portfolio).then(pf => Promise.all(pf.positions.map(x => refreshTicker($, x.symbol))))
      void refreshCalendar($)
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

    return { result: { content: [{ type: 'text', text }], isError: false } }
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

    return { result: { content: [{ type: 'text', text: `Added to the calendar: ${date} ${event.title} (${CATEGORY[category].label}).` }], isError: false } }
  })

  on('tool.call', { tool: 'mcp__stock-desk__calendar_list' }, async ($, e) => {
    const days = Math.max(1, Math.min(90, Number((e as unknown as { days?: number }).days ?? 30)))
    await refreshCalendar($)
    const p = await read($, prefs)
    const today = marketToday()
    const events = buildEvents({ today, horizon: days, calendar: await read($, calendar), tickers: await read($, tickers), watchlist: followed(p, await read($, portfolio)), mine: await read($, myEvents) })

    return { result: { content: [{ type: 'text', text: eventsText(events, today) }], isError: false } }
  })

  on('tool.call', { tool: 'mcp__stock-desk__show_tickers' }, async ($, e) => {
    const added = await addSymbols($, String((e as unknown as { symbols?: string }).symbols ?? ''))
    await openMain($)

    return { result: { content: [{ type: 'text', text: added.length ? `Showing ${added.join(', ')} in the stock pane.` : 'No valid tickers given.' }], isError: !added.length } }
  })

  // ---------- the main pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Link } = t
    // Every table names every element; the surface decides what draws.
    const Input = e.surface !== 'mobile' && 'Input' in t ? t.Input : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in t ? t.Svg : undefined
    const p = await read($, prefs)
    const all = await read($, tickers)
    const cal = await read($, calendar)
    const loading = await read($, busy)
    const cols = e.props.bodyColumns ?? 60
    const data = p.selected ? all[p.selected] : undefined
    const today = marketToday()
    const earnings = p.selected ? nextEarnings(cal, p.selected) : undefined
    const a: Analysis | undefined = data ? analyze(data.bars, p.range, earnings ? daysBetween(today, earnings.date) : undefined) : undefined
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
        {[{ name: '', label: 'All', count: p.watchlist.length }, ...p.groups.map(g => ({ name: g.name, label: g.name, count: g.symbols.length }))].map((g, i) => (
          <Button key={i === 0 ? 'group-all' : `group-${i - 1}`} plain={p.group === g.name ? undefined : true} variant={p.group === g.name ? 'primary' : undefined} onPress={() => void selectGroup($, g.name)}>
            {g.label} <Text dimColor>{g.count}</Text>
          </Button>
        ))}
        <Button key="manage-groups" plain dimColor={p.manageGroups ? undefined : true} onPress={() => void setPrefs($, x => ({ ...x, manageGroups: !x.manageGroups }))}>
          {p.manageGroups ? 'Done' : p.groups.length ? '⚙ Groups' : '+ Group'}
        </Button>
      </Box>
    )

    const groupTools = p.manageGroups && (
      <Box flexDirection="column" gap={1} paddingX={1} borderStyle="round" borderColor="#3b4048">
        {Input && <Input key="new-group" placeholder="New group, e.g. Chips: NVDA AMD TSM" submitLabel="Create" onSubmit={value => void createGroup($, value)} />}
        {group && (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {Input && <Input key="rename-group" label="Rename" value={group.name} submitLabel="Rename" onSubmit={value => void renameGroup($, value)} />}
            <Button key="group-left" plain onPress={() => void moveGroup($, -1)}>
              ← Move
            </Button>
            <Button key="group-right" plain onPress={() => void moveGroup($, 1)}>
              Move →
            </Button>
            <Button key="delete-group" plain dimColor onPress={() => void deleteGroup($)}>
              Delete group {group.name}
            </Button>
          </Box>
        )}
        {p.selected && p.groups.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Text>{p.selected} is in:</Text>
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
          A stock can be in several groups. Tickers added while a group is open go into it too. Deleting a group, or removing a stock from one, keeps the stock in All.
        </Text>
      </Box>
    )

    const watchlist = (
      <Box flexDirection="column" gap={1}>
        {groupTabs}
        {groupTools}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {list.length === 0 && <Text dimColor>{group ? `No stocks in ${group.name} yet. Add tickers below, or pick a stock in All and use ⚙ Groups to put it here.` : 'No stocks yet.'}</Text>}
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
      <Input key="add" placeholder={group ? `Add tickers to ${group.name}, e.g. TSLA AMD` : 'Add tickers, e.g. TSLA AMD'} submitLabel="Add" onSubmit={value => void addSymbols($, value)} />
    )

    if (!p.selected || !data) {
      return (
        <Box flexDirection="column" gap={1}>
          {watchlist}
          {addField}
          <Text dimColor>{p.selected ? `Loading ${p.selected}…` : 'Add a ticker to start.'}</Text>
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
          {q ? `${q.asOf} · ${q.marketStatus || 'Market'} · 15-min delayed` : ''}
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
            ['overview', 'Overview'],
            ['news', newsAlerts ? `News · ${newsAlerts} alert${newsAlerts === 1 ? '' : 's'}` : 'News'],
            ['calendar', 'Calendar'],
          ] as [Tab, string][]
        ).map(([tab, label]) => (
          <Button key={`tab-${tab}`} plain={p.tab === tab ? undefined : true} variant={p.tab === tab ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, tab }))}>
            {label}
          </Button>
        ))}
      </Box>
    )

    let body
    if (p.tab === 'overview') {
      if (!a) {
        body = <Text dimColor>No price history for {data.symbol}.</Text>
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
                ⤢ Expand chart
              </Button>
              <Button key="browser" plain onPress={() => void setPrefs($, x => ({ ...x, bigRange: x.range })).then(() => openInBrowser($))}>
                Open in browser (full screen)
              </Button>
            </Box>
            {Svg ? (
              <Svg
                source={candleChart({ bars: data.bars, from, a, width, colors: p.colors })}
                alt={`${data.symbol} daily candlestick chart, ${p.range}: high ${money(a.rangeHigh.price)} on ${a.rangeHigh.date}, low ${money(a.rangeLow.price)} on ${a.rangeLow.date}, last close ${money(last)}`}
              />
            ) : (
              <Text dimColor>
                The chart draws in the desktop app. {p.range}: high {money(a.rangeHigh.price)} ({a.rangeHigh.date}), low {money(a.rangeLow.price)} ({a.rangeLow.date}).
              </Text>
            )}
            <Text dimColor size="footnote">
              For each candle's open, high, low, close and volume, use ⤢ Expand chart or Open in browser. <Text color={MA_COLORS.ma20}>MA20</Text> · <Text color={MA_COLORS.ma50}>MA50</Text> · <Text color={MA_COLORS.ma200}>MA200</Text> · dashed lines are support and resistance.
            </Text>
            <Text weight="semibold">
              Key levels <Text dimColor size="footnote">· hover an underlined name for what it means</Text>
            </Text>
            {explained(levelRows(a, p.range), ['Level', 'Price', 'vs. now'], 'level')}
            <Text weight="semibold">Indicators</Text>
            {explained(statRows(a, data), ['Measure', 'Value', 'Reading'], 'stat')}
            <Text weight="semibold">Price-drop check</Text>
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
              text={
                '**Before acting on a drop, ask:** 1) Why did it fall? (News tab) 2) Is the 200-day trend still up? ' +
                '3) Where is the next support, and how much would you lose if it breaks? 4) Is earnings or a big data release coming? ' +
                '5) Would a loss to your exit level stay within the risk you set per trade (often 1–2% of the account)?'
              }
            />
          </Box>
        )
      }
    } else if (p.tab === 'news') {
      const sym = encodeURIComponent(data.symbol)
      body = (
        <Box flexDirection="column" gap={1}>
          {data.news.length === 0 && <Text dimColor>No recent headlines from Nasdaq.</Text>}
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
          <Text dimColor size="footnote">⚠ marks headlines with words like lawsuit, probe, downgrade, recall or guidance cut: possible incidents worth reading first.</Text>
          <Text>
            More: <Link href={`https://finance.yahoo.com/quote/${sym}/news`} label="Yahoo Finance" /> · <Link href={`https://news.google.com/search?q=${sym}%20stock`} label="Google News" /> ·{' '}
            <Link href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${sym}&type=8-K`} label="SEC filings (8-K)" />
          </Text>
        </Box>
      )
    } else {
      const upcoming = buildEvents({ today, horizon: 14, calendar: cal, tickers: all, watchlist: followed(p, await read($, portfolio)), mine: await read($, myEvents) }).filter(ev => ev.importance === 3)
      body = (
        <Box flexDirection="column" gap={1}>
          <Button key="open-cal" variant="primary" onPress={() => void openCalendar($)}>
            Open the full market calendar
          </Button>
          {cal.fetchedAt === 0 && <Text dimColor>Loading the calendar…</Text>}
          <Text weight="semibold">Most important, next two weeks</Text>
          {upcoming.length === 0 && <Text dimColor>Nothing marked ★★★.</Text>}
          {upcoming.map(ev => (
            <Text>
              <Text color={CATEGORY[ev.category].color}>● </Text>
              {dayLabel(ev.date)}
              {ev.time ? ` ${ev.time} ET` : ''} · {ev.title}
            </Text>
          ))}
        </Box>
      )
    }

    const isLoading = loading.includes(p.selected) || (p.tab === 'calendar' && loading.includes('#calendar'))

    return (
      <Box flexDirection="column" gap={1}>
        {watchlist}
        {addField}
        {header}
        {tabs}
        {body}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="refresh" onPress={() => void Promise.all([refreshTicker($, p.selected, true), refreshCalendar($, true)])}>
            {isLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            key="ask"
            onPress={() =>
              void $.prompt.submit({
                text: `Give me a full read on ${data.symbol}: use the us-stock-analysis skill for fundamentals and technicals, and check the latest news and upcoming catalysts. Point out anything that explains recent price drops.`,
                asUser: true,
              })
            }
          >
            Ask Claude about {data.symbol}
          </Button>
          <Button key="open-portfolio" onPress={() => void openPortfolio($)}>
            My portfolio
          </Button>
          <Button key="colors" plain onPress={() => void setPrefs($, x => ({ ...x, colors: x.colors === 'red-up' ? 'green-up' : 'red-up' }))}>
            {p.colors === 'red-up' ? 'Colors: red up (红涨绿跌)' : 'Colors: green up'}
          </Button>
          <Button key="remove" plain dimColor onPress={() => void remove($, data.symbol)}>
            {group ? `Remove ${data.symbol} from ${group.name}` : `Remove ${data.symbol}`}
          </Button>
        </Box>
        <Text dimColor size="footnote">
          Updated {ago(data.fetchedAt)} · data: Nasdaq · auto-refresh every 5 min. Signals come from price history only; this is not investment advice.
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
    const all = await read($, tickers)
    const data = all[p.selected]
    const a = data ? analyze(data.bars, p.bigRange) : undefined
    if (!data || !a) return <Text dimColor>Loading {p.selected}…</Text>

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
            Open in browser (full screen)
          </Button>
          <Button key="hover-candles" plain={p.hoverCandles ? undefined : true} variant={p.hoverCandles ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, hoverCandles: !x.hoverCandles }))}>
            {p.hoverCandles ? 'Candle details on hover: on' : 'Candle details on hover: off'}
          </Button>
        </Box>
        {Svg ? (
          // An interactive SVG is drawn in a frame of its own, which keeps the
          // scroll wheel while the pointer is over it; it is opt-in for that.
          <Svg
            source={candleChart({ bars: data.bars, from, a, width, height, colors: p.colors })}
            alt={`${data.symbol} daily candlestick chart, ${p.bigRange}`}
            isInteractive={p.hoverCandles ? true : undefined}
          />
        ) : (
          <Text dimColor>The chart draws in the desktop app; use Open in browser here.</Text>
        )}
        <Text dimColor size="footnote">
          {p.hoverCandles ? 'Hover any candle for its numbers. While this is on, scroll with the pointer beside the chart, not over it. ' : 'Turn on candle details to hover each candle, or see the last sessions below. '}
          <Text color={MA_COLORS.ma20}>MA20</Text> · <Text color={MA_COLORS.ma50}>MA50</Text> · <Text color={MA_COLORS.ma200}>MA200</Text> · Esc closes this pane.
        </Text>
        <Text weight="semibold">Last 10 sessions</Text>
        <Markdown text={sessionsMarkdown(data.bars, 10)} />
      </Box>
    )
  })

  // ---------- the calendar pane ----------

  on('ui.render', { component: 'Pane', requestId: CAL }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Input = e.surface !== 'mobile' && 'Input' in t ? t.Input : undefined
    const p = await read($, prefs)
    const cal = await read($, calendar)
    const loading = await read($, busy)
    const today = marketToday()
    const events = buildEvents({ today, horizon: p.calHorizon, calendar: cal, tickers: await read($, tickers), watchlist: followed(p, await read($, portfolio)), mine: await read($, myEvents) })
    const shown = events.filter(ev => p.calCategories.includes(ev.category))
    const days = [...new Set(shown.map(ev => ev.date))]
    const counts = new Map<CalCategory, number>()
    for (const ev of events) counts.set(ev.category, (counts.get(ev.category) ?? 0) + 1)

    const toggle = (c: CalCategory) =>
      void setPrefs($, x => ({ ...x, calCategories: x.calCategories.includes(c) ? x.calCategories.filter(y => y !== c) : [...x.calCategories, c] }))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {HORIZONS.map(([span, label]) => (
            <Button key={`h-${span}`} plain={p.calHorizon === span ? undefined : true} variant={p.calHorizon === span ? 'primary' : undefined} onPress={() => void setPrefs($, x => ({ ...x, calHorizon: span }))}>
              {label}
            </Button>
          ))}
          <Button key="cal-refresh" plain onPress={() => void refreshCalendar($, true)}>
            {loading.includes('#calendar') ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {ALL_CATEGORIES.map(c => {
            const isOn = p.calCategories.includes(c)

            return (
              <Button key={`cat-${c}`} plain={isOn ? undefined : true} variant={isOn ? 'primary' : undefined} onPress={() => toggle(c)}>
                <Text color={isOn ? undefined : CATEGORY[c].color}>●</Text> {CATEGORY[c].label} <Text dimColor>{counts.get(c) ?? 0}</Text>
              </Button>
            )
          })}
        </Box>
        {Input && <Input key="add-event" placeholder="Add your own: 2026-11-20 Nvidia GTC" submitLabel="Add" onSubmit={value => void addMyEvent($, value)} />}
        {cal.fetchedAt === 0 && <Text dimColor>Loading earnings and economic data…</Text>}
        {cal.error && <Text color="warning">{cal.error}</Text>}
        {shown.length === 0 && cal.fetchedAt > 0 && <Text dimColor>Nothing in this window for the kinds you picked.</Text>}
        {days.map(day => (
          <Box flexDirection="column">
            <Text weight="semibold">
              {dayLabel(day)} <Text dimColor>· {relative(today, day)}</Text>
            </Text>
            {shown
              .filter(ev => ev.date === day)
              .map(ev => (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text>
                    <Text color={CATEGORY[ev.category].color}>● {CATEGORY[ev.category].label}</Text>{' '}
                    <Text color={ev.importance === 3 ? 'warning' : 'subtle'}>{STARS[ev.importance]}</Text> {ev.time ? `${ev.time} ET · ` : ''}
                    <Text weight={ev.importance === 3 ? 'semibold' : undefined}>{ev.title}</Text>
                  </Text>
                  {ev.detail && (
                    <Text dimColor size="footnote">
                      {ev.detail}
                    </Text>
                  )}
                  {ev.myId && (
                    <Button key={`del-${ev.myId}`} plain dimColor onPress={() => void setMyEvents($, list => list.filter(m => m.id !== ev.myId))}>
                      Remove
                    </Button>
                  )}
                </Box>
              ))}
          </Box>
        ))}
        <Text dimColor size="footnote">
          ★★★ moves the whole market · ★★ notable · ★ minor. Earnings and economic releases come from Nasdaq and reach four weeks ahead; Fed meetings follow the Fed's 2026 schedule; holidays, options expiry and election day are worked out from exchange and federal rules. Ask Claude to add other events (a funding deadline, a court ruling, a summit) and they appear here. Times are US Eastern.
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
    const pf = await read($, portfolio)
    const all = await read($, tickers)
    const sized = await read($, sizer)
    const today = marketToday()
    const cols = e.props.bodyColumns ?? 80
    const { holdings, totals, sectors } = valuePortfolio(pf, all)
    const checks = runChecks(pf, all, await read($, calendar), today)
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
      ...(holdings.length > 8 ? [{ label: 'Other', pct: holdings.slice(8).reduce((s, pos) => s + pos.weight, 0), color: palette[8]! }] : []),
      ...(totals.cash > 0 && totals.value > 0 ? [{ label: 'Cash', pct: (totals.cash / totals.value) * 100, color: '#9ca3af' }] : []),
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
      `| Ticker | Shares | Avg cost | Price | Value | Weight | Today | Profit/loss | Stop / target |\n|---|---|---|---|---|---|---|---|---|\n` +
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
          {stat('Total value', 'Everything you hold at the latest prices, plus the cash you entered.', usd(totals.value))}
          {stat("Today's change", "How much your holdings moved in the latest session, in dollars.", usd(totals.day), pnlColor(totals.day))}
          {stat('Unrealized P/L', 'Gain or loss on what you still hold: current value minus what you paid. It becomes real only when you sell.', `${usd(totals.pnl)} (${signed(totals.pnlPct, 1)}%)`, pnlColor(totals.pnl))}
          {stat('Realized P/L', 'Gain or loss already locked in by the sells you entered here.', usd(totals.realized), pnlColor(totals.realized))}
          {stat('Cash', 'Uninvested money, as you entered it ("cash 5000"). Buys and sells here do not change it.', usd(totals.cash))}
          {stat('Risk to stops', 'What you would lose if every position fell to its stop. Positions without a stop are not counted.', usd(totals.openRisk))}
        </Box>
        {holdings.length > 0 && (
          <Box flexDirection="column">
            {Svg && <Svg source={bar} alt={`Allocation: ${slices.map(sl => `${sl.label} ${sl.pct.toFixed(0)}%`).join(', ')}`} />}
            <Text dimColor size="footnote">
              {slices.map(sl => (
                <Text>
                  <Text color={sl.color}>■</Text> {sl.label} {sl.pct.toFixed(1)}%{'   '}
                </Text>
              ))}
            </Text>
            <Text dimColor size="footnote">
              Sectors: {sectors.map(([name, pct]) => `${name} ${pct.toFixed(0)}%`).join(' · ')}
            </Text>
          </Box>
        )}
        {Input && (
          <Input key="trade" placeholder='Add a trade: "NVDA 50 @ 120.5 stop 110 target 160", "sell NVDA 10 @ 140" or "cash 5000"' submitLabel="Enter" onSubmit={value => void enterTrade($, value)} />
        )}
        {holdings.length === 0 ? (
          <Text dimColor>No positions yet. Enter one above, e.g. NVDA 50 @ 120.5 stop 110. Your holdings stay on this computer.</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Markdown text={positionsTable} />
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Text dimColor>Edit:</Text>
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
              {editing.symbol} <Text dimColor>· press Enter in a field to save it</Text>
            </Text>
            <Input key={`pos-shares-${editing.symbol}`} label="Shares" value={String(editing.shares)} onSubmit={v => void editPosition($, editing.symbol, 'shares', v)} />
            <Input key={`pos-cost-${editing.symbol}`} label="Average cost per share" value={String(editing.cost)} onSubmit={v => void editPosition($, editing.symbol, 'cost', v)} />
            <Input key={`pos-stop-${editing.symbol}`} label="Stop (the price where you plan to get out; empty to clear)" value={editing.stop === undefined ? '' : String(editing.stop)} onSubmit={v => void editPosition($, editing.symbol, 'stop', v)} />
            <Input key={`pos-target-${editing.symbol}`} label="Target (empty to clear)" value={editing.target === undefined ? '' : String(editing.target)} onSubmit={v => void editPosition($, editing.symbol, 'target', v)} />
            <Input key={`pos-note-${editing.symbol}`} label="Note: why you bought it, what would change your mind" value={editing.note ?? ''} rows={2} onSubmit={v => void editPosition($, editing.symbol, 'note', v)} />
            <Box flexDirection="row" gap={1}>
              <Button key="pos-chart" onPress={() => void select($, editing.symbol).then(() => openMain($))}>
                Open its chart
              </Button>
              <Button key="pos-remove" plain dimColor onPress={() => void setPortfolio($, x => ({ ...x, positions: x.positions.filter(y => y.symbol !== editing.symbol) })).then(() => setPrefs($, x => ({ ...x, editing: undefined })))}>
                Remove position
              </Button>
              <Button key="pos-done" plain onPress={() => void setPrefs($, x => ({ ...x, editing: undefined }))}>
                Done
              </Button>
            </Box>
          </Box>
        )}
        {holdings.length > 0 && (
          <Box flexDirection="column">
            <Text weight="semibold">
              Checks against your rules <Text dimColor size="footnote">· {checks.filter(c => c.tone === 'risk' || c.tone === 'warn').length} need a look</Text>
            </Text>
            {checks.length === 0 && <Text color="success">● Nothing crosses your rules.</Text>}
            {checks.map(c => (
              <Text>
                <Text color={TONE_COLOR[c.tone]}>{TONE_MARK[c.tone]} </Text>
                {c.text}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <Text weight="semibold">Position-size calculator</Text>
          {Input && <Input key="sizer" placeholder='Entry and stop, e.g. "NVDA 180 stop 165"' submitLabel="Size it" onSubmit={value => void update($, sizer, () => sizePosition(value, totals.value, pf.rules))} />}
          <Text dimColor={!sized}>{sized || `How many shares keep a stopped-out trade to your ${pf.rules.riskPerTradePct}% risk per trade.`}</Text>
        </Box>
        <Button key="rules" plain onPress={() => void setPrefs($, x => ({ ...x, showRules: !x.showRules }))}>
          {p.showRules ? '▾ Your rules' : '▸ Your rules'} ({pf.rules.maxWeightPct}% max position · {pf.rules.maxLossPct}% loss alert · {pf.rules.riskPerTradePct}% risk per trade)
        </Button>
        {p.showRules &&
          Input &&
          RULE_LABELS.map(r => (
            <Box flexDirection="column">
              <Input key={`rule-${r.key}`} label={`${r.label} (${r.unit})`} value={String(pf.rules[r.key])} onSubmit={v => void setRule($, r.key, v)} />
              <Text dimColor size="footnote">
                {r.meaning}
              </Text>
            </Box>
          ))}
        {pf.trades.length > 0 && (
          <Box flexDirection="column">
            <Text weight="semibold">Recent trades</Text>
            <Markdown
              text={
                `| Date | Trade | Price | Realized |\n|---|---|---|---|\n` +
                pf.trades
                  .slice(-6)
                  .reverse()
                  .map(tr => `| ${tr.date} | ${tr.side} ${tr.shares} ${tr.symbol} | ${usd(tr.price)} | ${tr.realized === undefined ? '—' : usd(tr.realized)} |`)
                  .join('\n')
              }
            />
          </Box>
        )}
        <Text dimColor size="footnote">
          Checks compare your positions with the rules you set; they are not recommendations to buy or sell. Prices are about 15 minutes delayed. Your holdings are kept only on this computer.
        </Text>
      </Box>
    )
  })
}
