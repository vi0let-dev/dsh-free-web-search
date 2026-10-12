/**
 * Live proxy verification against the real internet.
 *
 * `proxy-e2e.mjs` proves the tunnel works against a local origin. This one answers
 * the different question the user actually cares about: with a proxy configured,
 * does a backend that was previously unreachable start working?
 *
 *   node test/live-proxy.mjs http://127.0.0.1:7890
 *
 * Reports only; it does not assert, because whether a given proxy can reach a
 * given engine is a fact about the network.
 */
import { searchGoogle } from '../src/backends/google.js'
import { resolveConfig } from '../src/config.js'
import { parseProxy } from '../src/proxy.js'
import { probeProxy } from '../src/proxycheck.js'

const proxyUrl = process.argv[2] ?? process.env.DSH_FREE_WEB_SEARCH_PROXY ?? ''
console.log(`\nlive proxy check — proxy: ${proxyUrl === '' ? '(none)' : proxyUrl}\n`)

const parsed = proxyUrl === '' ? undefined : parseProxy(proxyUrl)
if (proxyUrl !== '' && parsed === undefined) {
  console.error(`  the proxy URL could not be parsed: ${proxyUrl}`)
  process.exit(1)
}

if (parsed !== undefined) {
  console.log('proxy reachability:')
  const result = await probeProxy(parsed, { timeoutMs: 10000 })
  console.log(`  ${result.reachable ? 'ok  ' : 'FAIL'} ${result.message}`)
  console.log('')
}

// Google is the backend that most needs a proxy, so it is the sharpest test.
console.log('google search:')
const started = Date.now()
try {
  const { sources } = await searchGoogle('DeepSeek Harness', { timeoutMs: 15000, limit: 5, proxy: parsed })
  console.log(`  ok   ${sources.length} sources in ${Date.now() - started}ms`)
  for (const source of sources.slice(0, 3)) {
    console.log(`       - ${(source.title ?? '(no title)').slice(0, 80)}`)
    console.log(`         ${source.url.slice(0, 110)}`)
  }
} catch (error) {
  console.log(`  FAIL ${Date.now() - started}ms  ${(error?.message ?? error).slice(0, 220)}`)
}

// And confirm the policy layer routes per backend as configured.
console.log('\nresolved policy per backend:')
const options = resolveConfig({ proxy: proxyUrl }, process.env)
for (const backend of options.backends) {
  const resolved = options.proxyPolicy.for(backend)
  console.log(`  ${backend.padEnd(11)} ${resolved === undefined ? 'direct' : `${resolved.protocol}://${resolved.host}:${resolved.port}`}`)
}
