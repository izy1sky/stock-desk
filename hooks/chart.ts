import type { Analysis } from './analysis'
import type { Bar, ColorMode } from '../types'

export const MA_COLORS = { ma20: '#f59e0b', ma50: '#3b82f6', ma200: '#a855f7' } as const
const MUTED = '#8b8f97'
const GRID = 'rgba(139,143,151,0.18)'
const FONT = 'font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"'

export function candleColors(mode: ColorMode): { up: string; down: string } {
  return mode === 'red-up' ? { up: '#e5484d', down: '#30a46c' } : { up: '#30a46c', down: '#e5484d' }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmt = (n: number) => (n >= 1000 ? n.toFixed(0) : n >= 100 ? n.toFixed(1) : n.toFixed(2))
const vol = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n))
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`

/**
 * A daily candlestick (K-line) chart as one SVG document: candles, 20/50/200-day
 * averages, volume, the range's high and low marked, support and resistance
 * lines, and a hover tooltip per candle.
 */
export function candleChart(opts: {
  bars: Bar[]
  /** Index into `bars` of the first candle shown. */
  from: number
  a: Analysis
  width: number
  /** Pixels; left out, about 0.6 of the width. */
  height?: number
  colors: ColorMode
}): string {
  const { bars, from, a, colors } = opts
  const shown = bars.slice(from)
  const n = shown.length
  const W = Math.round(opts.width)
  const H = Math.round(opts.height ?? Math.min(360, Math.max(240, W * 0.62)))
  const padL = 6
  const padR = 52
  const padT = 22
  const padB = 18
  const plotW = W - padL - padR
  const volH = Math.round((H - padT - padB) * 0.18)
  const priceH = H - padT - padB - volH - 6
  const { up, down } = candleColors(colors)

  const avg = (key: 'ma20' | 'ma50' | 'ma200') => a[key].slice(from)
  const lines = { ma20: avg('ma20'), ma50: avg('ma50'), ma200: avg('ma200') }

  let lo = Math.min(...shown.map(b => b.l))
  let hi = Math.max(...shown.map(b => b.h))
  const pad = (hi - lo) * 0.08 || hi * 0.02
  lo -= pad
  hi += pad
  const y = (p: number) => padT + ((hi - p) / (hi - lo)) * priceH
  const step = plotW / n
  const x = (i: number) => padL + step * i + step / 2
  const bodyW = Math.max(1, Math.min(12, step * 0.68))
  const maxVol = Math.max(...shown.map(b => b.v), 1)
  const volTop = padT + priceH + 6

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT} font-size="10">`)

  // Price grid and labels.
  for (let g = 0; g <= 4; g++) {
    const p = lo + ((hi - lo) * g) / 4
    const gy = y(p).toFixed(1)
    parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${gy}" y2="${gy}" stroke="${GRID}"/>`)
    parts.push(`<text x="${W - padR + 4}" y="${gy}" dy="3" fill="${MUTED}">${fmt(p)}</text>`)
  }

  // Month (or week) ticks along the bottom.
  let lastLabelX = -100
  for (let i = 0; i < n; i++) {
    const t = shown[i]!.t
    const prevT = i > 0 ? shown[i - 1]!.t : ''
    const isNewMonth = t.slice(0, 7) !== prevT.slice(0, 7)
    const isNewWeek = n <= 30 && i > 0 && new Date(`${t}T12:00:00Z`).getUTCDay() < new Date(`${prevT}T12:00:00Z`).getUTCDay()
    if (!(isNewMonth || isNewWeek) || x(i) - lastLabelX < 46) continue
    lastLabelX = x(i)
    parts.push(`<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${padT}" y2="${H - padB}" stroke="${GRID}"/>`)
    parts.push(`<text x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="middle" fill="${MUTED}">${isNewMonth && n > 30 ? MONTHS[Number(t.slice(5, 7)) - 1] : shortDate(t)}</text>`)
  }

  // Support (dashed) and resistance (dotted) levels inside the visible price span.
  const level = (p: number, label: string, color: string, dash: string) => {
    if (p < lo || p > hi) return
    const ly = y(p).toFixed(1)
    parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${ly}" y2="${ly}" stroke="${color}" stroke-dasharray="${dash}" stroke-opacity="0.8"/>`)
    parts.push(`<text x="${padL + 2}" y="${ly}" dy="-3" fill="${color}" font-size="9">${esc(label)} ${fmt(p)}</text>`)
  }
  a.supports.slice(0, 2).forEach((s, i) => level(s.price, `Support ${i + 1}`, '#0ea5e9', '5 3'))
  a.resistances.slice(0, 1).forEach(r => level(r.price, 'Resistance', '#f97316', '2 3'))

  // Volume bars.
  shown.forEach((b, i) => {
    const h = (b.v / maxVol) * volH
    const color = b.c >= b.o ? up : down
    parts.push(`<rect x="${(x(i) - bodyW / 2).toFixed(1)}" y="${(volTop + volH - h).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${color}" fill-opacity="0.35"/>`)
  })

  // Moving averages.
  for (const key of ['ma200', 'ma50', 'ma20'] as const) {
    let d = ''
    lines[key].forEach((v, i) => {
      if (v === null || v === undefined || v < lo || v > hi) return
      d += `${d && lines[key][i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    })
    if (d) parts.push(`<path d="${d}" fill="none" stroke="${MA_COLORS[key]}" stroke-width="1.2" stroke-opacity="0.9"/>`)
  }

  // Candles, each with a tooltip.
  shown.forEach((b, i) => {
    const color = b.c >= b.o ? up : down
    const prevClose = i > 0 ? shown[i - 1]!.c : from > 0 ? bars[from - 1]!.c : b.o
    const chg = ((b.c - prevClose) / prevClose) * 100
    const tip = `${b.t}  O ${fmt(b.o)}  H ${fmt(b.h)}  L ${fmt(b.l)}  C ${fmt(b.c)}  ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%  Vol ${vol(b.v)}`
    const top = y(Math.max(b.o, b.c))
    const bodyH = Math.max(1, Math.abs(y(b.o) - y(b.c)))
    parts.push(
      `<g><title>${esc(tip)}</title>` +
        `<rect x="${(x(i) - step / 2).toFixed(1)}" y="${padT}" width="${step.toFixed(1)}" height="${(H - padT - padB).toFixed(1)}" fill="transparent"/>` +
        `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke="${color}"/>` +
        `<rect x="${(x(i) - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/></g>`,
    )
  })

  // The range's high and low points.
  const mark = (index: number, price: number, kind: 'high' | 'low') => {
    const i = index - from
    if (i < 0 || i >= n) return
    const px = x(i)
    const py = y(price)
    const anchor = px > padL + plotW * 0.8 ? 'end' : px < padL + plotW * 0.2 ? 'start' : 'middle'
    const ty = kind === 'high' ? py - 6 : py + 13
    const label = `${kind === 'high' ? 'High' : 'Low'} ${fmt(price)} · ${shortDate(bars[index]!.t)}`
    parts.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.5" fill="none" stroke="currentColor" stroke-width="1"/>`)
    parts.push(`<text x="${px.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}" font-weight="600" fill="${kind === 'high' ? up : down}">${esc(label)}</text>`)
  }
  mark(a.rangeHigh.index, a.rangeHigh.price, 'high')
  mark(a.rangeLow.index, a.rangeLow.price, 'low')

  // Last close: dashed line and a tag on the price axis.
  const lc = a.last.c
  const ly = y(lc)
  const lastColor = a.change >= 0 ? up : down
  parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${lastColor}" stroke-dasharray="1 2"/>`)
  parts.push(`<rect x="${W - padR + 1}" y="${(ly - 7).toFixed(1)}" width="${padR - 2}" height="14" rx="3" fill="${lastColor}"/>`)
  parts.push(`<text x="${W - padR + 4}" y="${ly.toFixed(1)}" dy="3.5" fill="#fff" font-weight="600">${fmt(lc)}</text>`)

  // Legend.
  const legend: [string, string][] = [
    ['MA20', MA_COLORS.ma20],
    ['MA50', MA_COLORS.ma50],
    ['MA200', MA_COLORS.ma200],
  ]
  let lx = padL
  for (const [label, color] of legend) {
    parts.push(`<rect x="${lx}" y="6" width="10" height="2.5" fill="${color}"/><text x="${lx + 13}" y="10" fill="${MUTED}">${label}</text>`)
    lx += 52
  }
  parts.push(`<text x="${W - padR}" y="10" text-anchor="end" fill="${MUTED}">Daily · ${n} sessions</text>`)

  parts.push('</svg>')

  return parts.join('')
}
