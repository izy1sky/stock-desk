import type { Analysis } from './analysis'
import { tr } from './i18n'
import type { Lang } from './i18n'
import { levelHead, statHead } from './levels'
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
export function chartPage(input: { data: TickerData; a: Analysis; svg: string; levels: Row[]; stats: Row[]; range: string; lang?: Lang }): string {
  const { data, a, svg } = input
  const lang = input.lang ?? 'en'
  const t = (en: string, zh: string) => tr(lang, en, zh)
  const q = data.quote
  const recent: Bar[] = data.bars.slice(-31)
  const sessions = recent
    .slice(1)
    .map((b, i) => {
      const chg = ((b.c - recent[i]!.c) / recent[i]!.c) * 100

      return [b.t, b.o.toFixed(2), b.h.toFixed(2), b.l.toFixed(2), b.c.toFixed(2), `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, `${(b.v / 1e6).toFixed(1)}M`]
    })
    .reverse()

  return `<!doctype html><html lang="${t('en', 'zh-CN')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.symbol)} ${t('chart', '图表')}</title>
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
${q ? `<div class="price">$${q.price.toFixed(2)} <span style="font-size:18px">${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)} (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%)</span></div><div class="muted">${esc(q.asOf)} · ${esc(q.marketStatus)} · ${t('15-min delayed', '延迟 15 分钟')} · ${esc(a.trend.label)}${t(': ', '：')}${esc(a.trend.detail)}</div>` : ''}
${svg}
<p class="muted">${t(
       `Daily candles over ${esc(input.range)}. Hover a candle for its open, high, low, close and volume. Orange MA20, blue MA50, purple MA200; dashed lines are support and resistance. Use your browser's zoom (⌘ +) or full screen (⌃⌘F) to look closer.`,
       `${esc(input.range)} 日 K 线。把鼠标停在一根 K 线上，可查看开盘、最高、最低、收盘和成交量。橙色为 MA20，蓝色为 MA50，紫色为 MA200；虚线为支撑和阻力。可用浏览器缩放（⌘ +）或全屏（⌃⌘F）细看。`,
     )}</p>
<h2>${t('Price-drop check', '下跌检查')}</h2><ul>${a.insights.map(i => `<li>${esc(i.text)}</li>`).join('')}</ul>
<h2>${t('Key levels', '关键价位')} <span class="muted" style="font-size:13px;font-weight:400">${t('· hover an underlined name for what it means', '· 把鼠标停在带下划线的名称上，可查看含义')}</span></h2>${explainedTable(levelHead(lang), input.levels)}
<h2>${t('Indicators', '指标')}</h2>${explainedTable(statHead(lang), input.stats)}
<h2>${t('Last 30 sessions', '最近 30 个交易日')}</h2>${table(lang === 'zh' ? ['日期', '开盘', '最高', '最低', '收盘', '涨跌幅', '成交量'] : ['Date', 'Open', 'High', 'Low', 'Close', 'Change', 'Volume'], sessions)}
<p class="muted">${t('Data: Nasdaq. Signals come from price history only; this is not investment advice.', '数据来源：Nasdaq。信号只来自价格历史，不构成投资建议。')}</p>
</main></body></html>`
}
