/**
 * Bing backend — the `www.bing.com/search` result page.
 *
 * Bing has no free, key-less search API (the Web Search API was retired and the
 * replacement requires an Azure subscription), so like DuckDuckGo this backend
 * parses the result page. It is worth having anyway, and worth trying *before*
 * DuckDuckGo, because the two fail in different circumstances: Bing is generally
 * more tolerant of automated result-page requests, and its markup has been far
 * more stable over time than DuckDuckGo's.
 *
 * The page has three shapes of outbound link that all have to be handled:
 *
 *   - `https://www.bing.com/ck/a?!&&p=…&u=a1aHR0cHM6…` — the click tracker. The
 *     target is the `u=` parameter, base64url-encoded with an `a1` marker prefix.
 *   - `https://www.bing.com/ck/a?…` with no recoverable `u` — an ad or an
 *     internal hop. Dropped, because a tracker with no target is not a citation.
 *   - A plain `https://example.com/…` — a real result on some page variants.
 *
 * Titles live in `<h2><a href=…>`, and Bing marks the organic results with a
 * `b_algo` class on the containing list item. Matching `b_algo` first and then
 * looking for the heading inside it is more robust than matching every `h2 a` on
 * the page, which would also pick up the header, sidebar and "related searches".
 *
 * @module src/backends/bing.js
 */

import { requestText } from '../http.js'
import { collectClassMatches, innerOf, stripTags, attrValue } from '../html.js'
import { isUsableResultUrl as isUsableUrl, decodeBase64Url, looksSubstituted, measureRelevance } from '../urls.js'

/** The result endpoint. `count` asks for more than the default 10. */
const ENDPOINT = 'https://www.bing.com/search'

/** Result container class. `b_algo` is Bing's organic-result list item. */
const RESULT_CLASS = 'b_algo'

/**
 * Unwrap Bing's `bing.com/ck/a` click tracker.
 *
 * @param href - the raw `href` attribute value.
 * @returns the real target URL, or `undefined` when it cannot be recovered.
 */
export function unwrapBingRedirect(href) {
  if (typeof href !== 'string' || href.trim() === '') return undefined
  const raw = href.trim()

  const looksLikeTracker = /(?:^|\/\/|\.)bing\.com\/ck\/a/i.test(raw) || raw.startsWith('/ck/a')
  if (!looksLikeTracker) {
    // A plain link, either absolute or protocol-relative.
    if (raw.startsWith('//')) return `https:${raw}`
    return raw
  }

  let encoded
  try {
    encoded = new URL(raw, 'https://www.bing.com').searchParams.get('u')
  } catch {
    return undefined
  }
  if (encoded === null || encoded === '') return undefined

  // Bing prefixes the base64 payload with `a1` (and has used other short markers
  // over the years). Strip a leading marker only when what remains still decodes
  // to a URL, so a genuine payload that happens to start with those characters is
  // not corrupted.
  const candidates = [encoded]
  const marker = /^a\d/.exec(encoded)
  if (marker !== null) candidates.push(encoded.slice(marker[0].length))

  for (const candidate of candidates) {
    const decoded = decodeBase64Url(candidate)
    if (decoded === undefined) continue
    if (/^https?:\/\//i.test(decoded)) return decoded
  }
  return undefined
}

/**
 * Reject URLs that are not usable citations from a Bing result page.
 *
 * @param url - a candidate target URL.
 * @returns true when the URL should be reported as a source.
 */
export function isUsableBingResultUrl(url) {
  return isUsableUrl(url, {
    blockedHosts: ['bing.com', 'microsofttranslator.com'],
    blockedPaths: [
      // Bing's own navigation and ad surfaces. These are real `bing.com` paths
      // rather than separate hosts, so they cannot be expressed as a host rule.
      { host: 'bing.com', prefix: '/ck/a' },
      { host: 'bing.com', prefix: '/aclick' },
      { host: 'bing.com', prefix: '/images/' },
      { host: 'bing.com', prefix: '/videos/' },
      { host: 'bing.com', prefix: '/maps' },
    ],
  })
}

/**
 * Parse a Bing result page into sources.
 *
 * Titles and snippets are paired by document position, as in the DuckDuckGo
 * backend: within a `b_algo` block the heading comes first and the caption
 * follows, so the nearest following caption is that result's snippet. Captions
 * are matched by their own class first, falling back to the paragraph inside the
 * block, because Bing has shipped both shapes.
 *
 * @param html - the fetched result page.
 * @returns the parsed sources, in page order.
 */
export function parseBingResults(html) {
  const blocks = collectClassMatches(html, RESULT_CLASS)
  if (blocks.length === 0) return []

  const sources = []
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const nextIndex = i + 1 < blocks.length ? blocks[i + 1].index : html.length
    const blockHtml = html.slice(block.openEnd, nextIndex)

    // The heading anchor is the result's link. Fall back to the first anchor in
    // the block, which covers Bing's variant without a classed heading.
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(blockHtml)
    const anchorSource = heading === null ? blockHtml : heading[1]
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(anchorSource)
    if (anchor === null) continue

    const url = unwrapBingRedirect(attrValue(anchor[1], 'href'))
    if (!isUsableBingResultUrl(url)) continue

    // Prefer the anchor's own text; fall back to any text in the heading.
    let title = stripTags(anchor[2])
    if (title === '' && heading !== null) title = stripTags(heading[1])

    // The snippet: a classed caption, else the first paragraph in the block.
    const caption = collectClassMatches(blockHtml, 'b_caption')[0] ?? collectClassMatches(blockHtml, 'b_lineclamp')[0]
    let snippet
    if (caption !== undefined) {
      snippet = stripTags(innerOf(blockHtml, caption))
    } else {
      const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(blockHtml)
      if (paragraph !== null) snippet = stripTags(paragraph[1])
    }
    // `b_caption` wraps the URL line too, which would repeat the title's own
    // text as the snippet. Drop a snippet that adds nothing over the title.
    if (snippet !== undefined && (snippet === '' || snippet === title)) snippet = undefined

    sources.push({
      url,
      ...(title === '' ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
    })
  }
  return sources
}

/**
 * Detect Bing's bot interstitial or a consent wall.
 *
 * @param status - the HTTP status.
 * @param html - the response body.
 * @returns true when the response is a block page rather than results.
 */
export function isBingBlocked(status, html) {
  if (status === 429 || status === 403 || status === 503) return true
  if (typeof html !== 'string') return false
  // `b_results` present means we got a real result page, whatever else it says.
  if (html.includes('b_results')) return false
  return /captcha|unusual traffic|Verify you are human|consent\.bing\.com|b_no results/i.test(html)
}

/**
 * Search Bing.
 *
 * @param options - `{ timeoutMs, deadline, signal, userAgent, logger, limit, proxy }`.
 *        `signal` is the caller's cancellation, forwarded so a cancel aborts the
 *        in-flight request. `proxy` routes the request through a proxy when one is
 *        configured.
 * @returns `{ sources, usedEndpoint }`.
 * @throws {Error} when the request failed, was blocked, or yielded no results.
 */
export async function searchBing(query, { timeoutMs, deadline, signal, userAgent, logger, limit, proxy } = {}) {
  const left = typeof deadline === 'number' ? deadline - Date.now() : timeoutMs
  if (typeof left === 'number' && left <= 0) throw new Error('bing: skipped, the search budget was exhausted')
  const budget = typeof left === 'number' ? Math.min(timeoutMs ?? left, left) : timeoutMs

  const url = new URL(ENDPOINT)
  url.searchParams.set('q', query)
  // `count` reduces the chance of a second page being needed; Bing caps it at 50.
  if (Number.isInteger(limit) && limit > 0) url.searchParams.set('count', String(Math.min(50, limit)))
  url.searchParams.set('setlang', 'en')

  let response
  try {
    response = await requestText(url.href, {
      timeoutMs: budget,
      signal,
      proxy,
      userAgent,
      // Bing answers a GET on the search endpoint; a same-origin referer is what
      // the real page sends and reduces the chance of the interstitial.
      headers: { referer: 'https://www.bing.com/' },
    })
  } catch (error) {
    if (error?.kind === 'aborted') throw error
    throw new Error(`bing: ${error?.message ?? String(error)}`)
  }

  if (isBingBlocked(response.status, response.text)) {
    throw new Error(`bing: blocked by Bing (HTTP ${response.status}; captcha or consent interstitial)`)
  }
  if (!response.ok) throw new Error(`bing: HTTP ${response.status}`)

  const sources = parseBingResults(response.text)
  if (sources.length === 0) {
    // A 200 with no parseable results is the signature of a layout change, and
    // is worth surfacing as such — it is the one failure that needs a code fix.
    logger?.debug?.('free-web-search: bing returned an unparseable page')
    throw new Error('bing: no results could be parsed (layout may have changed)')
  }

  // Guard against a substituted response. Measured: an exit node returned a page
  // whose title and search box correctly read the query while every organic
  // result was about something else entirely. Failing lets the chain try the next
  // backend, which is strictly better than returning unrelated results.
  if (looksSubstituted(sources, query)) {
    const relevance = measureRelevance(sources, query)
    logger?.debug?.(
      `free-web-search: bing returned ${relevance.total} results of which ${relevance.matching} mention the query; treating as substituted`,
    )
    throw new Error(
      `bing: returned ${relevance.total} results, none matching the query ` +
        '(the response looks substituted — a proxy or exit node may be rewriting results)',
    )
  }

  return { sources, usedEndpoint: 'bing' }
}
