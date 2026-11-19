import { fullDate } from './analysis'
import type { Analysis } from './analysis'
import { tr } from './i18n'
import type { Lang } from './i18n'
import type { Bar, Range, TickerData } from '../types'

export type Row = { label: string; value: string; note: string; meaning: string }

const money = (n: number | undefined) => (n === undefined ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const gap = (from: number, to: number) => `${to >= from ? '+' : ''}${(((to - from) / from) * 100).toFixed(1)}%`
const big = (n: number | undefined) =>
  n === undefined ? '—' : n >= 1e12 ? `${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n.toLocaleString('en-US')
/** Large dollar amounts the Chinese way: 万亿, 亿, 万. */
const bigZh = (n: number | undefined) =>
  n === undefined ? '—' : n >= 1e12 ? `$${(n / 1e12).toFixed(2)} 万亿` : n >= 1e8 ? `$${(n / 1e8).toFixed(1)} 亿` : n >= 1e4 ? `$${(n / 1e4).toFixed(1)} 万` : `$${n.toLocaleString('en-US')}`

const RANGE_ZH: Record<Range, string> = { '1M': '近 1 个月', '3M': '近 3 个月', '6M': '近 6 个月', '1Y': '近 1 年', '2Y': '近 2 年' }

/** Price levels, each with the plain-language reason it matters. */
export function levelRows(a: Analysis, range: Range, lang: Lang = 'en'): Row[] {
  const t = (en: string, zh: string) => tr(lang, en, zh)
  const day = (iso: string) => fullDate(lang, iso)
  const last = a.last.c
  const rows: Row[] = [
    {
      label: t(`${range} high`, `${RANGE_ZH[range] ?? range}高点`),
      value: money(a.rangeHigh.price),
      note: t(`${a.rangeHigh.date} · ${gap(a.rangeHigh.price, last)} from here`, `${day(a.rangeHigh.date)} · 现价较此 ${gap(a.rangeHigh.price, last)}`),
      meaning: t('Highest price in the chart. Sellers took over here last time, so rallies often slow near it.', '图中的最高价。上次卖方在这里占了上风，所以反弹到附近时常会放缓。'),
    },
    {
      label: t(`${range} low`, `${RANGE_ZH[range] ?? range}低点`),
      value: money(a.rangeLow.price),
      note: t(`${a.rangeLow.date} · ${gap(a.rangeLow.price, last)} from here`, `${day(a.rangeLow.date)} · 现价较此 ${gap(a.rangeLow.price, last)}`),
      meaning: t('Lowest price in the chart. Buyers stepped in here last time.', '图中的最低价。上次买方在这里入场。'),
    },
    {
      label: t('52-week high', '52 周高点'),
      value: money(a.high52.price),
      note: t(`${a.high52.date} · now ${a.drawdown.toFixed(1)}% below`, `${day(a.high52.date)} · 现价低 ${a.drawdown.toFixed(1)}%`),
      meaning: t('Top of the past year. More than 20% below it is usually called a bear market for the stock.', '过去一年的顶部。较它下跌超过 20%，通常就被视为这只股票进入熊市。'),
    },
    {
      label: t('52-week low', '52 周低点'),
      value: money(a.low52.price),
      note: day(a.low52.date),
      meaning: t('Bottom of the past year. A close below it is a sign of serious weakness.', '过去一年的底部。收盘跌破它是明显走弱的信号。'),
    },
    ...a.resistances.map((r, i) => ({
      label: t(`Resistance ${i + 1}`, `阻力 ${i + 1}`),
      value: money(r.price),
      note: `${day(r.date)} · ${gap(last, r.price)}`,
      meaning: t('A recent peak above today’s price. Rallies often stall here; a close above it is a breakout.', '现价上方的近期高点。反弹常在这里受阻；收盘站上它即为突破。'),
    })),
    ...a.supports.map((s, i) => ({
      label: t(`Support ${i + 1}`, `支撑 ${i + 1}`),
      value: money(s.price),
      note: `${day(s.date)} · ${gap(last, s.price)}`,
      meaning: t('A recent low below today’s price. Drops often pause or bounce here; a close below it is a warning.', '现价下方的近期低点。下跌常在这里暂停或反弹；收盘跌破它是警示信号。'),
    })),
  ]
  const ma = (key: 'ma20' | 'ma50' | 'ma200', label: string, meaning: string) => {
    const v = a[key][a[key].length - 1]
    if (v === null || v === undefined) return
    const note = t(`price ${last >= v ? 'above' : 'below'} (${gap(v, last)})`, `股价在${last >= v ? '上方' : '下方'}（${gap(v, last)}）`)
    rows.push({ label, value: money(v), note, meaning })
  }
  ma('ma20', t('20-day average', '20 日均线'), t('Short-term trend, about one month of closes. Price above it means near-term momentum is up.', '短期趋势，约一个月的收盘价。股价在其上方说明近期动能向上。'))
  ma('ma50', t('50-day average', '50 日均线'), t('Medium-term trend, about one quarter. Big funds watch it; it often acts as support in an uptrend.', '中期趋势，约一个季度。大型基金会盯着它；在上升趋势中它常起支撑作用。'))
  ma('ma200', t('200-day average', '200 日均线'), t('Long-term trend, about one year. Above it the trend is healthy; below it, rallies are often sold.', '长期趋势，约一年。在其上方说明趋势健康；在其下方，反弹常遭抛售。'))

  return rows
}

/** Indicators and company figures, each explained. */
export function statRows(a: Analysis, data: TickerData, lang: Lang = 'en'): Row[] {
  const t = (en: string, zh: string) => tr(lang, en, zh)
  const last = a.last.c

  return [
    {
      label: 'RSI (14)',
      value: a.rsi?.toFixed(0) ?? '—',
      note: a.rsi === undefined ? '' : a.rsi <= 30 ? t('oversold', '超卖') : a.rsi >= 70 ? t('overbought', '超买') : t('neutral', '中性'),
      meaning: t('Momentum from 0 to 100 over 14 days. Under 30: fell fast (oversold). Over 70: rose fast (overbought).', '14 天动能指标，取值 0 到 100。低于 30：跌得快（超卖）。高于 70：涨得快（超买）。'),
    },
    {
      label: 'ATR (14)',
      value: a.atr ? money(a.atr) : '—',
      note: a.atr ? t(`${((a.atr / last) * 100).toFixed(1)}% of the price`, `为股价的 ${((a.atr / last) * 100).toFixed(1)}%`) : '',
      meaning: t('Average daily swing, high to low. A one-day move over 2× ATR is unusual and usually news-driven.', '平均每日波幅（最高价到最低价）。单日波动超过 2× ATR 并不寻常，通常由消息驱动。'),
    },
    {
      label: t('Volume vs average', '成交量 / 均量'),
      value: a.volumeRatio ? `${a.volumeRatio.toFixed(2)}×` : '—',
      note: a.volumeRatio === undefined ? '' : a.volumeRatio >= 1.5 ? t('heavy', '放量') : a.volumeRatio < 0.8 ? t('light', '缩量') : t('normal', '正常'),
      meaning: t('Last session’s shares traded against the 50-day average. Heavy volume makes a move more meaningful.', '上一交易日的成交股数与 50 日均量之比。放量时的涨跌更有分量。'),
    },
    {
      label: t('Market cap', '市值'),
      value: lang === 'zh' ? bigZh(data.summary.marketCap) : big(data.summary.marketCap),
      note: '',
      meaning: t('Total value of all shares: the company’s size.', '全部股份的总价值，即公司的规模。'),
    },
    {
      label: t('1-year target', '1 年目标价'),
      value: money(data.summary.target1y),
      note: data.summary.target1y ? gap(last, data.summary.target1y) : '',
      meaning: t('Average analyst price target for 12 months out. Analysts are often too optimistic; treat it as a mood gauge.', '分析师对 12 个月后的平均目标价。分析师往往过于乐观，把它当作情绪参考即可。'),
    },
    { label: t('Dividend yield', '股息率'), value: data.summary.dividendYield ?? '—', note: '', meaning: t('Yearly dividend as a percent of the price.', '一年的股息占股价的百分比。') },
  ]
}

/** The headers of the level table and of the indicator table. */
export const levelHead = (lang: Lang = 'en'): [string, string, string] => (lang === 'zh' ? ['价位', '价格', '较现价'] : ['Level', 'Price', 'vs. now'])
export const statHead = (lang: Lang = 'en'): [string, string, string] => (lang === 'zh' ? ['指标', '数值', '解读'] : ['Measure', 'Value', 'Reading'])

export function rowsMarkdown(rows: Row[], headers?: [string, string, string], lang: Lang = 'en'): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|')
  const head = headers ?? levelHead(lang)

  return `| ${head[0]} | ${head[1]} | ${head[2]} | ${tr(lang, 'What it means', '含义')} |\n|---|---|---|---|\n${rows.map(r => `| **${cell(r.label)}** | ${cell(r.value)} | ${cell(r.note)} | ${cell(r.meaning)} |`).join('\n')}`
}

export function sessionsMarkdown(bars: Bar[], count: number, lang: Lang = 'en'): string {
  const recent = bars.slice(-count - 1)
  const lines = recent.slice(1).map((b, i) => {
    const prev = recent[i]!.c
    const chg = ((b.c - prev) / prev) * 100

    return `| ${b.t} | ${b.o.toFixed(2)} | ${b.h.toFixed(2)} | ${b.l.toFixed(2)} | ${b.c.toFixed(2)} | ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% | ${(b.v / 1e6).toFixed(1)}M |`
  })
  const head = tr(lang, '| Date | Open | High | Low | Close | Change | Volume |', '| 日期 | 开盘 | 最高 | 最低 | 收盘 | 涨跌幅 | 成交量 |')

  return `${head}\n|---|---|---|---|---|---|---|\n${lines.reverse().join('\n')}`
}
