import type { Analysis } from './analysis'
import type { Row } from './levels'
import type { Bar, TickerData } from '../types'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function table(head: string[], rows: string[][]): string {
  return `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`
}

/** A table whose first column names show their meaning on hover. */
function explainedTable(head: string[], rows: Row[]): string {
  return `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(r => `<tr><td><span class="tip" title="${esc(r.meaning).replace(/"/g, '&quot;')}">${esc(r.label)}</span></td><td>${esc(r.value)}</td><td>${esc(r.note)}</td></tr>`)
    .join('')}</tbody></table>`
}

/** A standalone page for the browser: the chart at full width, levels and recent sessions. */
export function chartPage(input: { data: TickerData; a: Analysis; svg: string; levels: Row[]; stats: Row[]; range: string }): string {
  const { data, a, svg } = input
  const q = data.quote
  const recent: Bar[] = data.bars.slice(-31)
  const sessions = recent
    .slice(1)
    .map((b, i) => {
      const chg = ((b.c - recent[i]!.c) / recent[i]!.c) * 100

      return [b.t, b.o.toFixed(2), b.h.toFixed(2), b.l.toFixed(2), b.c.toFixed(2), `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, `${(b.v / 1e6).toFixed(1)}M`]
    })
    .reverse()

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.symbol)} chart</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--fg:#e6e6e6;--muted:#9aa0a6;--line:#2a2e33}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1600px;margin:0 auto;padding:20px 24px 48px}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:28px 0 8px}
.price{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}.muted{color:var(--muted)}
svg{width:100%;height:auto;display:block;margin-top:12px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
li{margin:4px 0}.tip{text-decoration:underline dotted;text-underline-offset:3px;cursor:help}
</style></head><body><main>
<h1>${esc(data.name)} <span class="muted">${esc(data.symbol)}</span></h1>
${q ? `<div class="price">$${q.price.toFixed(2)} <span style="font-size:18px">${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)} (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%)</span></div><div class="muted">${esc(q.asOf)} · ${esc(q.marketStatus)} · 15-min delayed · ${esc(a.trend.label)}: ${esc(a.trend.detail)}</div>` : ''}
${svg}
<p class="muted">Daily candles over ${esc(input.range)}. Hover a candle for its open, high, low, close and volume. Orange MA20, blue MA50, purple MA200; dashed lines are support and resistance. Use your browser's zoom (⌘ +) or full screen (⌃⌘F) to look closer.</p>
<h2>Price-drop check</h2><ul>${a.insights.map(i => `<li>${esc(i.text)}</li>`).join('')}</ul>
<h2>Key levels <span class="muted" style="font-size:13px;font-weight:400">· hover an underlined name for what it means</span></h2>${explainedTable(['Level', 'Price', 'vs. now'], input.levels)}
<h2>Indicators</h2>${explainedTable(['Measure', 'Value', 'Reading'], input.stats)}
<h2>Last 30 sessions</h2>${table(['Date', 'Open', 'High', 'Low', 'Close', 'Change', 'Volume'], sessions)}
<p class="muted">Data: Nasdaq. Signals come from price history only; this is not investment advice.</p>
</main></body></html>`
}
