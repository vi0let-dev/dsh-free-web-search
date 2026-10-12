/**
 * Wikipedia backend — the MediaWiki action API.
 *
 * This is the only backend here backed by an explicit public API contract: no
 * key, no quota, no scraping, and a documented JSON envelope. It is not a
 * general web search, but for the large class of factual and definitional
 * queries it is both the most reliable and the most authoritative source
 * available for free — so it is most useful as a *fallback* after a general
 * engine, which is exactly how the plugin orders it by default.
 *
 * @module src/backends/wikipedia.js
 */

import { requestJson } from '../http.js'

/** Shape of the URL used for a page when the API did not report a canonical one. */
const FALLBACK_PAGE = (lang, title) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

/**
 * Search Wikipedia and return page-level sources.
 *
 * Two round trips are used: the search endpoint gives ranked titles, then a
 * single batched query fetches extracts and canonical URLs for all of them at
 * once. That keeps the request count at two regardless of the result limit,
 * instead of one request per hit.
 *
 * @param options - `{ lang, timeoutMs, deadline, signal, userAgent, limit, logger, proxy }`.
 *        `deadline` is an absolute `Date.now()` value shared across the whole
 *        search, so the second round trip only gets what the first left behind.
 *        `signal` is the caller's cancellation, forwarded to both requests.
 *        `proxy` routes both requests through a proxy when one is configured.
 * @returns `{ sources }`.
 * @throws {Error} when the API could not be reached or returned no usable pages.
 */
export async function searchWikipedia(query, { lang = 'en', timeoutMs, deadline, signal, userAgent, limit: requestedLimit, logger, proxy } = {}) {
  const language = typeof lang === 'string' && /^[a-z]{2,3}(-[a-z]+)?$/i.test(lang.trim()) ? lang.trim().toLowerCase() : 'en'
  const api = `https://${language}.wikipedia.org/w/api.php`
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 20) : 5

  /** Time left for one request, capped by the per-request timeout. */
  const budgetFor = () => {
    if (typeof deadline !== 'number') return timeoutMs
    const left = deadline - Date.now()
    if (left <= 0) return 0
    return typeof timeoutMs === 'number' ? Math.min(timeoutMs, left) : left
  }

  const searchBudget = budgetFor()
  if (searchBudget === 0) throw new Error('wikipedia: skipped, the search budget was exhausted')

  const searchUrl = new URL(api)
  searchUrl.searchParams.set('action', 'query')
  searchUrl.searchParams.set('list', 'search')
  searchUrl.searchParams.set('srsearch', query)
  searchUrl.searchParams.set('srlimit', String(limit))
  searchUrl.searchParams.set('format', 'json')
  searchUrl.searchParams.set('origin', '*')

  const found = await requestJson(searchUrl.href, { timeoutMs: searchBudget, signal, userAgent, proxy, headers: { accept: 'application/json' } })
  if (!found.ok) throw new Error(`wikipedia: search endpoint returned HTTP ${found.status}`)
  const hits = found.json?.query?.search
  if (!Array.isArray(hits) || hits.length === 0) throw new Error('wikipedia: no pages matched this query')

  const titles = hits.map((hit) => (typeof hit?.title === 'string' ? hit.title : '')).filter((title) => title !== '')
  if (titles.length === 0) throw new Error('wikipedia: no pages matched this query')

  // One batched call for every title: extracts plus canonical URLs.
  const detailUrl = new URL(api)
  detailUrl.searchParams.set('action', 'query')
  detailUrl.searchParams.set('titles', titles.join('|'))
  detailUrl.searchParams.set('prop', 'extracts|info')
  detailUrl.searchParams.set('exintro', '1')
  detailUrl.searchParams.set('explaintext', '1')
  detailUrl.searchParams.set('inprop', 'url')
  detailUrl.searchParams.set('redirects', '1')
  detailUrl.searchParams.set('format', 'json')
  detailUrl.searchParams.set('origin', '*')

  let pages = []
  try {
    const detailBudget = budgetFor()
    if (detailBudget === 0) throw Object.assign(new Error('budget exhausted'), { kind: 'timeout' })
    const detail = await requestJson(detailUrl.href, { timeoutMs: detailBudget, signal, userAgent, proxy, headers: { accept: 'application/json' } })
    const byId = detail.json?.query?.pages
    if (byId !== null && typeof byId === 'object') pages = Object.values(byId)
  } catch (error) {
    // The search round trip already succeeded, so a failed detail call must not
    // lose the ranking: fall back to titles with a constructed URL.
    if (error?.kind === 'aborted') throw error
    logger?.debug?.(`free-web-search: wikipedia detail lookup failed, using titles only: ${error?.message ?? error}`)
  }

  const detailByTitle = new Map()
  for (const page of pages) {
    if (typeof page?.title === 'string') detailByTitle.set(page.title, page)
  }

  const sources = []
  for (const hit of hits) {
    const title = typeof hit?.title === 'string' ? hit.title : ''
    if (title === '') continue
    const page = detailByTitle.get(title)
    const url = typeof page?.fullurl === 'string' && page.fullurl !== '' ? page.fullurl : FALLBACK_PAGE(language, title)
    const extract = typeof page?.extract === 'string' ? page.extract.replace(/\s+/g, ' ').trim() : ''
    // `srsearch` includes an HTML-highlighted snippet; strip it for display.
    const fallbackSnippet = typeof hit?.snippet === 'string' ? hit.snippet.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : ''
    const snippet = extract !== '' ? (extract.length > 400 ? `${extract.slice(0, 397)}…` : extract) : fallbackSnippet
    const timestamp = typeof hit?.timestamp === 'string' ? hit.timestamp : undefined
    sources.push({
      url,
      title,
      ...(snippet === '' ? {} : { snippet }),
      ...(timestamp === undefined ? {} : { publishedAt: timestamp }),
    })
  }

  if (sources.length === 0) throw new Error('wikipedia: no pages matched this query')
  return { sources }
}
