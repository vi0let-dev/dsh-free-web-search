/**
 * Proxy reachability probe.
 *
 * This exists as its own module and its own route because "the search failed" has
 * two very different causes that look identical in a search result:
 *
 *   - the **proxy** is wrong, unreachable, or rejecting our credentials; and
 *   - the proxy is fine but the **engine** is blocking us (captcha, consent wall).
 *
 * The first is fixed by correcting the proxy; the second is not fixed by the proxy
 * at all. Reporting them together as "search failed" would send the user to fix
 * the wrong thing, so the settings page can test the proxy on its own.
 *
 * @module src/proxycheck.js
 */

import { openTunnel } from './proxy.js'

/** A host that is reliable, cheap, and not a search engine. */
const CANARY_HOST = 'www.example.com'
const CANARY_PORT = 443

/**
 * Attempt a tunnel through the proxy to a known host.
 *
 * Deliberately only opens the tunnel (the TCP/CONNECT/SOCKS5 handshake) and does
 * not complete a TLS request: the handshake is where every proxy failure actually
 * happens — unreachable host, refused CONNECT, rejected credentials — and stopping
 * here keeps the probe fast and free of any dependency on a third-party site being
 * up.
 *
 * @param proxy - a parsed proxy from `parseProxy`.
 * @param options - `{ timeoutMs }`.
 * @returns `{ reachable, latencyMs, message }` — never throws.
 */
export async function probeProxy(proxy, { timeoutMs = 8000 } = {}) {
  const started = Date.now()
  try {
    const socket = await openTunnel(proxy, CANARY_HOST, CANARY_PORT, { timeoutMs })
    const latencyMs = Date.now() - started
    socket.destroy()
    return {
      reachable: true,
      latencyMs,
      message: `the proxy accepted a CONNECT to ${CANARY_HOST}:${CANARY_PORT} in ${latencyMs}ms`,
    }
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - started,
      message: describeProxyFailure(error, proxy),
    }
  }
}

/**
 * Turn a tunnel failure into advice.
 *
 * The raw errors are accurate but not actionable — `ECONNREFUSED` on its own does
 * not tell a user whether to fix the port, the scheme, or the credentials.
 *
 * @param error - the thrown error.
 * @param proxy - the parsed proxy that was tried.
 * @returns a message naming the likely cause and the next step.
 */
export function describeProxyFailure(error, proxy) {
  const message = String(error?.message ?? error)
  const endpoint = `${proxy.protocol}://${proxy.host}:${proxy.port}`

  if (/ECONNREFUSED/.test(message)) {
    return `nothing is listening on ${endpoint} — check the port, and that the proxy application is running`
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    return `the proxy host ${proxy.host} could not be resolved — check the hostname`
  }
  if (/ETIMEDOUT|timed out/.test(message)) {
    return `${endpoint} did not answer in time — the host may be unreachable, or a firewall may be dropping it`
  }
  if (/407|requires authentication/.test(message)) {
    return 'the proxy requires authentication — add username:password to the proxy URL'
  }
  if (/rejected the username\/password/.test(message)) {
    return 'the SOCKS5 proxy rejected the username/password'
  }
  // Check the specific CONNECT refusal *before* the generic socks5 catch-all:
  // "CONNECT refused (connection refused)" is far more actionable than
  // "SOCKS5 negotiation failed", and the latter would otherwise swallow it.
  if (/refused CONNECT|CONNECT refused/.test(message)) {
    return `the proxy refused the tunnel: ${message}`
  }
  if (/socks5/.test(message)) {
    return `SOCKS5 negotiation failed: ${message}`
  }
  return `could not reach ${endpoint}: ${message}`
}
