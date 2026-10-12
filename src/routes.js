/**
 * The settings-page HTTP API (host half).
 *
 * The browser half is a thin view over these routes. They exist because the
 * browser cannot do the work itself: a speed test must issue real requests from
 * the host (which is where the proxy and the credentials live), and reading the
 * live configuration requires access to the loader's config object.
 *
 * ## Security posture
 *
 * These routes **read configuration and make outbound requests on behalf of the
 * user**. That is less dangerous than writing files, but not harmless: a route
 * that can be triggered cross-origin would let any web page the user visits use
 * their machine as a probe, and a route that echoed the configuration would leak
 * a proxy password.
 *
 * Three fences, the same ones the other installed plugin in this profile uses,
 * because they defend against different attacks:
 *
 *   1. **Loopback only.** The route is not for remote clients.
 *   2. **Host must be a loopback literal.** This is the DNS-rebinding defence: an
 *      attacker who points `evil.example` at 127.0.0.1 makes the request
 *      same-origin, so `Origin` checks would pass — but the `Host` header is
 *      still `evil.example`.
 *   3. **A custom client header.** Any page can send a simple cross-origin POST
 *      (CORS blocks reading the *response*, not the side effect). A custom header
 *      forces a preflight, which this server never answers, so the request is
 *      never sent.
 *
 * ## Credentials
 *
 * The **display** field (`proxy`) has any password replaced by a placeholder, so a
 * rendered value never contains the secret. The edit field is seeded from
 * `proxyRaw`, which is the real value: the user has to be able to edit the address
 * without retyping their password, and a field seeded with `********` would
 * overwrite the real password on the next save. Sending it is acceptable because
 * this route is loopback-only and fenced against cross-site reads — but it is a
 * deliberate choice, not an oversight, and the two fields are named apart so the
 * distinction is visible at every call site.
 *
 * @module src/routes.js
 */

import { runLatencyTest, suggestConfigSnippet } from './latency.js'
import { parseProxy } from './proxy.js'
import {
  clearSettings,
  normalizeSettings,
  readSettings,
  resolveHome,
  settingsPath as settingsPathFor,
  writeSettings,
} from './settings.js'

/** Route prefix. Longer than `/api`, so the web server dispatches it here. */
export const ROUTE_PREFIX = '/api/dsh-free-web-search'

/** Client marker header. */
export const CLIENT_HEADER = 'x-dsh-free-web-search'
export const CLIENT_HEADER_VALUE = '1'

/** Loopback host literal, for the DNS-rebinding fence. */
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d{1,5})?$/i

/** Cap on a POST body. */
const MAX_BODY = 32 * 1024

/** Is this connection from the loopback interface? */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

/**
 * Second and third fences.
 *
 * @param req - the request.
 * @returns `undefined` when the request passes, else a human-readable reason.
 */
export function requestFence(req) {
  const host = String(req?.headers?.host ?? '').trim()
  if (!LOOPBACK_HOST.test(host)) {
    return (
      `only requests to 127.0.0.1 / localhost are accepted (Host: ${host === '' ? '(missing)' : host}). ` +
      'If you reach the UI through a custom domain, use http://127.0.0.1:<port> instead.'
    )
  }
  if (String(req?.headers?.[CLIENT_HEADER] ?? '') !== CLIENT_HEADER_VALUE) {
    return `missing the ${CLIENT_HEADER} header: this route rejects cross-site requests from other pages.`
  }
  return undefined
}

/**
 * Replace a proxy password with a placeholder before it leaves the host.
 *
 * @param url - the configured proxy URL, possibly with credentials.
 * @returns a display-safe form.
 */
export function redactProxy(url) {
  if (typeof url !== 'string' || url === '') return ''
  // A bypass keyword is not a proxy URL. Re-parsing it would treat "direct" as a
  // hostname and display "http://direct:8080", which is both wrong and confusing.
  if (isDirectKeyword(url)) return url
  const parsed = parseProxy(url)
  if (parsed === undefined) return url
  const credentials = parsed.auth === undefined ? '' : `${parsed.auth.username}:${'*'.repeat(8)}@`
  return `${parsed.protocol}://${credentials}${parsed.host}:${parsed.port}`
}

/** The spellings that mean "connect directly, bypass any proxy". */
export const DIRECT_KEYWORDS = ['direct', 'none', 'off', 'no', 'bypass']

/**
 * Is this value a bypass keyword rather than a proxy address?
 *
 * @param value - the configured value.
 * @returns true when it means "go direct".
 */
export function isDirectKeyword(value) {
  return typeof value === 'string' && DIRECT_KEYWORDS.includes(value.trim().toLowerCase())
}

/** Read a JSON request body. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (body === '') return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Build the route handler.
 *
 * @param options - `{ resolveOptions, logger }`.
 *        `resolveOptions` returns the live options for the next operation, so the
 *        page always sees current configuration rather than a startup snapshot.
 * @returns an async `(req, res) => void` handler.
 */
export function createHandler({ resolveOptions, control, logger }) {
  return async function handler(req, res) {
    const send = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(payload))
    }

    if (!isLoopback(req)) return send(403, { error: 'loopback connections only' })
    const fence = requestFence(req)
    if (fence !== undefined) return send(403, { error: fence })

    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    /**
     * The provider-selection block, shared by `/config` and the switch routes.
     *
     * A control object is optional: a headless composition has no seam to switch,
     * and the UI must still be able to render.
     */
    const providerState = () => {
      if (control === undefined || control === null) {
        return { providerControlAvailable: false }
      }
      try {
        return {
          providerControlAvailable: true,
          // The id currently in effect, or null when the seam picks for itself.
          activeProvider: control.current() ?? null,
          freeProviderId: 'free-web',
          freeActive: control.isFreeActive(),
          // Whether anything other than this plugin is registered — the UI uses it
          // to avoid offering a restore that would fail with
          // WEB_PROVIDER_CONFIGURED_MISSING.
          officialAvailable: control.hasOfficial(),
          registeredProviders: control.registered(),
        }
      } catch (error) {
        logger?.warn?.(`free-web-search: could not read provider state: ${error?.message ?? error}`)
        return { providerControlAvailable: false }
      }
    }

    try {
      // ── Configuration view ──────────────────────────────────────────────────
      if (method === 'GET' && route === '/config') {
        const options = resolveOptions()
        return send(200, {
          ok: true,
          backends: [...options.backends],
          timeoutMs: options.timeoutMs,
          totalTimeoutMs: options.totalTimeoutMs,
          maxResults: options.maxResults,
          wikipediaLang: options.wikipediaLang,
          searxngInstances: [...options.searxngInstances],
          takeover: options.takeover,
          digest: options.digest,
          ...providerState(),
          // `proxy` is the redacted form, for display. `proxyRaw` is the actual
          // configured value, so the edit field can be seeded with something
          // editable — seeding it with `********` would let a save overwrite the
          // real password with asterisks. The value is safe to send: this route is
          // loopback-only and fenced against cross-site reads.
          proxy: redactProxy(options.proxyUrl),
          proxyRaw: options.proxyUrl ?? '',
          proxyConfigured: options.proxyUrl !== '',
          proxyByBackend: Object.fromEntries(
            Object.entries(options.proxyByBackend).map(([backend, value]) => [backend, redactProxy(value)]),
          ),
          /** True when any backend has a per-backend override. */
          hasPerBackendProxy: Object.keys(options.proxyByBackend ?? {}).length > 0,
          noProxy: [...options.noProxy],
          knownBackends: [...options.knownBackends ?? []],
          /**
           * The backends enabled on a fresh install.
           *
           * Sent so "restore defaults" restores the *actual* default rather than a
           * copy hardcoded in the browser half — two lists that must agree would
           * eventually drift, and the UI would then be silently wrong about what
           * "default" means.
           */
          defaultBackends: [...options.defaultBackends ?? []],
          // The latency test sends no query, so there is no probe term to report.
        })
      }

      // ── Make this plugin the default search provider ───────────────────────
      // The seam re-reads its configured id on every search, so this takes effect
      // immediately — no restart. See `src/provider-control.js` for why an explicit
      // switch is needed rather than relying on automatic fallback: the official
      // provider reports itself available even without a credential.
      if (method === 'POST' && route === '/provider/default') {
        if (control === undefined || control === null) {
          return send(503, { ok: false, error: 'the web capability seam is not available in this composition' })
        }
        const result = control.setDefault()
        if (!result.ok) return send(500, { ok: false, error: result.error })

        // Persist the choice so it survives a restart. Best-effort: the switch has
        // already happened, and failing to write the file must not undo it.
        let persisted = true
        try {
          const home = resolveHome(process.env)
          const merged = { ...readSettings(home, logger), searchProvider: 'free-web' }
          const normalized = normalizeSettings(merged)
          if (normalized.ok) await writeSettings(home, normalized.settings)
          else persisted = false
        } catch (error) {
          persisted = false
          logger?.warn?.(`free-web-search: could not persist the provider choice: ${error?.message ?? error}`)
        }

        return send(200, { ok: true, activeProvider: result.current, persisted, ...providerState() })
      }

      // ── Restore the official (default) search provider ─────────────────────
      // Clears the override rather than naming a provider id, so the seam resumes
      // its own selection. Naming `deepseek-official` would raise
      // WEB_PROVIDER_CONFIGURED_MISSING in a composition that never registered it.
      if (method === 'POST' && route === '/provider/official') {
        if (control === undefined || control === null) {
          return send(503, { ok: false, error: 'the web capability seam is not available in this composition' })
        }
        // No guard against "nothing else is registered": this was verified against
        // the real seam, and clearing the id is harmless there. With only this
        // plugin registered the seam falls back to its "exactly one usable
        // provider" rule and keeps using it, so search still works. Refusing would
        // block a legitimate action for no benefit.
        const result = control.restoreOfficial()
        if (!result.ok) return send(500, { ok: false, error: result.error })

        let persisted = true
        try {
          const home = resolveHome(process.env)
          const merged = { ...readSettings(home, logger), searchProvider: 'official' }
          const normalized = normalizeSettings(merged)
          if (normalized.ok) await writeSettings(home, normalized.settings)
          else persisted = false
        } catch (error) {
          persisted = false
          logger?.warn?.(`free-web-search: could not persist the provider choice: ${error?.message ?? error}`)
        }

        return send(200, { ok: true, restoredTo: result.restored, persisted, ...providerState() })
      }

      // ── Save settings ──────────────────────────────────────────────────────
      // Writes only this plugin's own settings file; the loader's
      // `cordis.patch.yml` is never touched. See `src/settings.js`.
      if (method === 'POST' && route === '/settings') {
        const body = await readJson(req)
        const home = resolveHome(process.env)

        // Start from what is already saved, so a partial update from the UI does
        // not silently drop a field the page did not send.
        const merged = { ...readSettings(home, logger) }
        for (const key of ['proxy', 'proxyByBackend', 'backends', 'noProxy', 'takeover', 'digest', 'maxResults', 'searchProvider']) {
          if (key in body) merged[key] = body[key]
        }

        const normalized = normalizeSettings(merged)
        if (!normalized.ok) return send(400, { ok: false, error: normalized.error })

        try {
          await writeSettings(home, normalized.settings)
        } catch (error) {
          return send(500, { ok: false, error: `could not write the settings file: ${error?.message ?? error}` })
        }

        logger?.info?.(`free-web-search: settings saved to ${settingsPathFor(home)}`)
        return send(200, { ok: true, saved: normalized.settings, path: settingsPathFor(home) })
      }

      // ── Clear settings ─────────────────────────────────────────────────────
      // Removes the override, handing control back to `cordis.patch.yml`.
      if (method === 'POST' && route === '/settings/clear') {
        const home = resolveHome(process.env)
        await clearSettings(home)
        logger?.info?.('free-web-search: settings override cleared')
        return send(200, { ok: true, cleared: true })
      }

      // ── Latency test ───────────────────────────────────────────────────────
      // A pure reachability/latency probe: it sends **no query**. Each backend is
      // measured by connecting to its own host and timing the TLS handshake plus
      // the response headers to a HEAD request. See `src/latency.js` for why it is
      // deliberately not a search, and for the caveat that reachability is not the
      // same as being able to serve results.
      if (method === 'POST' && route === '/latency') {
        const body = await readJson(req)
        const options = resolveOptions()
        const backends =
          Array.isArray(body.backends) && body.backends.length > 0
            ? body.backends.filter((name) => typeof name === 'string')
            : [...options.backends]
        const timeoutMs = Number.isInteger(body.timeoutMs) && body.timeoutMs > 0 ? Math.min(60000, body.timeoutMs) : 8000

        logger?.info?.(`free-web-search: latency test requested for ${backends.join(', ')} (${timeoutMs}ms each)`)

        const report = await runLatencyTest({ ...options, backends, timeoutMs })
        return send(200, {
          ok: true,
          timeoutMs: report.timeoutMs,
          results: report.results,
          best: report.best?.backend ?? null,
          suggestedOrder: report.suggestedOrder,
          changed: report.changed,
          reasoning: report.reasoning,
          snippet: suggestConfigSnippet(report.suggestedOrder, options.proxyUrl),
        })
      }

      // ── Proxy reachability ─────────────────────────────────────────────────
      // A dedicated probe, because "the proxy is wrong" and "the engine is
      // blocked" produce the same symptom in a search and different fixes.
      if (method === 'POST' && route === '/proxy-check') {
        const body = await readJson(req)
        const candidate = typeof body.proxy === 'string' ? body.proxy.trim() : resolveOptions().proxyUrl
        if (candidate === '') return send(200, { ok: true, configured: false, message: 'no proxy is configured' })
        const parsed = parseProxy(candidate)
        if (parsed === undefined) {
          return send(400, { ok: false, error: 'the proxy URL could not be parsed (expected http://, https://, socks5:// or socks5h://)' })
        }
        const { probeProxy } = await import('./proxycheck.js')
        const result = await probeProxy(parsed)
        return send(200, { ok: true, configured: true, proxy: redactProxy(candidate), ...result })
      }

      return send(404, { error: `unknown route ${method} ${route}` })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      logger?.warn?.(`free-web-search: ${method} ${route} failed: ${error?.message ?? error}`)
      return send(status, { error: error?.message ?? String(error) })
    }
  }
}
