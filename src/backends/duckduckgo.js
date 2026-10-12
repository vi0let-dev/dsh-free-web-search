/**
 * DuckDuckGo backend — the HTML and Lite result pages.
 *
 * This is the only backend here that parses markup rather than a documented API,
 * which is why it is written defensively and why it is not the plugin's first
 * choice for a general query. It earns its place because it needs no instance to
 * be configured and no key to be obtained: on a machine where every SearxNG
 * instance happens to be down, it is the difference between an answer and an
 * error.
 *
 * Two endpoints are tried, in order:
 *
 *   - `html.duckduckgo.com/html/` — the full result page, richest snippets.
 *   - `lite.duckduckgo.com/lite/` — the table-based low-bandwidth page. It uses
 *     different class names, but it is a separate code path on DuckDuckGo's side
 *     and frequently keeps working when the html endpoint starts refusing.
 *
 * Both wrap outbound links in a `duckduckgo.com/l/?uddg=…` redirector. The real
 * target is unwrapped before the source is reported, because the seam renders
 * the URL to the user and cites it — a redirector link is not a citation.
 *
 * @module src/backends/duckduckgo.js
 */

import { requestText } from '../http.js'
import { collectClassMatches, innerOf, stripTags, attrValue } from '../html.js'
import { isUsableResultUrl as isUsableUrl, looksSubstituted, measureRelevance } from '../urls.js'

/** The two result endpoints, in preference order. */
const ENDPOINTS = [
  {
    name: 'html',
    url: 'https://html.duckduckgo.com/html/',
    titleClass: 'result__a',
    snippetClass: 'result__snippet',
  },
  {
    name: 'lite',
    url: 'https://lite.duckduckgo.com/lite/',
    titleClass: 'result-link',
    snippetClass: 'result-snippet',
  },
]

/**
 * Unwrap DuckDuckGo's outbound-link redirector.
 *
 * The redirector appears in three shapes across the two endpoints: a
 * protocol-relative URL, an absolute one, and (on the Lite page) a bare path.
 * Anything that is not a redirector is returned unchanged, and a redirector
 * whose target cannot be recovered yields `undefined` so the caller can skip the
 * result rather than cite a dead wrapper.
 *
 * @param href - the raw `href` attribute value.
 * @returns the real target URL, or `undefined` when it cannot be recovered.
 */
export function unwrapRedirect(href) {
  if (typeof href !== 'string' || href.trim() === '') return undefined
  const raw = href.trim()

  // Fast path: an ordinary absolute link is already the target.
  const looksLikeRedirector = /(?:^|\/\/|\.)duckduckgo\.com\/l\/?\?/i.test(raw) || raw.startsWith('/l/?')
  if (!looksLikeRedirector) return raw.startsWith('//') ? `https:${raw}` : raw

  let target
  try {
    const parsed = new URL(raw, 'https://duckduckgo.com')
    target = parsed.searchParams.get('uddg')
  } catch {
    return undefined
  }
  if (target === null || target === '') return undefined

  // `searchParams` has already percent-decoded the value once; a second decode
  // is what makes `%3A%2F%2F`-style double encoding resolve.
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/**
 * Reject URLs that are not usable citations.
 *
 * DuckDuckGo's pages contain internal navigation, ad slots and its own help
 * links; none of those belong in a search result set. The rule itself is shared
 * with the Bing backend (see `../urls.js`); only the host list is specific.
 *
 * @param url - a candidate target URL.
 * @returns true when the URL should be reported as a source.
 */
export function isUsableResultUrl(url) {
  return isUsableUrl(url, {
    blockedHosts: ['duckduckgo.com'],
    // `bing.com/aclick` is Bing's ad-redirect path, which DuckDuckGo funnels
    // sponsored hits through. Bing's own backend must NOT block this host
    // wholesale, which is why the rule is expressed as a path here.
    blockedPaths: [{ host: 'bing.com', prefix: '/aclick' }],
  })
}

/**
 * Find the link a matched title element points at.
 *
 * The two endpoints disagree about where the link lives. On the html page the
 * matched element *is* the anchor (`<a class="result__a" href=…>`), while on the
 * Lite page it is the wrapping table cell (`<td class="result-link"><a href=…>`).
 * Reading `href` off the matched element alone would therefore silently produce
 * zero results on the Lite endpoint — the exact failure that is hardest to
 * notice, because it looks like a layout change rather than a bug.
 *
 * @param html - the document.
 * @param match - a match from `collectClassMatches`.
 * @returns the raw `href`, or `undefined` when neither the element nor a nested
 *          anchor carries one.
 */
function findHref(html, match) {
  if (typeof match.href === 'string' && match.href !== '') return match.href
  // Look only inside this element, so a neighbouring result's link is never used.
  const inner = innerOf(html, match)
  const nested = /<a\b([^>]*)>/i.exec(inner)
  if (nested === null) return undefined
  return attrValue(nested[1], 'href')
}

/**
 * Parse one result page into sources.
 *
 * Titles and snippets are paired by document position: each snippet is attached
 * to the nearest preceding title. That relationship is the one thing both
 * endpoints preserve, and pairing this way keeps a layout change from silently
 * attaching every snippet to the wrong result.
 *
 * @param html - the fetched result page.
 * @param endpoint - one entry of {@link ENDPOINTS}.
 * @returns the parsed sources, in page order.
 */
export function parseResultsPage(html, endpoint) {
  const titles = collectClassMatches(html, endpoint.titleClass)
  if (titles.length === 0) return []
  const snippets = collectClassMatches(html, endpoint.snippetClass)

  const sources = []
  for (let i = 0; i < titles.length; i += 1) {
    const titleMatch = titles[i]
    const url = unwrapRedirect(findHref(html, titleMatch))
    if (!isUsableResultUrl(url)) continue

    // The title text is the anchor's own inner HTML, not the whole element.
    const title = stripTags(innerOf(html, titleMatch))

    // Attribute the first snippet that starts after this title and before the
    // next one; searching the whole tail would reuse one snippet for every hit.
    const nextTitleIndex = i + 1 < titles.length ? titles[i + 1].index : Number.POSITIVE_INFINITY
    let snippet
    for (const candidate of snippets) {
      if (candidate.index <= titleMatch.index) continue
      if (candidate.index >= nextTitleIndex) break
      const text = stripTags(innerOf(html, candidate))
      if (text !== '') {
        snippet = text
        break
      }
    }

    sources.push({
      url,
      ...(title === '' ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
    })
  }
  return sources
}

/**
 * Detect DuckDuckGo's anti-automation interstitial.
 *
 * A 202, or a body that is the anomaly page rather than results, means this
 * backend is rate-limited right now. Reporting that distinctly matters: it tells
 * the operator to slow down or configure a SearxNG instance, rather than looking
 * like a generic network failure.
 *
 * @param status - the HTTP status.
 * @param html - the response body.
 * @returns true when the response is a block page.
 */
export function isBlocked(status, html) {
  if (status === 202 || status === 429 || status === 403) return true
  if (typeof html !== 'string') return false
  return /anomaly-modal|If this error persists|unusual traffic|challenge-form/i.test(html)
}

/**
 * Search through the DuckDuckGo result pages.
 *
 * @param options - `{ timeoutMs, deadline, signal, userAgent, logger, proxy }`.
 *        `deadline` is an absolute `Date.now()` value shared across the whole
 *        search, so the second endpoint only gets the time the first one left
 *        behind. `signal` is the caller's cancellation, forwarded so a cancel
 *        aborts the in-flight request instead of waiting for the deadline.
 *        `proxy` routes each endpoint request through a proxy when configured.
 * @returns `{ sources, usedEndpoint }`.
 * @throws {Error} when both endpoints failed or were blocked.
 */
export async function searchDuckDuckGo(query, { timeoutMs, deadline, signal, userAgent, logger, proxy } = {}) {
  const failures = []

  for (const endpoint of ENDPOINTS) {
    const left = typeof deadline === 'number' ? deadline - Date.now() : timeoutMs
    if (typeof left === 'number' && left <= 0) {
      failures.push(`${endpoint.name}: skipped, the search budget was exhausted`)
      continue
    }
    const budget = typeof left === 'number' ? Math.min(timeoutMs ?? left, left) : timeoutMs

    let response
    try {
      response = await requestText(endpoint.url, {
        timeoutMs: budget,
        signal,
        proxy,
        userAgent,
        method: 'POST',
        redirect: 'follow',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // A same-origin referer is what the real page sends, and its absence
          // is one of the signals the anomaly detector keys on.
          referer: endpoint.url,
        },
        body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
      })
    } catch (error) {
      if (error?.kind === 'aborted') throw error
      failures.push(`${endpoint.name}: ${error?.message ?? String(error)}`)
      continue
    }

    if (isBlocked(response.status, response.text)) {
      failures.push(`${endpoint.name}: blocked by DuckDuckGo (HTTP ${response.status}; rate-limited or interstitial)`)
      continue
    }
    if (!response.ok) {
      failures.push(`${endpoint.name}: HTTP ${response.status}`)
      continue
    }

    const sources = parseResultsPage(response.text, endpoint)
    if (sources.length === 0) {
      // A 200 with no parseable results is the signature of a layout change, and
      // is worth surfacing as such — it is the one failure that needs a code fix.
      failures.push(`${endpoint.name}: no results could be parsed (layout may have changed)`)
      logger?.debug?.(`free-web-search: duckduckgo ${endpoint.name} returned an unparseable page`)
      continue
    }
    // Guard against a substituted response; see `looksSubstituted` for the measured
    // case that motivated it.
    if (looksSubstituted(sources, query)) {
      const relevance = measureRelevance(sources, query)
      failures.push(
        `${endpoint.name}: ${relevance.total} results but none matching the query (looks substituted)`,
      )
      continue
    }
    return { sources, usedEndpoint: endpoint.name }
  }

  throw new Error(`duckduckgo: every endpoint failed — ${failures.join('; ')}`)
}
