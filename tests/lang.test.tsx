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

const pad = (n: number) => String(n).padStart(2, '0')

/** CNBC-shaped bars: 1-minute bars of one day (04:00–16:00), or 5-minute regular-session bars of the 30 weekdays up to a date. */
function cnbcBars(url: string): Res {
  const m = /\/bars\/[^/]+\/(1M|5M)\/(\d{8})\d{6}\/(\d{8})\d{6}\//.exec(url)
  if (!m) return missing
  const [, iv, from, to] = m
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
    if (weekday(date)) for (let min = 240; min < 960; min++) push(date, min, 300 + Math.sin(min / 25) * 3 + (min > 570 ? (min - 570) * 0.01 : 0), min >= 570 ? 20_000 : 800)
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

function respond(url: string): Res {
  if (url.includes('ts-api.cnbc.com/harmony/app/bars/')) return cnbcBars(url)
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

  // Intraday: the session read, its tables and the chart legend.
  await ui.press({ key: 'tab-intraday' })
  expect(await ui.find({ type: 'Button', key: 'tab-intraday', text: /^盘中$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /本交易日剩余时段/ })).toBeDefined()
  const intraMd = (await ui.findAll({ type: 'Markdown' })).map(t => t.text ?? '').join('\n')
  expect(intraMd).toContain('| 区间 | 低–高 | 状态 |')
  expect(intraMd).toContain('| 价格 | 较现价 | 价位 |')
  expect({ tab: 'tab-intraday', left: await untranslated(ui) }).toEqual({ tab: 'tab-intraday', left: [] })

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

  // The intraday tool too: a plain string result, in English, while the pane is Chinese.
  const intra = (await $.tool.call({ tool: 'mcp__stock-desk__intraday_read', symbol: 'TSLA' } as never)) as { result?: unknown; isError?: boolean }
  expect(typeof intra.result).toBe('string')
  expect(intra.isError).toBeUndefined()
  expect(String(intra.result)).toContain('TSLA')
  expect(/[一-鿿]/.test(String(intra.result))).toBe(false)

  // intraday_read moved the pane to its Intraday tab; back to Analysis, in English.
  await ui.press({ key: 'lang' })
  await ui.press({ key: 'tab-analysis' })
  expect(await ui.find({ type: 'Button', key: 'tab-analysis', text: /^Analysis$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Trend$/ })).toBeDefined()
  await ui.unmount()
})
