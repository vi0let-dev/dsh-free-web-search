/**
 * A local TLS origin, for tests that need to exercise a real handshake.
 *
 * ## Why this exists
 *
 * Several tests need a genuine TLS endpoint: the proxy end-to-end suite proves a
 * tunnel carries a real handshake, and the latency suite proves the probe's
 * connect → TLS → HEAD path works. Stubbing the socket would prove neither, since
 * the whole point is that the handshake actually completes.
 *
 * The certificate is generated at runtime with `node:crypto`, so there are no
 * fixture files and no `openssl` dependency. It is a deliberately minimal DER
 * encoder — enough ASN.1 for one self-signed certificate with a SAN — not a
 * general X.509 library.
 *
 * @module test/tls-origin.mjs
 */

import https from 'node:https'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

/** DER primitives. */
function der() {
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
  return {
    tlv,
    seq: (...parts) => tlv(0x30, Buffer.concat(parts)),
    set: (...parts) => tlv(0x31, Buffer.concat(parts)),
    int: (value) => {
      let hex = value.toString(16)
      if (hex.length % 2) hex = `0${hex}`
      let buf = Buffer.from(hex, 'hex')
      if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf])
      return tlv(0x02, buf)
    },
    bitString: (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf])),
    octetString: (buf) => tlv(0x04, buf),
    nullTag: () => Buffer.from([0x05, 0x00]),
    oid: (dotted) => {
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
    },
    utf8: (text) => tlv(0x0c, Buffer.from(text, 'utf8')),
    utcTime: (date) => {
      const pad = (n) => String(n).padStart(2, '0')
      const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
      return tlv(0x17, Buffer.from(text, 'ascii'))
    },
    ctxTag: (n, content) => tlv(0xa0 | n, content),
  }
}

/** Wrap DER bytes in a PEM envelope. */
export function pem(label, derBytes) {
  const base64 = derBytes.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}

/**
 * Build a self-signed certificate for `localhost` / `127.0.0.1`.
 *
 * @returns `{ key, cert }` in PEM form.
 */
export function createSelfSignedCertificate() {
  const d = der()
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

  const algorithm = d.seq(d.oid('1.2.840.113549.1.1.11'), d.nullTag()) // sha256WithRSAEncryption
  const name = d.seq(d.set(d.seq(d.oid('2.5.4.3'), d.utf8('localhost'))))

  const now = new Date()
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000)
  const notAfter = new Date(now.getTime() + 365 * 24 * 3600 * 1000)

  const san = d.seq(d.tlv(0x82, Buffer.from('localhost', 'ascii')), d.tlv(0x87, Buffer.from([127, 0, 0, 1])))
  const extensions = d.ctxTag(3, d.seq(d.seq(d.oid('2.5.29.17'), d.octetString(san))))

  const tbs = d.seq(
    d.ctxTag(0, d.int(2)), // version v3
    d.int(Math.floor(Math.random() * 0x7fffffff)),
    algorithm,
    name,
    d.seq(d.utcTime(notBefore), d.utcTime(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  )

  const signature = sign('sha256', tbs, privateKey)
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', d.seq(tbs, algorithm, d.bitString(signature))),
  }
}

/**
 * Start a local HTTPS origin that answers `200` to any request.
 *
 * Tracks its sockets so `close()` cannot block on a lingering connection — the
 * failure mode that once hung the proxy suite indefinitely.
 *
 * @param options - `{ body }`, the response body.
 * @returns `{ server, port, cert, sockets, close }`.
 */
export async function startLocalTlsOrigin({ body = 'origin-ok' } = {}) {
  const { key, cert } = createSelfSignedCertificate()
  const sockets = new Set()

  const server = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`${body}:${req.url}`)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    server,
    cert,
    sockets,
    port: server.address().port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** Exported so a caller can reuse the hash helper without importing node:crypto. */
export { createHash }
