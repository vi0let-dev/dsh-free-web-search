/**
 * Shared URL validation for the scrape-based backends.
 *
 * Both Bing and DuckDuckGo return result pages that mix real results with their
 * own internal navigation, redirector endpoints and advertising slots. Deciding
 * which links are usable citations is the same *shape* of problem for both, with
 * different host lists — so the rule lives here once, parameterised, rather than
 * being reimplemented per backend and drifting apart.
 *
 * @module src/urls.js
 */

/**
 * Decide whether a URL may be reported as a search source.
 *
 * @param url - the candidate URL.
 * @param options - `{ blockedHosts, blockedPaths }`.
 *        `blockedHosts` entries match the host exactly or as a parent domain, so
 *        `'bing.com'` also blocks `www.bing.com`.
 *        `blockedPaths` entries are `{ host, prefix }` pairs, for hosts that are
 *        legitimate results in general but have an internal path to exclude.
 * @returns true when the URL is a usable citation.
 */
export function isUsableResultUrl(url, options = {}) {
  const { blockedHosts = [], blockedPaths = [] } = options
  if (typeof url !== 'string' || url === '') return false

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const host = parsed.hostname.toLowerCase()
  for (const blocked of blockedHosts) {
    const name = String(blocked).toLowerCase()
    if (host === name || host.endsWith(`.${name}`)) return false
  }
  for (const rule of blockedPaths) {
    const name = String(rule?.host ?? '').toLowerCase()
    if (name === '') continue
    if (host !== name && !host.endsWith(`.${name}`)) continue
    if (parsed.pathname.startsWith(String(rule.prefix ?? ''))) return false
  }
  return true
}

/**
 * Decode a base64url string into UTF-8 text.
 *
 * Used for the redirect parameters both engines embed; they encode the target
 * URL with the URL-safe alphabet and omit padding, so both have to be restored
 * before decoding.
 *
 * @param value - the encoded text.
 * @returns the decoded string, or `undefined` when it is not decodable.
 */
export function decodeBase64Url(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    // `Buffer` is available in every environment this plugin runs in: it is a
    // DSH *host* plugin, so it only ever loads inside Node.
    const text = Buffer.from(padded, 'base64').toString('utf8')
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** Words too common to indicate that a result is about the query. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which', 'who', 'how', 'why',
  'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'you', 'your', 'its', 'can', 'will', 'would',
  'there', 'their', 'them', 'then', 'than', 'into', 'over', 'under', 'about', 'after', 'before', 'best',
  'com', 'www', 'http', 'https',
])

/**
 * Extract the query terms worth checking for in a result.
 *
 * @param query - the user's query.
 * @returns lowercase terms of 3+ characters, minus stop words.
 */
export function queryTerms(query) {
  if (typeof query !== 'string') return []
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
}

/**
 * Measure how many results actually look like they are about the query.
 *
 * ## Why this exists
 *
 * A search provider that returns **plausible but unrelated** results is far more
 * harmful than one that fails: the model cites them, and the user has no way to
 * tell. That is not hypothetical — it was measured. With a proxy in use, Bing
 * answered HTTP 200 with a page whose `<title>` and search box correctly read
 * "DeepSeek Harness", while the organic results were about Michigan casinos, then
 * Japanese sneakers, then Gmail on successive requests. The same garbage came back
 * through a raw tunnel that bypassed this plugin's HTTP layer entirely, so the
 * cause is the exit node, not the parser.
 *
 * The check is deliberately loose — it asks only whether *any* significant term
 * from the query appears in a result's title, snippet or URL. It is a sanity
 * filter against wholesale substitution, not a relevance ranking, and a legitimate
 * result set that happens to avoid every query term is a very unusual thing.
 *
 * @param sources - the parsed sources.
 * @param query - the user's query.
 * @returns `{ total, matching, ratio, checked }`, where `checked` is false when
 *          the query had no significant terms (so no verdict can be drawn).
 */
export function measureRelevance(sources, query) {
  const terms = queryTerms(query)
  const list = Array.isArray(sources) ? sources : []
  if (terms.length === 0 || list.length === 0) {
    return { total: list.length, matching: 0, ratio: 0, checked: false }
  }
  let matching = 0
  for (const source of list) {
    const haystack = `${source?.title ?? ''} ${source?.snippet ?? ''} ${source?.url ?? ''}`.toLowerCase()
    if (terms.some((term) => haystack.includes(term))) matching += 1
  }
  return { total: list.length, matching, ratio: matching / list.length, checked: true }
}

/**
 * Decide whether a result set looks substituted rather than merely imperfect.
 *
 * Requires both a meaningful sample size and a total absence of matches, so a
 * small or partially-relevant result set is never rejected. The threshold is
 * intentionally conservative: rejecting good results is worse than passing
 * through a bad set that the next backend would have replaced anyway.
 *
 * @param sources - the parsed sources.
 * @param query - the user's query.
 * @param options - `{ minResults, minMatches }`.
 * @returns true when the results should be treated as not answering the query.
 */
export function looksSubstituted(sources, query, { minResults = 3, minMatches = 1 } = {}) {
  const relevance = measureRelevance(sources, query)
  if (!relevance.checked) return false
  if (relevance.total < minResults) return false
  return relevance.matching < minMatches
}
