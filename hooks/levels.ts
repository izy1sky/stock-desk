import type { Analysis } from './analysis'
import type { Bar, Range, TickerData } from '../types'

export type Row = { label: string; value: string; note: string; meaning: string }

const money = (n: number | undefined) => (n === undefined ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const gap = (from: number, to: number) => `${to >= from ? '+' : ''}${(((to - from) / from) * 100).toFixed(1)}%`
const big = (n: number | undefined) =>
  n === undefined ? '—' : n >= 1e12 ? `${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n.toLocaleString('en-US')

/** Price levels, each with the plain-language reason it matters. */
export function levelRows(a: Analysis, range: Range): Row[] {
  const last = a.last.c
  const rows: Row[] = [
    {
      label: `${range} high`,
      value: money(a.rangeHigh.price),
      note: `${a.rangeHigh.date} · ${gap(a.rangeHigh.price, last)} from here`,
      meaning: 'Highest price in the chart. Sellers took over here last time, so rallies often slow near it.',
    },
    {
      label: `${range} low`,
      value: money(a.rangeLow.price),
      note: `${a.rangeLow.date} · ${gap(a.rangeLow.price, last)} from here`,
      meaning: 'Lowest price in the chart. Buyers stepped in here last time.',
    },
    {
      label: '52-week high',
      value: money(a.high52.price),
      note: `${a.high52.date} · now ${a.drawdown.toFixed(1)}% below`,
      meaning: 'Top of the past year. More than 20% below it is usually called a bear market for the stock.',
    },
    {
      label: '52-week low',
      value: money(a.low52.price),
      note: a.low52.date,
      meaning: 'Bottom of the past year. A close below it is a sign of serious weakness.',
    },
    ...a.resistances.map((r, i) => ({
      label: `Resistance ${i + 1}`,
      value: money(r.price),
      note: `${r.date} · ${gap(last, r.price)}`,
      meaning: 'A recent peak above today’s price. Rallies often stall here; a close above it is a breakout.',
    })),
    ...a.supports.map((s, i) => ({
      label: `Support ${i + 1}`,
      value: money(s.price),
      note: `${s.date} · ${gap(last, s.price)}`,
      meaning: 'A recent low below today’s price. Drops often pause or bounce here; a close below it is a warning.',
    })),
  ]
  const ma = (key: 'ma20' | 'ma50' | 'ma200', label: string, meaning: string) => {
    const v = a[key][a[key].length - 1]
    if (v === null || v === undefined) return
    rows.push({ label, value: money(v), note: `price ${last >= v ? 'above' : 'below'} (${gap(v, last)})`, meaning })
  }
  ma('ma20', '20-day average', 'Short-term trend, about one month of closes. Price above it means near-term momentum is up.')
  ma('ma50', '50-day average', 'Medium-term trend, about one quarter. Big funds watch it; it often acts as support in an uptrend.')
  ma('ma200', '200-day average', 'Long-term trend, about one year. Above it the trend is healthy; below it, rallies are often sold.')

  return rows
}

/** Indicators and company figures, each explained. */
export function statRows(a: Analysis, data: TickerData): Row[] {
  const last = a.last.c

  return [
    {
      label: 'RSI (14)',
      value: a.rsi?.toFixed(0) ?? '—',
      note: a.rsi === undefined ? '' : a.rsi <= 30 ? 'oversold' : a.rsi >= 70 ? 'overbought' : 'neutral',
      meaning: 'Momentum from 0 to 100 over 14 days. Under 30: fell fast (oversold). Over 70: rose fast (overbought).',
    },
    {
      label: 'ATR (14)',
      value: a.atr ? money(a.atr) : '—',
      note: a.atr ? `${((a.atr / last) * 100).toFixed(1)}% of the price` : '',
      meaning: 'Average daily swing, high to low. A one-day move over 2× ATR is unusual and usually news-driven.',
    },
    {
      label: 'Volume vs average',
      value: a.volumeRatio ? `${a.volumeRatio.toFixed(2)}×` : '—',
      note: a.volumeRatio === undefined ? '' : a.volumeRatio >= 1.5 ? 'heavy' : a.volumeRatio < 0.8 ? 'light' : 'normal',
      meaning: 'Last session’s shares traded against the 50-day average. Heavy volume makes a move more meaningful.',
    },
    { label: 'Market cap', value: big(data.summary.marketCap), note: '', meaning: 'Total value of all shares: the company’s size.' },
    {
      label: '1-year target',
      value: money(data.summary.target1y),
      note: data.summary.target1y ? gap(last, data.summary.target1y) : '',
      meaning: 'Average analyst price target for 12 months out. Analysts are often too optimistic; treat it as a mood gauge.',
    },
    { label: 'Dividend yield', value: data.summary.dividendYield ?? '—', note: '', meaning: 'Yearly dividend as a percent of the price.' },
  ]
}

export function rowsMarkdown(rows: Row[], head: [string, string, string] = ['Level', 'Price', 'vs. now']): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|')

  return `| ${head[0]} | ${head[1]} | ${head[2]} | What it means |\n|---|---|---|---|\n${rows.map(r => `| **${cell(r.label)}** | ${cell(r.value)} | ${cell(r.note)} | ${cell(r.meaning)} |`).join('\n')}`
}

export function sessionsMarkdown(bars: Bar[], count: number): string {
  const recent = bars.slice(-count - 1)
  const lines = recent.slice(1).map((b, i) => {
    const prev = recent[i]!.c
    const chg = ((b.c - prev) / prev) * 100

    return `| ${b.t} | ${b.o.toFixed(2)} | ${b.h.toFixed(2)} | ${b.l.toFixed(2)} | ${b.c.toFixed(2)} | ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% | ${(b.v / 1e6).toFixed(1)}M |`
  })

  return `| Date | Open | High | Low | Close | Change | Volume |\n|---|---|---|---|---|---|---|\n${lines.reverse().join('\n')}`
}
