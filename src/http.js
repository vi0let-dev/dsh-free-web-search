/**
 * The one HTTP primitive every backend goes through.
 *
 * ## Why this does not use `fetch`
 *
 * This layer is built on `node:http`/`node:https` rather than the global `fetch`,
 * and that is a direct consequence of the zero-dependency constraint. `fetch`
 * cannot be told to use a proxy without undici's `ProxyAgent`, and undici is not
 * importable from the DSH host runtime. Since per-request proxying is a required
 * feature (Google is unreachable without one in many networks), the request has
 * to be issued through a socket the plugin can control — which means `http.request`
 * with a custom agent.
 *
 * The cost of that choice is that redirects are no longer followed for free;
 * they are implemented below. That turns out to be an advantage: each hop must be
 * re-tunnelled through the proxy anyway, and the final URL is then known exactly.
 *
 * ## What it provides
 *
 *   1. **Deadlines.** A search must not hang the agent's turn.
 *   2. **Cancellation honesty.** A caller cancellation is reported as an abort,
 *      distinctly from our own deadline firing. Conflating the two is a real bug
 *      with a large blast radius (see `src/provider.js`).
 *   3. **Proxying.** An optional parsed proxy routes the connection through an
 *      HTTP CONNECT or SOCKS5 tunnel.
 *   4. **A response size cap**, so a hostile or broken endpoint cannot exhaust
 *      memory — the Baidu result page is already over a megabyte.
 *
 * @module src/http.js
 */

import http from 'node:http'
import https from 'node:https'
import { createProxyAgent } from './proxy.js'

/** Marker property set on every error this module throws, for cheap classification. */
const NETWORK_ERROR = 'ERR_FREE_SEARCH_NETWORK'

/** Default cap on a response body. Search result pages are large but not this large. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** Default redirect budget. */
const DEFAULT_MAX_REDIRECTS = 5

/** A stable, honest product User-Agent — never a browser disguise. */
const DEFAULT_USER_AGENT = 'deepseek-harness-free-web-search/1.0 (+https://github.com/deepseek-ai/deepseek-harness)'

/**
 * An HTTP failure that names the endpoint, so a model reading the error can tell
 * which backend broke instead of seeing a bare `fetch failed`.
 */
export class HttpError extends Error {
  /**
   * @param message - human-readable description, including the URL.
   * @param options - `{ url, status, cause, kind }`.
   *        `kind` is one of `'timeout' | 'aborted' | 'status' | 'network' | 'body' | 'too-large' | 'redirect'`.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HttpError'
    this.code = NETWORK_ERROR
    this.url = options.url
    this.status = options.status
    this.kind = options.kind ?? 'network'
  }
}

/** True when the value looks like an abort, however the runtime spelled it. */
export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 20
}

/**
 * Issue exactly one request (no redirect following) and return the response.
 *
 * @param url - absolute URL.
 * @param options - `{ method, headers, body, signal, timeoutMs, proxy, maxBytes, secure }`.
 * @returns `{ status, headers, text, url }`.
 * @throws {HttpError}
 */
function requestOnce(url, options) {
  const {
    method = 'GET',
    headers = {},
    body,
    signal,
    timeoutMs = 15000,
    proxy,
    maxBytes = DEFAULT_MAX_BYTES,
  } = options

  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new HttpError(`invalid URL: ${url}`, { url, kind: 'network' }))
      return
    }
    const secure = parsed.protocol === 'https:'
    if (!secure && parsed.protocol !== 'http:') {
      reject(new HttpError(`unsupported protocol "${parsed.protocol}" in ${url}`, { url, kind: 'network' }))
      return
    }

    // TLS settings a caller may supply. These are forwarded to the request (and,
    // when a proxy is used, to the tunnel's TLS wrap) so that a private CA or an
    // enterprise interception proxy can be trusted. They are never *defaulted* to
    // anything permissive: omitting them leaves Node's own verification on.
    const tlsOptions = {
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      ...(options.cert === undefined ? {} : { cert: options.cert }),
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
      ...(options.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
    }

    const transport = secure ? https : http
    // The agent is given the caller's TLS settings too, because with a proxy the
    // TLS handshake happens inside the agent's tunnel, not in `transport.request`.
    const agent =
      proxy === undefined || proxy === null
        ? undefined
        : createProxyAgent(proxy, { timeoutMs, signal, secure, tls: tlsOptions })

    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    let callerAborted = false

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port === '' ? undefined : Number.parseInt(parsed.port, 10),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        ...tlsOptions,
        headers: {
          'accept-encoding': 'identity',
          'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
          ...headers,
        },
        ...(agent === undefined ? {} : { agent }),
        // Certificate verification is left at Node's default (on). It is
        // deliberately NOT forced to `true` here: forcing it would override any
        // `ca`/`rejectUnauthorized` the caller passed through options, which is
        // how a private CA or an enterprise interception proxy is configured.
      },
      (response) => {
        const chunks = []
        let size = 0
        let aborted = false

        response.on('data', (chunk) => {
          if (aborted) return
          size += chunk.length
          if (size > maxBytes) {
            aborted = true
            // Destroy rather than accumulate: the point of the cap is to bound memory.
            response.destroy()
            request.destroy()
            fail(new HttpError(`response exceeded ${maxBytes} bytes: ${url}`, { url, kind: 'too-large' }))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          if (aborted || settled) return
          settled = true
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            url,
          })
        })
        response.on('error', (error) => {
          if (aborted || settled) return
          fail(new HttpError(`could not read the response body: ${url} (${String(error)})`, { url, kind: 'body', cause: error }))
        })
      },
    )

    // The deadline is owned by `requestText` (it must span redirect hops), and it
    // arrives here as an already-armed `signal`. A socket-level timer is still set
    // as a backstop for a transport that ignores its signal — a stalled socket
    // would otherwise hang forever — but it is generous, so it never races the
    // real deadline into a misclassified failure.
    let socketTimedOut = false
    const socketTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            socketTimedOut = true
            request.destroy(new Error(`request timed out after ${timeoutMs}ms`))
          }, timeoutMs + 1000)
        : undefined
    if (socketTimer !== undefined && typeof socketTimer.unref === 'function') socketTimer.unref()

    const onAbort = () => {
      callerAborted = true
      request.destroy(Object.assign(new Error('request aborted'), { name: 'AbortError' }))
    }
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    request.on('error', (error) => {
      if (socketTimer !== undefined) clearTimeout(socketTimer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
      if (callerAborted) {
        // The signal was aborted: it may have been the caller cancelling or our
        // own deadline. `requestText` decides which, by inspecting the caller's
        // signal and its own timer, so this is reported as an abort either way.
        fail(new HttpError(`request aborted: ${url}`, { url, kind: 'aborted', cause: error }))
        return
      }
      if (socketTimedOut) {
        fail(new HttpError(`request timed out after ${timeoutMs}ms: ${url}`, { url, kind: 'timeout', cause: error }))
        return
      }
      if (isAbortError(error)) {
        fail(new HttpError(`request aborted: ${url}`, { url, kind: 'aborted', cause: error }))
        return
      }
      fail(new HttpError(`request failed: ${url} (${error?.code ?? String(error)})`, { url, kind: 'network', cause: error }))
    })

    request.on('close', () => {
      if (socketTimer !== undefined) clearTimeout(socketTimer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
    })

    if (body !== undefined && body !== null) request.write(body)
    request.end()
  })
}

/** Statuses that carry a `Location` the client is expected to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * The single-request implementation {@link requestText} delegates to.
 *
 * Held in a mutable holder rather than called directly so the offline test suite
 * can substitute a stub. That substitution is necessary, not convenient: the
 * request layer is built on `node:http` (see the module comment), so there is no
 * global `fetch` left to monkey-patch, and tests must be able to exercise
 * timeout, abort and redirect handling without a network.
 *
 * It is deliberately the *lowest* layer that is replaceable — `requestText`'s own
 * redirect, deadline and classification logic stays real in every test.
 */
const transport = { request: requestOnce }

/**
 * Replace the single-request implementation. **Test-only.**
 *
 * @param impl - `(url, options) => Promise<{status, headers, text, url}>`.
 */
export function __setTransportForTests(impl) {
  transport.request = typeof impl === 'function' ? impl : requestOnce
}

/**
 * Perform one request, following redirects, and return the body as text.
 *
 * A non-2xx status is returned, not thrown: the caller decides whether a given
 * status is fatal for its backend (DuckDuckGo's 202 is a soft block, for
 * instance, while a 404 from a SearxNG base URL is a configuration mistake).
 * Only transport failures, aborts, and an exhausted redirect budget throw.
 *
 * **The deadline is enforced here, not in the transport.** That is deliberate:
 * one budget must cover the whole exchange (all redirect hops), and it must hold
 * no matter which transport is underneath — including a substituted one in tests.
 * Enforcing it only inside the socket layer would make the timeout behaviour
 * depend on the transport, which is exactly the kind of thing that passes tests
 * and fails in production.
 *
 * @param url - absolute URL to request.
 * @param options - `{ signal, timeoutMs, headers, method, body, redirect, userAgent, proxy, maxBytes, maxRedirects }`.
 *        `redirect` may be `'follow'` (default), `'manual'`, or `'error'`.
 * @returns `{ ok, status, text, url }` with `url` being the final URL after redirects.
 * @throws {HttpError} on timeout, abort, transport failure, or a redirect error.
 */
export async function requestText(url, options = {}) {
  const {
    redirect = 'follow',
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    signal: callerSignal,
    timeoutMs = 15000,
    method = 'GET',
    body,
    proxy,
  } = options

  // One deadline for the whole exchange, not per hop, so a redirect chain cannot
  // multiply the caller's timeout by its length.
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined
  let currentUrl = url
  let currentMethod = method
  let currentBody = body

  for (let hop = 0; ; hop += 1) {
    if (callerSignal?.aborted === true) {
      throw new HttpError(`request aborted: ${url}`, { url, kind: 'aborted' })
    }
    const remaining = deadline === undefined ? timeoutMs : deadline - Date.now()
    if (deadline !== undefined && remaining <= 0) {
      throw new HttpError(`request timed out after ${timeoutMs}ms: ${url}`, { url, kind: 'timeout' })
    }

    // Bound this hop by what is left, via a signal the transport must honour.
    // A controller (rather than a bare timer) is used so the same abort reaches
    // whichever transport is in use.
    const controller = new AbortController()
    const onCallerAbort = () => controller.abort(callerSignal?.reason)
    if (callerSignal !== undefined && callerSignal !== null) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason)
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
    let timedOut = false
    const timer =
      remaining > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort(new Error(`request timed out after ${timeoutMs}ms`))
          }, remaining)
        : undefined
    if (timer !== undefined && typeof timer.unref === 'function') timer.unref()

    let response
    try {
      response = await transport.request(currentUrl, {
        ...options,
        method: currentMethod,
        body: currentBody,
        signal: controller.signal,
        timeoutMs: remaining,
        proxy,
      })
    } catch (error) {
      // Classify in this order, because both a deadline and a cancellation
      // surface as an abort and they mean different things to the caller: a
      // timeout should let the chain try the next backend, a cancellation must
      // stop it. Getting this backwards once silently disabled every fallback.
      if (callerSignal?.aborted === true) {
        throw new HttpError(`request aborted: ${url}`, { url, kind: 'aborted', cause: error })
      }
      if (timedOut || error?.kind === 'timeout') {
        throw new HttpError(`request timed out after ${timeoutMs}ms: ${url}`, { url, kind: 'timeout', cause: error })
      }
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (callerSignal !== undefined && callerSignal !== null) callerSignal.removeEventListener('abort', onCallerAbort)
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { ok: response.status >= 200 && response.status < 300, status: response.status, text: response.text, url: response.url }
    }

    const location = response.headers?.location
    if (typeof location !== 'string' || location === '') {
      // A redirect status with nowhere to go: report it as the status it is.
      return { ok: false, status: response.status, text: response.text, url: response.url }
    }
    if (redirect === 'manual') {
      return { ok: false, status: response.status, text: response.text, url: response.url }
    }
    if (redirect === 'error') {
      throw new HttpError(`unexpected redirect to ${location}: ${currentUrl}`, { url: currentUrl, status: response.status, kind: 'redirect' })
    }
    if (hop >= maxRedirects) {
      throw new HttpError(`too many redirects (more than ${maxRedirects}) starting at ${url}`, { url, kind: 'redirect' })
    }

    let next
    try {
      next = new URL(location, currentUrl).href
    } catch {
      throw new HttpError(`invalid redirect target "${location}" from ${currentUrl}`, { url: currentUrl, kind: 'redirect' })
    }
    // 303 always becomes a GET, and browsers downgrade 301/302 POSTs to GET too.
    // 307/308 exist precisely to preserve the method and body, so they do not.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
      currentMethod = 'GET'
      currentBody = undefined
    }
    currentUrl = next
  }
}

/**
 * Perform one request and parse the body as JSON.
 *
 * @param url - absolute URL to request.
 * @param options - same as {@link requestText}.
 * @returns `{ ok, status, json, url }`, where `json` is `undefined` when the
 *          body was not valid JSON (some backends answer errors with HTML).
 * @throws {HttpError} on timeout, abort, or transport failure.
 */
export async function requestJson(url, options = {}) {
  const result = await requestText(url, options)
  let json
  try {
    json = JSON.parse(result.text)
  } catch {
    json = undefined
  }
  return { ok: result.ok, status: result.status, json, url: result.url }
}

export { DEFAULT_USER_AGENT, DEFAULT_MAX_BYTES, DEFAULT_MAX_REDIRECTS }
