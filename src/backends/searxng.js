/**
 * SearxNG backend — a metasearch instance's JSON API.
 *
 * SearxNG is the best free option here because it returns a documented JSON
 * document instead of a result page, so there is no markup to guess at. It is
 * also a *metasearch* engine: one request fans out to several upstream engines
 * (Google, Bing, Brave, Wikipedia, …) and the instance merges the answers.
 *
 * The catch is that public instances are volunteer-run and individually
 * unreliable — they rate-limit, disable the JSON format, or go offline — so this
 * backend accepts a list of instances and walks it until one answers usefully.
 * The list is configuration, never hard-coded, because the set of instances that
 * allow JSON changes over time.
 *
 * @module src/backends/searxng.js
 */

import { requestJson } from '../http.js'

/**
 * Turn one SearxNG result entry into the seam's source shape.
 *
 * @param entry - one element of the instance's `results` array.
 * @returns a source, or `undefined` when the entry carries no usable URL.
 */
function toSource(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const url = typeof entry.url === 'string' ? entry.url.trim() : ''
  if (url === '') return undefined
  const title = typeof entry.title === 'string' ? entry.title.trim() : ''
  // `content` is the snippet; some engines only fill `pretty_url`.
  const snippet = typeof entry.content === 'string' && entry.content.trim() !== '' ? entry.content.trim() : undefined
  const published = typeof entry.publishedDate === 'string' && entry.publishedDate.trim() !== '' ? entry.publishedDate.trim() : undefined
  return {
    url,
    ...(title === '' ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(published === undefined ? {} : { publishedAt: published }),
  }
}

/**
 * Read the `results` array out of an instance response.
 *
 * SearxNG answers a rejected request with HTTP 200 and a body that is either an
 * HTML error page or a JSON object without `results`, so both the status and the
 * shape are checked before the body is trusted.
 *
 * @param payload - the parsed JSON body, or `undefined` when it was not JSON.
 * @returns the entries, or `undefined` when the payload was not a result set.
 */
function readResults(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  if (!Array.isArray(payload.results)) return undefined
  return payload.results
}

/**
 * Search through the first SearxNG instance that answers.
 *
 * @param options - `{ instances, timeoutMs, deadline, signal, userAgent, logger, proxy }`.
 *        `deadline` is an absolute `Date.now()` value shared across the whole
 *        search: it caps the *total* time spent walking instances, so five slow
 *        instances cannot each burn a full timeout. `signal` is the caller's
 *        cancellation, forwarded so a cancel aborts the in-flight request.
 *        `proxy` routes each instance request through a proxy when configured.
 * @returns `{ sources, usedInstance }`.
 * @throws {Error} when no instance produced a usable response; the message names
 *         every instance tried and why each was rejected.
 */
export async function searchSearxng(query, { instances, timeoutMs, deadline, signal, userAgent, logger, proxy } = {}) {
  const list = Array.isArray(instances) ? instances.filter((item) => typeof item === 'string' && item.trim() !== '') : []
  if (list.length === 0) throw new Error('searxng: no instance is configured')

  const failures = []
  for (const base of list) {
    const trimmed = base.trim().replace(/\/+$/, '')

    // Stop as soon as the shared budget is gone, and never give one instance
    // more than the time actually left.
    const left = typeof deadline === 'number' ? deadline - Date.now() : timeoutMs
    if (typeof left === 'number' && left <= 0) {
      failures.push(`${trimmed}: skipped, the search budget was exhausted`)
      continue
    }
    const budget = typeof left === 'number' ? Math.min(timeoutMs ?? left, left) : timeoutMs

    let endpoint
    try {
      // `format=json` is what makes this a data source rather than a scrape.
      const url = new URL('/search', `${trimmed}/`)
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      url.searchParams.set('safesearch', '0')
      endpoint = url.href
    } catch {
      failures.push(`${trimmed}: not a valid URL`)
      continue
    }

    try {
      const { ok, status, json, url } = await requestJson(endpoint, {
        timeoutMs: budget,
        signal,
        userAgent,
        proxy,
        headers: { accept: 'application/json' },
      })
      if (!ok) {
        failures.push(`${trimmed}: HTTP ${status}`)
        continue
      }
      const results = readResults(json)
      if (results === undefined) {
        // HTTP 200 with a non-JSON body almost always means "JSON output is
        // disabled on this instance" or a rate-limit interstitial.
        failures.push(`${trimmed}: JSON format unavailable (the instance may disable it, or rate-limit this client)`)
        continue
      }
      const sources = []
      for (const entry of results) {
        const source = toSource(entry)
        if (source !== undefined) sources.push(source)
      }
      if (sources.length === 0) {
        failures.push(`${trimmed}: answered with zero results`)
        continue
      }
      // Report the instance that answered, not the response's final URL: with
      // redirects followed, `url` may be a different host than the one tried, and
      // the useful fact for the operator is which configured instance worked.
      return { sources, usedInstance: trimmed }
    } catch (error) {
      // An abort means the caller cancelled: stop walking the list rather than
      // burning the remaining instances on a search nobody is waiting for.
      if (error?.kind === 'aborted') throw error
      failures.push(`${trimmed}: ${error?.message ?? String(error)}`)
      logger?.debug?.(`free-web-search: searxng instance failed (${trimmed}): ${error?.message ?? error}`)
    }
  }

  throw new Error(`searxng: every configured instance failed — ${failures.join('; ')}`)
}
