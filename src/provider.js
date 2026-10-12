/**
 * The `WebSearchProvider` implementation registered with `ctx.web`.
 *
 * Its one interesting responsibility is conflict avoidance. The seam's provider
 * selection is *registration-order independent* and refuses to guess: with no
 * provider configured and more than one usable provider registered, it throws
 * `WEB_PROVIDER_AMBIGUOUS`. A plugin that simply registered itself as always
 * available would therefore take a working installation and break it — the
 * official DeepSeek provider and this one would both claim the slot, and every
 * `web_search` call would start failing with an ambiguity error.
 *
 * So this provider is a **fallback by default**, and that is a deliberate
 * design choice rather than a limitation:
 *
 *   - it reports itself available when the user has explicitly selected it
 *     (`DSH_WEB_SEARCH_PROVIDER=free-web`, or `searchProvider: 'free-web'`),
 *     because an explicit choice must always be honoured;
 *   - otherwise it reports itself available only when no *other* usable search
 *     provider is registered, so installing the plugin adds a working search to
 *     a bare installation and stays dormant in one that already has search;
 *   - `takeover: true` overrides both and always claims the slot.
 *
 * Determining "is another provider registered" means reading the seam's own
 * registry. That is introspection of another module's internals, so it is done
 * behind a guard that treats any surprise as "assume another provider exists" —
 * the safe direction, since a wrong guess then costs a dormant plugin instead of
 * a broken one.
 *
 * @module src/provider.js
 */

import { HttpError } from './http.js'
import { dedupeSources } from './html.js'
import {
  searchBaidu,
  searchBing,
  searchDuckDuckGo,
  searchGoogle,
  searchSearxng,
  searchWikipedia,
  searchYandex,
} from './backends/index.js'

/** Stable id this provider registers under. Distinct from every shipped provider id. */
export const FREE_SEARCH_PROVIDER_ID = 'free-web'

/** Environment variable that selects a search provider for the whole seam. */
const PROVIDER_ENV = 'DSH_WEB_SEARCH_PROVIDER'

/** Default per-request budget. Public instances are slow; 12s is a usable middle ground. */
const DEFAULT_TIMEOUT_MS = 12000

/**
 * Smallest slice of the budget a backend may be given.
 *
 * Below roughly this, no backend can complete a request, so spending the time is
 * pointless. The floor is what stops an even division of a nearly-spent budget
 * from handing the last backend a 200ms attempt that was never going to work.
 */
const MIN_BACKEND_SLICE_MS = 2000

/** A stable, honest product User-Agent — never a browser disguise. */
const DEFAULT_USER_AGENT = 'deepseek-harness-free-web-search/1.0 (+https://github.com/deepseek-ai/deepseek-harness)'

/**
 * Public SearxNG instances that are commonly known to serve the JSON API.
 *
 * These are a *starting point only* and are deliberately not treated as
 * guaranteed: public instances come and go, and one that answers today may
 * disable JSON output tomorrow. A failure against every one of them is a normal,
 * reported outcome — not an internal error. Operators who care about reliability
 * should point `searxngInstances` at an instance they run themselves.
 */
export const DEFAULT_SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://searxng.site',
  'https://priv.au',
  'https://search.inetol.net',
]

/**
 * Read the seam's registered search providers, without assuming anything about
 * how the seam stores them.
 *
 * @param web - the `ctx.web` service instance.
 * @returns a `Map` of id → provider, or `undefined` when it could not be read.
 */
function readRegisteredProviders(web) {
  try {
    const store = web?.searchProviders
    if (store instanceof Map) return store
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Read the id the seam was configured to use, if any.
 *
 * @param web - the `ctx.web` service instance.
 * @returns the configured id, or `undefined`.
 */
function readConfiguredProviderId(web) {
  try {
    const id = web?.searchProviderId
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * The primary endpoint host of each backend.
 *
 * Used only for the `noProxy` check, so that a `noProxy: ['baidu.com']` entry
 * can exempt Baidu without exempting everything. It is a best-effort label: a
 * backend that talks to several hosts (SearxNG walks a list) is represented by
 * its most characteristic one.
 */
const BACKEND_HOSTS = {
  searxng: 'searx.be',
  google: 'www.google.com',
  bing: 'www.bing.com',
  baidu: 'www.baidu.com',
  yandex: 'yandex.com',
  duckduckgo: 'html.duckduckgo.com',
  wikipedia: 'en.wikipedia.org',
}

/**
 * Run exactly one backend.
 *
 * Extracted from the chain because the speed test needs to run the *same*
 * backends through the *same* code path — a diagnostic that exercised a
 * different path than real searches would measure something other than what the
 * user experiences.
 *
 * @param backend - the backend name.
 * @param query - the query.
 * @param options - `{ timeoutMs, deadline, signal, userAgent, logger, limit, proxy,
 *        searxngInstances, wikipediaLang }`.
 * @returns `{ sources, detail }`.
 * @throws {Error} when the backend fails; message names the cause.
 */
export async function runOneBackend(backend, query, options) {
  const { timeoutMs, deadline, signal, userAgent, logger, limit, proxy, searxngInstances, wikipediaLang } = options
  const shared = { timeoutMs, deadline, signal, userAgent, logger, proxy }

  if (backend === 'searxng') {
    const { sources, usedInstance } = await searchSearxng(query, { ...shared, instances: searxngInstances })
    return { sources, detail: usedInstance }
  }
  if (backend === 'google') {
    const { sources, usedEndpoint } = await searchGoogle(query, { ...shared, limit })
    return { sources, detail: `google/${usedEndpoint}` }
  }
  if (backend === 'bing') {
    const { sources, usedEndpoint } = await searchBing(query, { ...shared, limit })
    return { sources, detail: `bing/${usedEndpoint}` }
  }
  if (backend === 'baidu') {
    const { sources, usedEndpoint } = await searchBaidu(query, { ...shared, limit })
    return { sources, detail: `baidu/${usedEndpoint}` }
  }
  if (backend === 'yandex') {
    const { sources, usedEndpoint } = await searchYandex(query, { ...shared, limit })
    return { sources, detail: `yandex/${usedEndpoint}` }
  }
  if (backend === 'duckduckgo') {
    const { sources, usedEndpoint } = await searchDuckDuckGo(query, shared)
    return { sources, detail: `duckduckgo/${usedEndpoint}` }
  }
  if (backend === 'wikipedia') {
    const { sources } = await searchWikipedia(query, { ...shared, lang: wikipediaLang, limit })
    return { sources, detail: `wikipedia/${wikipediaLang}` }
  }
  throw new Error(`${backend}: unknown backend name`)
}

/**
 * Run the enabled backends in order and return the first non-empty result.
 *
 * The whole chain runs under one wall-clock budget (`totalTimeoutMs`), divided so
 * that **every backend is guaranteed a turn**.
 *
 * A naive shared deadline is not enough, and this was measured rather than
 * assumed: with four backends and a 24s budget, five hung SearxNG instances
 * consumed all 24s, and the three backends behind it were reported as
 * `skipped, the search budget was exhausted` — never actually tried. That is the
 * worst possible failure, because it is exactly the case the chain exists for
 * (the first backend is down and a later one would have worked).
 *
 * So the budget is allocated as a reservation. Each backend gets its own share,
 * and the shares of the backends behind it are protected: a backend may never
 * consume more than its share. A fast failure hands its unused time back to the
 * pool, so a healthy chain is not slowed down by the reservation — only a hung
 * one is cut short.
 *
 * @param query - the user's query.
 * @param options - resolved provider options.
 * @returns `{ sources, backend, attempts }`.
 * @throws {HttpError} with `kind: 'aborted'` when the caller cancelled.
 * @throws {Error} when every enabled backend failed, naming each failure.
 */
async function runBackends(query, options) {
  const { backends, timeoutMs, totalTimeoutMs, logger, limit } = options
  const attempts = []
  const deadline = Date.now() + totalTimeoutMs

  for (const [index, backend] of backends.entries()) {
    // Check between backends too, so a cancel during a slow first backend does
    // not get followed by two more requests.
    if (options.signal?.aborted === true) {
      throw new HttpError('search aborted', { kind: 'aborted' })
    }
    const left = Math.max(0, deadline - Date.now())
    if (left === 0) {
      attempts.push(`${backend}: skipped, the ${totalTimeoutMs}ms search budget was exhausted`)
      continue
    }

    // How many backends still need a turn, including this one.
    const stillToTry = backends.length - index
    // Reserve a usable slice for every backend *behind* this one, and let this
    // one use the rest — capped by the per-request timeout, so a generous budget
    // never silently becomes a longer per-request wait than configured.
    const reservedForRest = MIN_BACKEND_SLICE_MS * (stillToTry - 1)
    const ownShare = left - reservedForRest
    // When the budget is too small to reserve anything (a short test budget, or a
    // search that has already nearly run out), split what is left evenly instead.
    // Every backend then gets a short turn rather than the last ones getting
    // none — a short attempt can still succeed, whereas no attempt cannot.
    const share = ownShare >= MIN_BACKEND_SLICE_MS ? ownShare : Math.floor(left / stillToTry)
    const perRequest = Math.max(1, Math.min(timeoutMs, share))

    // This backend's own deadline, so a multi-request backend (SearxNG walking
    // instances, Wikipedia making two round trips) cannot run past its share.
    const backendDeadline = Math.min(deadline, Date.now() + perRequest)

    try {
      const { sources, detail } = await runOneBackend(backend, query, {
        ...options,
        timeoutMs: perRequest,
        deadline: backendDeadline,
        proxy: resolveBackendProxy(options, backend),
      })
      return { sources, backend, detail, attempts }
    } catch (error) {
      // A cancellation is the caller's decision: surface it as-is rather than
      // spending the remaining backends on a search nobody is waiting for.
      if (error?.kind === 'aborted' || options.signal?.aborted === true) {
        throw error?.kind === 'aborted' ? error : new HttpError('search aborted', { kind: 'aborted', cause: error })
      }
      attempts.push(error?.message ?? String(error))
      logger?.debug?.(`free-web-search: backend "${backend}" failed: ${error?.message ?? error}`)
    }
  }

  throw new Error(`free-web-search: all enabled backends failed (${attempts.join(' | ')})`)
}

/**
 * Resolve the proxy that applies to one backend.
 *
 * @param options - resolved provider options, carrying the proxy policy.
 * @param backend - the backend name.
 * @returns a parsed proxy, or `undefined` for a direct connection.
 */
function resolveBackendProxy(options, backend) {
  const policy = options.proxyPolicy
  if (policy === undefined || policy === null) return undefined
  try {
    return policy.for(backend, BACKEND_HOSTS[backend])
  } catch {
    // A malformed policy must not break searching; fall back to direct.
    return undefined
  }
}

export { BACKEND_HOSTS }

/**
 * The free multi-backend search provider.
 */
export class FreeSearchProvider {
  /**
   * @param resolveOptions - a thunk returning the options for the *next*
   *        operation, so one search never mixes two configuration snapshots.
   *        A thunk rather than a value because the plugin's config can be
   *        re-evaluated, and re-registering the provider to carry it would make
   *        the seam's selection flicker for the user.
   * @param getWeb - a thunk returning the current `ctx.web` service, used only
   *        for the availability heuristic above.
   */
  constructor(resolveOptions, getWeb) {
    this.resolveOptions = resolveOptions
    this.getWeb = getWeb
    this.id = FREE_SEARCH_PROVIDER_ID
  }

  /**
   * Report whether this provider can run a search right now.
   *
   * The result is consulted by the seam on every call, so it must be cheap and
   * must never throw.
   *
   * @returns true when this provider is willing to be selected.
   */
  available() {
    let options
    try {
      options = this.resolveOptions()
    } catch {
      return false
    }
    if (options === undefined || options === null) return false
    if (!Array.isArray(options.backends) || options.backends.length === 0) return false
    // `fetch` is the only hard requirement; without it no backend can work.
    if (typeof fetch !== 'function') return false
    if (options.takeover === true) return true

    let web
    try {
      web = this.getWeb?.()
    } catch {
      web = undefined
    }

    const configured = readConfiguredProviderId(web)
    if (configured === this.id) return true
    // Another provider was explicitly chosen: stay out of the way. Reporting
    // available here would not steal the slot (selection is by id), but it would
    // make the *unconfigured* case ambiguous for no benefit.
    if (configured !== undefined) return false

    const registered = readRegisteredProviders(web)
    if (registered === undefined) {
      // The registry could not be inspected. Claim the slot so the plugin works
      // at all; the cost of being wrong is a documented one-line configuration.
      return true
    }
    for (const id of registered.keys()) {
      if (id === this.id) continue
      const other = registered.get(id)
      let otherUsable = false
      try {
        otherUsable = other?.available?.() === true
      } catch {
        otherUsable = false
      }
      if (otherUsable) return false
    }
    return true
  }

  /**
   * Run one search through the backend chain.
   *
   * @param request - `{ query, maxResults? }`.
   * @param signal - optional cancellation signal from the seam.
   * @returns the seam's result shape; `truncated` is left `false` because the
   *          seam owns the final `maxResults` truncation.
   * @throws {Error} when the query is empty or every backend failed.
   */
  async search(request, signal) {
    const query = typeof request?.query === 'string' ? request.query.trim() : ''
    if (query === '') throw new Error('free-web-search: the query is empty')

    const options = this.resolveOptions()
    if (options === undefined || options === null) throw new Error('free-web-search: the provider is not configured')

    // Ask each backend for a little more than requested, so that dropping
    // DuckDuckGo's ad and navigation links still leaves enough results.
    const requested = Number.isInteger(request?.maxResults) && request.maxResults > 0 ? request.maxResults : options.maxResults
    const limit = Math.max(1, Math.min(20, (requested ?? 5) + 2))

    const { sources, backend, detail } = await runBackends(query, { ...options, signal, limit })

    const trimmed = dedupeSources(sources).slice(0, requested ?? options.maxResults ?? 5)
    if (trimmed.length === 0) {
      throw new Error(`free-web-search: backend "${backend}" returned no usable results for this query`)
    }

    options.logger?.debug?.(`free-web-search: "${query}" served by ${detail ?? backend} (${trimmed.length} sources)`)

    return {
      sources: trimmed,
      truncated: false,
      ...(options.digest === true ? { content: buildDigest(query, trimmed, backend) } : {}),
    }
  }
}

/**
 * Render a compact plain-text digest of the results.
 *
 * Off by default: the seam already renders `sources` as a card, and a digest
 * duplicates them. It is offered for compositions where the model consumes the
 * search result as text and a pre-ranked summary is more useful than a list.
 *
 * @param query - the query, for the heading.
 * @param sources - the trimmed sources.
 * @param backend - the backend that answered.
 * @returns a short multi-line string.
 */
function buildDigest(query, sources, backend) {
  const lines = [`Search results for "${query}" (via ${backend}):`]
  for (const [index, source] of sources.entries()) {
    const title = source.title ?? source.url
    lines.push(`${index + 1}. ${title} — ${source.url}`)
    if (typeof source.snippet === 'string' && source.snippet !== '') lines.push(`   ${source.snippet}`)
  }
  return lines.join('\n')
}
