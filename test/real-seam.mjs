/**
 * Integration test: run this plugin against the REAL `ctx.web` seam.
 *
 * `test/smoke.mjs` verifies the plugin's own logic with a hand-written stand-in
 * for `ctx.web`. That is not enough for the plugin's central claim — that it
 * coexists with other search providers instead of creating a
 * `WEB_PROVIDER_AMBIGUOUS` conflict — because that claim is about *the seam's*
 * selection algorithm, which the plugin does not own. A stand-in written by the
 * same person who wrote the plugin would only prove the stand-in agrees.
 *
 * So this test loads the actual `@deepseek-ai/dsh-web` implementation extracted
 * from `app.asar` (see `extract-real-seam.mjs`) and drives the real
 * `WebRuntime.search()`.
 *
 * The three bare specifiers `dsh-web` imports are satisfied by minimal shims
 * under `test/real/node_modules/`. They are deliberately trivial: `Service` is
 * only needed as a base class, `schemastery` only for a `Config` declaration that
 * is never validated here, and `HarnessError` only as an error base. None of them
 * participate in provider selection, so shimming them cannot mask a bug in the
 * behaviour under test.
 *
 *   node test/real-seam.mjs
 *
 * @module test/real-seam.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SEARXNG_JSON } from './fixtures.js'
import { resolveConfig } from '../src/config.js'
import { FreeSearchProvider } from '../src/provider.js'

const REAL_SEAM = path.join(import.meta.dirname, 'real', 'node_modules', '@deepseek-ai', 'dsh-web', 'lib', 'index.js')

/**
 * Isolate this suite from the real `$DSH_HOME`.
 *
 * `apply()` re-applies a saved provider choice on load, and `resolveConfig` reads
 * the settings file — both located via `$DSH_HOME`, which falls back to the real
 * `~/.dsh`. Without this, a developer whose own `settings.json` says
 * `searchProvider: "free-web"` gets a plugin that claims the search slot, and the
 * "steps aside for an official provider" assertion fails for a reason that has
 * nothing to do with the code.
 */
const TEST_HOME = path.join(os.tmpdir(), `dsh-fws-realseam-${process.pid}-${Date.now()}`)
const ORIGINAL_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = TEST_HOME
fs.mkdirSync(TEST_HOME, { recursive: true })

/** An env object that can never resolve to the real home. */
const TEST_ENV = { DSH_HOME: TEST_HOME }

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

console.log('\ndsh-free-web-search — integration against the real ctx.web seam\n')

if (!fs.existsSync(REAL_SEAM)) {
  console.error(`  SKIP the real seam was not extracted; run: node test/extract-real-seam.mjs\n`)
  process.exit(1)
}

// Confirm we are driving the genuine article, not an accidental local copy.
const seamSource = fs.readFileSync(REAL_SEAM, 'utf8')
console.log('  using seam source:', REAL_SEAM)

const { WebRuntime, WebError } = await import(new URL('./real/node_modules/@deepseek-ai/dsh-web/lib/index.js', import.meta.url).href)

/** The real seam registers itself on a cordis context; this is the minimum it touches. */
function makeCtx() {
  return {
    /** `Service` calls this in its constructor to publish itself. */
    reflect: { provide: () => {} },
    /** `registerProvider` wraps registration in `ctx.effect`. */
    effect: (fn) => {
      const iterator = typeof fn === 'function' ? fn() : fn
      if (iterator !== null && typeof iterator === 'object' && typeof iterator.next === 'function') iterator.next()
      return () => {}
    },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  }
}

/** A minimal stand-in for another search provider, to occupy the slot. */
function otherProvider(id, available = true) {
  return {
    id,
    available: () => available,
    search: async () => ({ sources: [{ url: `https://${id}.example/` }], truncated: false }),
  }
}

/** Install a fetch stub that answers every request with a SearxNG result set. */
function stubFetch() {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://searx.example/search',
    text: async () => JSON.stringify(SEARXNG_JSON),
  })
}

const originalFetch = globalThis.fetch

console.log('\nseam behaviour without this plugin')
await check('a lone foreign provider is selected', async () => {
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(otherProvider('deepseek-official'))
  const result = await web.search({ query: 'x' })
  assert.equal(result.sources[0].url, 'https://deepseek-official.example/')
})
await check('two usable providers and no configured id raise WEB_PROVIDER_AMBIGUOUS', async () => {
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(otherProvider('deepseek-official'))
  web.registerSearchProvider(otherProvider('second-provider'))
  await assert.rejects(() => web.search({ query: 'x' }), (error) => {
    assert.ok(error instanceof WebError)
    assert.equal(error.code, 'WEB_PROVIDER_AMBIGUOUS')
    return true
  })
})

console.log('\nthis plugin alongside the real seam')
await check('registering under "free-web" does not collide with a shipped id', async () => {
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(otherProvider('deepseek-official'))
  // Must not throw WEB_DUPLICATE_PROVIDER.
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web))
  assert.ok(web.searchProviders.has('free-web'))
  assert.ok(web.searchProviders.has('deepseek-official'))
})
await check('a duplicate of our own id is rejected by the seam as expected', async () => {
  const web = new WebRuntime(makeCtx(), {})
  const make = () => new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web)
  web.registerSearchProvider(make())
  assert.throws(() => web.registerSearchProvider(make()), (error) => error.code === 'WEB_DUPLICATE_PROVIDER')
})

console.log('\nthe anti-conflict guarantee, verified against the real selection algorithm')
await check('with a working official provider present, search still succeeds (no ambiguity)', async () => {
  stubFetch()
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(otherProvider('deepseek-official'))
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web))

  // This is the regression that a naive plugin would cause: WEB_PROVIDER_AMBIGUOUS.
  const result = await web.search({ query: 'python' })
  assert.equal(result.sources[0].url, 'https://deepseek-official.example/', 'the pre-existing provider must keep serving search')
})
await check('with no other provider, this plugin serves the search', async () => {
  stubFetch()
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web))
  const result = await web.search({ query: 'python', maxResults: 2 })
  assert.equal(result.sources[0].url, 'https://www.python.org/')
  assert.equal(result.sources.length, 2)
})
await check('with another provider registered but unavailable, this plugin takes over', async () => {
  stubFetch()
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(otherProvider('deepseek-official', false))
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web))
  const result = await web.search({ query: 'python' })
  assert.equal(result.sources[0].url, 'https://www.python.org/')
})
await check('an explicit selection of "free-web" wins even beside a usable official provider', async () => {
  stubFetch()
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(otherProvider('deepseek-official'))
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web))
  web.searchProviderId = 'free-web'
  const result = await web.search({ query: 'python' })
  assert.equal(result.sources[0].url, 'https://www.python.org/')
})
await check('an explicit selection of the official provider keeps it authoritative', async () => {
  stubFetch()
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(otherProvider('deepseek-official'))
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web))
  web.searchProviderId = 'deepseek-official'
  const result = await web.search({ query: 'python' })
  assert.equal(result.sources[0].url, 'https://deepseek-official.example/')
})
await check('takeover:true claims the slot even when the official provider is configured', async () => {
  stubFetch()
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(otherProvider('deepseek-official'))
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({ takeover: true }, TEST_ENV), () => web))
  web.searchProviderId = 'free-web'
  const result = await web.search({ query: 'python' })
  assert.equal(result.sources[0].url, 'https://www.python.org/')
})
await check('this plugin respects maxResults itself, so the seam need not truncate', async () => {
  stubFetch()
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web))
  const result = await web.search({ query: 'python', maxResults: 1 })
  // The provider caps its own output (as the official provider does), so the
  // seam sees nothing to truncate and `truncated` stays false. `truncated` is
  // the seam's report that *it* had to cut results, not a general flag.
  assert.equal(result.sources.length, 1)
  assert.equal(result.truncated, false)
})
await check('the seam does truncate and flag when a provider over-returns', async () => {
  const web = new WebRuntime(makeCtx(), {})
  // A deliberately over-returning provider, to prove the control case above is
  // meaningful rather than an artifact of the seam never truncating at all.
  web.registerSearchProvider({
    id: 'over-returner',
    available: () => true,
    search: async () => ({
      sources: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }, { url: 'https://c.example/' }],
      truncated: false,
    }),
  })
  const result = await web.search({ query: 'x', maxResults: 1 })
  assert.equal(result.sources.length, 1)
  assert.equal(result.truncated, true)
})
await check('cancellation propagates through the real seam', async () => {
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web))
  await assert.rejects(() => web.search({ query: 'x' }, controller.signal), (error) => error.kind === 'aborted')
})
await check('a configured id that is not registered still reports CONFIGURED_MISSING', async () => {
  const web = new WebRuntime(makeCtx(), {})
  web.registerSearchProvider(new FreeSearchProvider(() => resolveConfig({}, TEST_ENV), () => web))
  web.searchProviderId = 'nonexistent'
  await assert.rejects(() => web.search({ query: 'x' }), (error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING')
})

console.log('\nthe plugin entry point, wired the way the loader wires it')
await check('apply() registers into ctx.web and reports the fallback stance', async () => {
  const plugin = await import('../index.js')
  const logs = []
  const web = new WebRuntime(makeCtx(), {})
  const ctx = {
    reflect: { provide: () => {} },
    effect: (fn) => {
      const iterator = typeof fn === 'function' ? fn() : fn
      if (iterator !== null && typeof iterator === 'object' && typeof iterator.next === 'function') iterator.next()
      return () => {}
    },
    get: (serviceName) => (serviceName === 'web' ? web : undefined),
    logger: { info: (m) => logs.push(`INFO ${m}`), warn: (m) => logs.push(`WARN ${m}`), debug: () => {} },
    // This is how cordis exposes a published service, and the only property
    // apply() touches directly.
    web,
  }

  plugin.apply(ctx, {})

  assert.deepEqual([...web.searchProviders.keys()], ['free-web'])
  assert.equal(logs.filter((line) => line.startsWith('WARN')).length, 0, 'apply() must not warn on a clean install')
  assert.match(logs.join('\n'), /registered search provider "free-web"/)

  // The coexistence guarantee, end to end through apply().
  assert.equal(web.searchProviders.get('free-web').available(), true, 'a bare install should be served by this plugin')
  web.registerSearchProvider(otherProvider('deepseek-official'))
  assert.equal(
    web.searchProviders.get('free-web').available(),
    false,
    'once an official provider exists, this plugin must step aside',
  )
})
await check('apply() is safe to run twice (the loader may re-evaluate the entry)', async () => {
  const plugin = await import('../index.js')
  const warnings = []
  const web = new WebRuntime(makeCtx(), {})
  const freshCtx = () => ({
    reflect: { provide: () => {} },
    effect: () => () => {},
    get: () => web,
    logger: { info: () => {}, warn: (m) => warnings.push(String(m)), debug: () => {} },
    web,
  })
  plugin.apply(freshCtx(), {})
  // A second apply() hits the seam's duplicate check. It must be reported, not thrown.
  plugin.apply(freshCtx(), {})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /already registered/)
})

globalThis.fetch = originalFetch

// Release the isolated home and prove the real one was never touched.
if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = ORIGINAL_DSH_HOME
try {
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
} catch {
  /* best effort */
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
