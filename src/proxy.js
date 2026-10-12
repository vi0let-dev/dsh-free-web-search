/**
 * Proxy support, implemented from scratch.
 *
 * ## Why this file exists
 *
 * The obvious way to route `fetch` through a proxy is undici's `ProxyAgent` and
 * `setGlobalDispatcher`. That is not available here: this plugin's hard
 * constraint is **zero third-party dependencies**, and `undici` is not importable
 * from the DSH host runtime (`ERR_MODULE_NOT_FOUND` — verified). Node's
 * experimental `NODE_USE_ENV_PROXY` is also unusable, because it is read once at
 * process start and this is a long-running host that may gain a proxy later.
 *
 * So the tunnel is built by hand, on `node:net`/`node:tls`/`node:http`, and the
 * HTTP layer routes through it instead of calling `fetch`. That keeps the
 * dependency count at zero, which is what stops this plugin from colliding with
 * whatever the host and the other installed plugins already bring.
 *
 * ## What is supported
 *
 *   - `http://` and `https://` proxies, via the HTTP `CONNECT` method. This
 *     covers Squid, mitmproxy, Charles, Fiddler, Clash/V2Ray in HTTP mode, and
 *     the corporate proxies that dominate real deployments.
 *   - `socks5://` and `socks5h://` proxies, via SOCKS5 `CONNECT`. Clash, V2Ray
 *     and Shadowsocks commonly expose a SOCKS5 port instead of (or as well as)
 *     an HTTP one, so supporting only HTTP would leave a large share of the
 *     proxy setups people actually run unusable.
 *   - `user:pass@` credentials on both, with Basic auth (HTTP) and
 *     username/password auth (SOCKS5).
 *
 * ## What is deliberately not supported
 *
 *   - SOCKS4. It cannot resolve names remotely and is obsolete; `socks5h` covers
 *     the same need better.
 *   - TLS-to-the-proxy client certificates, and proxy auto-config (PAC) files.
 *
 * @module src/proxy.js
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

/**
 * Parse a proxy URL into the shape the connectors need.
 *
 * @param input - a proxy URL such as `http://user:pass@host:8080` or
 *        `socks5h://host:1080`. A bare `host:port` is accepted and assumed HTTP.
 * @returns `{ protocol, host, port, auth }`, or `undefined` when unusable.
 */
export function parseProxy(input) {
  if (typeof input !== 'string' || input.trim() === '') return undefined
  let raw = input.trim()
  // Accept `host:port` and `user:pass@host:port` without a scheme.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`

  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }

  const protocol = url.protocol.replace(/:$/, '').toLowerCase()
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) return undefined

  const host = url.hostname
  if (host === '') return undefined
  // Default ports: 1080 is the conventional SOCKS port, 8080 the conventional
  // HTTP proxy port. Neither is certain, but guessing beats refusing to connect.
  const port = url.port !== '' ? Number.parseInt(url.port, 10) : protocol.startsWith('socks') ? 1080 : 8080
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined

  const auth =
    url.username === '' && url.password === ''
      ? undefined
      : { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }

  return { protocol, host, port, auth }
}

/**
 * Is this a SOCKS proxy?
 *
 * @param proxy - a parsed proxy.
 * @returns true when the SOCKS5 handshake is required.
 */
function isSocks(proxy) {
  return proxy.protocol === 'socks5' || proxy.protocol === 'socks5h'
}

/**
 * Perform the SOCKS5 greeting and CONNECT command over an established socket.
 *
 * @param socket - a connected socket to the proxy.
 * @param proxy - the parsed proxy (for credentials).
 * @param targetHost - the destination host.
 * @param targetPort - the destination port.
 * @param onReady - called once the tunnel is open.
 * @param onError - called with the failure reason.
 */
function socks5Connect(socket, proxy, targetHost, targetPort, onReady, onError) {
  const wantsAuth = proxy.auth !== undefined && proxy.auth.username !== ''
  // Greeting: version 5, then the methods we are willing to use.
  socket.write(Buffer.from(wantsAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))

  let stage = 'greeting'
  let buffer = Buffer.alloc(0)

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])

    if (stage === 'greeting') {
      if (buffer.length < 2) return
      if (buffer[0] !== 0x05) return onError(new Error('socks5: proxy did not answer with version 5'))
      const method = buffer[1]
      buffer = buffer.subarray(2)
      if (method === 0x02) {
        if (!wantsAuth) return onError(new Error('socks5: proxy demands authentication but none was configured'))
        const user = Buffer.from(proxy.auth.username, 'utf8')
        const pass = Buffer.from(proxy.auth.password, 'utf8')
        if (user.length > 255 || pass.length > 255) return onError(new Error('socks5: credential is too long'))
        const request = Buffer.concat([
          Buffer.from([0x01, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ])
        stage = 'auth'
        socket.write(request)
        return
      }
      if (method !== 0x00) return onError(new Error(`socks5: proxy rejected every offered auth method (0x${method.toString(16)})`))
      stage = 'reply'
      socket.write(buildSocks5Connect(targetHost, targetPort))
      return
    }

    if (stage === 'auth') {
      if (buffer.length < 2) return
      const ok = buffer[1] === 0x00
      buffer = buffer.subarray(2)
      if (!ok) return onError(new Error('socks5: the proxy rejected the username/password'))
      stage = 'reply'
      socket.write(buildSocks5Connect(targetHost, targetPort))
      return
    }

    // stage === 'reply': version, status, reserved, address type, address, port.
    if (buffer.length < 4) return
    if (buffer[0] !== 0x05) return onError(new Error('socks5: malformed reply'))
    const status = buffer[1]
    if (status !== 0x00) return onError(new Error(`socks5: CONNECT refused (${SOCKS5_ERRORS[status] ?? `code 0x${status.toString(16)}`})`))
    const addressType = buffer[3]
    const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : addressType === 0x03 ? buffer[4] + 1 : 0
    if (addressLength === 0) return onError(new Error('socks5: unsupported address type in reply'))
    const needed = 4 + addressLength + 2
    if (buffer.length < needed) return
    socket.removeListener('data', onData)
    onReady()
  }

  socket.on('data', onData)
}

/** SOCKS5 reply codes, for error messages a human can act on. */
const SOCKS5_ERRORS = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
}

/**
 * Build the SOCKS5 CONNECT request for a destination.
 *
 * The host is sent as a domain name (address type 0x03) rather than resolved
 * locally, so DNS happens at the proxy. That is required for `socks5h` and
 * desirable for `socks5` too: it lets the proxy resolve names that the local
 * resolver cannot, which is the common case for the sites that need a proxy.
 *
 * @param host - destination host.
 * @param port - destination port.
 * @returns the request bytes.
 */
function buildSocks5Connect(host, port) {
  const name = Buffer.from(host, 'utf8')
  const head = Buffer.from([0x05, 0x01, 0x00, 0x03, name.length])
  const tail = Buffer.alloc(2)
  tail.writeUInt16BE(port, 0)
  return Buffer.concat([head, name, tail])
}

/**
 * Open a TCP tunnel to `targetHost:targetPort` through the proxy.
 *
 * @param proxy - the parsed proxy.
 * @param targetHost - destination host.
 * @param targetPort - destination port.
 * @param options - `{ timeoutMs, signal }`.
 * @returns a promise for a connected (but not yet TLS-wrapped) socket.
 */
export function openTunnel(proxy, targetHost, targetPort, options = {}) {
  const { timeoutMs = 15000, signal } = options

  return new Promise((resolve, reject) => {
    let settled = false
    const socket = net.connect({ host: proxy.host, port: proxy.port })

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

    const onAbort = () => fail(Object.assign(new Error('proxy tunnel aborted'), { name: 'AbortError' }))
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (timeoutMs > 0) socket.setTimeout(timeoutMs, () => fail(new Error(`proxy connect timed out after ${timeoutMs}ms`)))
    socket.on('error', (error) => fail(new Error(`cannot reach the proxy at ${proxy.host}:${proxy.port} (${error.code ?? error.message})`)))

    if (isSocks(proxy)) {
      socket.on('connect', () => {
        socket.setTimeout(timeoutMs, () => fail(new Error(`socks5 handshake timed out after ${timeoutMs}ms`)))
        socks5Connect(socket, proxy, targetHost, targetPort, succeed, fail)
      })
      return
    }

    // HTTP CONNECT.
    socket.on('connect', () => {
      const auth =
        proxy.auth !== undefined && proxy.auth.username !== ''
          ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64')}\r\n`
          : ''
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `${auth}` +
          `Proxy-Connection: Keep-Alive\r\n\r\n`,
      )
    })

    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) {
        // Guard against a proxy that streams a body without ending the headers.
        if (buffer.length > 65536) fail(new Error('proxy sent an oversized response to CONNECT'))
        return
      }
      socket.removeListener('data', onData)
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'))
      const status = Number.parseInt(statusLine.split(/\s+/)[1] ?? '', 10)
      if (status === 407) return fail(new Error('proxy requires authentication (HTTP 407); set the proxy username and password'))
      if (status !== 200) return fail(new Error(`proxy refused CONNECT: ${statusLine.trim()}`))
      succeed()
    }
    socket.on('data', onData)
  })
}

/**
 * Create an `http.Agent`/`https.Agent` that routes every connection through the
 * proxy.
 *
 * Returning a real Agent (rather than doing requests by hand) means the existing
 * HTTP code keeps working unchanged, including keep-alive and TLS verification.
 *
 * @param proxy - a parsed proxy.
 * @param options - `{ timeoutMs, signal, secure, tls }`.
 *        `secure` selects an https.Agent (for `https:` targets); an http.Agent
 *        is returned otherwise, since an http.Agent cannot be used for https.
 *        `tls` carries the caller's certificate settings, which must be applied
 *        to the tunnel's TLS wrap because that is where the handshake happens.
 * @returns an Agent whose `createConnection` tunnels through the proxy.
 */
export function createProxyAgent(proxy, options = {}) {
  const { timeoutMs = 15000, signal, secure = true, tls: callerTls = {} } = options
  const Base = secure ? https.Agent : http.Agent

  class TunnelAgent extends Base {
    createConnection(connectOptions, callback) {
      openTunnel(proxy, connectOptions.host, connectOptions.port || (secure ? 443 : 80), { timeoutMs, signal })
        .then((socket) => {
          if (!secure) return callback(null, socket)
          // Wrap the tunnel in TLS, verifying the certificate against the real
          // destination — the proxy is a transport, not the peer.
          //
          // Verification settings come from the caller (explicitly passed `tls`,
          // falling back to whatever the request supplied) rather than being
          // hardcoded. Forcing `rejectUnauthorized: true` would silently break a
          // private CA or an enterprise interception proxy.
          const secureSocket = tls.connect({
            socket,
            servername: connectOptions.servername ?? connectOptions.host,
            rejectUnauthorized: callerTls.rejectUnauthorized ?? connectOptions.rejectUnauthorized,
            ca: callerTls.ca ?? connectOptions.ca,
            cert: callerTls.cert ?? connectOptions.cert,
            key: callerTls.key ?? connectOptions.key,
            passphrase: callerTls.passphrase ?? connectOptions.passphrase,
          })
          secureSocket.once('secureConnect', () => callback(null, secureSocket))
          secureSocket.once('error', (error) => callback(error))
        })
        .catch((error) => callback(error))
    }
  }

  return new TunnelAgent({ keepAlive: false })
}

/**
 * A resolved proxy policy: which proxy (if any) applies to a given backend.
 *
 * The shape is deliberately small so it can be built from config, from the
 * environment, or by hand in a test.
 *
 * @param input - `{ url, perBackend, noProxy }`.
 * @returns a frozen policy object with a `for(backendId)` method.
 */
export function createProxyPolicy(input = {}) {
  const defaultProxy = parseProxy(input.url)
  const perBackend = new Map()
  if (input.perBackend !== null && typeof input.perBackend === 'object') {
    for (const [backend, value] of Object.entries(input.perBackend)) {
      // `null`/`''`/`'direct'` is an explicit "bypass the proxy for this one".
      if (value === null || value === undefined || value === '' || value === 'direct' || value === false) {
        perBackend.set(backend, null)
        continue
      }
      const parsed = parseProxy(value)
      if (parsed !== undefined) perBackend.set(backend, parsed)
    }
  }
  const noProxy = Array.isArray(input.noProxy) ? input.noProxy.filter((h) => typeof h === 'string' && h !== '') : []

  return Object.freeze({
    /** The default proxy, or `undefined` when unset. */
    default: defaultProxy,
    /** Per-backend overrides; a `null` value means "go direct". */
    perBackend,
    /** Hosts that always bypass the proxy. */
    noProxy,
    /** True when nothing at all is configured. */
    get isEmpty() {
      return defaultProxy === undefined && perBackend.size === 0
    },
    /**
     * Resolve the proxy to use for a backend and target host.
     *
     * @param backendId - the backend name (e.g. `google`).
     * @param host - the destination host, for the `noProxy` check.
     * @returns a parsed proxy, or `undefined` for a direct connection.
     */
    for(backendId, host) {
      if (typeof host === 'string' && host !== '' && matchesNoProxy(host, noProxy)) return undefined
      if (perBackend.has(backendId)) return perBackend.get(backendId) ?? undefined
      return defaultProxy
    },
  })
}

/**
 * Does a host match the `noProxy` list?
 *
 * Entries match the host exactly or as a parent domain, so `example.com` covers
 * `api.example.com` — the same semantics `NO_PROXY` has everywhere else, which is
 * what a user copying their existing value will expect.
 *
 * @param host - the destination host.
 * @param list - the configured entries.
 * @returns true when the proxy must be bypassed.
 */
export function matchesNoProxy(host, list) {
  const target = host.toLowerCase()
  for (const entry of list) {
    const name = String(entry).toLowerCase().replace(/^\./, '')
    if (name === '') continue
    if (name === '*') return true
    if (target === name || target.endsWith(`.${name}`)) return true
  }
  return false
}

/**
 * Build a proxy policy from the ambient environment.
 *
 * Honours the conventional variable names so a machine that already has a proxy
 * configured works with no plugin configuration at all.
 *
 * @param env - an environment-like object.
 * @returns `{ url, noProxy }` suitable for {@link createProxyPolicy}.
 */
export function proxyFromEnvironment(env = process.env) {
  const url =
    env.DSH_FREE_WEB_SEARCH_PROXY ??
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.HTTP_PROXY ??
    env.http_proxy ??
    env.ALL_PROXY ??
    env.all_proxy
  const noProxyRaw = env.DSH_FREE_WEB_SEARCH_NO_PROXY ?? env.NO_PROXY ?? env.no_proxy
  const noProxy =
    typeof noProxyRaw === 'string' && noProxyRaw.trim() !== ''
      ? noProxyRaw.split(/[,\s]+/).filter((entry) => entry !== '')
      : []
  return { url: typeof url === 'string' ? url : undefined, noProxy }
}
