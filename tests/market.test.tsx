import { expect, test } from 'claude-code/testing'

// The market read covers SPX and NDX side by side: market_overview analyses
// SPY and QQQ, market_intraday reads both sessions, the futures module leads
// with each fund's own contract, and the pane shows both above its tabs.

const PANE = {
  plugin: 'stock-desk',
  component: 'Pane',
  requestId: 'stock-desk',
  props: { title: 'Stocks', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

type Res = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const json = (body: unknown): Res => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(body) })
const missing: Res = { status: 404, ok: false, headers: {}, text: '' }

// Three years of daily rows, newest first: a long rise, then a slide on heavy volume.
function history(): unknown {
  const rows: Record<string, string>[] = []
  const days: string[] = []
  for (const d = new Date('2023-11-01T12:00:00Z'); d < new Date('2026-11-19T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10))
  let price = 100
  days.forEach((iso, i) => {
    const sliding = i >= days.length - 15
    const open = price
    price = sliding ? price * 0.985 : price * (1 + 0.0012 + 0.012 * Math.sin(i / 6))
    const [y, m, d] = iso.split('-')
    rows.unshift({
      date: `${m}/${d}/${y}`,
      open: `$${open.toFixed(2)}`,
      high: `$${(Math.max(open, price) * 1.008).toFixed(2)}`,
      low: `$${(Math.min(open, price) * 0.992).toFixed(2)}`,
      close: `$${price.toFixed(2)}`,
      volume: sliding ? '60,000,000' : `${30 + (i % 7)},000,000`,
    })
  })

  return { data: { tradesTable: { rows } } }
}
const HISTORY = history()

// ES +1.24%, NQ +2.16% vs settle.
const CNBC_FUTURES = {
  FormattedQuoteResult: {
    FormattedQuote: [
      { symbol: '@SP.1', code: 0, name: "S&P 500 Fut (Dec'26)", altSymbol: 'ESZ26', last: '7,431.75', change: '+91.25', change_pct: '+1.24%', previous_day_closing: '7,340.50', last_time: '2026-11-19T05:53:07.000-0500', expiration_date: '2026-12-18' },
      { symbol: '@ND.1', code: 0, name: "NASDAQ 100 Fut (Dec'26)", altSymbol: 'NQZ26', last: '27,775.25', change: '+588.50', change_pct: '+2.16%', previous_day_closing: '27,186.75', last_time: '2026-11-19T05:53:08.000-0500', expiration_date: '2026-12-18' },
    ],
  },
}

const pad = (n: number) => String(n).padStart(2, '0')

/** CNBC-shaped bars: 1-minute bars of one day (04:00–16:00), or 5-minute regular-session bars of the 30 weekdays up to a date. QQQ runs a little stronger than SPY. */
function cnbcBars(url: string): Res {
  const m = /\/bars\/([^/]+)\/(1M|5M)\/(\d{8})\d{6}\/(\d{8})\d{6}\//.exec(url)
  if (!m) return missing
  const [, sym, iv, from, to] = m
  const tilt = sym === 'QQQ' || sym === '@ND.1' ? 0.02 : 0.01
  const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  const rows: unknown[] = []
  const push = (date: string, min: number, price: number, v: number) => {
    const [y, mo, d] = date.split('-').map(Number)
    const t = Date.UTC(y!, mo! - 1, d!, Math.floor(min / 60) + 5, min % 60)
    rows.push({ open: price.toFixed(2), high: (price * 1.001).toFixed(2), low: (price * 0.999).toFixed(2), close: (price * 1.0002).toFixed(2), volume: v, tradeTime: `${date.replace(/-/g, '')}${pad(Math.floor(min / 60))}${pad(min % 60)}00`, tradeTimeinMills: t })
  }
  const weekday = (date: string) => ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())
  if (iv === '1M') {
    const date = iso(from!)
    if (weekday(date)) for (let min = 240; min < 960; min++) push(date, min, 300 + Math.sin(min / 25) * 3 + (min > 570 ? (min - 570) * tilt : 0), min >= 570 ? 20_000 : 800)
  } else {
    const end = new Date(`${iso(to!)}T12:00:00Z`)
    const dates: string[] = []
    for (let d = new Date(end); dates.length < 30; d.setUTCDate(d.getUTCDate() - 1)) if (weekday(d.toISOString().slice(0, 10))) dates.unshift(d.toISOString().slice(0, 10))
    dates.forEach((date, i) => {
      for (let min = 570; min < 960; min += 5) push(date, min, 290 + i * 0.3 + Math.sin(min / 30), 100_000)
    })
  }

  return json({ barData: { priceBars: rows } })
}

const served: string[] = []

function respond(url: string): Res {
  served.push(url)
  if (url.includes('ts-api.cnbc.com/harmony/app/bars/')) return cnbcBars(url)
  if (url.includes('/quote/') && url.includes('/info')) return json({ data: null })
  if (url.includes('/historical') && url.includes('api.nasdaq.com')) return json(HISTORY)
  if (url.includes('quote.cnbc.com') && url.includes('SP.1')) return json(CNBC_FUTURES)
  if (url.includes('/calendar/')) return json({ data: { rows: [] } })

  return missing
}

const callTool = ($: { tool: { call: (input: never) => Promise<unknown> } }, input: Record<string, unknown>) => $.tool.call(input as never) as Promise<{ result?: unknown; isError?: boolean }>

test('market_overview analyses SPY and QQQ side by side, each futures read led by its own contract', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))

  const answer = await callTool($, { tool: 'mcp__stock-desk__market_overview', horizon_days: 5 })
  expect(typeof answer.result).toBe('string')
  const text = String(answer.result)
  expect(text).toContain('## SPY vs QQQ (SPX vs NDX), horizon 5 trading days')
  expect(text).toContain('| | SPY | QQQ |')
  for (const row of ['| Composite |', '| Trend |', '| Futures |', '| Close vs MA20 / MA50 / MA200 |', '| ADX(14) |', '| Analogs 5 days: win vs baseline |', '| Nearest resistance / support |'])
    expect(text).toContain(row)
  expect(text).toMatch(/\| Futures \| [+-]\d+ \(\d\.\d\d\) · ES \| [+-]\d+ \(\d\.\d\d\) · NQ \|/)
  expect(text).toMatch(/\*\*(Both|They disagree)/)
  expect(text).toContain('## SPY\n\n# SPY')
  expect(text).toContain('## QQQ\n\n# QQQ')
  // Each fund's futures verdict leads with its own contract.
  expect(text).toContain('Futures point higher (bullish): ES +1.24%, NQ +2.16% vs settle')
  expect(text).toContain('Futures point higher (bullish): NQ +2.16%, ES +1.24% vs settle')
})

test('an inverse index fund reads the futures signal the other way', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const text = String((await callTool($, { tool: 'mcp__stock-desk__analyze_ticker', symbol: 'SQQQ', horizon_days: 5 })).result)
  expect(text).toContain('SQQQ is an inverse fund: the futures signal counts against it')
  expect(text).toMatch(/\| Futures \| -\d+ \|/)
})

test('market_intraday reads SPY and QQQ (or ES and NQ) side by side, with the market-wide context once', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))

  const etf = await callTool($, { tool: 'mcp__stock-desk__market_intraday' })
  expect(typeof etf.result).toBe('string')
  expect(etf.isError).toBeUndefined()
  const text = String(etf.result)
  expect(text).toMatch(/^# Market intraday — SPY and QQQ, /)
  expect(text).toContain('| | SPY | QQQ |')
  // Two real columns: the separator between them is not escaped.
  expect(text).toMatch(/\n\| Price \| [^|\\]+ \| [^|\\]+ \|\n/)
  expect(text.slice(0, text.indexOf('# SPY intraday'))).not.toContain('\\|')
  for (const row of ['| Price |', '| Gap |', '| vs VWAP |', '| First hour (IB) |', '| Lean, rest of day |', '| Nearest level above |']) expect(text).toContain(row)
  expect(text).toContain('# SPY intraday')
  expect(text).toContain('# QQQ intraday')
  // The source note is printed once for both, not once per index.
  expect(text.split('Bars: CNBC real-time').length - 1).toBe(1)

  const fut = String((await callTool($, { tool: 'mcp__stock-desk__market_intraday', use: 'futures' })).result)
  expect(fut).toMatch(/^# Market intraday — @SP\.1 and @ND\.1, /)

  // The 5-minute history is kept between reads: a second read of both fetches only today's bars.
  served.length = 0
  await callTool($, { tool: 'mcp__stock-desk__market_intraday' })
  expect(served.filter(u => u.includes('/5M/'))).toEqual([])
  expect(served.filter(u => u.includes('/1M/')).length).toBe(2)
})

test('the market strip shows SPY and QQQ above Analysis and Intraday, hides, and opens either index', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'add', text: 'TSLA' })
  await ui.press({ key: 'tab-analysis' })
  expect(await ui.find({ type: 'Button', key: 'market-SPY' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'market-QQQ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SPY for SPX, QQQ for NDX/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /conf \d\.\d\d · close / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^(Both|They disagree)/ })).toBeDefined()

  await ui.press({ key: 'tab-intraday' })
  expect(await ui.find({ type: 'Text', text: /· today · SPY for SPX/ })).toBeDefined()
  // Price and change are there at any hour (VWAP only once the session is open).
  expect(await ui.find({ type: 'Text', text: /^\d+\.\d\d [+-]\d+\.\d\d%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /(stronger index today|move together)/ })).toBeDefined()

  // Opening QQQ from the strip selects it; TSLA stays where it was.
  await ui.press({ key: 'market-QQQ' })
  expect((await ui.find({ type: 'Button', key: 'sym-QQQ' }))?.props.variant).toBe('primary')
  expect((await ui.find({ type: 'Button', key: 'market-QQQ' }))?.props.variant).toBe('primary')
  expect((await ui.find({ type: 'Button', key: 'sym-TSLA' }))?.props.variant).toBe('secondary')

  await ui.press({ key: 'market-hide' })
  expect(await ui.find({ type: 'Button', key: 'market-SPY' })).toBeUndefined()
  await ui.press({ key: 'market-show' })
  expect(await ui.find({ type: 'Button', key: 'market-SPY' })).toBeDefined()
  await ui.unmount()
})
