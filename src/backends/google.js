/**
 * Google backend — the `www.google.com/search` result page.
 *
 * Google is the highest-quality general engine here and the one that most often
 * needs a proxy: in several networks (including the machine this was developed
 * on) `www.google.com:443` does not connect at all while Baidu, Bing and Yandex
 * do. That is exactly why this plugin grew proxy support, and why this backend is
 * the one that benefits from it most.
 *
 * There is no free Google search API — the Custom Search JSON API needs a key and
 * a billing-enabled project — so this parses the result page like the Bing and
 * DuckDuckGo backends do. Google's markup is deliberately obfuscated and changes
 * more often than the others', so the parser keys on structure that has survived
 * several redesigns rather than on generated class names:
 *
 *   - A result block is a `div` whose class contains `g` (Google's long-standing
 *     marker for a result container).
 *   - The link is the first `<a href>` with an `http(s)` target in the block,
 *     preferring one wrapped in an `<h3>` when present.
 *   - The snippet is the block's text minus the title, taken from the deepest
 *     text-bearing container available.
 *
 * Google wraps outbound links in `/url?q=<target>&sa=…` on some page variants and
 * links directly on others, so both shapes are handled.
 *
 * @module src/backends/google.js
 */

import { requestText } from '../http.js'
import { collectClassMatches, innerOf, stripTags } from '../html.js'
import { isUsableResultUrl as isUsableUrl, looksSubstituted, measureRelevance } from '../urls.js'

/** The result endpoint. */
const ENDPOINT = 'https://www.google.com/search'

/** Result container class token. `g` has marked a Google result for many years. */
const RESULT_CLASS = 'g'

/** Hosts that must never be reported as sources. */
const BLOCKED_HOSTS = ['google.com', 'googleusercontent.com', 'gstatic.com', 'googleadservices.com']

/**
 * Unwrap Google's `/url?q=` link shim.
 *
 * @param href - the raw `href`.
 * @returns the real target, or `undefined` when it cannot be recovered.
 */
export function unwrapGoogleRedirect(href) {
  if (typeof href !== 'string' || href.trim() === '') return undefined
  const raw = href.trim()

  // The shim is either a path (`/url?q=…`) or an absolute google.com URL.
  const isShim = /^\/url\?/i.test(raw) || /(?:^|\/\/|\.)google\.[a-z.]+\/url\?/i.test(raw)
  if (!isShim) return raw.startsWith('//') ? `https:${raw}` : raw

  let target
  try {
    target = new URL(raw, 'https://www.google.com').searchParams.get('q')
  } catch {
    return undefined
  }
  if (target === null || target === '') return undefined
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/**
 * Reject URLs that are not usable citations from a Google result page.
 *
 * @param url - a candidate target URL.
 * @returns true when the URL should be reported as a source.
 */
export function isUsableGoogleResultUrl(url) {
  return isUsableUrl(url, {
    blockedHosts: BLOCKED_HOSTS,
    blockedPaths: [{ host: 'google.com', prefix: '/search' }],
  })
}

/**
 * Extract the first outbound anchor from a result block.
 *
 * Prefers an anchor inside an `<h3>` (Google's title markup) and falls back to the
 * first anchor with an external target, which covers the variants where the
 * heading is a plain `<a>` or a `<div role="link">`.
 *
 * @param blockHtml - the result block's inner HTML.
 * @returns `{ href, title }`, or `undefined` when no usable anchor exists.
 */
function extractAnchor(blockHtml) {
  const candidates = []
  const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(blockHtml)
  if (heading !== null) {
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading[1])
    if (anchor !== null) candidates.push({ attrs: anchor[1], inner: anchor[2], title: stripTags(anchor[2]) })
  }
  for (const match of blockHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[1])
    if (href === null) continue
    candidates.push({ attrs: match[1], inner: match[2], title: stripTags(match[2]), rawHref: href[1] ?? href[2] })
  }
  for (const candidate of candidates) {
    const hrefAttr = candidate.rawHref ?? /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(candidate.attrs)?.[1]
    const url = unwrapGoogleRedirect(hrefAttr)
    if (isUsableGoogleResultUrl(url)) return { url, title: candidate.title ?? '' }
  }
  return undefined
}

/**
 * Parse a Google result page into sources.
 *
 * @param html - the fetched result page.
 * @returns the parsed sources, in page order.
 */
export function parseGoogleResults(html) {
  const blocks = collectClassMatches(html, RESULT_CLASS)
  if (blocks.length === 0) return []

  const sources = []
  const seen = new Set()
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const nextIndex = i + 1 < blocks.length ? blocks[i + 1].index : html.length
    // Only the block's own slice: a nested `.g` (Google nests result containers)
    // would otherwise make the parent swallow its children.
    const blockHtml = html.slice(block.openEnd, nextIndex)

    const anchor = extractAnchor(blockHtml)
    if (anchor === undefined || seen.has(anchor.url)) continue
    seen.add(anchor.url)

    // The snippet is the longest text run in the block that is not the title.
    // Google puts it in a `div` with a `data-sncf`/`VwiC3b`-style class or a
    // `<span>`; matching by "longest remaining text" avoids depending on either.
    let snippet
    const spans = [...blockHtml.matchAll(/<(?:span|div)\b[^>]*>([\s\S]{40,600}?)<\/(?:span|div)>/gi)]
      .map((match) => stripTags(match[1]))
      .filter((text) => text.length > 40 && text !== anchor.title && !/^https?:\/\//.test(text))
      .sort((a, b) => b.length - a.length)
    if (spans.length > 0) snippet = spans[0]

    sources.push({
      url: anchor.url,
      ...(anchor.title === '' ? {} : { title: anchor.title }),
      ...(snippet === undefined ? {} : { snippet: snippet.length > 400 ? `${snippet.slice(0, 397)}…` : snippet }),
    })
  }
  return sources
}

/**
 * Detect Google's consent wall, captcha, or "unusual traffic" page.
 *
 * @param status - the HTTP status.
 * @param html - the response body.
 * @returns true when the response is a block page rather than results.
 */
export function isGoogleBlocked(status, html) {
  if (status === 429 || status === 403 || status === 503) return true
  if (typeof html !== 'string') return false
  // `consent.google.com` is the cookie wall; `/sorry/` is the anti-bot page.
  if (/consent\.google\.com|\/sorry\/index|unusual traffic|id="captcha-form"|recaptcha/i.test(html)) return true
  return false
}

/**
 * Detect Google's "JavaScript required" shell.
 *
 * This is a distinct outcome from a layout change, and reporting it as one would
 * be actively misleading. Google increasingly answers a non-browser client with a
 * ~93 KB document that contains **no results at all** — measured on this machine
 * through a working proxy: 2 `<div>`s, 0 `<h3>`, 0 `class="g"`, and a `<noscript>`
 * redirect to `/httpservice/retry/enablejs`. The results are fetched by script
 * afterwards, so no amount of HTML parsing will find them.
 *
 * Verified to be served for all of: the default request, `gbv=1`, `udm=14`,
 * `nojs=1`, `complete=0`, `lite=1`, an Android client string, and plain HTTP. So
 * there is no server-rendered variant to fall back to.
 *
 * The practical meaning for a user: this egress is not being served HTML results.
 * A proxy sometimes helps (it changes the apparent client and location) and
 * sometimes does not; a different network, or a SearxNG instance, is the reliable
 * fix.
 *
 * @param html - the response body.
 * @returns true when the body is the JS-required shell rather than results.
 */
export function isGoogleJavaScriptShell(html) {
  if (typeof html !== 'string' || html === '') return false
  // The shell is tiny and empty; a real result page is far larger and full of divs.
  const divs = (html.match(/<div/gi) ?? []).length
  const headings = (html.match(/<h3/gi) ?? []).length
  if (headings > 0 || divs > 40) return false
  return /enablejs|httpservice\/retry|\/sorry\/|please click <a href/i.test(html)
}

/**
 * Search Google.
 *
 * @param options - `{ timeoutMs, deadline, signal, userAgent, logger, limit, proxy }`.
 * @returns `{ sources, usedEndpoint }`.
 * @throws {Error} when the request failed, was blocked, or yielded no results.
 */
export async function searchGoogle(query, { timeoutMs, deadline, signal, userAgent, logger, limit, proxy } = {}) {
  const left = typeof deadline === 'number' ? deadline - Date.now() : timeoutMs
  if (typeof left === 'number' && left <= 0) throw new Error('google: skipped, the search budget was exhausted')
  const budget = typeof left === 'number' ? Math.min(timeoutMs ?? left, left) : timeoutMs

  const url = new URL(ENDPOINT)
  url.searchParams.set('q', query)
  if (Number.isInteger(limit) && limit > 0) url.searchParams.set('num', String(Math.min(30, limit + 2)))
  url.searchParams.set('hl', 'en')

  let response
  try {
    response = await requestText(url.href, {
      timeoutMs: budget,
      signal,
      proxy,
      userAgent: userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
  } catch (error) {
    if (error?.kind === 'aborted') throw error
    // A proxy that cannot reach Google is the single most likely failure here, so
    // the message says which proxy was used — that is the actionable part.
    const via = proxy === undefined ? '' : ` (via proxy ${proxy.protocol}://${proxy.host}:${proxy.port})`
    throw new Error(`google: ${error?.message ?? String(error)}${via}`)
  }

  if (isGoogleBlocked(response.status, response.text)) {
    throw new Error(`google: blocked by Google (HTTP ${response.status}; consent wall or anti-bot page)`)
  }
  if (!response.ok) throw new Error(`google: HTTP ${response.status}`)

  // Checked before parsing, so the user gets the real reason rather than a
  // misleading "layout may have changed".
  if (isGoogleJavaScriptShell(response.text)) {
    throw new Error(
      'google: Google served a JavaScript-only page with no results in the HTML ' +
        '(the /httpservice/retry/enablejs shell). Google no longer renders results for this client. ' +
        (proxy === undefined
          ? 'Configuring a proxy may change how Google classifies this client, but it is not guaranteed.'
          : 'A proxy is already in use, so changing it may help; a SearxNG instance is the reliable alternative.'),
    )
  }

  const sources = parseGoogleResults(response.text)
  if (sources.length === 0) {
    logger?.debug?.('free-web-search: google returned an unparseable page')
    throw new Error('google: no results could be parsed (layout may have changed, or the page was an interstitial)')
  }
  // Guard against a substituted response; see `looksSubstituted` for the measured
  // case that motivated it.
  if (looksSubstituted(sources, query)) {
    const relevance = measureRelevance(sources, query)
    throw new Error(
      `google: returned ${relevance.total} results, none matching the query ` +
        '(the response looks substituted — a proxy or exit node may be rewriting results)',
    )
  }
  return { sources, usedEndpoint: 'google' }
}
