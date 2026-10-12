/**
 * Backend latency probe.
 *
 * ## What this measures, and what it deliberately does not
 *
 * This answers "how fast can I reach each search service from here?" — a pure
 * connectivity and latency measurement. It performs **no search and uses no query
 * term**. Each backend is probed by connecting to its own host and reading the
 * response headers to a `HEAD /` request, with the time split into stages:
 *
 *     connect  — TCP to the host, or the proxy tunnel (proxy CONNECT / SOCKS5)
 *     tls      — the TLS handshake
 *     ttfb     — time to the first byte of the response
 *     total    — everything above
 *
 * A `HEAD` is used because it proves the service answered without downloading a
 * page: a homepage is hundreds of kilobytes, and pulling seven of them to measure
 * latency would be both slow and rude. Some servers reply `405` to `HEAD`; that
 * still proves reachability, so any HTTP status counts as a success.
 *
 * ## The honest caveat, stated in the UI too
 *
 * **Reachable is not the same as useful.** A backend can answer in 40 ms and still
 * be unable to serve results — measured cases in this very plugin: Google returns
 * HTTP 200 with a JavaScript-only shell that contains no results, Yandex answers
 * with a captcha, and a public SearxNG instance may have JSON output disabled. So
 * the recommendation ranks by latency among the backends that *responded*, and
 * says plainly that it is a reachability measurement, not a guarantee. Ordering
 * the chain purely on this could put a fast-but-useless backend first.
 *
 * ## It never changes the configuration
 *
 * The output is a suggestion plus a pasteable snippet. Applying it is a button the
 * user presses. A latency measurement is a snapshot of one network at one moment,
 * so silently rewriting the chain from it would be both surprising and often
 * wrong.
 *
 * @module src/latency.js
 */

import net from 'node:net'
import tls from 'node:tls'

import { openTunnel } from './proxy.js'
import { KNOWN_BACKENDS } from './backends/index.js'

/** Default per-backend budget. This is interactive, so it stays short. */
export const DEFAULT_PROBE_TIMEOUT_MS = 8000

/**
 * Where each backend is probed.
 *
 * The host is the service's own front door, not a search URL: no query is sent, so
 * there is nothing here that could be mistaken for one. SearxNG is special — its
 * host comes from the configured instance list.
 */
export const PROBE_TARGETS = {
  searxng: { host: 'searx.be', path: '/' },
  google: { host: 'www.google.com', path: '/' },
  bing: { host: 'www.bing.com', path: '/' },
  baidu: { host: 'www.baidu.com', path: '/' },
  yandex: { host: 'yandex.com', path: '/' },
  duckduckgo: { host: 'duckduckgo.com', path: '/' },
  wikipedia: { host: 'en.wikipedia.org', path: '/' },
}

/** A stable, honest product User-Agent — never a browser disguise. */
const PROBE_USER_AGENT = 'deepseek-harness-free-web-search/1.0 (+https://github.com/deepseek-ai/deepseek-harness)'

/**
 * Open a TCP connection to a host, directly or through a proxy.
 *
 * @param host - destination host.
 * @param port - destination port.
 * @param options - `{ proxy, timeoutMs, signal }`.
 * @returns a promise for a connected socket.
 */
function connect(host, port, { proxy, timeoutMs, signal }) {
  if (proxy !== undefined && proxy !== null) {
    return openTunnel(proxy, host, port, { timeoutMs, signal })
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    const succeed = () => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      resolve(socket)
    }
    const onAbort = () => fail(Object.assign(new Error('probe aborted'), { name: 'AbortError' }))
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    if (timeoutMs > 0) socket.setTimeout(timeoutMs, () => fail(new Error(`connect timed out after ${timeoutMs}ms`)))
    socket.on('error', (error) => fail(new Error(`${error.code ?? error.message}`)))
    socket.on('connect', succeed)
  })
}

/** True when a host is an IP literal rather than a name. */
function isIpLiteral(host) {
  if (typeof host !== 'string' || host === '') return false
  if (net.isIP(host) !== 0) return true
  // A bracketed IPv6 literal.
  return host.startsWith('[') && host.endsWith(']') && net.isIP(host.slice(1, -1)) !== 0
}

/**
 * Wrap a socket in TLS.
 *
 * @param socket - the connected socket.
 * @param host - the hostname, for SNI and verification.
 * @param options - `{ timeoutMs, ca }`.
 * @returns a promise for the secured socket.
 */
function secure(socket, host, { timeoutMs, ca }) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      // SNI is only sent for a *name*: RFC 6066 forbids an IP literal, and Node
      // warns (and will eventually ignore it). A self-hosted instance configured
      // by IP is a normal case, so this must not emit a warning or rely on
      // behaviour Node plans to remove.
      ...(isIpLiteral(host) ? {} : { servername: host }),
      // A private CA is supported for the same reason the HTTP layer supports one:
      // an enterprise interception proxy or an internal instance. Verification is
      // otherwise left at Node's default (on).
      ...(ca === undefined ? {} : { ca }),
    })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      secureSocket.destroy()
      reject(error)
    }
    if (timeoutMs > 0) secureSocket.setTimeout(timeoutMs, () => fail(new Error(`TLS handshake timed out after ${timeoutMs}ms`)))
    secureSocket.once('secureConnect', () => {
      if (settled) return
      settled = true
      secureSocket.setTimeout(0)
      resolve(secureSocket)
    })
    secureSocket.once('error', (error) => fail(error))
  })
}

/**
 * Send `HEAD path` and wait for the first byte of the response.
 *
 * @param socket - the TLS socket.
 * @param host - the hostname, for the `Host` header.
 * @param path - the request path.
 * @param options - `{ timeoutMs }`.
 * @returns `{ statusCode, ttfbMs }`.
 */
function headRequest(socket, host, path, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let settled = false
    const finish = (fn) => (value) => {
      if (settled) return
      settled = true
      socket.removeAllListeners('data')
      fn(value)
    }
    const ok = finish(resolve)
    const fail = finish(reject)

    if (timeoutMs > 0) socket.setTimeout(timeoutMs, () => fail(new Error(`no response within ${timeoutMs}ms`)))
    socket.on('error', (error) => fail(error))
    socket.on('data', (chunk) => {
      const statusLine = chunk.toString('latin1').split('\r\n')[0] ?? ''
      const statusCode = Number.parseInt(statusLine.split(/\s+/)[1] ?? '', 10)
      ok({ statusCode: Number.isInteger(statusCode) ? statusCode : undefined, ttfbMs: Date.now() - started })
    })
    // A server that closes without answering still proved it is reachable, so
    // this resolves rather than rejects.
    socket.on('end', () => ok({ statusCode: undefined, ttfbMs: Date.now() - started }))

    socket.write(
      `HEAD ${path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `User-Agent: ${PROBE_USER_AGENT}\r\n` +
        `Accept: */*\r\n` +
        `Connection: close\r\n\r\n`,
    )
  })
}

/**
 * Classify a probe failure for display.
 *
 * @param error - the thrown error.
 * @returns a status string.
 */
function classify(error) {
  if (error?.name === 'AbortError') return 'aborted'
  const message = String(error?.message ?? error)
  if (/timed out/i.test(message)) return 'timeout'
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET|EPIPE|certificate|self.signed|CERT_/i.test(message)) {
    return 'unreachable'
  }
  return 'error'
}

/** Render a proxy as `protocol://host:port`, or `direct`. */
function describeProxy(proxy) {
  if (proxy === undefined || proxy === null) return 'direct'
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`
}

/**
 * Resolve the probe target for a backend.
 *
 * `options.probeTargets` may override any backend's target. That exists for two
 * reasons: it lets a self-hosted service be probed at its real address, and it
 * lets the test suite point a probe at a local origin so the connect → TLS → HEAD
 * path is genuinely exercised rather than stubbed out.
 *
 * @param backend - the backend name.
 * @param options - resolved provider options.
 * @returns `{ host, path, port }`, or `undefined` when the backend has no target.
 */
export function probeTargetFor(backend, options = {}) {
  const override = options.probeTargets?.[backend]
  if (override !== undefined && typeof override.host === 'string' && override.host !== '') {
    return { host: override.host, path: override.path ?? '/', port: override.port ?? 443 }
  }
  if (backend === 'searxng') {
    // SearxNG is reached through a configured instance, so probe the first one —
    // that is the host a search would actually use first.
    const instances = Array.isArray(options.searxngInstances) ? options.searxngInstances : []
    for (const instance of instances) {
      try {
        const url = new URL(instance)
        return { host: url.hostname, path: '/', port: url.port === '' ? 443 : Number.parseInt(url.port, 10) }
      } catch {
        /* skip an unusable instance */
      }
    }
    return undefined
  }
  const target = PROBE_TARGETS[backend]
  return target === undefined ? undefined : { ...target, port: 443 }
}

/**
 * Resolve the proxy that applies to one backend.
 *
 * @param options - resolved provider options.
 * @param backend - the backend name.
 * @param host - the target host, for the `noProxy` check.
 * @returns a parsed proxy, or `undefined` for a direct connection.
 */
function resolveProxy(options, backend, host) {
  const policy = options.proxyPolicy
  if (policy === undefined || policy === null) return undefined
  try {
    return policy.for(backend, host)
  } catch {
    return undefined
  }
}

/**
 * Probe one backend's latency.
 *
 * Never throws: a failure is the result, because reporting which services are
 * unreachable is half the point.
 *
 * @param backend - the backend name.
 * @param options - resolved provider options plus `{ timeoutMs, signal, logger }`.
 * @returns a result record.
 */
export async function probeLatency(backend, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  const signal = options.signal
  const target = probeTargetFor(backend, options)

  if (target === undefined) {
    return {
      backend,
      status: 'error',
      totalMs: 0,
      error: backend === 'searxng' ? 'no usable SearxNG instance is configured to probe' : `no probe target for "${backend}"`,
      usedProxy: 'direct',
    }
  }

  const proxy = resolveProxy(options, backend, target.host)
  const endpoint = `${target.host}${target.path}`
  const started = Date.now()
  let socket

  try {
    const connected = await connect(target.host, target.port ?? 443, { proxy, timeoutMs, signal })
    const connectMs = Date.now() - started
    socket = connected

    const secured = await secure(connected, target.host, { timeoutMs, ca: options.ca })
    const tlsMs = Date.now() - started
    socket = secured

    const response = await headRequest(secured, target.host, target.path, { timeoutMs })
    const totalMs = Date.now() - started

    return {
      backend,
      status: 'ok',
      connectMs,
      tlsMs,
      ttfbMs: totalMs,
      totalMs,
      statusCode: response.statusCode,
      endpoint,
      usedProxy: describeProxy(proxy),
      detail: response.statusCode === undefined ? `${endpoint} answered` : `${endpoint} → HTTP ${response.statusCode}`,
    }
  } catch (error) {
    const status = classify(error)
    options.logger?.debug?.(`free-web-search: latency probe "${backend}" -> ${status}: ${error?.message ?? error}`)
    return {
      backend,
      status,
      totalMs: Date.now() - started,
      endpoint,
      usedProxy: describeProxy(proxy),
      error: `${endpoint}: ${error?.message ?? error}`,
    }
  } finally {
    if (socket !== undefined) socket.destroy()
  }
}

/**
 * Probe every selected backend.
 *
 * Probes run **concurrently**, unlike a real search. Two reasons: a sequential
 * sweep of seven backends with an 8s timeout each could take a minute, and
 * measuring them at the same time is also fairer — the figure reflects each
 * backend's own latency rather than its position in a queue. The one cost is that
 * a very small upstream pipe may inflate every figure; the raw numbers are
 * reported so that is visible.
 *
 * @param options - resolved provider options plus `{ backends, timeoutMs, signal, concurrency }`.
 * @returns `{ results, ranked, best, suggestedOrder, changed, reasoning }`.
 */
export async function runLatencyTest(options = {}) {
  // Falling back to every *known* backend (not the default-enabled set) is right
  // here: the caller normally passes an explicit selection, and when it does not,
  // probing everything the plugin knows is more useful than probing one.
  const backends =
    Array.isArray(options.backends) && options.backends.length > 0 ? options.backends : [...KNOWN_BACKENDS]
  const timeoutMs =
    Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : backends.length

  const results = []
  // A small worker pool rather than Promise.all: it bounds how many sockets and
  // TLS handshakes are in flight at once, which matters on a constrained network.
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, backends.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= backends.length) return
      if (options.signal?.aborted === true) return
      results.push(await probeLatency(backends[index], { ...options, timeoutMs }))
    }
  })
  await Promise.all(workers)

  // Restore the requested order for display, so the table reads the way the user
  // arranged it rather than by completion order.
  results.sort((a, b) => backends.indexOf(a.backend) - backends.indexOf(b.backend))

  return { results, timeoutMs, ...rank(results, backends) }
}

/**
 * Rank the probes and build the recommendation.
 *
 * Ordering is by total latency among the backends that responded; anything that
 * did not respond sorts last regardless of how quickly it failed. Ties keep the
 * user's existing preference, so a meaningless tie does not reshuffle the chain.
 *
 * @param results - the probe records.
 * @param configuredOrder - the order currently configured.
 * @returns `{ ranked, best, suggestedOrder, changed, reasoning }`.
 */
export function rank(results, configuredOrder = []) {
  const scored = results.map((result) => ({
    ...result,
    score: result.status === 'ok' && Number.isFinite(result.totalMs) ? result.totalMs : Number.POSITIVE_INFINITY,
  }))

  const ranked = [...scored].sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    return configuredOrder.indexOf(a.backend) - configuredOrder.indexOf(b.backend)
  })

  const working = ranked.filter((result) => Number.isFinite(result.score))
  const suggestedOrder = [
    ...working.map((result) => result.backend),
    ...ranked.filter((result) => !Number.isFinite(result.score)).map((result) => result.backend),
  ]
  const changed = suggestedOrder.join(',') !== configuredOrder.join(',')
  const best = working[0]

  return {
    ranked,
    best,
    suggestedOrder,
    changed,
    reasoning: buildReasoning({ working, ranked, best, configuredOrder, suggestedOrder, changed }),
  }
}

/**
 * Explain the recommendation in words.
 *
 * The caveat about reachability is not boilerplate: recommending a fast but
 * unusable backend would be an actively harmful suggestion, and this plugin has
 * measured exactly that case with Google.
 *
 * @param input - the pieces needed for the explanation.
 * @returns an array of short sentences.
 */
function buildReasoning({ working, ranked, best, configuredOrder, suggestedOrder, changed }) {
  const lines = []

  if (working.length === 0) {
    lines.push(
      'No backend answered. This is a connectivity or proxy problem rather than a ranking problem — check the network, then set a proxy if the services you want are unreachable.',
    )
    return lines
  }

  lines.push(
    `${working.length} of ${ranked.length} backend(s) responded. Fastest to reach: ${best.backend} at ${Math.round(best.totalMs)}ms.`,
  )
  lines.push(
    'This measures reachability and latency only — it sends no query. A backend that answers quickly can still fail to return results: Google serves a JavaScript-only page with no results, Yandex shows a captcha, and a public SearxNG instance may have JSON output disabled. Reordering the chain purely on these numbers can therefore put a fast but unusable backend first.',
  )

  const failed = ranked.filter((result) => !Number.isFinite(result.score))
  if (failed.length > 0) {
    const timeouts = failed.filter((result) => result.status === 'timeout')
    const unreachable = failed.filter((result) => result.status === 'unreachable')
    const parts = []
    if (timeouts.length > 0) parts.push(`${timeouts.map((r) => r.backend).join(', ')} timed out — services like Google usually need a proxy`)
    if (unreachable.length > 0) parts.push(`${unreachable.map((r) => r.backend).join(', ')} could not be reached`)
    const errored = failed.filter((result) => result.status === 'error')
    if (errored.length > 0) parts.push(`${errored.map((r) => r.backend).join(', ')} failed`)
    lines.push(`${parts.join('; ')}. Unreachable backends are ranked last regardless of how fast they failed.`)
  }

  if (changed) {
    lines.push(`Ordered by latency: ${suggestedOrder.join(' → ')} (currently ${configuredOrder.join(' → ')}). This is a suggestion only — nothing has been changed.`)
  } else {
    lines.push('The configured order already matches this latency ranking.')
  }

  lines.push('Latency varies with network conditions and with load on the public SearxNG instances, so re-run this before relying on it.')
  return lines
}

/**
 * Render a copy-pasteable configuration snippet for a suggested order.
 *
 * Returning text rather than writing a file is the point: applying the suggestion
 * stays a deliberate act by the user.
 *
 * @param suggestedOrder - the backend order to suggest.
 * @param proxyUrl - the proxy currently in effect, if any.
 * @returns YAML text for the plugin's config block.
 */
export function suggestConfigSnippet(suggestedOrder, proxyUrl) {
  const lines = [
    '- id: free-web-search',
    "  name: 'dsh-free-web-search'",
    '  config:',
    `    backends: [${suggestedOrder.map((b) => `'${b}'`).join(', ')}]`,
  ]
  if (typeof proxyUrl === 'string' && proxyUrl !== '') lines.push(`    proxy: '${proxyUrl}'`)
  return lines.join('\n')
}
