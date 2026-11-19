import { candleColors } from './chart'
import type { IntradayLevel, IntradayRead, MinuteBar } from './engine/intraday'
import { pick, tr } from './i18n'
import type { Lang } from './i18n'
import type { ColorMode } from '../types'

const MUTED = '#8b8f97'
const GRID = 'rgba(139,143,151,0.18)'
const FONT = 'font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"'
const VWAP_COLOR = '#f59e0b'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmt = (n: number) => (n >= 1000 ? n.toFixed(0) : n >= 100 ? n.toFixed(1) : n.toFixed(2))

const minuteOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const OPEN = 9 * 60 + 30
const CLOSE = 16 * 60

/** Short names for the level lines (the read's own labels can join several coinciding levels). */
const SHORT: Partial<Record<IntradayLevel['kind'], [string, string]>> = {
  'prior close': ['prior close', '昨收'],
  'pre-market high': ['pre-mkt high', '盘前高'],
  'pre-market low': ['pre-mkt low', '盘前低'],
  'gamma flip': ['gamma flip', '伽马翻转'],
  'call wall': ['call wall', '看涨墙'],
  'put wall': ['put wall', '看跌墙'],
  'prior high': ['prior high', '昨高'],
  'prior low': ['prior low', '昨低'],
}

/** Levels drawn as lines on the chart, with their colour and dash. */
const LINE_STYLE: Partial<Record<IntradayLevel['kind'], { color: string; dash: string }>> = {
  'prior close': { color: '#9ca3af', dash: '5 4' },
  'pre-market high': { color: '#64748b', dash: '2 3' },
  'pre-market low': { color: '#64748b', dash: '2 3' },
  'gamma flip': { color: '#a855f7', dash: '6 3' },
  'call wall': { color: '#22c55e', dash: '6 3' },
  'put wall': { color: '#ef4444', dash: '6 3' },
  'prior high': { color: '#94a3b8', dash: '1 3' },
  'prior low': { color: '#94a3b8', dash: '1 3' },
}

/**
 * Today's session as one SVG: candles grouped to a readable width (the
 * pre-market shaded), VWAP with its ±1σ band, the 30-minute opening range and
 * the initial balance (first hour) as boxes, the prior close, pre-market
 * high/low and the options levels as lines, and volume below.
 */
export function intradayChart(opts: { read: IntradayRead; bars: MinuteBar[]; width: number; height?: number; colors: ColorMode; lang?: Lang; showPremarket?: boolean }): string {
  const lang = opts.lang ?? 'en'
  const t = (en: string, zh: string) => tr(lang, en, zh)
  const { read } = opts
  const all = opts.bars.filter(b => b.date === read.sessionDate)
  const bars = opts.showPremarket === false ? all.filter(b => minuteOf(b.time) >= OPEN) : all
  const W = Math.round(opts.width)
  const H = Math.round(opts.height ?? Math.min(380, Math.max(260, W * 0.5)))
  if (bars.length === 0)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 60" width="${W}" height="60"><text x="8" y="34" fill="${MUTED}" font-size="13" ${FONT}>${esc(t('No intraday bars yet.', '还没有盘中数据。'))}</text></svg>`

  const padL = 6
  const padR = 64
  const padT = 18
  const padB = 20
  const plotW = W - padL - padR
  const volH = Math.round((H - padT - padB) * 0.16)
  const priceH = H - padT - padB - volH - 6
  const { up, down } = candleColors(opts.colors)

  // The time axis: from the first bar to the close (or the last bar after hours).
  const startMin = minuteOf(bars[0]!.time)
  const lastMin = minuteOf(bars[bars.length - 1]!.time)
  const endMin = Math.max(lastMin + 1, Math.min(20 * 60, Math.max(CLOSE, lastMin + 1)))
  const span = Math.max(30, endMin - startMin)
  // The regular session gets most of the width: the pre-market is squeezed to
  // about a fifth and after hours to a tenth, so the open reads clearly.
  const preEnd = Math.min(Math.max(startMin, OPEN), endMin)
  const regEnd = Math.min(Math.max(preEnd, CLOSE), endMin)
  const preMin = preEnd - startMin
  const regMin = regEnd - preEnd
  const postMin = endMin - regEnd
  const weights = { pre: preMin > 0 ? 0.18 : 0, post: postMin > 0 ? 0.1 : 0 }
  const preW = plotW * weights.pre
  const postW = plotW * weights.post
  const regW = plotW - preW - postW
  const xOf = (min: number) => {
    if (min <= preEnd) return padL + (preMin > 0 ? ((min - startMin) / preMin) * preW : 0)
    if (min <= regEnd) return padL + preW + (regMin > 0 ? ((min - preEnd) / regMin) * regW : 0)

    return padL + preW + regW + (postMin > 0 ? ((min - regEnd) / postMin) * postW : 0)
  }

  // Group minutes so each regular-session candle is at least ~4 px wide (the pre-market groups coarser to fit its strip).
  const regStep = Math.max(1, Math.ceil(Math.max(regMin, 30) / (regW / 4.5)))
  const preStep = preMin > 0 ? Math.max(regStep, Math.ceil(preMin / (preW / 4.5))) : regStep
  const stepAt = (min: number) => (min < OPEN ? preStep : min >= CLOSE ? Math.max(regStep, Math.ceil(Math.max(postMin, 1) / Math.max(postW / 4.5, 1))) : regStep)
  const bucketOf = (min: number) => {
    const st = stepAt(min)
    const base = min < OPEN ? startMin : min >= CLOSE ? CLOSE : OPEN

    return `${base}:${Math.floor((min - base) / st)}`
  }
  const groups: MinuteBar[] = []
  for (const b of bars) {
    const key = bucketOf(minuteOf(b.time))
    const g = groups[groups.length - 1]
    const gKey = g ? bucketOf(minuteOf(g.time)) : ''
    if (g && gKey === key) {
      g.h = Math.max(g.h, b.h)
      g.l = Math.min(g.l, b.l)
      g.c = b.c
      g.v += b.v
    } else groups.push({ ...b })
  }

  // The price scale holds the candles, VWAP bands and the levels near price.
  const levels = read.levels.filter(l => LINE_STYLE[l.kind])
  let lo = Math.min(...bars.map(b => b.l))
  let hi = Math.max(...bars.map(b => b.h))
  const near = (p: number) => p > lo - (hi - lo) * 0.6 && p < hi + (hi - lo) * 0.6
  for (const l of levels) if (near(l.price)) ((lo = Math.min(lo, l.price)), (hi = Math.max(hi, l.price)))
  if (read.vwap) for (const s of read.vwap.series) ((lo = Math.min(lo, s.lower1)), (hi = Math.max(hi, s.upper1)))
  const pad = (hi - lo) * 0.06 || hi * 0.002
  lo -= pad
  hi += pad
  const yOf = (p: number) => padT + ((hi - p) / (hi - lo)) * priceH
  const volTop = padT + priceH + 6
  const maxVol = Math.max(...groups.map(g => g.v), 1)

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>`)

  // Pre-market shading.
  if (startMin < OPEN) {
    const x2 = xOf(Math.min(OPEN, endMin))
    parts.push(`<rect x="${padL}" y="${padT}" width="${(x2 - padL).toFixed(1)}" height="${priceH + volH + 6}" fill="rgba(139,143,151,0.08)"/>`)
    parts.push(`<text x="${padL + 4}" y="${padT + 12}" fill="${MUTED}" font-size="10">${esc(t('pre-market', '盘前'))}</text>`)
  }

  // Price grid.
  for (let i = 0; i <= 4; i++) {
    const p = lo + ((hi - lo) * i) / 4
    const y = yOf(p)
    parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${GRID}"/>`)
    parts.push(`<text x="${padL + plotW + 4}" y="${(y + 3).toFixed(1)}" fill="${MUTED}" font-size="10">${fmt(p)}</text>`)
  }

  // Time labels.
  for (const m of [4 * 60, 8 * 60, OPEN, 10 * 60 + 30, 12 * 60, 14 * 60, CLOSE, 18 * 60]) {
    if (m < startMin || m > endMin) continue
    const x = xOf(m)
    const label = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT}" y2="${volTop + volH}" stroke="${GRID}"/>`)
    parts.push(`<text x="${x.toFixed(1)}" y="${H - 6}" fill="${MUTED}" font-size="10" text-anchor="middle">${label}</text>`)
  }

  // Opening range (30 min) and initial balance (60 min) boxes.
  for (const r of read.ranges.filter(x => x.minutes === 30 || x.minutes === 60)) {
    const x1 = xOf(OPEN)
    const x2 = xOf(Math.min(OPEN + r.minutes, Math.max(OPEN + 1, lastMin + 1)))
    const color = r.minutes === 60 ? '#38bdf8' : '#facc15'
    parts.push(
      `<rect x="${x1.toFixed(1)}" y="${yOf(r.high).toFixed(1)}" width="${Math.max(1, x2 - x1).toFixed(1)}" height="${Math.max(1, yOf(r.low) - yOf(r.high)).toFixed(1)}" fill="none" stroke="${color}" stroke-dasharray="4 3" stroke-opacity="0.8"/>`,
    )
    // After the range closes, its edges run on as faint lines: breakouts read against them.
    if (r.complete && lastMin > OPEN + r.minutes) {
      for (const p of [r.high, r.low])
        parts.push(`<line x1="${x2.toFixed(1)}" x2="${xOf(lastMin + 1).toFixed(1)}" y1="${yOf(p).toFixed(1)}" y2="${yOf(p).toFixed(1)}" stroke="${color}" stroke-opacity="0.45" stroke-dasharray="2 4"/>`)
    }
    // OR label at the box's top left, IB label at its top right, so they never overlap.
    parts.push(
      r.minutes === 60
        ? `<text x="${(x2 - 2).toFixed(1)}" y="${(yOf(r.high) - 3).toFixed(1)}" fill="${color}" font-size="10" text-anchor="end">${esc(t('1st hour', '首小时'))}</text>`
        : `<text x="${(x1 + 2).toFixed(1)}" y="${(yOf(r.high) + 11).toFixed(1)}" fill="${color}" font-size="10">${esc(t('OR 30m', '开盘 30 分'))}</text>`,
    )
  }

  // Level lines with labels on the right.
  const labelYs: number[] = []
  for (const l of levels) {
    if (l.price < lo || l.price > hi) continue
    const s = LINE_STYLE[l.kind]!
    const y = yOf(l.price)
    parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${s.color}" stroke-dasharray="${s.dash}" stroke-opacity="0.85"/>`)
    if (labelYs.every(v => Math.abs(v - y) > 11)) {
      labelYs.push(y)
      const short = SHORT[l.kind]
      const name = short ? (lang === 'zh' ? short[1] : short[0]) : pick(lang, l.label)
      const more = pick('en', l.label).split(' / ').length - 1
      parts.push(`<text x="${(padL + plotW - 4).toFixed(1)}" y="${(y - 3).toFixed(1)}" fill="${s.color}" font-size="10" text-anchor="end">${esc(`${name}${more > 0 ? ` +${more}` : ''} ${fmt(l.price)}`)}</text>`)
    }
  }

  // VWAP band and line.
  if (read.vwap && read.vwap.series.length > 1) {
    const pts = read.vwap.series.map(s => ({ x: xOf(minuteOf(barTime(s.t))), ...s }))
    const band = [...pts.map(p => `${p.x.toFixed(1)},${yOf(p.upper1).toFixed(1)}`), ...[...pts].reverse().map(p => `${p.x.toFixed(1)},${yOf(p.lower1).toFixed(1)}`)].join(' ')
    parts.push(`<polygon points="${band}" fill="${VWAP_COLOR}" fill-opacity="0.08"/>`)
    parts.push(`<polyline points="${pts.map(p => `${p.x.toFixed(1)},${yOf(p.vwap).toFixed(1)}`).join(' ')}" fill="none" stroke="${VWAP_COLOR}" stroke-width="1.6"/>`)
    const last = pts[pts.length - 1]!
    parts.push(`<text x="${(last.x + 3).toFixed(1)}" y="${(yOf(last.vwap) + 3).toFixed(1)}" fill="${VWAP_COLOR}" font-size="10">VWAP</text>`)
  }

  // Candles and volume.
  for (const g of groups) {
    const gm = minuteOf(g.time)
    const st = stepAt(gm)
    const x = (xOf(gm) + xOf(Math.min(gm + st, endMin))) / 2
    const cw = Math.max(1, (xOf(Math.min(gm + st, endMin)) - xOf(gm)) * 0.7)
    const color = g.c >= g.o ? up : down
    const pre = minuteOf(g.time) < OPEN
    const op = pre ? 0.55 : 1
    parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${yOf(g.h).toFixed(1)}" y2="${yOf(g.l).toFixed(1)}" stroke="${color}" stroke-opacity="${op}"/>`)
    const top = yOf(Math.max(g.o, g.c))
    const bh = Math.max(1, Math.abs(yOf(g.o) - yOf(g.c)))
    parts.push(`<rect x="${(x - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" fill-opacity="${op}"><title>${g.time} O ${fmt(g.o)} H ${fmt(g.h)} L ${fmt(g.l)} C ${fmt(g.c)}</title></rect>`)
    const vh = (g.v / maxVol) * volH
    parts.push(`<rect x="${(x - cw / 2).toFixed(1)}" y="${(volTop + volH - vh).toFixed(1)}" width="${cw.toFixed(1)}" height="${vh.toFixed(1)}" fill="${color}" fill-opacity="${pre ? 0.25 : 0.45}"/>`)
  }

  // Last price marker.
  const lastBar = bars[bars.length - 1]!
  const ly = yOf(lastBar.c)
  parts.push(`<rect x="${padL + plotW + 1}" y="${(ly - 7).toFixed(1)}" width="${padR - 4}" height="14" rx="3" fill="${lastBar.c >= (read.open ?? lastBar.o) ? up : down}"/>`)
  parts.push(`<text x="${padL + plotW + 5}" y="${(ly + 4).toFixed(1)}" fill="#fff" font-size="10" font-weight="600">${fmt(lastBar.c)}</text>`)
  parts.push('</svg>')

  return parts.join('')
}

/** HH:MM in New York for an epoch-ms bar start. */
function barTime(ms: number): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
  } catch {
    const d = new Date(ms - 5 * 3600_000)

    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  }
}
