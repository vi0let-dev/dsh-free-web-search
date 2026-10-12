/**
 * Yandex backend — the `yandex.com/search/` result page.
 *
 * ## Verification status — read this before trusting the parser
 *
 * Unlike the Bing and Baidu backends, this one's result parser was **not**
 * verified against a live result page. On the development machine Yandex was
 * reachable (TCP 443 connected in ~845 ms) but answered the search with its
 * captcha interstitial (`CheckboxCaptcha`, 14 KB, zero `serp-item` markers),
 * so there was no result markup to capture. What *was* verified is the captcha
 * path — which is the more valuable half anyway, because it means a blocked
 * Yandex is reported as "blocked" rather than as a mysterious parse failure.
 *
 * The result parser is therefore written against Yandex's long-standing
 * structure (`serp-item` containers, an `OrganicTitle` link, an
 * `OrganicTextContentSpan`/`TextContainer` snippet) and is deliberately
 * tolerant: it falls back from the classed selectors to structural ones, and
 * reports `layout may have changed` rather than returning nothing when it finds
 * a page that is neither a captcha nor parseable.
 *
 * Yandex is included because it is genuinely useful for Russian-language queries
 * and it is one of the engines that answers without a proxy in some networks. If
 * its markup has moved on, the failure is reported honestly and the backend can
 * simply be disabled with `backends: ['searxng','bing','duckduckgo','wikipedia']`.
 *
 * @module src/backends/yandex.js
 */

import { requestText } from '../http.js'
import { collectClassMatches, innerOf, stripTags, attrValue } from '../html.js'
import { isUsableResultUrl as isUsableUrl, looksSubstituted, measureRelevance } from '../urls.js'

/** The result endpoint. */
const ENDPOINT = 'https://yandex.com/search/'

/** Result container class token. */
const RESULT_CLASS = 'serp-item'

/** Title link class tokens Yandex has used for organic results. */
const TITLE_CLASSES = ['OrganicTitle-Link', 'OrganicTitle', 'Link_theme_outer', 'serp-item__title']

/** Snippet class tokens Yandex has used. */
const SNIPPET_CLASSES = ['OrganicTextContentSpan', 'TextContainer', 'Organic-ContentWrapper']

/**
 * Reject URLs that are not usable citations from a Yandex result page.
 *
 * @param url - a candidate target URL.
 * @returns true when the URL should be reported as a source.
 */
export function isUsableYandexResultUrl(url) {
  return isUsableUrl(url, {
    blockedHosts: ['yandex.com', 'yandex.ru', 'yandex.net', 'yastatic.net'],
    blockedPaths: [
      { host: 'yandex.com', prefix: '/search' },
      { host: 'yandex.com', prefix: '/images' },
      { host: 'yandex.com', prefix: '/maps' },
    ],
  })
}

/**
 * Parse a Yandex result page into sources.
 *
 * @param html - the fetched result page.
 * @returns the parsed sources, in page order.
 */
export function parseYandexResults(html) {
  const blocks = collectClassMatches(html, RESULT_CLASS)
  if (blocks.length === 0) return []

  const sources = []
  const seen = new Set()
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const nextIndex = i + 1 < blocks.length ? blocks[i + 1].index : html.length
    const blockHtml = html.slice(block.openEnd, nextIndex)

    // Title: try each known class, then fall back to the first external anchor.
    let title
    let url
    for (const className of TITLE_CLASSES) {
      const match = collectClassMatches(blockHtml, className)[0]
      if (match === undefined) continue
      // The classed element may be the anchor itself or a wrapper around it.
      const href = attrValue(match.attrs, 'href') ?? attrValue(/<a\b([^>]*)>/i.exec(innerOf(blockHtml, match))?.[1] ?? '', 'href')
      const candidate = typeof href === 'string' ? (href.startsWith('//') ? `https:${href}` : href) : undefined
      if (!isUsableYandexResultUrl(candidate)) continue
      url = candidate
      title = stripTags(innerOf(blockHtml, match)) || undefined
      break
    }
    if (url === undefined) {
      for (const match of blockHtml.matchAll(/<a\b([^>]*)>/gi)) {
        const href = attrValue(match[1], 'href')
        const candidate = typeof href === 'string' ? (href.startsWith('//') ? `https:${href}` : href) : undefined
        if (isUsableYandexResultUrl(candidate)) {
          url = candidate
          break
        }
      }
    }
    if (url === undefined || seen.has(url)) continue
    seen.add(url)

    // Snippet: the first known snippet class that yields text, else the longest
    // text run that is not the title.
    let snippet
    for (const className of SNIPPET_CLASSES) {
      const match = collectClassMatches(blockHtml, className)[0]
      if (match === undefined) continue
      const text = stripTags(innerOf(blockHtml, match))
      if (text !== '') {
        snippet = text
        break
      }
    }
    if (snippet === undefined) {
      const candidates = [...blockHtml.matchAll(/<(?:div|span|p)\b[^>]*>([\s\S]{40,700}?)<\/(?:div|span|p)>/gi)]
        .map((match) => stripTags(match[1]))
        .filter((text) => text.length > 40 && text !== title)
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
 * Detect Yandex's captcha, consent wall, or anti-bot page.
 *
 * Verified against a live response: `yandex.com/search/` from a datacentre-ish
 * client answered HTTP 200 with a 14 KB body containing `CheckboxCaptcha` and
 * `checkbox-captcha-form` and no result markers. A 200-with-captcha is exactly
 * the case that would otherwise be misreported as a layout change, so it is
 * detected explicitly.
 *
 * @param status - the HTTP status.
 * @param html - the response body.
 * @returns true when the response is a block page rather than results.
 */
export function isYandexBlocked(status, html) {
  if (status === 429 || status === 403 || status === 503) return true
  if (typeof html !== 'string') return false
  if (/CheckboxCaptcha|checkbox-captcha|SmartCaptcha|captcha-page|showcaptcha/i.test(html)) return true
  if (/Are you not a robot|Подтвердите, что запросы отправляли вы/i.test(html)) return true
  return false
}

/**
 * Search Yandex.
 *
 * @param options - `{ timeoutMs, deadline, signal, userAgent, logger, limit, proxy }`.
 * @returns `{ sources, usedEndpoint }`.
 * @throws {Error} when the request failed, was blocked, or yielded no results.
 */
export async function searchYandex(query, { timeoutMs, deadline, signal, userAgent, logger, limit, proxy } = {}) {
  const left = typeof deadline === 'number' ? deadline - Date.now() : timeoutMs
  if (typeof left === 'number' && left <= 0) throw new Error('yandex: skipped, the search budget was exhausted')
  const budget = typeof left === 'number' ? Math.min(timeoutMs ?? left, left) : timeoutMs

  const url = new URL(ENDPOINT)
  url.searchParams.set('text', query)
  if (Number.isInteger(limit) && limit > 0) url.searchParams.set('numdoc', String(Math.min(50, limit + 2)))

  let response
  try {
    response = await requestText(url.href, {
      timeoutMs: budget,
      signal,
      proxy,
      userAgent: userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
    })
  } catch (error) {
    if (error?.kind === 'aborted') throw error
    const via = proxy === undefined ? '' : ` (via proxy ${proxy.protocol}://${proxy.host}:${proxy.port})`
    throw new Error(`yandex: ${error?.message ?? String(error)}${via}`)
  }

  if (isYandexBlocked(response.status, response.text)) {
    throw new Error(
      `yandex: blocked by Yandex (HTTP ${response.status}; captcha challenge — ` +
        'Yandex shows this to most automated clients, so treat this backend as best-effort)',
    )
  }
  if (!response.ok) throw new Error(`yandex: HTTP ${response.status}`)

  const sources = parseYandexResults(response.text)
  if (sources.length === 0) {
    logger?.debug?.('free-web-search: yandex returned an unparseable page')
    throw new Error('yandex: no results could be parsed (layout may have changed)')
  }
  // Guard against a substituted response; see `looksSubstituted` for the measured
  // case that motivated it.
  if (looksSubstituted(sources, query)) {
    const relevance = measureRelevance(sources, query)
    throw new Error(
      `yandex: returned ${relevance.total} results, none matching the query ` +
        '(the response looks substituted — a proxy or exit node may be rewriting results)',
    )
  }
  return { sources, usedEndpoint: 'yandex' }
}
