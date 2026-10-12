/**
 * Free, key-less search backends.
 *
 * Each backend is a plain async function with the same contract, so the provider
 * can walk them without knowing anything about HTTP, markup, or quotas:
 *
 *     search(query, options) -> { sources, ...diagnostics }
 *
 * A backend either resolves with at least one source, or throws an `Error` whose
 * message names what went wrong. An `HttpError` with `kind === 'aborted'` is
 * special: it means the caller cancelled, and the provider rethrows it
 * immediately instead of falling through to the next backend.
 *
 * Every backend accepts a `proxy` option and forwards it to the HTTP layer, so a
 * per-backend proxy policy works uniformly.
 *
 * @module src/backends/index.js
 */

export { searchSearxng } from './searxng.js'
export { searchGoogle, parseGoogleResults, unwrapGoogleRedirect, isUsableGoogleResultUrl, isGoogleBlocked } from './google.js'
export { searchBing, parseBingResults, unwrapBingRedirect, isUsableBingResultUrl, isBingBlocked } from './bing.js'
export { searchBaidu, parseBaiduResults, unwrapBaiduRedirect, isUsableBaiduResultUrl, isBaiduBlocked } from './baidu.js'
export { searchYandex, parseYandexResults, isUsableYandexResultUrl, isYandexBlocked } from './yandex.js'
export { searchDuckDuckGo, parseResultsPage, unwrapRedirect, isUsableResultUrl, isBlocked } from './duckduckgo.js'
export { searchWikipedia } from './wikipedia.js'

/**
 * Every backend this plugin knows how to run, in canonical order.
 *
 * This is the **validation vocabulary**: the set of names that may appear in
 * configuration or be selected in the settings page. It is deliberately separate
 * from {@link DEFAULT_BACKEND_ORDER}, because the two answer different questions —
 * "what is a valid name?" versus "what is turned on to begin with?". Collapsing
 * them would mean that narrowing the default set also made every other backend
 * un-selectable.
 *
 * The order here is by *reliability*, not result quality, since the provider stops
 * at the first backend that answers, and a chain pays for a failure in latency:
 *
 *   1. `searxng`     — documented JSON, so no parsing risk. Needs a configured
 *                      instance; when it works it is the best option.
 *   2. `google`      — best coverage and snippets, but usually needs a proxy, and
 *                      fails hard (consent wall, captcha, or no route) exactly
 *                      where no proxy is configured.
 *   3. `bing`        — no setup, general coverage, the more stable scrape target.
 *   4. `baidu`       — no setup, strongest for Chinese queries.
 *   5. `yandex`      — no setup; useful for Russian. Its parser is the least
 *                      verified here and it shows a captcha to most automated
 *                      clients.
 *   6. `duckduckgo`  — no setup, but blocks automated clients most readily and
 *                      changes its class names most often.
 *   7. `wikipedia`   — the most stable API, but encyclopedic only.
 */
export const KNOWN_BACKENDS = ['searxng', 'google', 'bing', 'baidu', 'yandex', 'duckduckgo', 'wikipedia']

/**
 * The backends enabled on a fresh install.
 *
 * `bing` alone, deliberately. It is the one backend that needs no setup, no proxy
 * and no configured instance, and that was measured answering reliably — so a new
 * user gets working search immediately rather than a chain that spends its latency
 * budget on backends that cannot answer in their network. Everything else is one
 * checkbox away in the settings page, and the latency test tells the user which
 * ones are reachable from where they are.
 *
 * Ordering within this list is the order they are tried in.
 */
export const DEFAULT_BACKEND_ORDER = ['bing']

