import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'stock-desk',
  component: 'Pane',
  requestId: 'stock-desk',
  props: { title: 'Stocks', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

type Res = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const json = (body: unknown): Res => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(body) })
const missing: Res = { status: 404, ok: false, headers: {}, text: '' }

// Three years of rows, newest first: a long rise, then a slide on heavy volume.
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

// Source data stays as published: the company name, headlines and publishers.
const COMPANY = 'Tesla, Inc. Common Stock'
const HEADLINE = 'Regulators open probe into Tesla driver assistance'

function respond(url: string): Res {
  if (url.includes('/quote/TSLA/info'))
    return json({ data: { symbol: 'TSLA', companyName: COMPANY, marketStatus: 'Closed', primaryData: { lastSalePrice: '$300.00', netChange: '-4.00', percentageChange: '-1.3%', volume: '60,000,000', lastTradeTimestamp: 'Nov 18, 2026' } } })
  if (url.includes('/quote/') && url.includes('/info')) return json({ data: null })
  if (url.includes('/historical') && url.includes('api.nasdaq.com')) return json(HISTORY)
  if (url.includes('articlebysymbol')) return json({ data: { rows: [{ title: HEADLINE, publisher: 'Reuters', ago: '2 hours ago', url: '/articles/probe' }] } })
  if (url.includes('/calendar/economicevents'))
    return json({ data: { rows: [{ gmt: '08:30', country: 'United States', eventName: 'Nonfarm Payrolls', consensus: '63K', previous: '40K', actual: '&nbsp;' }] } })
  if (url.includes('/calendar/')) return json({ data: { rows: [] } })

  return missing
}

/** Strings that are data, not the mod's own words: allowed to stay English in Chinese mode. */
const SOURCE = [/Tesla, Inc\./, new RegExp(HEADLINE), /Reuters/, /2 hours ago/, /Nov 18, 2026/, /Closed/]

/**
 * Text the mod draws in English while Chinese is on: three English words in a
 * row (abbreviations and tickers are single words, so they pass).
 */
async function untranslated(ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }): Promise<string[]> {
  const texts = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Markdown' })), ...(await ui.findAll({ type: 'Button' }))].map(n => n.text ?? '')
  const out: string[] = []
  for (const t of texts) {
    const cleaned = SOURCE.reduce((s, re) => s.replace(new RegExp(re.source, 'g'), ''), t)
    const m = /\b[A-Za-z]{2,}[,.]? [A-Za-z]{2,}[,.]? [A-Za-z]{2,}\b/.exec(cleaned)
    if (m && !/^English\b/.test(m[0])) out.push(`${m[0]}  ⟵  ${t.slice(0, 120)}`)
  }

  return [...new Set(out)]
}

test('the language switch turns every pane Chinese, and nothing the mod writes stays English', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'add', text: 'TSLA' })
  expect(await ui.find({ type: 'Button', key: 'tab-analysis', text: /^Analysis$/ })).toBeDefined()

  await ui.press({ key: 'lang' })
  expect(await ui.find({ type: 'Button', key: 'tab-analysis', text: /^分析$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'lang', text: /语言：中文/ })).toBeDefined()

  // Analysis: the bias word, module names and the tables are Chinese.
  await ui.press({ key: 'tab-analysis' })
  expect(await ui.find({ type: 'Text', text: /^(看多|偏多|中性|偏空|看空)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^趋势$/ })).toBeDefined()
  const md = (await ui.findAll({ type: 'Markdown' })).map(t => t.text ?? '').join('\n')
  expect(md).toContain('| 情景 | 目标 | 概率 |')
  expect(md).toContain('| 价格 | 较收盘 | 价位 |')
  expect(await untranslated(ui)).toEqual([])

  // Chart & levels, news and the calendar tab.
  for (const tab of ['tab-overview', 'tab-news', 'tab-calendar']) {
    await ui.press({ key: tab })
    expect({ tab, left: await untranslated(ui) }).toEqual({ tab, left: [] })
  }
  await ui.press({ key: 'tab-overview' })
  expect(await ui.find({ type: 'Text', text: /^52 周高点$/ })).toBeDefined()
  await ui.press({ key: 'tab-calendar' })
  await ui.press({ key: 'open-cal' })
  await ui.unmount()

  // The calendar pane: dates, categories, the Nasdaq release name.
  const cal = await $.ui.mount({ ...PANE, requestId: 'stock-desk-calendar', props: { ...PANE.props, title: '市场日历' }, surface: 'desktop' })
  await cal.press({ key: 'h-90' })
  expect(await cal.find({ type: 'Text', text: /非农就业/ })).toBeDefined()
  expect(await cal.find({ type: 'Text', text: /\d+月\d+日 周[一二三四五六日]/ })).toBeDefined()
  expect(await untranslated(cal)).toEqual([])
  await cal.unmount()

  // The portfolio pane, with a position and its checks.
  const port = await $.ui.mount({ ...PANE, requestId: 'stock-desk-portfolio', props: { ...PANE.props, title: '我的持仓' }, surface: 'desktop' })
  await port.input({ key: 'trade', text: 'TSLA 10 @ 350 stop 310' })
  expect(await port.find({ type: 'Text', text: /^总市值$/ })).toBeDefined()
  await port.press({ key: 'rules' })
  expect(await untranslated(port)).toEqual([])
  await port.unmount()

  // The expanded chart.
  const chart = await $.ui.mount({ ...PANE, requestId: 'stock-desk-chart', props: { ...PANE.props, title: 'TSLA K 线图' }, surface: 'desktop' })
  expect(await chart.find({ type: 'Text', text: /^最近 10 个交易日$/ })).toBeDefined()
  expect(await untranslated(chart)).toEqual([])
  await chart.unmount()
})

test('switching back to English restores it, and the tools keep answering in English', async ($, on) => {
  on('http.fetch', (_, e) => ({ value: respond(e.url) }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'add', text: 'TSLA' })
  await ui.press({ key: 'lang' })
  const answer = JSON.stringify(await $.tool.call({ tool: 'mcp__stock-desk__analyze_ticker', symbol: 'TSLA', horizon_days: 5 } as never))
  expect(answer).toContain('# TSLA')
  expect(/[一-鿿]/.test(answer)).toBe(false)

  await ui.press({ key: 'lang' })
  expect(await ui.find({ type: 'Button', key: 'tab-analysis', text: /^Analysis$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Trend$/ })).toBeDefined()
  await ui.unmount()
})
