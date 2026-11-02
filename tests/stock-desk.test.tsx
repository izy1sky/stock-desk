import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'stock-desk',
  component: 'Pane',
  requestId: 'stock-desk',
  props: {
    title: 'Stocks',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Nasdaq answers, newest first, for a stock that rose for a year and then
// dropped 12% on heavy volume in its last session.
function history(): unknown {
  const rows: Record<string, string>[] = []
  let price = 100
  const day = new Date('2024-11-01T12:00:00Z')
  const days: string[] = []
  while (day < new Date('2026-10-31T00:00:00Z')) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days.push(day.toISOString().slice(0, 10))
    day.setUTCDate(day.getUTCDate() + 1)
  }
  days.forEach((iso, i) => {
    const isLast = i === days.length - 1
    const open = price
    price = isLast ? price * 0.88 : price * (1 + 0.002 + 0.01 * Math.sin(i / 7))
    const [y, m, d] = iso.split('-')
    rows.unshift({
      date: `${m}/${d}/${y}`,
      open: `$${open.toFixed(2)}`,
      high: `$${(Math.max(open, price) * 1.01).toFixed(2)}`,
      low: `$${(Math.min(open, price) * 0.99).toFixed(2)}`,
      close: `$${price.toFixed(2)}`,
      volume: isLast ? '90,000,000' : '30,000,000',
    })
  })

  return { data: { tradesTable: { rows } } }
}

// TSLA reports on the first trading day the calendar asks about.
let earningsServed = 0

function respond(url: string): { status: number; ok: boolean; headers: Record<string, string>; text: string } {
  const json = (body: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(body) })
  if (url.includes('/quote/TSLA/info'))
    return json({
      data: {
        symbol: 'TSLA',
        companyName: 'Tesla, Inc. Common Stock',
        marketStatus: 'Closed',
        primaryData: { lastSalePrice: '$300.00', netChange: '-40.00', percentageChange: '-11.76%', volume: '90,000,000', lastTradeTimestamp: 'Oct 30, 2026' },
      },
    })
  if (url.includes('/quote/') && url.includes('/info')) return json({ data: null })
  if (url.includes('/historical')) return json(history())
  if (url.includes('/summary')) return json({ data: { summaryData: { Sector: { value: 'Consumer Discretionary' }, MarketCap: { value: '1,000,000,000,000' } } } })
  if (url.includes('articlebysymbol'))
    return json({
      data: {
        rows: [
          { title: 'Regulators open probe into Tesla driver assistance', publisher: 'Reuters', ago: '2 hours ago', url: '/articles/probe' },
          { title: 'Tesla deliveries in focus', publisher: 'Motley Fool', ago: '1 day ago', url: '/articles/deliveries' },
        ],
      },
    })
  if (url.includes('/calendar/earnings') && !earningsServed++)
    return json({ data: { rows: [{ symbol: 'TSLA', name: 'Tesla', time: 'time-after-hours', epsForecast: '$0.55', lastYearEPS: '$0.50', fiscalQuarterEnding: 'Sep/2026', marketCap: '$1,000,000,000,000' }] } })
  if (url.includes('/calendar/earnings')) return json({ data: { rows: [] } })
  if (url.includes('/calendar/economicevents'))
    return json({ data: { rows: [{ gmt: '08:30', country: 'United States', eventName: 'Nonfarm Payrolls', consensus: '63K', previous: '40K', actual: '&nbsp;' }] } })

  return { status: 404, ok: false, headers: {}, text: '' }
}

test('adding a ticker loads its chart, drop check, news and calendar', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'add', text: 'tsla' })

  expect((await ui.find({ type: 'Text', text: /^Tesla, Inc\./ }))?.text).toContain('TSLA')
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  // The last session fell 12% on 3× volume: both are called out.
  expect(await ui.find({ type: 'Text', text: /normal day's range/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /heavy volume/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Nearest support/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /News · 1 alert/ })).toBeDefined()

  await ui.press({ key: 'tab-news' })
  expect(await ui.find({ type: 'Text', text: /⚠/ })).toBeDefined()

  await ui.unmount()
})

test('key levels and indicators explain themselves on hover, with no extra column', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'add', text: 'TSLA' })
  await ui.press({ key: 'tab-overview' })

  expect((await ui.findAll({ type: 'Markdown' })).some(t => (t.text ?? '').includes('What it means'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /^52-week high$/ })).toBeDefined()
  // The meaning sits in a card that hovering the name reveals.
  expect(await ui.find({ type: 'Text', text: /Sellers took over here/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Momentum from 0 to 100/ })).toBeDefined()
  await ui.unmount()
})

test('the portfolio pane values positions and checks them against your rules', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ui = await $.ui.mount({ ...PANE, requestId: 'stock-desk-portfolio', props: { ...PANE.props, title: 'My portfolio' }, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No positions yet/ })).toBeDefined()

  // TSLA last traded at $300 (fixture), bought at 350 with a stop at 310.
  await ui.input({ key: 'trade', text: 'TSLA 10 @ 350 stop 310' })
  await ui.input({ key: 'trade', text: 'cash 1000' })
  const table = (await ui.findAll({ type: 'Markdown' })).map(t => t.text ?? '').find(t => t.includes('| Ticker |'))
  expect(table).toContain('**TSLA**')
  expect(table).toContain('-$500.00')
  expect(await ui.find({ type: 'Text', text: /at or below your stop of \$310\.00/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /14\.3% below your cost/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /75\.0% of your portfolio, above your 25% limit/ })).toBeDefined()

  // A rule the person changes takes effect.
  await ui.press({ key: 'rules' })
  await ui.input({ key: 'rule-maxWeightPct', text: '80' })
  expect(await ui.find({ type: 'Text', text: /above your 25% limit/ })).toBeUndefined()

  // Selling records the realized loss; the calculator sizes from the rules.
  await ui.input({ key: 'trade', text: 'sell TSLA 4 @ 300' })
  expect(await ui.find({ type: 'Text', text: /^-\$200\.00$/ })).toBeDefined()
  await ui.input({ key: 'sizer', text: 'NVDA 180 stop 165' })
  expect(await ui.find({ type: 'Text', text: /^NVDA: 1 shares/ })).toBeDefined()
  await ui.unmount()
})

test('the calendar pane gathers earnings, data, holidays, your events and Claude\'s', async ($, on) => {
  earningsServed = 0
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const main = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await main.input({ key: 'add', text: 'TSLA' })
  await main.press({ key: 'tab-calendar' })
  await main.press({ key: 'open-cal' })
  await main.unmount()

  const cal = await $.ui.mount({ ...PANE, requestId: 'stock-desk-calendar', props: { ...PANE.props, title: 'Market calendar' }, surface: 'desktop' })
  await cal.press({ key: 'h-90' })
  expect(await cal.find({ type: 'Text', text: /TSLA earnings after the close/ })).toBeDefined()
  expect(await cal.find({ type: 'Text', text: /Nonfarm Payrolls/ })).toBeDefined()
  expect(await cal.find({ type: 'Text', text: /Market closed: (Thanksgiving|Christmas|New Year)/ })).toBeDefined()
  expect(await cal.find({ type: 'Text', text: /options expiration|Quad witching/ })).toBeDefined()

  await cal.input({ key: 'add-event', text: 'Nov 20 Nvidia GTC keynote' })
  expect(await cal.find({ type: 'Text', text: /Nvidia GTC keynote/ })).toBeDefined()

  await $.tool.call({ tool: 'mcp__stock-desk__calendar_add', date: '2026-11-25', title: 'Funding deadline', category: 'politics', importance: 3 })
  expect(await cal.find({ type: 'Text', text: /Funding deadline/ })).toBeDefined()

  await cal.press({ key: 'cat-politics' })
  expect(await cal.find({ type: 'Text', text: /Funding deadline/ })).toBeUndefined()
  await cal.unmount()
})

test('charts scroll with the pane: no interactive frame unless the person turns hover on', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const main = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await main.input({ key: 'add', text: 'TSLA' })
  await main.press({ key: 'tab-overview' })
  expect(await main.find({ type: 'Svg' })).toBeDefined()
  expect(JSON.stringify(await main.drawn())).not.toContain('isInteractive')
  await main.unmount()

  const chart = await $.ui.mount({ ...PANE, requestId: 'stock-desk-chart', props: { ...PANE.props, title: 'TSLA chart' }, surface: 'desktop' })
  expect(JSON.stringify(await chart.drawn())).not.toContain('isInteractive')
  await chart.press({ key: 'hover-candles' })
  expect(JSON.stringify(await chart.drawn())).toContain('"isInteractive":true')
  await chart.press({ key: 'hover-candles' })
  await chart.unmount()
})

test('the terminal gets a text summary in place of the chart', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'add', text: 'TSLA' })

  await ui.press({ key: 'tab-overview' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /chart draws in the desktop app/ })).toBeDefined()
  await ui.unmount()
})

test('groups in the top row sort tickers, and a stock can sit in several', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'group-all' })
  await ui.press({ key: 'manage-groups' })
  await ui.input({ key: 'new-group', text: 'EV: TSLA' })

  // The new group opens with only its own ticker in the row.
  expect(await ui.find({ type: 'Button', key: 'group-0', text: /EV/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'sym-TSLA' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'sym-AAPL' })).toBeUndefined()

  // A second group; AAPL joins it from All, and TSLA joins both.
  await ui.input({ key: 'new-group', text: 'Watch' })
  expect(await ui.find({ type: 'Text', text: /No stocks in Watch yet/ })).toBeDefined()
  await ui.input({ key: 'add', text: 'AAPL' })
  await ui.press({ key: 'group-0' })
  await ui.press({ key: 'member-1' })
  await ui.press({ key: 'group-1' })
  expect(await ui.find({ type: 'Button', key: 'sym-TSLA' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'sym-AAPL' })).toBeDefined()

  // Removing from a group keeps the stock in All; renaming and deleting work.
  await ui.press({ key: 'sym-TSLA' })
  await ui.press({ key: 'remove' })
  expect(await ui.find({ type: 'Button', key: 'sym-TSLA' })).toBeUndefined()
  await ui.input({ key: 'rename-group', text: 'Big tech' })
  expect(await ui.find({ type: 'Button', key: 'group-1', text: /Big tech/ })).toBeDefined()
  await ui.press({ key: 'delete-group' })
  expect(await ui.find({ type: 'Button', key: 'group-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'sym-TSLA' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'sym-AAPL' })).toBeDefined()
  await ui.press({ key: 'manage-groups' })
  await ui.unmount()
})
