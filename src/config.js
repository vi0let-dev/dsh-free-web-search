/**
 * Configuration normalization.
 *
 * The plugin reads its configuration from three places, in increasing
 * precedence: built-in defaults, the environment, then the loader's `config`
 * object. Nothing here validates with a schema library on purpose — a third-party
 * plugin shares the profile's `node_modules` with the host and every other
 * installed plugin, so pulling in a validator risks resolving a *different copy*
 * than the host uses. Hand-written normalization keeps the plugin's dependency
 * list empty, which is the only way to be certain it cannot collide.
 *
 * Every field is normalized rather than merely checked, so a malformed value
 * degrades to the default instead of failing the plugin at load. The single
 * exception is an explicitly requested provider that cannot work; that is
 * reported through `available()` instead of by throwing.
 *
 * @module src/config.js
 */

import { DEFAULT_BACKEND_ORDER, KNOWN_BACKENDS } from './backends/index.js'
import { DEFAULT_SEARXNG_INSTANCES } from './provider.js'
import { createProxyPolicy, parseProxy, proxyFromEnvironment } from './proxy.js'
import { readSettings, resolveHome, settingsPath as settingsPathOf } from './settings.js'

/** Re-exported for the settings page and for tests. */
export { KNOWN_BACKENDS }

/** Environment variable overrides, all namespaced to this plugin. */
const ENV = {
  backends: 'DSH_FREE_WEB_SEARCH_BACKENDS',
  timeoutMs: 'DSH_FREE_WEB_SEARCH_TIMEOUT_MS',
  totalTimeoutMs: 'DSH_FREE_WEB_SEARCH_TOTAL_TIMEOUT_MS',
  searxng: 'DSH_FREE_WEB_SEARCH_SEARXNG_INSTANCES',
  wikipediaLang: 'DSH_FREE_WEB_SEARCH_WIKIPEDIA_LANG',
  maxResults: 'DSH_FREE_WEB_SEARCH_MAX_RESULTS',
  userAgent: 'DSH_FREE_WEB_SEARCH_USER_AGENT',
  takeover: 'DSH_FREE_WEB_SEARCH_TAKEOVER',
  digest: 'DSH_FREE_WEB_SEARCH_DIGEST',
  proxy: 'DSH_FREE_WEB_SEARCH_PROXY',
  noProxy: 'DSH_FREE_WEB_SEARCH_NO_PROXY',
  proxyByBackend: 'DSH_FREE_WEB_SEARCH_PROXY_BY_BACKEND',
  useEnvProxy: 'DSH_FREE_WEB_SEARCH_USE_ENV_PROXY',
}

/** Coerce a positive integer, falling back when the value is unusable. */
function positiveInt(value, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

/** Coerce a boolean, accepting the spellings a YAML/JSON/env value may arrive in. */
function boolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true
    if (['0', 'false', 'no', 'off', ''].includes(lowered)) return false
  }
  return fallback
}

/** Coerce a non-empty trimmed string. */
function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Split a comma- or whitespace-separated list, dropping empties and duplicates.
 *
 * @param value - a string, or an already-formed array.
 * @returns a new array of non-empty strings.
 */
function list(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/)
      : []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Normalize the backend list.
 *
 * Unknown names are dropped with a warning rather than throwing: a typo in one
 * name should cost that one backend, not the whole plugin. If nothing valid
 * remains, the defaults are used — an empty backend list would make the plugin
 * permanently unavailable, which is never what a user meant.
 *
 * **The user's order is preserved.** This used to be re-sorted into a canonical
 * order, on the theory that the sequence was a reliability contract rather than a
 * preference. The settings page now lets the user arrange the chain explicitly and
 * offers "apply this order" after a latency test, so re-sorting would silently
 * discard that decision — and the UI would show one order while the plugin ran
 * another. Only duplicates and unknown names are removed.
 *
 * @param value - the configured value.
 * @param logger - optional logger for dropped names.
 * @returns a non-empty array of known backend names, in the order given.
 */
function normalizeBackends(value, logger) {
  const requested = list(value)
  if (requested.length === 0) return [...DEFAULT_BACKEND_ORDER]
  const unknown = requested.filter((name) => !KNOWN_BACKENDS.includes(name))
  if (unknown.length > 0) {
    logger?.warn?.(`free-web-search: ignoring unknown backend name(s): ${unknown.join(', ')}`)
  }
  const enabled = requested.filter((name) => KNOWN_BACKENDS.includes(name))
  return enabled.length === 0 ? [...DEFAULT_BACKEND_ORDER] : enabled
}

/**
 * Normalize the per-backend proxy map.
 *
 * Accepts an object (`{ google: 'http://…', baidu: 'direct' }`) or a compact
 * string (`google=http://…,baidu=direct`), because the string form is what fits
 * in an environment variable. A `direct`/`none`/`off` value is preserved as an
 * explicit bypass rather than being dropped, so "everything through the proxy
 * except Baidu" is expressible.
 *
 * @param value - the configured value.
 * @param logger - optional logger for ignored entries.
 * @returns a plain object of backend → proxy string (or `'direct'`).
 */
function normalizePerBackendProxy(value, logger) {
  const out = {}
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [backend, entry] of Object.entries(value)) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (trimmed === '') continue
      out[backend] = trimmed
    }
    return out
  }
  if (typeof value !== 'string' || value.trim() === '') return out
  for (const pair of value.split(',')) {
    const trimmed = pair.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) {
      logger?.warn?.(`free-web-search: ignoring malformed proxyByBackend entry "${trimmed}" (expected backend=url)`)
      continue
    }
    const backend = trimmed.slice(0, separator).trim()
    const proxy = trimmed.slice(separator + 1).trim()
    if (backend === '' || proxy === '') continue
    out[backend] = proxy
  }
  return out
}

/**
 * Build the effective options for the next operation.
 *
 * @param config - the loader's config object (may be empty or undefined).
 * @param env - an environment-like lookup, defaulting to `process.env`.
 * @param logger - optional logger.
 * @returns a frozen options object.
 */
export function resolveConfig(config = {}, env = process.env, logger) {
  const source = config !== null && typeof config === 'object' ? config : {}

  // ── Runtime settings ───────────────────────────────────────────────────────
  // Read once per resolution so a change made in the settings page takes effect
  // on the next operation without a restart. `settings.json` outranks the loader
  // config because it is the user's most recent explicit action.
  const home = resolveHome(env)
  const settings = readSettings(home, logger)

  // Environment first, then the loader config on top of it.
  const backendsValue = settings.backends ?? source.backends ?? env[ENV.backends]
  const instancesValue = source.searxngInstances ?? source.instances ?? env[ENV.searxng]

  const instances = list(instancesValue)
  const searxngInstances = instances.length > 0 ? instances : [...DEFAULT_SEARXNG_INSTANCES]

  const wikipediaLang = text(source.wikipediaLang ?? env[ENV.wikipediaLang], 'en')

  // Per-request timeout, bounded: below ~1s no backend can finish, and an
  // unbounded value would let one hung instance stall the agent's turn.
  const timeoutMs = Math.min(60000, positiveInt(source.timeoutMs ?? env[ENV.timeoutMs], 12000))
  // Whole-chain budget. Defaults to twice the per-request timeout, so a search
  // that has to fall through several backends still finishes promptly, while a
  // single slow backend is allowed to use its full timeout. Never less than the
  // per-request timeout, or the first request could not complete.
  const configuredTotal = positiveInt(source.totalTimeoutMs ?? env[ENV.totalTimeoutMs], timeoutMs * 2)
  const totalTimeoutMs = Math.max(timeoutMs, Math.min(120000, configuredTotal))

  // ── Proxy ──────────────────────────────────────────────────────────────────
  // Precedence, lowest to highest: environment, then the loader config, then the
  // settings file. The settings file wins because it is the user's most recent
  // explicit action in the UI.
  //
  // `settings.proxy === ''` is meaningful: it is an explicit "bypass the proxy",
  // recorded when the user chose direct connection, and it must override a proxy
  // configured in `cordis.patch.yml`.
  const explicitProxy = 'proxy' in settings ? settings.proxy : (source.proxy ?? env[ENV.proxy])
  const useEnvProxy = boolean(source.useEnvProxy ?? env[ENV.useEnvProxy], explicitProxy === undefined)
  const ambient = proxyFromEnvironment(env)
  const proxyUrl = explicitProxy === '' ? undefined : text(explicitProxy, useEnvProxy ? ambient.url : undefined)
  // A proxy string that does not parse is reported and ignored, rather than
  // silently producing direct connections that look like a proxy failure.
  if (proxyUrl !== undefined && parseProxy(proxyUrl) === undefined) {
    logger?.warn?.(`free-web-search: ignoring unparseable proxy "${proxyUrl}" (expected http://, https://, socks5:// or socks5h://)`)
  }
  const noProxySource = settings.noProxy ?? source.noProxy ?? env[ENV.noProxy]
  const noProxy = list(noProxySource).length > 0 ? list(noProxySource) : ambient.noProxy
  const proxyByBackend = normalizePerBackendProxy(settings.proxyByBackend ?? source.proxyByBackend ?? env[ENV.proxyByBackend], logger)
  const proxyPolicy = createProxyPolicy({ url: proxyUrl, perBackend: proxyByBackend, noProxy })

  return Object.freeze({
    backends: Object.freeze(normalizeBackends(backendsValue, logger)),
    timeoutMs,
    totalTimeoutMs,
    searxngInstances: Object.freeze(searxngInstances),
    wikipediaLang,
    maxResults: Math.min(20, positiveInt(settings.maxResults ?? source.maxResults ?? env[ENV.maxResults], 5)),
    userAgent: text(source.userAgent ?? env[ENV.userAgent], undefined),
    // Always claim the search slot, even when another provider is registered.
    takeover: settings.takeover ?? boolean(source.takeover ?? env[ENV.takeover], false),
    // Attach a plain-text digest of the results as `content`.
    digest: settings.digest ?? boolean(source.digest ?? env[ENV.digest], false),
    /** The proxy string in effect, for display and for the config snippet. */
    proxyUrl: proxyUrl ?? '',
    proxyPolicy,
    /** Per-backend proxy strings, for display. */
    proxyByBackend: Object.freeze({ ...proxyByBackend }),
    noProxy: Object.freeze([...noProxy]),
    /**
     * The settings file consulted for this resolution.
     *
     * Kept on the options object for diagnostics and for tests; it is deliberately
     * not surfaced in the settings API, because the file is an implementation
     * detail rather than something the user configures.
     */
    settingsPath: settingsPathOf(home),
    logger,
  })
}

/** Exported for tests and documentation. */
export const ENV_NAMES = ENV
