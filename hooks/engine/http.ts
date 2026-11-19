import type { HttpInit, HttpResponse } from 'claude-code'

export type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

export const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
}

/** GET a JSON document; throws on a non-2xx status or a body that is not JSON. */
export async function getJson(fetch: Fetch, url: string, headers: Record<string, string> = BROWSER_HEADERS): Promise<any> {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  try {
    return JSON.parse(res.text)
  } catch {
    throw new Error(`Not JSON from ${new URL(url).host}`)
  }
}

/** "$1,234.50" → 1234.5, "+1.24%" → 1.24; anything else → undefined */
export function num(text: unknown): number | undefined {
  if (typeof text === 'number') return Number.isFinite(text) ? text : undefined
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const n = Number(text.replace(/[$,%\s+]/g, ''))

  return Number.isFinite(n) ? n : undefined
}
