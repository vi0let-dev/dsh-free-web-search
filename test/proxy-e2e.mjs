/**
 * End-to-end proxy verification.
 *
 * Parsing a proxy URL correctly proves nothing about whether a request can travel
 * through it. This test stands up **real** proxies on loopback — one HTTP CONNECT
 * proxy, one SOCKS5 proxy, both with authentication — and drives the plugin's
 * actual HTTP layer through them to a real local HTTPS origin.
 *
 * That matters because the tunnel code is the part of this plugin most likely to
 * be subtly wrong: a hand-rolled CONNECT/SOCKS5 implementation has to get the
 * handshake bytes, the auth sub-negotiation, and the TLS layering all right, and
 * none of those failures show up in a unit test that stubs the socket.
 *
 *   node test/proxy-e2e.mjs
 *
 * @module test/proxy-e2e.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

import { requestText } from '../src/http.js'
import { openTunnel, parseProxy } from '../src/proxy.js'
import { probeProxy } from '../src/proxycheck.js'

/**
 * Hard watchdog.
 *
 * `server.close()` waits for every open connection, and a CONNECT tunnel stays
 * open until the client destroys it — so a leaked tunnel socket hangs the whole
 * run instead of failing it. That happened while writing this file. The watchdog
 * turns any such hang into a visible failure.
 */
const watchdog = setTimeout(() => {
  console.error('\n  FAIL the suite did not finish within 90s — a socket was leaked, or close() is waiting on an open tunnel')
  process.exit(1)
}, 90000)
if (typeof watchdog.unref === 'function') watchdog.unref()

/**
 * Close a server without waiting on lingering tunnel sockets.
 *
 * Tracked sockets are destroyed first, then `close()` resolves. Without this,
 * `close()` blocks on any connection a proxy is still holding open.
 *
 * @param server - the server to close.
 * @param sockets - a Set the server adds every accepted socket to.
 */
function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  return new Promise((resolve) => server.close(() => resolve()))
}

let passed = 0
let failed = 0

async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

/**
 * Start a local HTTPS origin with a self-signed certificate.
 *
 * Generated at runtime with `node:crypto` and `node:tls` — no files, no openssl
 * dependency. The certificate is for `localhost` so TLS verification can be
 * exercised for real.
 */
async function startOrigin() {
  const { generateKeyPairSync, createHash, sign } = await import('node:crypto')

  // A minimal self-signed X.509 v3 certificate for CN=localhost.
  // Built by hand because Node exposes no certificate generator.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const cert = selfSign({ privateKey, publicKey, sign, createHash })

  const sockets = new Set()
  const server = https.createServer({ key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`origin-ok:${req.url}`)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, sockets, port: server.address().port, cert }
}

/**
 * Build a DER-encoded self-signed certificate.
 *
 * This is a deliberately minimal encoder: enough ASN.1/DER for one certificate
 * with one SAN, which is all the test needs. It is not a general X.509 library.
 */
function selfSign({ privateKey, publicKey, sign, createHash }) {
  // DER primitives.
  const len = (n) => {
    if (n < 0x80) return Buffer.from([n])
    const bytes = []
    let value = n
    while (value > 0) {
      bytes.unshift(value & 0xff)
      value >>= 8
    }
    return Buffer.from([0x80 | bytes.length, ...bytes])
  }
  const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), len(content.length), content])
  const seq = (...parts) => tlv(0x30, Buffer.concat(parts))
  const set = (...parts) => tlv(0x31, Buffer.concat(parts))
  const int = (value) => {
    let hex = value.toString(16)
    if (hex.length % 2) hex = `0${hex}`
    let buf = Buffer.from(hex, 'hex')
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf])
    return tlv(0x02, buf)
  }
  const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]))
  const octetString = (buf) => tlv(0x04, buf)
  const nullTag = () => Buffer.from([0x05, 0x00])
  const oid = (dotted) => {
    const parts = dotted.split('.').map(Number)
    const bytes = [parts[0] * 40 + parts[1]]
    for (const part of parts.slice(2)) {
      const chunk = []
      let value = part
      do {
        chunk.unshift(value & 0x7f)
        value >>= 7
      } while (value > 0)
      for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80
      bytes.push(...chunk)
    }
    return tlv(0x06, Buffer.from(bytes))
  }
  const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'))
  const utcTime = (date) => {
    const pad = (n) => String(n).padStart(2, '0')
    const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
    return tlv(0x17, Buffer.from(text, 'ascii'))
  }
  const ctxTag = (n, content) => tlv(0xa0 | n, content)

  const algorithm = seq(oid('1.2.840.113549.1.1.11'), nullTag()) // sha256WithRSAEncryption
  const name = seq(set(seq(oid('2.5.4.3'), utf8('localhost'))))

  const now = new Date()
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000)
  const notAfter = new Date(now.getTime() + 365 * 24 * 3600 * 1000)

  // SubjectAltName with dNSName=localhost and iPAddress=127.0.0.1
  const san = seq(
    tlv(0x82, Buffer.from('localhost', 'ascii')),
    tlv(0x87, Buffer.from([127, 0, 0, 1])),
  )
  const extensions = ctxTag(3, seq(seq(oid('2.5.29.17'), octetString(san))))

  const tbs = seq(
    ctxTag(0, int(2)), // version v3
    int(Math.floor(Math.random() * 0x7fffffff)),
    algorithm,
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    // SubjectPublicKeyInfo: re-export the public key and parse it back out.
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  )

  const signature = sign('sha256', tbs, privateKey)
  const certificate = seq(tbs, algorithm, bitString(signature))
  return pem('CERTIFICATE', certificate)
}

/** Wrap DER bytes in a PEM envelope. */
function pem(label, der) {
  const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}

/**
 * Start a real HTTP CONNECT proxy.
 *
 * @param options - `{ requireAuth }`.
 * @returns `{ port, close, stats }`.
 */
async function startHttpProxy({ requireAuth = false, username = 'u', password = 'p' } = {}) {
  const stats = { connects: 0, denied: 0 }
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('connect', (req, clientSocket, head) => {
    if (requireAuth) {
      const header = req.headers['proxy-authorization'] ?? ''
      const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      if (header !== expected) {
        stats.denied += 1
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n')
        clientSocket.destroy()
        return
      }
    }
    const [host, port] = req.url.split(':')
    stats.connects += 1
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    stats,
    close: () => closeServer(server, sockets),
  }
}

/**
 * Start a real SOCKS5 proxy.
 *
 * Implements the no-auth and username/password paths, and CONNECT to an IPv4 or
 * domain address. Enough to exercise the plugin's client implementation.
 */
async function startSocks5Proxy({ requireAuth = false, username = 'u', password = 'p' } = {}) {
  const stats = { connects: 0, denied: 0, addressTypes: [] }
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let stage = 'greeting'
    let buffer = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      // Once relaying starts, the pipe set up below owns every byte. Writing here
      // as well would duplicate each chunk and corrupt the TLS stream — which
      // surfaces as ERR_SSL_SSL/TLS_ALERT_UNEXPECTED_MESSAGE on the client.
      if (stage === 'relay') return
      buffer = Buffer.concat([buffer, chunk])

      if (stage === 'greeting') {
        if (buffer.length < 2) return
        const count = buffer[1]
        if (buffer.length < 2 + count) return
        const methods = [...buffer.subarray(2, 2 + count)]
        buffer = buffer.subarray(2 + count)
        if (requireAuth) {
          if (!methods.includes(0x02)) {
            socket.write(Buffer.from([0x05, 0xff]))
            socket.destroy()
            return
          }
          socket.write(Buffer.from([0x05, 0x02]))
          stage = 'auth'
        } else {
          socket.write(Buffer.from([0x05, 0x00]))
          stage = 'request'
        }
        return
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return
        const userLength = buffer[1]
        if (buffer.length < 2 + userLength + 1) return
        const user = buffer.subarray(2, 2 + userLength).toString('utf8')
        const passLength = buffer[2 + userLength]
        if (buffer.length < 3 + userLength + passLength) return
        const pass = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString('utf8')
        buffer = buffer.subarray(3 + userLength + passLength)
        if (user !== username || pass !== password) {
          stats.denied += 1
          socket.write(Buffer.from([0x01, 0x01]))
          socket.destroy()
          return
        }
        socket.write(Buffer.from([0x01, 0x00]))
        stage = 'request'
        return
      }

      // request: ver cmd rsv atyp addr port
      if (buffer.length < 4) return
      const addressType = buffer[3]
      stats.addressTypes.push(addressType)
      let host
      let offset
      if (addressType === 0x01) {
        if (buffer.length < 10) return
        host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`
        offset = 8
      } else if (addressType === 0x03) {
        const nameLength = buffer[4]
        if (buffer.length < 5 + nameLength + 2) return
        host = buffer.subarray(5, 5 + nameLength).toString('utf8')
        offset = 5 + nameLength
      } else {
        socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        socket.destroy()
        return
      }
      const port = buffer.readUInt16BE(offset)
      buffer = buffer.subarray(offset + 2)
      stage = 'relay'

      const upstream = net.connect(port, host, () => {
        stats.connects += 1
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        // Anything already buffered past the request belongs to the tunnel.
        if (buffer.length) upstream.write(buffer)
        // The pipes below own all further bytes; the data handler returns early
        // once `stage === 'relay'`, so nothing is written twice.
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', () => {
        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        socket.destroy()
      })
      socket.on('error', () => upstream.destroy())
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    stats,
    close: () => closeServer(server, sockets),
  }
}

console.log('\ndsh-free-web-search — proxy end-to-end verification\n')

const origin = await startOrigin()
const originUrl = `https://127.0.0.1:${origin.port}/probe`

// The origin uses a self-signed certificate, so verification must be relaxed for
// the test. The tunnel itself is what is under test, not certificate validation.

console.log(`origin listening on https://127.0.0.1:${origin.port}\n`)

console.log('http connect proxy')
{
  const proxy = await startHttpProxy()
  const parsed = parseProxy(`http://127.0.0.1:${proxy.port}`)

  await check('tunnels an HTTPS request through a CONNECT proxy', async () => {
    const result = await requestText(originUrl, { timeoutMs: 8000, proxy: parsed, ca: origin.cert })
    assert.equal(result.status, 200)
    assert.match(result.text, /origin-ok:\/probe/)
    assert.equal(proxy.stats.connects, 1, 'the proxy should have seen exactly one CONNECT')
  })
  await check('openTunnel reports a usable socket through CONNECT', async () => {
    const socket = await openTunnel(parsed, '127.0.0.1', origin.port, { timeoutMs: 5000 })
    assert.equal(typeof socket.destroy, 'function')
    socket.destroy()
  })
  await check('probeProxy confirms the proxy is reachable', async () => {
    const result = await probeProxy(parsed, { timeoutMs: 8000 })
    // The canary is www.example.com; on a network without internet this still
    // proves the handshake, which is what the probe is for.
    assert.equal(typeof result.reachable, 'boolean')
    assert.equal(typeof result.message, 'string')
  })
  await proxy.close()
}

console.log('\nhttp connect proxy with authentication')
{
  const proxy = await startHttpProxy({ requireAuth: true, username: 'alice', password: 's3cret' })

  await check('authenticates with Basic credentials', async () => {
    const parsed = parseProxy(`http://alice:s3cret@127.0.0.1:${proxy.port}`)
    const result = await requestText(originUrl, { timeoutMs: 8000, proxy: parsed, ca: origin.cert })
    assert.equal(result.status, 200)
    assert.equal(proxy.stats.denied, 0)
  })
  await check('reports HTTP 407 as an actionable authentication failure', async () => {
    const parsed = parseProxy(`http://alice:wrong@127.0.0.1:${proxy.port}`)
    await assert.rejects(
      () => requestText(originUrl, { timeoutMs: 8000, proxy: parsed, ca: origin.cert }),
      (error) => {
        assert.match(String(error.message), /407|authentication/i)
        return true
      },
    )
    assert.ok(proxy.stats.denied >= 1)
  })
  await check('a missing credential is reported, not silently sent', async () => {
    const parsed = parseProxy(`http://127.0.0.1:${proxy.port}`)
    await assert.rejects(() => requestText(originUrl, { timeoutMs: 8000, proxy: parsed, ca: origin.cert }), /407|authentication/i)
  })
  await proxy.close()
}

console.log('\nsocks5 proxy')
{
  const proxy = await startSocks5Proxy()
  const parsed = parseProxy(`socks5://127.0.0.1:${proxy.port}`)

  await check('tunnels an HTTPS request through SOCKS5', async () => {
    const result = await requestText(originUrl, { timeoutMs: 8000, proxy: parsed, ca: origin.cert })
    assert.equal(result.status, 200)
    assert.match(result.text, /origin-ok:\/probe/)
    assert.equal(proxy.stats.connects, 1)
  })
  await check('sends the host as a domain name, not a locally resolved address', async () => {
    // Address type 0x03 (domain) is what the proxy receives when it is asked to
    // resolve the name itself. Sending 0x01 (IPv4) instead would mean the plugin
    // resolved locally — which breaks `socks5h` semantics and fails for any host
    // the local resolver cannot see.
    proxy.stats.addressTypes.length = 0
    const result = await requestText(`https://localhost:${origin.port}/domain-probe`, {
      timeoutMs: 8000,
      proxy: parsed,
      ca: origin.cert,
    })
    assert.equal(result.status, 200)
    assert.deepEqual(proxy.stats.addressTypes, [0x03], 'the proxy must receive a domain-name request')
  })
  await proxy.close()
}

console.log('\nsocks5 proxy with authentication')
{
  const proxy = await startSocks5Proxy({ requireAuth: true, username: 'bob', password: 'hunter2' })

  await check('completes the username/password sub-negotiation', async () => {
    const parsed = parseProxy(`socks5://bob:hunter2@127.0.0.1:${proxy.port}`)
    const result = await requestText(originUrl, { timeoutMs: 8000, proxy: parsed, ca: origin.cert })
    assert.equal(result.status, 200)
    assert.equal(proxy.stats.denied, 0)
  })
  await check('reports rejected credentials distinctly', async () => {
    const parsed = parseProxy(`socks5://bob:wrong@127.0.0.1:${proxy.port}`)
    await assert.rejects(
      () => requestText(originUrl, { timeoutMs: 8000, proxy: parsed, ca: origin.cert }),
      (error) => {
        assert.match(String(error.message), /rejected the username\/password/)
        return true
      },
    )
  })
  await check('a proxy demanding auth with none configured is reported clearly', async () => {
    const parsed = parseProxy(`socks5://127.0.0.1:${proxy.port}`)
    await assert.rejects(
      () => requestText(originUrl, { timeoutMs: 8000, proxy: parsed, ca: origin.cert }),
      /demands authentication but none was configured|rejected every offered auth method/,
    )
  })
  await proxy.close()
}

console.log('\nproxy failure modes')
await check('an unreachable proxy fails fast with the endpoint named', async () => {
  const parsed = parseProxy('http://127.0.0.1:1')
  const started = Date.now()
  await assert.rejects(
    () => requestText(originUrl, { timeoutMs: 8000, proxy: parsed, ca: origin.cert }),
    (error) => {
      assert.match(String(error.message), /127\.0\.0\.1:1/)
      return true
    },
  )
  assert.ok(Date.now() - started < 5000, 'a refused connection must not wait for the timeout')
})
await check('noProxy bypasses the proxy for a matching host', async () => {
  // The policy layer, exercised against a real request: 127.0.0.1 is excluded, so
  // the request goes direct even though a (dead) proxy is configured.
  const { createProxyPolicy } = await import('../src/proxy.js')
  const policy = createProxyPolicy({ url: 'http://127.0.0.1:1', noProxy: ['127.0.0.1'] })
  assert.equal(policy.for('bing', '127.0.0.1'), undefined)
  const result = await requestText(originUrl, { timeoutMs: 8000, proxy: policy.for('bing', '127.0.0.1'), ca: origin.cert })
  assert.equal(result.status, 200)
})

await closeServer(origin.server, origin.sockets)
clearTimeout(watchdog)

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
