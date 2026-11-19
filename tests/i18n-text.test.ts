import { expect, test } from 'claude-code/testing'

import type { Bar, Calendar, Portfolio, TickerData } from '../types'
import { analyze } from '../hooks/analysis'
import { candleChart } from '../hooks/chart'
import { buildEvents, categoryLabel, CATEGORY, econName, fedMeetings, marketHolidays, myEventHint, optionsExpirations, elections, parseMyEvent } from '../hooks/events'
import { levelRows, rowsMarkdown, sessionsMarkdown, statRows } from '../hooks/levels'
import { chartPage } from '../hooks/page'
import { applyCommand, DEFAULT_RULES, parseCommand, RULE_LABELS, ruleText, runChecks, sectorName, sizePosition, valuePortfolio } from '../hooks/portfolio'

// Two years of daily bars rising with a wobble, then a 12% drop on 3× volume.
function bars(): Bar[] {
  const out: Bar[] = []
  let price = 100
  const day = new Date('2024-11-01T12:00:00Z')
  const days: string[] = []
  while (day < new Date('2026-10-31T00:00:00Z')) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days.push(day.toISOString().slice(0, 10))
    day.setUTCDate(day.getUTCDate() + 1)
  }
  days.forEach((t, i) => {
    const isLast = i === days.length - 1
    const o = price
    price = isLast ? price * 0.88 : price * (1 + 0.002 + 0.01 * Math.sin(i / 7))
    out.push({ t, o, h: Math.max(o, price) * 1.01, l: Math.min(o, price) * 0.99, c: price, v: isLast ? 90e6 : 30e6 })
  })

  return out
}

const BARS = bars()
const TODAY = '2026-11-19'

function ticker(symbol: string, sector = 'Technology'): TickerData {
  return {
    symbol,
    name: `${symbol} Inc.`,
    assetClass: 'stocks',
    bars: BARS,
    summary: { sector, marketCap: 1.2e12, target1y: 400, dividendYield: '0.5%', exDividend: '2026-11-24', dividendPay: '2026-12-10' },
    news: [],
    fetchedAt: 1,
  } as TickerData
}

const CAL: Calendar = {
  earnings: { '2026-11-20': [{ date: '2026-11-20', symbol: 'NVDA', name: 'Nvidia', time: 'after-hours', epsForecast: '$1.20', lastYearEPS: '$0.81', quarter: 'Oct/2026', marketCap: 4e12 }] },
  econ: [
    { date: '2026-12-04', time: '08:30', name: 'Nonfarm Payrolls', consensus: '63K', previous: '40K', actual: '', tier: 3 },
    { date: '2026-12-04', time: '08:30', name: 'Unemployment Rate', consensus: '4.3%', previous: '4.3%', actual: '', tier: 3 },
    { date: '2026-12-10', time: '08:30', name: 'CPI (MoM)', consensus: '0.3%', previous: '0.3%', actual: '', tier: 3 },
    { date: '2026-12-10', time: '08:30', name: 'Core CPI (MoM)', consensus: '0.3%', previous: '0.2%', actual: '', tier: 3 },
    { date: '2026-12-09', time: '14:00', name: 'Fed Interest Rate Decision', consensus: '3.75%', previous: '4.00%', actual: '', tier: 3 },
  ],
  fetchedAt: 1,
}

const PF: Portfolio = {
  positions: [
    { symbol: 'NVDA', shares: 100, cost: 400, stop: 280, target: 500, opened: '2026-01-02' },
    { symbol: 'AAPL', shares: 10, cost: 200, opened: '2026-01-02' },
  ],
  cash: 1000,
  trades: [],
  rules: DEFAULT_RULES,
} as Portfolio

const TICKERS = { NVDA: ticker('NVDA'), AAPL: ticker('AAPL', 'Some New Sector') }

const CJK = /[一-鿿]/
/** Text that needs no translation: numbers, money, symbols, tickers, dates. */
const neutral = (s: string) => s === '' || /^[\sA-Z0-9$%+\-−.,:;·/×()（）—*|~]*$/.test(s)

/** Every string inside a value that should be Chinese and is not. */
function untranslated(x: unknown, path = '$', out: string[] = []): string[] {
  if (typeof x === 'string') {
    if (!neutral(x) && !CJK.test(x)) out.push(`${path}: ${x}`)
  } else if (Array.isArray(x)) x.forEach((v, i) => untranslated(v, `${path}[${i}]`, out))
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) untranslated(v, `${path}.${k}`, out)

  return out
}

test('insights and trend in Chinese: a 12% drop on 3× volume reads as 放量', () => {
  const a = analyze(BARS, '6M', 3, 'zh')!
  const texts = a.insights.map(i => i.text)
  expect(texts.some(t => t.includes('放量下跌'))).toBe(true)
  expect(texts.some(t => t.includes('52 周高点'))).toBe(true)
  expect(texts.some(t => t.includes('3 天后发布财报'))).toBe(true)
  expect(CJK.test(a.trend.label) && CJK.test(a.trend.detail)).toBe(true)
  expect(untranslated({ insights: texts, trend: [a.trend.label, a.trend.detail] })).toEqual([])
  // English stays as it was.
  const en = analyze(BARS, '6M', 3)!
  expect(en.insights.some(i => i.text.startsWith('Fell on heavy volume'))).toBe(true)
})

test('level and stat rows in Chinese', () => {
  const a = analyze(BARS, '6M', undefined, 'zh')!
  const levels = levelRows(a, '6M', 'zh')
  const stats = statRows(a, ticker('NVDA'), 'zh')
  const labels = levels.map(r => r.label)
  expect(labels).toContain('52 周高点')
  expect(labels).toContain('近 6 个月高点')
  expect(labels).toContain('200 日均线')
  expect(stats.find(r => r.label === '市值')?.value).toBe('$1.20 万亿')
  expect(untranslated(levels.map(r => [r.label, r.note, r.meaning]))).toEqual([])
  expect(untranslated(stats.map(r => [r.label, r.note, r.meaning]))).toEqual([])
  expect(rowsMarkdown(levels, undefined, 'zh').startsWith('| 价位 | 价格 | 较现价 | 含义 |')).toBe(true)
  expect(sessionsMarkdown(BARS, 3, 'zh').startsWith('| 日期 | 开盘 |')).toBe(true)
  // English defaults unchanged.
  expect(rowsMarkdown(levelRows(a, '6M')).startsWith('| Level | Price | vs. now | What it means |')).toBe(true)
  expect(levelRows(a, '6M')[0]!.label).toBe('6M high')
})

test('calendar in Chinese: holiday, FOMC, earnings and econ titles', () => {
  const events = buildEvents({ today: TODAY, horizon: 30, calendar: CAL, tickers: TICKERS, watchlist: ['NVDA'], mine: [], lang: 'zh' })
  const titles = events.map(e => e.title)
  expect(titles).toContain('休市：感恩节')
  expect(titles).toContain('提前收盘（美东 13:00）：感恩节次日')
  // The feed's decision comes first and is the one kept, as in English.
  expect(titles).toContain('美联储利率决议')
  expect(fedMeetings('zh')[0]!.title).toBe('美联储利率决议（FOMC），美东 14:30 召开新闻发布会')
  expect(titles).toContain('NVDA 盘后发布财报')
  expect(titles).toContain('非农就业人数')
  expect(titles).toContain('消费者物价指数（CPI）')
  expect(titles).toContain('月度期权到期')
  expect(titles).toContain('四巫日（quad witching）：季度期权和期货同日到期')
  // The Fed decision from the feed and the schedule stay one event, as in English.
  const en = buildEvents({ today: TODAY, horizon: 30, calendar: CAL, tickers: TICKERS, watchlist: ['NVDA'], mine: [] })
  expect(events.length).toBe(en.length)
  expect(events.filter(e => e.date === '2026-12-09' && e.category === 'fed').length).toBe(1)
  const cpi = events.find(e => e.title === '消费者物价指数（CPI）')!
  expect(cpi.detail).toContain('核心 月率：预期 0.3%')
  expect(untranslated(events.map(e => [e.title, e.detail ?? '']))).toEqual([])
  expect(untranslated([...marketHolidays(2026, 'zh'), ...optionsExpirations(2026, 'zh'), ...elections(2026, 'zh'), ...fedMeetings('zh')].map(e => [e.title, e.detail ?? '']))).toEqual([])
  expect(categoryLabel('fed', 'zh')).toBe('美联储')
  expect(categoryLabel('fed')).toBe(CATEGORY.fed.label)
  expect(CJK.test(myEventHint('zh'))).toBe(true)
  expect(parseMyEvent('11月20日 Nvidia GTC', TODAY)).toEqual({ date: '2026-11-20', title: 'Nvidia GTC' })
  expect(parseMyEvent('2027年1月5日 CES', TODAY)).toEqual({ date: '2027-01-05', title: 'CES' })
})

test('economic release names', () => {
  expect(econName('Nonfarm Payrolls', 'zh')).toBe('非农就业人数')
  expect(econName('Non-Farm Payrolls', 'zh')).toBe('非农就业人数')
  expect(econName('nonfarm payrolls', 'zh')).toBe('非农就业人数')
  expect(econName('Core CPI (YoY)', 'zh')).toBe('核心 CPI 年率')
  expect(econName('CPI (MoM)', 'zh')).toBe('消费者物价指数（CPI）月率')
  expect(econName('GDP (QoQ)', 'zh')).toBe('国内生产总值（GDP）季率')
  expect(econName('Jobless Claims 4-Week Avg.', 'zh')).toBe('初请失业金人数四周均值')
  expect(econName('Fed Chair Warsh Speaks', 'zh')).toBe('美联储主席 Warsh 讲话')
  expect(econName('FOMC Member Williams Speaks', 'zh')).toBe('FOMC 委员 Williams 讲话')
  expect(econName('S&amp;P Global Services PMI', 'zh')).toBe('标普全球服务业 PMI')
  expect(econName('Crude Oil Inventories', 'zh')).toBe('EIA 原油库存')
  expect(econName('Some Unknown Survey', 'zh')).toBe('Some Unknown Survey')
  expect(econName('Nonfarm Payrolls')).toBe('Nonfarm Payrolls')
})

test('portfolio checks, commands and sizing in Chinese', () => {
  const checks = runChecks(PF, TICKERS, CAL, TODAY, 'zh').map(c => c.text)
  expect(checks.some(t => t.includes('止损价') && t.includes('NVDA'))).toBe(true)
  expect(checks.some(t => t.includes('明天发布财报'))).toBe(true)
  expect(checks.some(t => t.includes('没有设止损'))).toBe(true)
  expect(untranslated(checks)).toEqual([])
  const en = runChecks(PF, TICKERS, CAL, TODAY)
  expect(en.length).toBe(checks.length)

  const { sectors } = valuePortfolio(PF, TICKERS, 'zh')
  expect(sectors.map(s => s[0])).toContain('科技')
  expect(sectorName('Health Care', 'zh')).toBe('医疗保健')

  const rules = RULE_LABELS.map(r => ruleText(r, 'zh'))
  expect(rules[3]!.label).toBe('单笔风险')
  expect(untranslated(rules)).toEqual([])
  expect(ruleText(RULE_LABELS[0]!).label).toBe('Largest position')

  const buy = parseCommand('买入 NVDA 50 @ 120.5 止损 110 目标 160')
  expect(buy).toEqual({ kind: 'buy', symbol: 'NVDA', shares: 50, price: 120.5, stop: 110, target: 160 })
  expect(parseCommand('卖出 NVDA 10 @ 140')).toEqual({ kind: 'sell', symbol: 'NVDA', shares: 10, price: 140 })
  expect(parseCommand('现金 5000')).toEqual({ kind: 'cash', amount: 5000 })
  const messages = [
    applyCommand(PF, buy!, TODAY, 'zh').message,
    applyCommand(PF, { kind: 'sell', symbol: 'NVDA', shares: 100, price: 450 }, TODAY, 'zh').message,
    applyCommand(PF, { kind: 'sell', symbol: 'TSLA', shares: 1, price: 1 }, TODAY, 'zh').message,
    applyCommand(PF, { kind: 'cash', amount: 5000 }, TODAY, 'zh').message,
  ]
  expect(messages[1]).toBe('以 $450 卖出 100 股 NVDA：已实现盈利 $5000.00，已清仓。')
  expect(untranslated(messages)).toEqual([])

  const sized = [sizePosition('NVDA 180 止损 165', 100_000, DEFAULT_RULES, 'zh'), sizePosition('nonsense', 100_000, DEFAULT_RULES, 'zh'), sizePosition('NVDA 180 stop 190', 100_000, DEFAULT_RULES, 'zh')]
  expect(sized[0]).toContain('66 股')
  expect(untranslated(sized)).toEqual([])
  expect(sizePosition('NVDA 180 stop 165', 100_000, DEFAULT_RULES).startsWith('NVDA: 66 shares')).toBe(true)
})

test('chart and browser page in Chinese', () => {
  const a = analyze(BARS, '3M', undefined, 'zh')!
  const svg = candleChart({ bars: BARS, from: BARS.length - 63, a, width: 900, colors: 'green-up', lang: 'zh' })
  expect(svg).toContain('个交易日')
  expect(svg).toContain('开 ')
  expect(svg).toContain('最高 ')
  expect(svg).toContain('阻力 ')
  expect(svg).not.toContain('sessions')
  const html = chartPage({ data: ticker('NVDA'), a, svg, levels: levelRows(a, '3M', 'zh'), stats: statRows(a, ticker('NVDA'), 'zh'), range: '3M', lang: 'zh' })
  expect(html).toContain('<html lang="zh-CN">')
  expect(html).toContain('关键价位')
  expect(html).toContain('最近 30 个交易日')
  expect(html).not.toContain('Key levels')
  const enSvg = candleChart({ bars: BARS, from: BARS.length - 63, a: analyze(BARS, '3M')!, width: 900, colors: 'green-up' })
  expect(enSvg).toContain('Daily · 63 sessions')
})
