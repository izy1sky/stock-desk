import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'stock-desk',
  component: 'Pane',
  requestId: 'stock-desk',
  props: { title: 'Stocks', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type Res = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const json = (body: unknown): Res => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(body) })
const missing: Res = { status: 404, ok: false, headers: {}, text: '' }

// Three years of Nasdaq daily rows, newest first: a long rise, then a
// three-week slide on heavy volume.
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

const CNBC_FUTURES = {
  FormattedQuoteResult: {
    FormattedQuote: [
      { symbol: '@SP.1', code: 0, name: "S&P 500 Fut (Dec'26)", altSymbol: 'ESZ26', last: '7,431.75', change: '+91.25', change_pct: '+1.24%', previous_day_closing: '7,340.50', last_time: '2026-11-19T05:53:07.000-0500', expiration_date: '2026-12-18' },
      { symbol: '@ND.1', code: 0, name: "NASDAQ 100 Fut (Dec'26)", altSymbol: 'NQZ26', last: '27,775.25', change: '+588.50', change_pct: '+2.16%', previous_day_closing: '27,186.75', last_time: '2026-11-19T05:53:08.000-0500', expiration_date: '2026-12-18' },
    ],
  },
}

function respond(url: string): Res {
  if (url.includes('/quote/TSLA/info'))
    return json({ data: { symbol: 'TSLA', companyName: 'Tesla, Inc. Common Stock', marketStatus: 'Closed', primaryData: { lastSalePrice: '$300.00', netChange: '-4.00', percentageChange: '-1.3%', volume: '60,000,000', lastTradeTimestamp: 'Nov 18, 2026' } } })
  if (url.includes('/quote/') && url.includes('/info')) return json({ data: null })
  if (url.includes('/historical') && url.includes('api.nasdaq.com')) return json(HISTORY)
  if (url.includes('quote.cnbc.com') && url.includes('SP.1')) return json(CNBC_FUTURES)
  if (url.includes('/calendar/')) return json({ data: { rows: [] } })

  return missing
}

const resultText = (r: unknown) => JSON.stringify(r)
// The new tools are not in the generated tool-name types until the mod has loaded once.
const callTool = ($: { tool: { call: (input: never) => Promise<unknown> } }, input: Record<string, unknown>) => $.tool.call(input as never)

test('the Analysis tab leads: composite bias, modules, levels, scenarios and analogs, with the gaps named', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'add', text: 'TSLA' })
  await ui.press({ key: 'tab-analysis' })

  expect(await ui.find({ type: 'Text', text: /^(BULLISH|LEAN BULLISH|NEUTRAL|LEAN BEARISH|BEARISH)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Trend$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Volume \/ flow$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Futures$/ })).toBeDefined()
  const md = (await ui.findAll({ type: 'Markdown' })).map(t => t.text ?? '').join('\n')
  expect(md).toContain('| Case | Target | Odds |')
  expect(md).toContain('| Price | vs close | Level |')
  expect(md).toContain('Analog win')
  // No option chain in this fixture: said, not hidden.
  expect(await ui.find({ type: 'Text', text: /Data gaps: .*Options chain/ })).toBeDefined()

  // A different horizon re-runs the analysis for it.
  await ui.press({ key: 'hz-63' })
  expect(await ui.find({ type: 'Text', text: /next 63 sessions/ })).toBeDefined()
  await ui.unmount()
})

test('analyze_ticker answers with the report and shows it in the pane', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const r = resultText(await callTool($, { tool: 'mcp__stock-desk__analyze_ticker', symbol: 'tsla', horizon_days: 5 }))
  expect(r).toContain('# TSLA')
  expect(r).toContain('horizon 5 trading days')
  expect(r).toContain('Futures point higher')
  expect(r).toContain('Historical analogs')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /next 5 sessions/ })).toBeDefined()
  await ui.unmount()
})

test('beta_map and probability answer from the same history', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))

  // Every ticker shares the fixture history, so the beta is 1 and the move maps one to one.
  const beta = resultText(await callTool($, { tool: 'mcp__stock-desk__beta_map', base: 'SPY', targets: 'TSLA', base_move_pct: 2 }))
  expect(beta).toContain('| TSLA | 1.00 | 1.00 |')
  expect(beta).toContain('+2.00%')

  const prob = resultText(await callTool($, { tool: 'mcp__stock-desk__probability', symbol: 'TSLA', levels: [1, 100000], days: 5 }))
  expect(prob).toContain('realized volatility')
  expect(prob).toContain('100.0%')

  const bad = resultText(await callTool($, { tool: 'mcp__stock-desk__beta_map', targets: 'TSLA' }))
  expect(bad).toContain('base_target')
})
