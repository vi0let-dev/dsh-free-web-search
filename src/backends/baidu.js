/**
 * Baidu backend — the `www.baidu.com/s` result page.
 *
 * Baidu is the useful engine for Chinese-language queries, and it is one of the
 * two here that answered on the development machine without any proxy (Bing and
 * Yandex being the others), so it is also the practical fallback when the
 * proxied engines are unavailable.
 *
 * ## How the parser was designed
 *
 * Not by guessing. A real result page was captured (`www.baidu.com/s?wd=…`,
 * HTTP 200, ~1.2 MB) and inspected, which showed that Baidu's organic results
 * carry two machine-readable hints that are far more reliable than its class
 * names:
 *
 *   - `mu="<real target URL>"` on the result container. This is the actual
 *     destination, so **no redirect needs to be followed** to learn it. The
 *     captured page had `mu="https://www.deepseek.com/harness/"`,
 *     `mu="https://baike.baidu.com/item/…"`, `mu="https://github.com/deepseek-ai/"`
 *     and so on, alongside a handful of internal/ad hosts
 *     (`nourl.ubs.baidu.com`, `*.recommend_list.baidu.com`) that must be dropped.
 *   - `data-tools="{&quot;title&quot;:…,&quot;url&quot;:…}"` on the title element,
 *     which names the result's own title. Its `url` is a `baidu.com/link?url=…`
 *     redirector (confirmed: it answers 302 to the real target), which is why
 *     `mu` is preferred over it.
 *
 * Using `mu` is also why this backend needs no extra request per result: the
 * common alternative — resolve each `/link?url=` redirector — would multiply the
 * request count by the number of results.
 *
 * The container classes are `result c-container` / `result-op c-container`, but
 * matching on `c-container` alone is unsafe: the captured page also contains the
 * string 105 times inside embedded CSS and inside an unrelated feedback form. The
 * parser therefore requires the `mu=` attribute, which only real result
 * containers have.
 *
 * @module src/backends/baidu.js
 */

import { requestText } from '../http.js'
import { decodeEntities, stripTags, collectClassMatches, innerOf } from '../html.js'
import { isUsableResultUrl as isUsableUrl, looksSubstituted, measureRelevance } from '../urls.js'

/** The result endpoint. `ie=utf-8` pins the encoding so the response is UTF-8. */
const ENDPOINT = 'https://www.baidu.com/s'

/** Result container class token. */
const RESULT_CLASS = 'c-container'

/**
 * Internal and advertising hosts that appear in `mu=` but are not results.
 *
 * Measured from a real page: `nourl.ubs.baidu.com` is Baidu's own tracking host
 * for widget slots, and `*.recommend_list.baidu.com` serves the "related
 * searches" card. Both carry a `mu=` and would otherwise be reported as sources.
 */
const BLOCKED_HOSTS = ['baidu.com', 'bdstatic.com', 'baidustatic.com', 'nourl.ubs.baidu.com']

/** Suffixes that mark an internal Baidu service host. */
const BLOCKED_SUFFIXES = ['recommend_list.baidu.com', 'ubs.baidu.com']

/**
 * Read the `mu` attribute of a result container — the real target URL.
 *
 * @param attrs - the container's attribute text.
 * @returns the decoded URL, or `undefined` when absent.
 */
function readMu(attrs) {
  const match = /(?:^|\s)mu\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs ?? '')
  if (match === null) return undefined
  const value = decodeEntities(match[1] ?? match[2] ?? '').trim()
  return value === '' ? undefined : value
}

/**
 * Reject URLs that are not usable citations from a Baidu result page.
 *
 * @param url - a candidate target URL.
 * @returns true when the URL should be reported as a source.
 */
export function isUsableBaiduResultUrl(url) {
  const lower = typeof url === 'string' ? url.toLowerCase() : ''
  for (const suffix of BLOCKED_SUFFIXES) {
    if (lower.includes(suffix)) return false
  }
  return isUsableUrl(url, {
    blockedHosts: BLOCKED_HOSTS,
    blockedPaths: [
      { host: 'baidu.com', prefix: '/s?' },
      { host: 'baidu.com', prefix: '/link?' },
      { host: 'baidu.com', prefix: '/home/' },
    ],
  })
}

/**
 * Unwrap a `baidu.com/link?url=…` redirector if one is present.
 *
 * The redirector cannot be decoded locally (the token is opaque and resolves only
 * via a 302), so when the only URL available is a redirector this returns
 * `undefined` and the caller drops the result. That is deliberate: reporting the
 * redirector would mean citing a `baidu.com` tracking URL, which is not a
 * citation. In practice `mu` supplies the real target, so this is a rare path.
 *
 * @param url - a candidate URL.
 * @returns the URL when it is already a real target, else `undefined`.
 */
export function unwrapBaiduRedirect(url) {
  if (typeof url !== 'string' || url === '') return undefined
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const host = parsed.hostname.toLowerCase()
  if ((host === 'baidu.com' || host.endsWith('.baidu.com')) && parsed.pathname === '/link') return undefined
  return url
}

/**
 * Parse a Baidu result page into sources.
 *
 * @param html - the fetched result page.
 * @returns the parsed sources, in page order.
 */
export function parseBaiduResults(html) {
  // Require `mu=` in the container tag: it is what distinguishes a real result
  // container from the 100+ CSS and feedback-form mentions of `c-container`.
  const blocks = collectClassMatches(html, RESULT_CLASS).filter((match) => readMu(match.attrs) !== undefined)
  if (blocks.length === 0) return []

  const sources = []
  const seen = new Set()
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const url = unwrapBaiduRedirect(readMu(block.attrs))
    if (!isUsableBaiduResultUrl(url) || seen.has(url)) continue
    seen.add(url)

    const nextIndex = i + 1 < blocks.length ? blocks[i + 1].index : html.length
    const blockHtml = html.slice(block.openEnd, nextIndex)

    // Title: prefer the `data-tools` JSON title (it is exactly the result's own
    // title), else the heading anchor's text.
    let title = readDataToolsTitle(blockHtml)
    if (title === undefined) {
      const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(blockHtml)
      if (heading !== null) {
        const text = stripTags(heading[1])
        if (text !== '') title = text
      }
    }

    // Snippet: `c-abstract` is Baidu's abstract container. Fall back to the
    // longest plausible text run that is not the title.
    let snippet
    const abstract = collectClassMatches(blockHtml, 'c-abstract')[0]
    if (abstract !== undefined) {
      const text = stripTags(innerOf(blockHtml, abstract))
      if (text !== '') snippet = text
    }
    if (snippet === undefined) {
      const candidates = [...blockHtml.matchAll(/<(?:div|span|p)\b[^>]*>([\s\S]{30,700}?)<\/(?:div|span|p)>/gi)]
        .map((match) => stripTags(match[1]))
        .filter((text) => text.length > 30 && text !== title)
        .sort((a, b) => b.length - a.length)
      if (candidates.length > 0) snippet = candidates[0]
    }
    if (snippet !== undefined && snippet === title) snippet = undefined

    sources.push({
      url,
      ...(title === undefined || title === '' ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet: snippet.length > 400 ? `${snippet.slice(0, 397)}…` : snippet }),
    })
  }
  return sources
}

/**
 * Read the `title` field out of a `data-tools` JSON payload.
 *
 * The attribute is HTML-escaped JSON, so the entities are decoded before parsing.
 * A payload that does not parse is treated as absent rather than fatal.
 *
 * @param blockHtml - the result block's inner HTML.
 * @returns the title, or `undefined`.
 */
function readDataToolsTitle(blockHtml) {
  const match = /data-tools=(["'])([\s\S]*?)\1/i.exec(blockHtml)
  if (match === null) return undefined
  try {
    const parsed = JSON.parse(decodeEntities(match[2]))
    return typeof parsed?.title === 'string' && parsed.title.trim() !== '' ? parsed.title.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Detect Baidu's verification page or an anti-bot interstitial.
 *
 * @param status - the HTTP status.
 * @param html - the response body.
 * @returns true when the response is a block page rather than results.
 */
export function isBaiduBlocked(status, html) {
  if (status === 429 || status === 403 || status === 503) return true
  if (typeof html !== 'string') return false
  if (/wappass\.baidu\.com|安全验证|网络不给力|请输入验证码|verify/i.test(html)) return true
  return false
}

/**
 * Search Baidu.
 *
 * @param options - `{ timeoutMs, deadline, signal, userAgent, logger, limit, proxy }`.
 * @returns `{ sources, usedEndpoint }`.
 * @throws {Error} when the request failed, was blocked, or yielded no results.
 */
export async function searchBaidu(query, { timeoutMs, deadline, signal, userAgent, logger, limit, proxy } = {}) {
  const left = typeof deadline === 'number' ? deadline - Date.now() : timeoutMs
  if (typeof left === 'number' && left <= 0) throw new Error('baidu: skipped, the search budget was exhausted')
  const budget = typeof left === 'number' ? Math.min(timeoutMs ?? left, left) : timeoutMs

  const url = new URL(ENDPOINT)
  url.searchParams.set('wd', query)
  url.searchParams.set('ie', 'utf-8')
  if (Number.isInteger(limit) && limit > 0) url.searchParams.set('rn', String(Math.min(50, limit + 2)))

  let response
  try {
    response = await requestText(url.href, {
      timeoutMs: budget,
      signal,
      proxy,
      userAgent: userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        referer: 'https://www.baidu.com/',
      },
    })
  } catch (error) {
    if (error?.kind === 'aborted') throw error
    const via = proxy === undefined ? '' : ` (via proxy ${proxy.protocol}://${proxy.host}:${proxy.port})`
    throw new Error(`baidu: ${error?.message ?? String(error)}${via}`)
  }

  if (isBaiduBlocked(response.status, response.text)) {
    throw new Error(`baidu: blocked by Baidu (HTTP ${response.status}; verification page)`)
  }
  if (!response.ok) throw new Error(`baidu: HTTP ${response.status}`)

  const sources = parseBaiduResults(response.text)
  if (sources.length === 0) {
    logger?.debug?.('free-web-search: baidu returned an unparseable page')
    throw new Error('baidu: no results could be parsed (layout may have changed)')
  }
  // Guard against a substituted response; see `looksSubstituted` for the measured
  // case that motivated it.
  if (looksSubstituted(sources, query)) {
    const relevance = measureRelevance(sources, query)
    throw new Error(
      `baidu: returned ${relevance.total} results, none matching the query ` +
        '(the response looks substituted — a proxy or exit node may be rewriting results)',
    )
  }
  return { sources, usedEndpoint: 'baidu' }
}
