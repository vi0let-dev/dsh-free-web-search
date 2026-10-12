/**
 * Offline smoke test for dsh-free-web-search.
 *
 * Runs with no network access at all: `globalThis.fetch` is replaced by a stub
 * that answers from `test/fixtures.js` based on the request URL. That is the
 * point — the parsers and the provider's selection logic are exactly the parts
 * that must be verifiable without a live instance or a live DuckDuckGo, and a
 * test that needed the internet would be unrunnable in the environments where
 * this plugin is most useful.
 *
 *   node test/smoke.mjs
 *
 * Exits non-zero on the first failed assertion.
 *
 * @module test/smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  BING_BLOCK_PAGE,
  BING_PAGE,
  BING_REDESIGNED_PAGE,
  DDG_BLOCK_PAGE,
  DDG_HTML_PAGE,
  DDG_LITE_PAGE,
  GOOGLE_CONSENT_PAGE,
  GOOGLE_JS_SHELL,
  SEARXNG_HTML_ERROR,
  SEARXNG_JSON,
  WIKI_DETAIL_JSON,
  WIKI_SEARCH_JSON,
} from './fixtures.js'
import { startLocalTlsOrigin } from './tls-origin.mjs'
import { decodeEntities, stripTags, collectClassMatches, innerOf, dedupeSources } from '../src/html.js'
import { __setTransportForTests, requestText } from '../src/http.js'
import { isBlocked, parseResultsPage, unwrapRedirect, isUsableResultUrl } from '../src/backends/duckduckgo.js'
import { searchDuckDuckGo } from '../src/backends/duckduckgo.js'
import { isBingBlocked, parseBingResults, searchBing, unwrapBingRedirect, isUsableBingResultUrl } from '../src/backends/bing.js'
import { isBaiduBlocked, parseBaiduResults, searchBaidu, unwrapBaiduRedirect, isUsableBaiduResultUrl } from '../src/backends/baidu.js'
import { isYandexBlocked, parseYandexResults, searchYandex } from '../src/backends/yandex.js'
import { isGoogleBlocked, isGoogleJavaScriptShell, parseGoogleResults, searchGoogle, unwrapGoogleRedirect, isUsableGoogleResultUrl } from '../src/backends/google.js'
import { decodeBase64Url, isUsableResultUrl as isUsableUrlShared, looksSubstituted, measureRelevance, queryTerms } from '../src/urls.js'
import { createProxyPolicy, matchesNoProxy, parseProxy, proxyFromEnvironment } from '../src/proxy.js'
import { createProviderControl } from '../src/provider-control.js'
import { normalizeSettings, resolveHome } from '../src/settings.js'
import { rank, runLatencyTest, probeLatency, probeTargetFor, suggestConfigSnippet, PROBE_TARGETS } from '../src/latency.js'
import * as routesModule from '../src/routes.js'
import { searchSearxng } from '../src/backends/searxng.js'
import { searchWikipedia } from '../src/backends/wikipedia.js'
import { resolveConfig, KNOWN_BACKENDS } from '../src/config.js'
import { FREE_SEARCH_PROVIDER_ID, FreeSearchProvider, runOneBackend } from '../src/provider.js'

let passed = 0
let failed = 0

/** Run one named assertion, recording the outcome instead of throwing out of the suite. */
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

/** Minimal response stand-in; the HTTP layer only uses status/headers/text/url. */
function stubResponse({ status = 200, body = '', url, headers = {} }) {
  return {
    status,
    headers,
    url: url ?? '',
    text: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

/**
 * Identify a SearxNG request precisely.
 *
 * `url.includes('/search?')` is NOT precise enough: Bing's and Google's endpoints
 * are also `/search`. `format=json` is the one parameter only the SearxNG backend
 * sends.
 *
 * @param url - the request URL.
 * @returns true when this is a SearxNG request.
 */
function isSearxngRequest(url) {
  return url.includes('format=json') && !url.includes('api.php')
}

/**
 * Install a transport stub that routes by URL.
 *
 * The stub is installed at `http.js`'s single-request seam rather than on
 * `globalThis.fetch`, because the HTTP layer is built on `node:http` (it has to
 * be, to support per-request proxies without `undici`). `requestText`'s own
 * redirect, deadline and error-classification logic therefore stays real in every
 * test below — only the socket is replaced.
 *
 * @param routes - array of `{ match, respond }`; the first match wins.
 * @returns a recorder of every request made, for assertions about method/body.
 */
function installFetch(routes) {
  const calls = []
  __setTransportForTests(async (url, options = {}) => {
    const href = String(url)
    calls.push({ url: href, init: options })
    for (const route of routes) {
      if (route.match(href)) return route.respond(href, options)
    }
    throw new Error(`stub transport: no route for ${href}`)
  })
  return calls
}

/** Restore the real transport. */
function restoreTransport() {
  __setTransportForTests(undefined)
}

/**
 * Drive a route handler with a fake request/response pair.
 *
 * The request must be a real Readable, because the handler reads POST bodies as a
 * stream — a plain object with `on` would not do.
 *
 * @param handler - the route handler.
 * @param method - HTTP method.
 * @param url - the request path.
 * @param overrides - `{ remoteAddress, host, clientHeader }`.
 * @param body - raw request body.
 * @returns `{ status, body, raw }`.
 */
async function callRoute(handler, method, url, overrides = {}, body = '') {
  const { Readable } = await import('node:stream')
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body)])
  const headers = { host: overrides.host ?? '127.0.0.1:19387' }
  if (overrides.clientHeader !== null) headers['x-dsh-free-web-search'] = overrides.clientHeader ?? '1'
  Object.assign(stream, {
    url,
    method,
    headers,
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
  })
  let status = 0
  let raw = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      raw = typeof chunk === 'string' ? chunk : String(chunk ?? '')
    },
  }
  await handler(stream, res)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  return { status, body: parsed, raw }
}

/**
 * A transport stub that never resolves on its own, and rejects when the request
 * is aborted — the behaviour a real request has against a black-holed host.
 *
 * Two details matter, and both were learned by getting them wrong:
 *
 *   - It must honour `signal`. Otherwise the deadline is ignored and the timeout
 *     assertions would pass for the wrong reason.
 *   - It must hold the event loop open. A bare pending promise is not a handle,
 *     and the deadline's timer does not hold the loop either, so Node would exit
 *     before the abort ever fired. The backstop timer below is deliberately *not*
 *     unref'd: it stands in for the socket a real request would have open.
 *
 * @param signal - the request's abort signal.
 * @param backstopMs - when to give up if no abort ever arrives.
 * @returns a promise that settles only by rejecting.
 */
function hangUntilAborted(signal, backstopMs = 5000) {
  return new Promise((_resolve, reject) => {
    let settled = false
    let timer
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    timer = setTimeout(() => fail(new Error('stub backstop: the request was never aborted')), backstopMs)
    if (signal === undefined || signal === null) return
    if (signal.aborted) {
      fail(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      return
    }
    signal.addEventListener('abort', () => fail(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true })
  })
}

const originalFetch = globalThis.fetch

/**
 * Guard: the suite must never write to the *real* `$DSH_HOME`.
 *
 * The settings tests read and write `$DSH_HOME/dsh-free-web-search/settings.json`.
 * When one of them accidentally resolved the real home, it overwrote the user's
 * actual configuration — replacing their configured proxy with an explicit
 * "direct" — and nothing failed, because the test only inspected the route's
 * response. The user's live plugin then silently stopped using its proxy.
 *
 * So the real settings file is fingerprinted here and re-checked at the end of the
 * suite. Any test that needs the settings file must point `DSH_HOME` at a temp
 * directory first.
 */
const REAL_HOME = resolveHome(process.env)
const REAL_SETTINGS = path.join(REAL_HOME, 'dsh-free-web-search', 'settings.json')

/** Fingerprint the real settings file: absent, or its exact contents. */
function snapshotRealSettings() {
  try {
    return fs.readFileSync(REAL_SETTINGS, 'utf8')
  } catch {
    return null
  }
}

const REAL_SETTINGS_BEFORE = snapshotRealSettings()

/**
 * Isolate the whole suite from the real `$DSH_HOME`.
 *
 * `resolveHome(env)` reads the env object it is **passed**, and only falls back to
 * `os.homedir()/.dsh` when that object carries no `DSH_HOME`. So a call like
 * `resolveConfig(x, {})` reads the *real* home — meaning every such call in this
 * file was silently reading the developer's own `settings.json`. Once that file
 * pins `backends`, it overrides whatever a test asks for, and the failures look
 * like code bugs when they are not.
 *
 * `TEST_ENV` is therefore passed to every `resolveConfig` call here, and
 * `process.env` is redirected as well for code that reads it directly. The real
 * file is fingerprinted above and re-checked at the end.
 */
const TEST_HOME = path.join(os.tmpdir(), `dsh-fws-smoke-${process.pid}-${Date.now()}`)
const ORIGINAL_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = TEST_HOME
fs.mkdirSync(TEST_HOME, { recursive: true })

/** An env object that can never resolve to the real home. */
const TEST_ENV = { DSH_HOME: TEST_HOME }

/** Restore the environment and remove the temp home. */
function restoreHome() {
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

console.log('\ndsh-free-web-search — offline smoke test\n')
console.log(`real DSH_HOME (must stay untouched): ${REAL_HOME}`)
console.log(`  settings file: ${REAL_SETTINGS_BEFORE === null ? '(absent)' : '(present)'}`)
console.log(`test DSH_HOME (isolated):            ${TEST_HOME}\n`)

console.log('html helpers')
await check('decodeEntities handles named, decimal and hex forms', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x27;e&#x27;'), "a & b <c> 'd' 'e'")
})
await check('decodeEntities leaves unknown and malformed references intact', () => {
  assert.equal(decodeEntities('&nosuchentity; &#xD800; &#0; &amp'), '&nosuchentity; &#xD800; &#0; &amp')
})
await check('decodeEntities returns empty for non-strings', () => {
  assert.equal(decodeEntities(undefined), '')
  assert.equal(decodeEntities(42), '')
})
await check('stripTags drops tags and collapses whitespace', () => {
  assert.equal(stripTags('<b>Hello</b>\n\n   <i>world</i>'), 'Hello world')
})
await check('stripTags does not resurrect an escaped tag as markup', () => {
  assert.equal(stripTags('&lt;script&gt;alert(1)&lt;/script&gt;'), '<script>alert(1)</script>')
})
await check('stripTags removes script and style content entirely', () => {
  assert.equal(stripTags('a<script>var x = 1</script>b'), 'a b')
})
await check('collectClassMatches matches exact class tokens only', () => {
  const html = '<a class="result__a">x</a><a class="result__a--mod">y</a><a class="z result__a">z</a>'
  assert.equal(collectClassMatches(html, 'result__a').length, 2)
})
await check('collectClassMatches reads attributes in any order and quoting', () => {
  const matches = collectClassMatches(`<a href='https://a.example/' class="result__a">a</a>`, 'result__a')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].href, 'https://a.example/')
})
await check('innerOf stops at the matching close tag', () => {
  const html = '<a class="x">inner</a>tail'
  const match = collectClassMatches(html, 'x')[0]
  assert.equal(innerOf(html, match), 'inner')
})
await check('innerOf caps a slice when no close tag exists', () => {
  const html = `<a class="x">${'y'.repeat(5000)}`
  const match = collectClassMatches(html, 'x')[0]
  assert.equal(innerOf(html, match).length, 1200)
})
await check('dedupeSources keeps the first occurrence of each URL', () => {
  const out = dedupeSources([{ url: 'a' }, { url: 'b' }, { url: 'a' }, { url: '' }, null])
  assert.deepEqual(out, [{ url: 'a' }, { url: 'b' }])
})

console.log('\nduckduckgo parsing')
await check('unwrapRedirect recovers the target from a protocol-relative redirector', () => {
  assert.equal(
    unwrapRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F&rut=x'),
    'https://nodejs.org/api/',
  )
})
await check('unwrapRedirect recovers the target from a bare-path redirector', () => {
  assert.equal(unwrapRedirect('/l/?uddg=https%3A%2F%2Fmdn.dev%2F'), 'https://mdn.dev/')
})
await check('unwrapRedirect passes an ordinary link through unchanged', () => {
  assert.equal(unwrapRedirect('https://example.com/plain'), 'https://example.com/plain')
})
await check('unwrapRedirect returns undefined when the target is missing', () => {
  assert.equal(unwrapRedirect('//duckduckgo.com/l/?rut=only-rut'), undefined)
  assert.equal(unwrapRedirect(''), undefined)
})
await check('isUsableResultUrl rejects non-http, DDG-internal and empty URLs', () => {
  assert.equal(isUsableResultUrl('https://example.com/'), true)
  assert.equal(isUsableResultUrl('ftp://example.com/'), false)
  assert.equal(isUsableResultUrl('https://duckduckgo.com/y.js'), false)
  assert.equal(isUsableResultUrl('https://html.duckduckgo.com/html/'), false)
  assert.equal(isUsableResultUrl('not a url'), false)
})
await check('parseResultsPage extracts titles, snippets and unwrapped URLs', () => {
  const sources = parseResultsPage(DDG_HTML_PAGE, { titleClass: 'result__a', snippetClass: 'result__snippet' })
  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://nodejs.org/api/', 'https://ads.example.com/promo', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', 'https://example.org/no-snippet'],
  )
  assert.equal(sources[0].title, 'Node.js API docs')
  assert.equal(sources[0].snippet, 'The official Node.js API reference & documentation.')
  assert.equal(sources[1].snippet, 'An advertisement that must not be treated as a result.')
  assert.equal(sources[2].title, 'MDN Web Docs — JavaScript')
  assert.equal(sources[3].snippet, undefined)
})
await check('parseResultsPage attaches each snippet to the nearest preceding title', () => {
  const sources = parseResultsPage(DDG_HTML_PAGE, { titleClass: 'result__a', snippetClass: 'result__snippet' })
  // The third result has no snippet of its own; it must not inherit the second's.
  assert.notEqual(sources[2].snippet, sources[1].snippet)
  assert.equal(sources[2].snippet, 'JavaScript (JS) is a lightweight interpreted language with first-class functions.')
})
await check('parseResultsPage handles the lite layout', () => {
  const sources = parseResultsPage(DDG_LITE_PAGE, { titleClass: 'result-link', snippetClass: 'result-snippet' })
  assert.equal(sources.length, 2)
  assert.equal(sources[0].url, 'https://www.rust-lang.org/')
  assert.equal(sources[0].title, 'Rust Programming Language')
  assert.equal(sources[0].snippet, 'A language empowering everyone to build reliable and efficient software.')
  assert.equal(sources[1].url, 'https://en.wikipedia.org/wiki/Rust_(programming_language)')
})
await check('parseResultsPage returns nothing for a page with no results', () => {
  assert.deepEqual(parseResultsPage('<html><body>nothing here</body></html>', { titleClass: 'result__a', snippetClass: 'result__snippet' }), [])
})
await check('isBlocked detects status codes and the anomaly page', () => {
  assert.equal(isBlocked(202, ''), true)
  assert.equal(isBlocked(429, ''), true)
  assert.equal(isBlocked(403, ''), true)
  assert.equal(isBlocked(200, DDG_BLOCK_PAGE), true)
  assert.equal(isBlocked(200, DDG_HTML_PAGE), false)
})

console.log('\nduckduckgo backend')
await check('falls back to the lite endpoint when html is blocked', async () => {
  const calls = installFetch([
    { match: (url) => url.includes('html.duckduckgo.com'), respond: () => stubResponse({ status: 202, body: DDG_BLOCK_PAGE }) },
    { match: (url) => url.includes('lite.duckduckgo.com'), respond: () => stubResponse({ status: 200, body: DDG_LITE_PAGE }) },
  ])
  const { sources, usedEndpoint } = await searchDuckDuckGo('rust', { timeoutMs: 5000 })
  assert.equal(usedEndpoint, 'lite')
  assert.equal(sources.length, 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.body, 'q=rust&kl=wt-wt')
})
await check('reports every endpoint failure when all are blocked', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 429, body: 'slow down' }) }])
  await assert.rejects(
    () => searchDuckDuckGo('rust', { timeoutMs: 5000 }),
    (error) => error.message.includes('blocked by DuckDuckGo') && error.message.includes('html') && error.message.includes('lite'),
  )
})
await check('names a layout change when a 200 page yields no results', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: '<html><body>redesigned</body></html>' }) }])
  await assert.rejects(() => searchDuckDuckGo('rust', { timeoutMs: 5000 }), /layout may have changed/)
})
await check('rethrows a cancellation instead of trying the next endpoint', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  installFetch([
    {
      match: () => {
        calls += 1
        return true
      },
      respond: () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    },
  ])
  await assert.rejects(() => searchDuckDuckGo('rust', { timeoutMs: 5000, signal: controller.signal }), (error) => error.kind === 'aborted')
  // An already-aborted signal short-circuits before the socket is opened, so the
  // lite endpoint is never attempted. The point of the assertion is that the
  // second endpoint was not tried; zero requests is the strongest form of that.
  assert.ok(calls <= 1, `expected at most one request, saw ${calls}`)
})

console.log('\nbing parsing')
await check('decodeBase64Url handles the url-safe alphabet and missing padding', () => {
  // 'https://a.example/' in base64url, unpadded.
  assert.equal(decodeBase64Url('aHR0cHM6Ly9hLmV4YW1wbGUv'), 'https://a.example/')
  // The url-safe alphabet: '-' and '_' must be translated, not rejected.
  assert.equal(decodeBase64Url('aHR0cHM6Ly9hLmV4YW1wbGUvP3g9Pg'), 'https://a.example/?x=>')
  assert.equal(decodeBase64Url(''), undefined)
  assert.equal(decodeBase64Url(undefined), undefined)
})
await check('unwrapBingRedirect recovers the target from a ck/a tracker', () => {
  const href = 'https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9ub2RlanMub3JnL2FwaS8&ntb=1'
  assert.equal(unwrapBingRedirect(href), 'https://nodejs.org/api/')
})
await check('unwrapBingRedirect passes a plain link through unchanged', () => {
  assert.equal(unwrapBingRedirect('https://example.com/plain'), 'https://example.com/plain')
  assert.equal(unwrapBingRedirect('//example.com/protocol-relative'), 'https://example.com/protocol-relative')
})
await check('unwrapBingRedirect returns undefined for a tracker with no target', () => {
  assert.equal(unwrapBingRedirect('https://www.bing.com/ck/a?!&&p=ad999&u='), undefined)
  assert.equal(unwrapBingRedirect('https://www.bing.com/ck/a?!&&p=ad999'), undefined)
  assert.equal(unwrapBingRedirect(''), undefined)
})
await check('unwrapBingRedirect survives a payload that is not valid base64', () => {
  // Must not throw, and must not invent a URL.
  assert.equal(unwrapBingRedirect('https://www.bing.com/ck/a?u=!!!!not-base64!!!!'), undefined)
})
await check('isUsableBingResultUrl rejects Bing-internal hosts and paths', () => {
  assert.equal(isUsableBingResultUrl('https://nodejs.org/api/'), true)
  assert.equal(isUsableBingResultUrl('https://www.bing.com/search?q=x'), false)
  assert.equal(isUsableBingResultUrl('https://cn.bing.com/'), false)
  assert.equal(isUsableBingResultUrl('https://www.bing.com/maps?q=x'), false)
  assert.equal(isUsableBingResultUrl('https://www.bing.com/images/search?q=x'), false)
  assert.equal(isUsableBingResultUrl('ftp://example.com/'), false)
  assert.equal(isUsableBingResultUrl('not a url'), false)
})
await check('parseBingResults extracts titles, snippets and unwrapped URLs', () => {
  const sources = parseBingResults(BING_PAGE)
  assert.deepEqual(
    sources.map((source) => source.url),
    [
      'https://nodejs.org/api/',
      'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
      'https://www.python.org/',
    ],
  )
  assert.equal(sources[0].title, 'Node.js API docs')
  assert.equal(sources[0].snippet, 'The official Node.js API reference & documentation.')
  assert.equal(sources[1].title, 'MDN Web Docs — JavaScript')
  assert.equal(sources[2].title, 'Welcome to Python.org')
})
await check('parseBingResults drops the ad and the internal Bing link', () => {
  const urls = parseBingResults(BING_PAGE).map((source) => source.url)
  assert.ok(!urls.some((url) => url.includes('bing.com')), 'no bing.com link may be reported')
  assert.ok(!urls.some((url) => url.includes('ads')), 'the untargeted tracker must be dropped')
})
await check('parseBingResults falls back to the paragraph when no caption class exists', () => {
  const python = parseBingResults(BING_PAGE).find((source) => source.url === 'https://www.python.org/')
  assert.equal(python.snippet, 'The official home of the Python Programming Language.')
})
await check('parseBingResults does not pick up links outside a b_algo block', () => {
  const urls = parseBingResults(BING_PAGE).map((source) => source.url)
  assert.ok(!urls.includes('https://www.bing.com/search?q=related'), 'the aside "related searches" link must be ignored')
  assert.equal(urls.length, 3)
})
await check('parseBingResults returns nothing for a page with no results', () => {
  assert.deepEqual(parseBingResults('<html><body>nothing</body></html>'), [])
  assert.deepEqual(parseBingResults(BING_REDESIGNED_PAGE), [])
})
await check('isBingBlocked detects status codes and the captcha page', () => {
  assert.equal(isBingBlocked(429, ''), true)
  assert.equal(isBingBlocked(403, ''), true)
  assert.equal(isBingBlocked(503, ''), true)
  assert.equal(isBingBlocked(200, BING_BLOCK_PAGE), true)
  assert.equal(isBingBlocked(200, BING_PAGE), false)
})
await check('isBingBlocked does not call a real result page blocked', () => {
  // A page containing b_results is a result page even if it mentions captcha
  // elsewhere (Bing ships a hidden captcha form on ordinary pages).
  assert.equal(isBingBlocked(200, '<html><div id="b_results"></div><form id="captcha"></form></html>'), false)
})

console.log('\nbing backend')
await check('requests the search endpoint and parses the page', async () => {
  const calls = installFetch([{ match: (url) => url.includes('bing.com/search'), respond: () => stubResponse({ status: 200, body: BING_PAGE }) }])
  const { sources, usedEndpoint } = await searchBing('node', { timeoutMs: 5000, limit: 5 })
  assert.equal(usedEndpoint, 'bing')
  assert.equal(sources.length, 3)
  const requested = new URL(calls[0].url)
  assert.equal(requested.searchParams.get('q'), 'node')
  assert.equal(requested.searchParams.get('count'), '5')
  assert.equal(calls[0].init.method, 'GET')
})
await check('reports a captcha interstitial distinctly from a network failure', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: BING_BLOCK_PAGE }) }])
  await assert.rejects(() => searchBing('node', { timeoutMs: 5000 }), /blocked by Bing/)
})
await check('names a layout change when a 200 page yields no results', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: BING_REDESIGNED_PAGE }) }])
  await assert.rejects(() => searchBing('node', { timeoutMs: 5000 }), /layout may have changed/)
})
await check('reports a non-2xx status', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 500, body: 'boom' }) }])
  await assert.rejects(() => searchBing('node', { timeoutMs: 5000 }), /HTTP 500/)
})
await check('propagates a cancellation rather than reporting it as a Bing failure', async () => {
  const controller = new AbortController()
  controller.abort()
  installFetch([{ match: () => true, respond: (_url, init) => hangUntilAborted(init?.signal) }])
  await assert.rejects(() => searchBing('node', { timeoutMs: 5000, signal: controller.signal }), (error) => error.kind === 'aborted')
})
await check('skips immediately when the shared budget is already spent', async () => {
  const calls = installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: BING_PAGE }) }])
  await assert.rejects(
    () => searchBing('node', { timeoutMs: 5000, deadline: Date.now() - 1 }),
    /search budget was exhausted/,
  )
  assert.equal(calls.length, 0, 'no request may be made once the budget is gone')
})

console.log('\ngoogle parsing')
await check('unwrapGoogleRedirect recovers the target from a /url?q= shim', () => {
  assert.equal(unwrapGoogleRedirect('/url?q=https://nodejs.org/api/&sa=U&ved=xyz'), 'https://nodejs.org/api/')
  assert.equal(unwrapGoogleRedirect('https://www.google.com/url?q=https%3A%2F%2Fmdn.dev%2F&sa=U'), 'https://mdn.dev/')
})
await check('unwrapGoogleRedirect passes a plain link through unchanged', () => {
  assert.equal(unwrapGoogleRedirect('https://example.com/plain'), 'https://example.com/plain')
  assert.equal(unwrapGoogleRedirect('//example.com/x'), 'https://example.com/x')
  assert.equal(unwrapGoogleRedirect(''), undefined)
})
await check('isUsableGoogleResultUrl rejects Google-internal hosts', () => {
  assert.equal(isUsableGoogleResultUrl('https://nodejs.org/'), true)
  assert.equal(isUsableGoogleResultUrl('https://www.google.com/search?q=x'), false)
  assert.equal(isUsableGoogleResultUrl('https://encrypted-tbn0.gstatic.com/x.png'), false)
  assert.equal(isUsableGoogleResultUrl('https://www.googleadservices.com/pagead/x'), false)
  assert.equal(isUsableGoogleResultUrl('not a url'), false)
})
await check('parseGoogleResults extracts the h3 title and the snippet', () => {
  const html = `
    <div class="g"><a href="/url?q=https://nodejs.org/api/&sa=U"><h3>Node.js API docs</h3></a>
      <div><span>The official Node.js API reference and documentation for the runtime.</span></div></div>
    <div class="g"><a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript"><h3>MDN &mdash; JavaScript</h3></a>
      <div><span>JavaScript (JS) is a lightweight interpreted programming language.</span></div></div>`
  const sources = parseGoogleResults(html)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].url, 'https://nodejs.org/api/')
  assert.equal(sources[0].title, 'Node.js API docs')
  assert.match(sources[0].snippet, /official Node\.js API reference/)
  assert.equal(sources[1].title, 'MDN — JavaScript')
})
await check('parseGoogleResults skips Google-internal links', () => {
  const html = `<div class="g"><a href="https://www.google.com/preferences"><h3>Settings</h3></a></div>`
  assert.deepEqual(parseGoogleResults(html), [])
})
await check('parseGoogleResults returns nothing for a page with no results', () => {
  assert.deepEqual(parseGoogleResults('<html><body>nothing</body></html>'), [])
})
await check('isGoogleBlocked detects the consent wall and the sorry page', () => {
  assert.equal(isGoogleBlocked(429, ''), true)
  assert.equal(isGoogleBlocked(200, GOOGLE_CONSENT_PAGE), true)
  assert.equal(isGoogleBlocked(200, '<html><body>https://www.google.com/sorry/index?continue=x</body></html>'), true)
  assert.equal(isGoogleBlocked(200, '<html><body>our systems have detected unusual traffic</body></html>'), true)
  assert.equal(isGoogleBlocked(200, '<div class="g"><h3>a result</h3></div>'), false)
})
await check('isGoogleJavaScriptShell detects the JS-only shell Google actually served', () => {
  // Measured through a working proxy: HTTP 200, ~93KB, 2 divs, 0 h3, 0 div.g.
  // Reporting this as "layout may have changed" would send the user to fix the
  // wrong thing, so it is detected as its own outcome.
  assert.equal(isGoogleJavaScriptShell(GOOGLE_JS_SHELL), true)
})
await check('isGoogleJavaScriptShell does not flag a real result page', () => {
  const real = '<div class="g"><a href="https://x.org/"><h3>Title</h3></a><div><span>A long enough snippet of text here.</span></div></div>'.repeat(30)
  assert.equal(isGoogleJavaScriptShell(real), false)
  assert.equal(isGoogleJavaScriptShell(''), false)
  assert.equal(isGoogleJavaScriptShell(undefined), false)
  // A page with headings but few divs is still a result page.
  assert.equal(isGoogleJavaScriptShell('<h3>Title</h3>'), false)
})
await check('a JS shell is reported as such, not as a layout change', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: GOOGLE_JS_SHELL }) }])
  await assert.rejects(
    () => searchGoogle('node', { timeoutMs: 5000 }),
    (error) => {
      assert.match(error.message, /JavaScript-only page/)
      assert.ok(!/layout may have changed/.test(error.message), 'must not be mislabelled as a layout change')
      return true
    },
  )
})
await check('the JS-shell message mentions the proxy only when one is in use', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: GOOGLE_JS_SHELL }) }])
  await assert.rejects(() => searchGoogle('node', { timeoutMs: 5000 }), /Configuring a proxy may change/)
  const proxy = parseProxy('http://127.0.0.1:7890')
  await assert.rejects(
    () => searchGoogle('node', { timeoutMs: 5000, proxy }),
    /A proxy is already in use/,
  )
})

console.log('\ngoogle backend')
await check('requests the search endpoint and parses the page', async () => {
  const calls = installFetch([
    {
      match: (url) => url.includes('google.com/search'),
      respond: () =>
        stubResponse({
          status: 200,
          body: '<div class="g"><a href="https://nodejs.org/api/"><h3>Node.js API docs</h3></a><div><span>The official Node.js API reference and documentation for the runtime.</span></div></div>',
        }),
    },
  ])
  const { sources, usedEndpoint } = await searchGoogle('node', { timeoutMs: 5000, limit: 5 })
  assert.equal(usedEndpoint, 'google')
  assert.equal(sources.length, 1)
  const requested = new URL(calls[0].url)
  assert.equal(requested.searchParams.get('q'), 'node')
  assert.equal(requested.searchParams.get('num'), '7')
})
await check('names the proxy in the error when a proxy was used', async () => {
  installFetch([{ match: () => true, respond: () => { throw Object.assign(new Error('ECONNREFUSED'), { kind: 'network' }) } }])
  const proxy = parseProxy('http://127.0.0.1:7890')
  await assert.rejects(
    () => searchGoogle('node', { timeoutMs: 5000, proxy }),
    (error) => /via proxy http:\/\/127\.0\.0\.1:7890/.test(error.message),
  )
})
await check('reports a consent wall distinctly from a network failure', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: '<html>consent.google.com</html>' }) }])
  await assert.rejects(() => searchGoogle('node', { timeoutMs: 5000 }), /blocked by Google/)
})

console.log('\nbaidu parsing')
await check('parseBaiduResults reads the real target from the mu attribute', () => {
  const html = `
    <div class="result c-container new-pmd" mu="https://www.deepseek.com/harness/" id="1">
      <h3><a href="http://www.baidu.com/link?url=abc">DeepSeek Harness 官网</a></h3>
      <div class="c-abstract">DeepSeek Harness 是一个把一切都做成插件的智能体宿主。</div>
    </div>
    <div class="result-op c-container new-pmd" mu="http://nourl.ubs.baidu.com/62631" id="2">
      <h3><a href="#">反馈</a></h3><div class="c-abstract">内部反馈组件</div>
    </div>`
  const sources = parseBaiduResults(html)
  assert.equal(sources.length, 1, 'the internal ubs.baidu.com widget must be dropped')
  assert.equal(sources[0].url, 'https://www.deepseek.com/harness/')
  assert.equal(sources[0].title, 'DeepSeek Harness 官网')
  assert.match(sources[0].snippet, /插件/)
})
await check('parseBaiduResults ignores c-container mentions inside CSS and feedback forms', () => {
  // Measured on a real page: `c-container` appears 105 times, mostly in embedded
  // CSS and in a feedback widget that has no mu= attribute.
  const html = `
    <style>.c-container table.result{width:100%}.c-container td.f{font-size:13px}</style>
    <h3 class="cosc-title">上一条搜索内容，你觉得满意吗？</h3>
    <div class="result c-container" mu="https://example.org/real"><h3><a href="#">Real</a></h3></div>`
  const sources = parseBaiduResults(html)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, 'https://example.org/real')
})
await check('parseBaiduResults prefers the data-tools title', () => {
  const html = `<div class="result c-container" mu="https://example.org/a">
      <h3><a href="#" data-tools="{&quot;title&quot;:&quot;From data-tools&quot;,&quot;url&quot;:&quot;http://www.baidu.com/link?url=x&quot;}"><span>From the anchor</span></a></h3>
    </div>`
  const sources = parseBaiduResults(html)
  assert.equal(sources[0].title, 'From data-tools')
})
await check('unwrapBaiduRedirect drops an unresolvable /link redirector', () => {
  // The token is opaque and only resolves via a 302, so citing it would mean
  // citing a baidu.com tracking URL. It must be dropped, not reported.
  assert.equal(unwrapBaiduRedirect('http://www.baidu.com/link?url=abc'), undefined)
  assert.equal(unwrapBaiduRedirect('https://www.deepseek.com/harness/'), 'https://www.deepseek.com/harness/')
})
await check('isUsableBaiduResultUrl rejects internal and ad hosts', () => {
  assert.equal(isUsableBaiduResultUrl('https://github.com/deepseek-ai/'), true)
  assert.equal(isUsableBaiduResultUrl('https://baike.baidu.com/item/x'), false)
  assert.equal(isUsableBaiduResultUrl('http://28616.recommend_list.baidu.com'), false)
  assert.equal(isUsableBaiduResultUrl('https://www.baidu.com/s?wd=x'), false)
  assert.equal(isUsableBaiduResultUrl('https://www.baidu.com/link?url=x'), false)
})
await check('isBaiduBlocked detects the verification page', () => {
  assert.equal(isBaiduBlocked(429, ''), true)
  assert.equal(isBaiduBlocked(200, '<html>wappass.baidu.com/static/captcha</html>'), true)
  assert.equal(isBaiduBlocked(200, '<html>安全验证</html>'), true)
  assert.equal(isBaiduBlocked(200, '<div class="result c-container" mu="https://x.org/">ok</div>'), false)
})

console.log('\nbaidu backend')
await check('requests the search endpoint with utf-8 pinned', async () => {
  const calls = installFetch([
    {
      match: (url) => url.includes('baidu.com/s'),
      respond: () =>
        stubResponse({
          status: 200,
          body: '<div class="result c-container" mu="https://example.org/a"><h3><a href="#">Title</a></h3><div class="c-abstract">A sufficiently long abstract for the snippet field.</div></div>',
        }),
    },
  ])
  const { sources } = await searchBaidu('测试', { timeoutMs: 5000, limit: 5 })
  assert.equal(sources.length, 1)
  const requested = new URL(calls[0].url)
  assert.equal(requested.searchParams.get('wd'), '测试')
  assert.equal(requested.searchParams.get('ie'), 'utf-8')
})
await check('reports a verification page distinctly', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: '<html>wappass.baidu.com</html>' }) }])
  await assert.rejects(() => searchBaidu('x', { timeoutMs: 5000 }), /blocked by Baidu/)
})

console.log('\nyandex parsing')
await check('isYandexBlocked detects the captcha page that was actually observed', () => {
  // Measured: yandex.com/search answered HTTP 200 with a 14KB body containing
  // CheckboxCaptcha and zero serp-item markers. Reporting that as "layout may
  // have changed" would be actively misleading.
  const captcha = '<html><body><form id="checkbox-captcha-form" class="CheckboxCaptcha"><div class="CheckboxCaptcha-Button">I am not a robot</div></form></body></html>'
  assert.equal(isYandexBlocked(200, captcha), true)
  assert.equal(isYandexBlocked(200, '<div class="serp-item">a result</div>'), false)
  assert.equal(isYandexBlocked(429, ''), true)
})
await check('parseYandexResults extracts a serp-item with its title and snippet', () => {
  const html = `
    <div class="serp-item">
      <a class="OrganicTitle-Link" href="https://example.org/a">Example title</a>
      <span class="OrganicTextContentSpan">A sufficiently long snippet describing the example page in detail.</span>
    </div>
    <div class="serp-item">
      <a class="OrganicTitle-Link" href="https://yandex.com/images/x">Internal</a>
      <span class="OrganicTextContentSpan">This internal link must be dropped from the results.</span>
    </div>`
  const sources = parseYandexResults(html)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, 'https://example.org/a')
  assert.equal(sources[0].title, 'Example title')
  assert.match(sources[0].snippet, /sufficiently long snippet/)
})
await check('parseYandexResults returns nothing for a page with no serp items', () => {
  assert.deepEqual(parseYandexResults('<html><body>nothing</body></html>'), [])
})
await check('yandex reports its captcha with an explicit warning', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: '<form class="CheckboxCaptcha"></form>' }) }])
  await assert.rejects(() => searchYandex('x', { timeoutMs: 5000 }), /captcha challenge — Yandex shows this to most automated clients/)
})

console.log('\nproxy parsing')
await check('parses http, https, socks5 and socks5h proxies', () => {
  assert.deepEqual(parseProxy('http://127.0.0.1:7890'), { protocol: 'http', host: '127.0.0.1', port: 7890, auth: undefined })
  assert.equal(parseProxy('https://proxy.example:8443').protocol, 'https')
  assert.equal(parseProxy('socks5://127.0.0.1:1080').protocol, 'socks5')
  assert.equal(parseProxy('socks5h://127.0.0.1:1080').protocol, 'socks5h')
})
await check('accepts a bare host:port and defaults to the conventional port', () => {
  assert.deepEqual(parseProxy('127.0.0.1:8080'), { protocol: 'http', host: '127.0.0.1', port: 8080, auth: undefined })
  // 1080 is the conventional SOCKS port, 8080 the conventional HTTP one.
  assert.equal(parseProxy('socks5://proxy.example').port, 1080)
  assert.equal(parseProxy('http://proxy.example').port, 8080)
})
await check('parses credentials and decodes them', () => {
  const proxy = parseProxy('http://user%40corp:p%40ss@proxy.example:3128')
  assert.deepEqual(proxy.auth, { username: 'user@corp', password: 'p@ss' })
})
await check('rejects unsupported or malformed proxies', () => {
  assert.equal(parseProxy('socks4://127.0.0.1:1080'), undefined, 'socks4 is deliberately unsupported')
  assert.equal(parseProxy('ftp://127.0.0.1:21'), undefined)
  assert.equal(parseProxy(''), undefined)
  assert.equal(parseProxy(undefined), undefined)
  assert.equal(parseProxy('http://host:99999'), undefined)
})
await check('the proxy policy applies the default, then per-backend overrides', () => {
  const policy = createProxyPolicy({ url: 'http://default:8080', perBackend: { baidu: 'direct', google: 'socks5://g:1080' } })
  assert.equal(policy.for('bing').host, 'default')
  assert.equal(policy.for('baidu'), undefined, 'an explicit direct must bypass the default')
  assert.equal(policy.for('google').protocol, 'socks5')
})
await check('the proxy policy honours noProxy by exact host and parent domain', () => {
  const policy = createProxyPolicy({ url: 'http://default:8080', noProxy: ['example.com', 'exact.test'] })
  assert.equal(policy.for('bing', 'example.com'), undefined)
  assert.equal(policy.for('bing', 'api.example.com'), undefined, 'a parent-domain entry must cover subdomains')
  assert.equal(policy.for('bing', 'exact.test'), undefined)
  assert.equal(policy.for('bing', 'notexample.com'), policy.default, 'a suffix match must not be a substring match')
})
await check('matchesNoProxy supports the wildcard and strips a leading dot', () => {
  assert.equal(matchesNoProxy('anything.test', ['*']), true)
  assert.equal(matchesNoProxy('api.example.com', ['.example.com']), true)
  assert.equal(matchesNoProxy('example.com', ['example.org']), false)
})
await check('a malformed per-backend proxy is ignored, not fatal', () => {
  const policy = createProxyPolicy({ url: 'http://default:8080', perBackend: { bing: 'not a proxy url with spaces' } })
  // The bad entry is skipped, so bing falls back to the default rather than
  // silently going direct (which would look like a proxy failure).
  assert.equal(policy.for('bing').host, 'default')
})
await check('proxyFromEnvironment reads the conventional variable names', () => {
  assert.equal(proxyFromEnvironment({ HTTPS_PROXY: 'http://a:1' }).url, 'http://a:1')
  assert.equal(proxyFromEnvironment({ https_proxy: 'http://b:2' }).url, 'http://b:2')
  assert.equal(proxyFromEnvironment({ ALL_PROXY: 'socks5://c:3' }).url, 'socks5://c:3')
  // The plugin-specific name wins, so it can override an ambient proxy.
  assert.equal(proxyFromEnvironment({ DSH_FREE_WEB_SEARCH_PROXY: 'http://d:4', HTTPS_PROXY: 'http://a:1' }).url, 'http://d:4')
  assert.deepEqual(proxyFromEnvironment({ NO_PROXY: 'a.com, b.com' }).noProxy, ['a.com', 'b.com'])
})

console.log('\nprovider control')
await check('reports which provider is active, and that nothing is overridden', () => {
  const web = { searchProviders: new Map([['deepseek-official', {}], ['free-web', {}]]), searchProviderId: undefined }
  const control = createProviderControl({ getWeb: () => web, logger: {} })
  assert.equal(control.isFreeActive(), false)
  assert.equal(control.current(), undefined, 'an unconfigured seam has no explicit id')
  assert.equal(control.hasOfficial(), true)
  assert.deepEqual([...control.registered()].sort(), ['deepseek-official', 'free-web'])
})
await check('setDefault() selects this plugin and persists the choice', () => {
  const web = { searchProviders: new Map(), searchProviderId: undefined }
  const control = createProviderControl({ getWeb: () => web, logger: {} })
  const result = control.setDefault()
  assert.equal(result.ok, true)
  assert.equal(web.searchProviderId, 'free-web')
  assert.equal(control.isFreeActive(), true)
})
await check('restoreOfficial() clears the override rather than naming an id', () => {
  // Naming `deepseek-official` would raise WEB_PROVIDER_CONFIGURED_MISSING in a
  // composition that never registered it, so restoring must clear instead.
  const web = { searchProviders: new Map(), searchProviderId: 'free-web' }
  const control = createProviderControl({ getWeb: () => web, logger: {} })
  const result = control.restoreOfficial()
  assert.equal(result.ok, true)
  assert.equal(web.searchProviderId, undefined, 'the id must be cleared, not set to a literal')
  assert.equal(result.restored, null)
  assert.equal(control.isFreeActive(), false)
})
await check('restoreOfficial() puts back a pre-existing explicit choice', () => {
  // The value in effect before this plugin interfered must be remembered, not
  // assumed, because a composition may have been pointed elsewhere on purpose.
  const web = { searchProviders: new Map(), searchProviderId: 'deepseek-official' }
  const control = createProviderControl({ getWeb: () => web, logger: {} })
  control.setDefault()
  assert.equal(control.capturedOriginal(), 'deepseek-official')
  const result = control.restoreOfficial()
  assert.equal(result.restored, 'deepseek-official')
  assert.equal(web.searchProviderId, 'deepseek-official')
})
await check('a hot reload does not capture this plugin as its own original', () => {
  // After a reload the seam may still hold our id from the previous generation.
  // Recording that would make "restore official" restore *us*.
  const web = { searchProviders: new Map(), searchProviderId: 'free-web' }
  const control = createProviderControl({ getWeb: () => web, logger: {} })
  control.setDefault()
  assert.equal(control.capturedOriginal(), undefined, 'our own id must never be captured as the original')
  control.restoreOfficial()
  assert.equal(web.searchProviderId, undefined)
})
await check('applySaved() selects this plugin only when that choice was saved', () => {
  const web = { searchProviders: new Map(), searchProviderId: undefined }
  const control = createProviderControl({ getWeb: () => web, logger: {} })
  control.applySaved({ searchProvider: 'official' })
  assert.equal(web.searchProviderId, undefined, '"official" means "no override"')
  control.applySaved({ searchProvider: 'free-web' })
  assert.equal(web.searchProviderId, 'free-web')
})
await check('applySaved() ignores an empty settings object', () => {
  const web = { searchProviders: new Map(), searchProviderId: undefined }
  const control = createProviderControl({ getWeb: () => web, logger: {} })
  control.applySaved({})
  assert.equal(web.searchProviderId, undefined)
})
await check('hasOfficial() is false when only this plugin is registered', () => {
  const web = { searchProviders: new Map([['free-web', {}]]), searchProviderId: undefined }
  const control = createProviderControl({ getWeb: () => web, logger: {} })
  assert.equal(control.hasOfficial(), false)
})
await check('a missing seam is reported rather than throwing', () => {
  const control = createProviderControl({ getWeb: () => undefined, logger: {} })
  assert.equal(control.current(), undefined)
  assert.deepEqual(control.registered(), [])
  const result = control.setDefault()
  assert.equal(result.ok, false)
  assert.match(result.error, /seam is not available/)
})
await check('a throwing getWeb is tolerated', () => {
  const control = createProviderControl({
    getWeb: () => {
      throw new Error('boom')
    },
    logger: {},
  })
  assert.equal(control.current(), undefined)
  assert.equal(control.setDefault().ok, false)
})
await check('searchProvider accepts only free-web or official', () => {
  assert.deepEqual(normalizeSettings({ searchProvider: 'free-web' }).settings, { searchProvider: 'free-web' })
  assert.deepEqual(normalizeSettings({ searchProvider: 'official' }).settings, { searchProvider: 'official' })
  // An empty value is "no override", so the key is dropped entirely.
  assert.deepEqual(normalizeSettings({ searchProvider: '' }).settings, {})
  const bad = normalizeSettings({ searchProvider: 'deepseek-official' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /unknown searchProvider/)
})

console.log('\nlatency test')
await check('probe targets are service front doors with no query term', () => {
  // The whole point of the change: the test must send no query. Every path is "/",
  // and no target carries a search parameter.
  for (const [backend, target] of Object.entries(PROBE_TARGETS)) {
    assert.equal(target.path, '/', `${backend} must probe the bare host, not a search URL`)
    assert.ok(!target.host.includes('?'), `${backend} host must not carry a query`)
  }
  assert.equal(PROBE_TARGETS.google.host, 'www.google.com')
  assert.equal(PROBE_TARGETS.baidu.host, 'www.baidu.com')
})
await check('probeTargetFor uses the configured SearxNG instance', () => {
  const target = probeTargetFor('searxng', { searxngInstances: ['https://my.searx.example/'] })
  assert.equal(target.host, 'my.searx.example')
  assert.equal(target.path, '/')
  // With no usable instance there is nothing to probe, and that must be reported
  // rather than silently probing the wrong host.
  assert.equal(probeTargetFor('searxng', { searxngInstances: [] }), undefined)
  assert.equal(probeTargetFor('searxng', { searxngInstances: ['not a url'] }), undefined)
})
await check('probes a backend by connecting, and records the stage timings', async () => {
  // A real local TLS server stands in for the search service, so the probe path
  // (connect → TLS → HEAD) is genuinely exercised rather than stubbed.
  const origin = await startLocalTlsOrigin()
  try {
    const result = await probeLatency('bing', {
      timeoutMs: 8000,
      probeTargets: { bing: { host: '127.0.0.1', path: '/', port: origin.port } },
      ca: origin.cert,
    })
    assert.equal(result.status, 'ok', `expected ok, got ${result.status}: ${result.error ?? ''}`)
    assert.equal(typeof result.connectMs, 'number')
    assert.equal(typeof result.tlsMs, 'number')
    assert.equal(typeof result.totalMs, 'number')
    assert.ok(result.totalMs >= result.tlsMs, 'total must include the TLS handshake')
    assert.ok(result.tlsMs >= result.connectMs, 'the TLS handshake happens after connect')
    assert.equal(result.statusCode, 200)
  } finally {
    await origin.close()
  }
})
await check('classifies a connection refusal as unreachable, not as a generic error', async () => {
  // Port 1 on loopback refuses immediately, which is the realistic "the service is
  // not reachable from here" case.
  const result = await probeLatency('bing', {
    timeoutMs: 4000,
    probeTargets: { bing: { host: '127.0.0.1', path: '/', port: 1 } },
  })
  assert.equal(result.status, 'unreachable', `expected unreachable, got ${result.status}: ${result.error ?? ''}`)
  assert.ok(result.error.includes('127.0.0.1'))
})
await check('probes every backend and reports a per-backend result', async () => {
  const origin = await startLocalTlsOrigin()
  try {
    const options = resolveConfig({ backends: 'bing,baidu', timeoutMs: 5000 }, process.env)
    const report = await runLatencyTest({
      ...options,
      backends: ['bing', 'baidu'],
      timeoutMs: 5000,
      probeTargets: {
        bing: { host: '127.0.0.1', path: '/', port: origin.port },
        baidu: { host: '127.0.0.1', path: '/', port: origin.port },
      },
      ca: origin.cert,
    })
    assert.equal(report.results.length, 2)
    // Results come back in the requested order, not completion order.
    assert.deepEqual(report.results.map((r) => r.backend), ['bing', 'baidu'])
    for (const result of report.results) {
      assert.equal(result.status, 'ok')
      assert.equal(typeof result.totalMs, 'number')
    }
    assert.ok(report.best !== undefined, 'a best backend must be identified')
    assert.equal(report.suggestedOrder.length, 2)
  } finally {
    await origin.close()
  }
})
await check('reports a SearxNG backend with no configured instance instead of guessing', async () => {
  const result = await probeLatency('searxng', { timeoutMs: 2000, searxngInstances: [] })
  assert.equal(result.status, 'error')
  assert.match(result.error, /no usable SearxNG instance/)
})
await check('the report carries a caveat that reachability is not usability', () => {
  // Recommending a fast-but-unusable backend would be a harmful suggestion, and
  // this plugin has measured exactly that with Google.
  const { reasoning } = rank(
    [
      { backend: 'fast', status: 'ok', totalMs: 100 },
      { backend: 'slow', status: 'ok', totalMs: 900 },
    ],
    ['slow', 'fast'],
  )
  assert.ok(
    reasoning.some((line) => /reachability and latency only/i.test(line)),
    'the report must state that it measures reachability, not usability',
  )
  assert.ok(reasoning.some((line) => /JavaScript-only page/.test(line)), 'the caveat must name the measured cases')
})
await check('ranks by total latency among the backends that responded', () => {
  const { ranked, best, suggestedOrder } = rank(
    [
      { backend: 'slow', status: 'ok', totalMs: 900 },
      { backend: 'fast', status: 'ok', totalMs: 100 },
    ],
    ['slow', 'fast'],
  )
  assert.equal(ranked[0].backend, 'fast')
  assert.equal(best.backend, 'fast')
  assert.deepEqual(suggestedOrder, ['fast', 'slow'])
})
await check('ranks a failure below every success regardless of speed', () => {
  const { ranked, best } = rank(
    [
      { backend: 'fast-fail', status: 'unreachable', totalMs: 1 },
      { backend: 'slow-ok', status: 'ok', totalMs: 5000 },
    ],
    ['fast-fail', 'slow-ok'],
  )
  assert.equal(ranked[0].backend, 'slow-ok')
  assert.equal(best.backend, 'slow-ok')
  assert.equal(ranked[1].score, Number.POSITIVE_INFINITY)
})
await check('breaks a latency tie using the configured order', () => {
  const { ranked } = rank(
    [
      { backend: 'a', status: 'ok', totalMs: 200 },
      { backend: 'b', status: 'ok', totalMs: 200 },
    ],
    ['b', 'a'],
  )
  assert.equal(ranked[0].backend, 'b', 'a tie must keep the user\'s existing preference')
})
await check('reports whether the suggestion differs from the configured order', () => {
  const changed = rank(
    [
      { backend: 'slow', status: 'ok', totalMs: 900 },
      { backend: 'fast', status: 'ok', totalMs: 100 },
    ],
    ['slow', 'fast'],
  )
  assert.equal(changed.changed, true)
  assert.ok(changed.reasoning.some((line) => /suggestion only/i.test(line)))

  const same = rank(
    [
      { backend: 'fast', status: 'ok', totalMs: 100 },
      { backend: 'slow', status: 'ok', totalMs: 900 },
    ],
    ['fast', 'slow'],
  )
  assert.equal(same.changed, false)
  assert.ok(same.reasoning.some((line) => /already matches/.test(line)))
})
await check('explains an all-unreachable result as a connectivity problem', () => {
  const { reasoning, best } = rank(
    [
      { backend: 'a', status: 'timeout', totalMs: 500 },
      { backend: 'b', status: 'unreachable', totalMs: 300 },
    ],
    ['a', 'b'],
  )
  assert.equal(best, undefined)
  assert.ok(reasoning.some((line) => /connectivity or proxy problem/.test(line)))
})
await check('produces a config snippet without applying it', () => {
  const snippet = suggestConfigSnippet(['baidu', 'bing'], 'http://127.0.0.1:7890')
  assert.match(snippet, /backends: \['baidu', 'bing'\]/)
  assert.match(snippet, /proxy: 'http:\/\/127\.0\.0\.1:7890'/)
  const withoutProxy = suggestConfigSnippet(['bing'], '')
  assert.ok(!withoutProxy.includes('proxy:'))
})
await check('never mutates the configuration it was given', async () => {
  // The user asked for a measurement, not an automatic rewrite.
  const origin = await startLocalTlsOrigin()
  try {
    const options = resolveConfig({ backends: 'baidu,bing' }, process.env)
    const before = [...options.backends]
    await runLatencyTest({
      ...options,
      backends: [...options.backends],
      timeoutMs: 5000,
      probeTargets: {
        baidu: { host: '127.0.0.1', path: '/', port: origin.port },
        bing: { host: '127.0.0.1', path: '/', port: origin.port },
      },
      ca: origin.cert,
    })
    assert.deepEqual([...options.backends], before)
  } finally {
    await origin.close()
  }
})
await check('every backend forwards the proxy to the HTTP layer', async () => {
  // This is the regression that shipped once and was caught only by a live run
  // against a real proxy: `proxy` was threaded into google/bing/baidu/yandex but
  // not into searxng/duckduckgo/wikipedia, so those three silently went DIRECT and
  // timed out on any network where they are blocked. A unit test that stubs the
  // transport cannot notice that, because the stub answers either way — so this
  // asserts on what each backend actually passes down.
  const seen = []
  __setTransportForTests(async (url, options = {}) => {
    seen.push({ url: String(url), proxy: options.proxy })
    // Answer with something each backend can parse, so it reaches the HTTP layer.
    if (String(url).includes('format=json') && !String(url).includes('api.php')) {
      return stubResponse({ status: 200, body: SEARXNG_JSON })
    }
    if (String(url).includes('api.php') && String(url).includes('list=search')) {
      return stubResponse({ status: 200, body: WIKI_SEARCH_JSON })
    }
    if (String(url).includes('api.php')) return stubResponse({ status: 200, body: WIKI_DETAIL_JSON })
    if (String(url).includes('bing.com')) return stubResponse({ status: 200, body: BING_PAGE })
    if (String(url).includes('google.com')) return stubResponse({ status: 200, body: '<div class="g"><a href="https://x.org/"><h3>T</h3></a><div><span>A long enough snippet of text for the parser.</span></div></div>' })
    if (String(url).includes('baidu.com')) return stubResponse({ status: 200, body: '<div class="result c-container" mu="https://x.org/"><h3><a href="#">T</a></h3><div class="c-abstract">A long enough abstract for the snippet.</div></div>' })
    if (String(url).includes('yandex.com')) return stubResponse({ status: 200, body: '<div class="serp-item"><a class="OrganicTitle-Link" href="https://x.org/">T</a><span class="OrganicTextContentSpan">A long enough snippet of text here.</span></div>' })
    return stubResponse({ status: 200, body: DDG_HTML_PAGE })
  })

  const proxy = parseProxy('http://127.0.0.1:7899')
  const options = resolveConfig({ backends: 'searxng,google,bing,baidu,yandex,duckduckgo,wikipedia' }, TEST_ENV)
  for (const backend of options.backends) {
    seen.length = 0
    await runOneBackend(backend, 'node', { ...options, proxy, limit: 5, timeoutMs: 2000, wikipediaLang: 'en' })
    assert.ok(seen.length > 0, `${backend}: expected at least one request`)
    for (const call of seen) {
      assert.equal(
        call.proxy,
        proxy,
        `${backend} did not forward the proxy to ${call.url.slice(0, 60)} — it would go DIRECT and fail on a blocked network`,
      )
    }
  }
  restoreTransport()
})

console.log('\nrelevance guard')
await check('queryTerms drops stop words and short terms', () => {
  assert.deepEqual(queryTerms('What is the DeepSeek Harness for?'), ['deepseek', 'harness'])
  assert.deepEqual(queryTerms('a to of'), [])
  assert.deepEqual(queryTerms(''), [])
  assert.deepEqual(queryTerms(undefined), [])
})
await check('measureRelevance counts results mentioning any query term', () => {
  const sources = [
    { title: 'DeepSeek Harness docs', url: 'https://a.example/' },
    { title: 'Unrelated page', url: 'https://b.example/' },
    { title: 'Nothing here', snippet: 'about harness racing', url: 'https://c.example/' },
  ]
  const relevance = measureRelevance(sources, 'DeepSeek Harness')
  assert.equal(relevance.total, 3)
  assert.equal(relevance.matching, 2)
  assert.equal(relevance.checked, true)
})
await check('measureRelevance reports checked:false when no verdict is possible', () => {
  assert.equal(measureRelevance([{ title: 'x' }], 'a of the').checked, false)
  assert.equal(measureRelevance([], 'deepseek').checked, false)
})
await check('looksSubstituted flags a wholesale substitution', () => {
  // The measured case: 10 organic results, none about the query.
  const garbage = Array.from({ length: 10 }, (_, i) => ({
    title: `Michigan Online Casinos ${i}`,
    url: `https://casino${i}.example/`,
  }))
  assert.equal(looksSubstituted(garbage, 'DeepSeek Harness'), true)
})
await check('looksSubstituted passes a genuinely relevant result set', () => {
  const good = [
    { title: 'DeepSeek Harness | Explore the limits of intelligence', url: 'https://www.deepseek.com/harness/' },
    { title: 'GitHub - deepseek-ai/deepseek-harness', url: 'https://github.com/deepseek-ai/deepseek-harness' },
    { title: 'DeepSeek Harness 教程', url: 'https://www.runoob.com/' },
  ]
  assert.equal(looksSubstituted(good, 'DeepSeek Harness'), false)
})
await check('looksSubstituted is conservative about small result sets', () => {
  // One or two results is not enough evidence to call it substituted.
  assert.equal(looksSubstituted([{ title: 'Unrelated' }], 'DeepSeek Harness'), false)
  assert.equal(looksSubstituted([{ title: 'Unrelated' }, { title: 'Also unrelated' }], 'DeepSeek Harness'), false)
})
await check('looksSubstituted passes a partially relevant set', () => {
  const mixed = [
    { title: 'Unrelated one' },
    { title: 'Unrelated two' },
    { title: 'DeepSeek Harness docs' },
    { title: 'Unrelated three' },
  ]
  assert.equal(looksSubstituted(mixed, 'DeepSeek Harness'), false, 'one match is enough to keep the set')
})
await check('the relevance guard matches on the URL as well as the text', () => {
  const byUrl = [
    { title: 'No text match', url: 'https://example.com/deepseek-harness' },
    { title: 'Nothing', url: 'https://x.example/' },
    { title: 'Nothing', url: 'https://y.example/' },
  ]
  assert.equal(looksSubstituted(byUrl, 'DeepSeek Harness'), false)
})
await check('bing rejects a substituted response instead of returning it', async () => {
  // Reproduces the measured failure: the page is a valid Bing result page, but
  // every organic result is about something else.
  const garbagePage = `<html><body><ol id="b_results">
    ${Array.from({ length: 5 }, (_, i) => `<li class="b_algo"><h2><a href="https://casino${i}.example/">Michigan Online Casinos ${i}</a></h2><div class="b_caption"><p>Best MI poker sites and slots.</p></div></li>`).join('')}
  </ol></body></html>`
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: garbagePage }) }])
  await assert.rejects(
    () => searchBing('DeepSeek Harness', { timeoutMs: 5000 }),
    (error) => {
      assert.match(error.message, /looks substituted/)
      assert.match(error.message, /proxy or exit node/)
      return true
    },
  )
})
await check('duckduckgo rejects a substituted response on every endpoint', async () => {
  const garbagePage = `<html><body>
    ${Array.from({ length: 5 }, (_, i) => `<a class="result__a" href="https://casino${i}.example/">Michigan Online Casinos ${i}</a><a class="result__snippet">Best MI poker sites.</a>`).join('')}
  </body></html>`
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: garbagePage }) }])
  await assert.rejects(() => searchDuckDuckGo('DeepSeek Harness', { timeoutMs: 5000 }), /looks substituted/)
})
await check('a substituted backend lets the chain fall through to the next one', async () => {
  // The practical benefit: unrelated results are treated as a failure, so the
  // chain keeps trying rather than reporting them as an answer.
  const garbagePage = `<html><body><ol id="b_results">
    ${Array.from({ length: 5 }, (_, i) => `<li class="b_algo"><h2><a href="https://casino${i}.example/">Michigan Online Casinos ${i}</a></h2><div class="b_caption"><p>Best MI poker sites.</p></div></li>`).join('')}
  </ol></body></html>`
  installFetch([
    { match: isSearxngRequest, respond: () => stubResponse({ status: 502, body: 'down' }) },
    { match: (url) => url.includes('bing.com/search'), respond: () => stubResponse({ status: 200, body: garbagePage }) },
    { match: (url) => url.includes('html.duckduckgo.com'), respond: () => stubResponse({ status: 200, body: DDG_HTML_PAGE }) },
  ])
  const options = resolveConfig({ backends: 'searxng,bing,duckduckgo', timeoutMs: 3000, totalTimeoutMs: 9000 }, TEST_ENV)
  const provider = new FreeSearchProvider(() => options, () => undefined)
  const result = await provider.search({ query: 'node', maxResults: 5 })
  assert.ok(
    result.sources.some((source) => source.url === 'https://nodejs.org/api/'),
    'the chain must fall through to duckduckgo when bing returns substituted results',
  )
})

console.log('\nsearxng backend')
await check('walks past a failing instance to the next one', async () => {
  installFetch([
    { match: (url) => url.startsWith('https://bad.example'), respond: () => stubResponse({ status: 502, body: 'bad gateway' }) },
    { match: (url) => url.startsWith('https://good.example'), respond: () => stubResponse({ status: 200, body: SEARXNG_JSON }) },
  ])
  const { sources, usedInstance } = await searchSearxng('python', {
    instances: ['https://bad.example', 'https://good.example'],
    timeoutMs: 5000,
  })
  // The entry without a URL is skipped; the rest survive.
  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://www.python.org/', 'https://docs.python.org/3/', 'https://peps.python.org/'],
  )
  assert.equal(sources[0].publishedAt, '2024-01-02T00:00:00')
  assert.equal(sources[1].snippet, 'Official documentation.')
  assert.ok(usedInstance.startsWith('https://good.example'))
})
await check('reports JSON being disabled when the instance answers HTML with 200', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: SEARXNG_HTML_ERROR }) }])
  await assert.rejects(
    () => searchSearxng('python', { instances: ['https://x.example'], timeoutMs: 5000 }),
    /JSON format unavailable/,
  )
})
await check('requires at least one configured instance', async () => {
  await assert.rejects(() => searchSearxng('python', { instances: [], timeoutMs: 5000 }), /no instance is configured/)
})
await check('reports an invalid instance URL without a network call', async () => {
  const calls = installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: SEARXNG_JSON }) }])
  await assert.rejects(
    () => searchSearxng('python', { instances: ['not-a-url'], timeoutMs: 5000 }),
    /not a valid URL/,
  )
  assert.equal(calls.length, 0)
})

console.log('\nwikipedia backend')
await check('batches the detail lookup into one request', async () => {
  const calls = installFetch([
    { match: (url) => url.includes('list=search'), respond: () => stubResponse({ status: 200, body: WIKI_SEARCH_JSON }) },
    { match: (url) => url.includes('prop=extracts'), respond: () => stubResponse({ status: 200, body: WIKI_DETAIL_JSON }) },
  ])
  const { sources } = await searchWikipedia('javascript', { lang: 'en', timeoutMs: 5000, limit: 5 })
  assert.equal(calls.length, 2, 'expected exactly two requests, not one per result')
  assert.equal(sources.length, 2)
  assert.equal(sources[0].url, 'https://en.wikipedia.org/wiki/JavaScript')
  assert.match(sources[0].snippet, /core technology of the Web/)
  assert.equal(sources[1].url, 'https://en.wikipedia.org/wiki/ECMAScript')
})
await check('falls back to titles when the detail call fails', async () => {
  installFetch([
    { match: (url) => url.includes('list=search'), respond: () => stubResponse({ status: 200, body: WIKI_SEARCH_JSON }) },
    { match: (url) => url.includes('prop=extracts'), respond: () => stubResponse({ status: 500, body: 'boom' }) },
  ])
  const { sources } = await searchWikipedia('javascript', { lang: 'en', timeoutMs: 5000 })
  assert.equal(sources.length, 2)
  assert.equal(sources[0].url, 'https://en.wikipedia.org/wiki/JavaScript')
  // The search snippet survives as the fallback.
  assert.match(sources[0].snippet, /programming language/)
})
await check('uses the requested language subdomain', async () => {
  const calls = installFetch([
    { match: (url) => url.includes('list=search'), respond: () => stubResponse({ status: 200, body: WIKI_SEARCH_JSON }) },
    { match: (url) => url.includes('prop=extracts'), respond: () => stubResponse({ status: 200, body: WIKI_DETAIL_JSON }) },
  ])
  await searchWikipedia('javascript', { lang: 'zh', timeoutMs: 5000 })
  assert.ok(calls[0].url.startsWith('https://zh.wikipedia.org/'))
})
await check('rejects a malformed language and falls back to en', async () => {
  const calls = installFetch([
    { match: (url) => url.includes('list=search'), respond: () => stubResponse({ status: 200, body: WIKI_SEARCH_JSON }) },
    { match: (url) => url.includes('prop=extracts'), respond: () => stubResponse({ status: 200, body: WIKI_DETAIL_JSON }) },
  ])
  await searchWikipedia('javascript', { lang: '../../etc/passwd', timeoutMs: 5000 })
  assert.ok(calls[0].url.startsWith('https://en.wikipedia.org/'))
})
await check('reports an empty result set as an error', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: { query: { search: [] } } }) }])
  await assert.rejects(() => searchWikipedia('zzzz', { timeoutMs: 5000 }), /no pages matched/)
})

console.log('\nconfig')
await check('defaults to bing only, so a fresh install searches immediately', () => {
  const options = resolveConfig({}, { DSH_HOME: 'C:/nonexistent-probe-home' })
  // `bing` is the one backend needing no setup, no proxy and no configured
  // instance, so it is the only one enabled out of the box; everything else is a
  // checkbox away in the settings page.
  assert.deepEqual([...options.backends], ['bing'])
  assert.equal(options.timeoutMs, 12000)
  assert.equal(options.maxResults, 5)
  assert.equal(options.takeover, false)
  assert.equal(options.digest, false)
  assert.equal(options.wikipediaLang, 'en')
  assert.ok(options.searxngInstances.length > 0)
})
await check('every known backend stays selectable, even though only bing is on', () => {
  // The validation vocabulary and the default-enabled set are separate concerns:
  // narrowing the default must not make the other backends un-selectable.
  assert.deepEqual([...KNOWN_BACKENDS], ['searxng', 'google', 'bing', 'baidu', 'yandex', 'duckduckgo', 'wikipedia'])
})
await check('reads boolean and integer spellings from strings', () => {
  const options = resolveConfig({ takeover: 'yes', digest: '0', timeoutMs: '3000', maxResults: '9' }, TEST_ENV)
  assert.equal(options.takeover, true)
  assert.equal(options.digest, false)
  assert.equal(options.timeoutMs, 3000)
  assert.equal(options.maxResults, 9)
})
await check('drops unknown backend names and preserves the order the user gave', () => {
  const options = resolveConfig({ backends: 'wikipedia, nosuchbackend, duckduckgo' }, TEST_ENV)
  // Order is preserved, not re-sorted: the settings page lets the user arrange the
  // chain, so re-sorting would discard that decision.
  assert.deepEqual([...options.backends], ['wikipedia', 'duckduckgo'])
})
await check('preserves a deliberate order rather than imposing a canonical one', () => {
  const options = resolveConfig({ backends: 'baidu,bing,google' }, TEST_ENV)
  assert.deepEqual([...options.backends], ['baidu', 'bing', 'google'])
})
await check('falls back to the defaults when every backend name is unknown', () => {
  const options = resolveConfig({ backends: 'nope' }, TEST_ENV)
  assert.deepEqual([...options.backends], ['bing'])
})
await check('clamps an absurd timeout and result count', () => {
  const options = resolveConfig({ timeoutMs: 999999, maxResults: 500 }, TEST_ENV)
  assert.equal(options.timeoutMs, 60000)
  assert.equal(options.maxResults, 20)
})
await check('derives the whole-chain budget from the per-request timeout', () => {
  assert.equal(resolveConfig({ timeoutMs: 5000 }, TEST_ENV).totalTimeoutMs, 10000)
})
await check('never lets the chain budget fall below the per-request timeout', () => {
  const options = resolveConfig({ timeoutMs: 8000, totalTimeoutMs: 1000 }, TEST_ENV)
  assert.equal(options.totalTimeoutMs, 8000, 'a budget under one request would make every search fail')
})
await check('clamps the chain budget to a sane ceiling', () => {
  assert.equal(resolveConfig({ totalTimeoutMs: 9999999 }, TEST_ENV).totalTimeoutMs, 120000)
})
await check('treats a malformed config object as empty rather than throwing', () => {
  const options = resolveConfig(null, TEST_ENV)
  assert.deepEqual([...options.backends], ['bing'])
})
await check('accepts instances as an array and de-duplicates them', () => {
  const options = resolveConfig({ searxngInstances: ['https://a.example', 'https://a.example', ' https://b.example '] }, TEST_ENV)
  assert.deepEqual([...options.searxngInstances], ['https://a.example', 'https://b.example'])
})

console.log('\nprovider: availability and conflict avoidance')
await check('uses a provider id that collides with no shipped provider', () => {
  assert.equal(FREE_SEARCH_PROVIDER_ID, 'free-web')
  assert.notEqual(FREE_SEARCH_PROVIDER_ID, 'deepseek-official')
  assert.notEqual(FREE_SEARCH_PROVIDER_ID, 'http')
})
await check('is available when nothing else claims the search slot', () => {
  const web = { searchProviders: new Map(), searchProviderId: undefined }
  const provider = new FreeSearchProvider(() => resolveConfig({}, process.env), () => web)
  assert.equal(provider.available(), true)
})
await check('stays dormant when another usable provider is registered', () => {
  const web = { searchProviders: new Map([['deepseek-official', { available: () => true }]]), searchProviderId: undefined }
  const provider = new FreeSearchProvider(() => resolveConfig({}, process.env), () => web)
  assert.equal(provider.available(), false, 'must not create a WEB_PROVIDER_AMBIGUOUS conflict')
})
await check('claims the slot when the other provider reports itself unavailable', () => {
  const web = { searchProviders: new Map([['deepseek-official', { available: () => false }]]), searchProviderId: undefined }
  const provider = new FreeSearchProvider(() => resolveConfig({}, process.env), () => web)
  assert.equal(provider.available(), true)
})
await check('claims the slot when explicitly selected, even alongside another provider', () => {
  const web = { searchProviders: new Map([['deepseek-official', { available: () => true }]]), searchProviderId: 'free-web' }
  const provider = new FreeSearchProvider(() => resolveConfig({}, process.env), () => web)
  assert.equal(provider.available(), true)
})
await check('stays dormant when a different provider was explicitly selected', () => {
  const web = { searchProviders: new Map(), searchProviderId: 'deepseek-official' }
  const provider = new FreeSearchProvider(() => resolveConfig({}, process.env), () => web)
  assert.equal(provider.available(), false)
})
await check('takeover:true always claims the slot', () => {
  const web = { searchProviders: new Map([['deepseek-official', { available: () => true }]]), searchProviderId: 'deepseek-official' }
  const provider = new FreeSearchProvider(() => resolveConfig({ takeover: true }, TEST_ENV), () => web)
  assert.equal(provider.available(), true)
})
await check('a throwing sibling provider is treated as unavailable, not fatal', () => {
  const web = {
    searchProviders: new Map([['broken', { available: () => { throw new Error('boom') } }]]),
    searchProviderId: undefined,
  }
  const provider = new FreeSearchProvider(() => resolveConfig({}, process.env), () => web)
  assert.equal(provider.available(), true)
})
await check('an unreadable registry claims the slot so the plugin still works', () => {
  const provider = new FreeSearchProvider(() => resolveConfig({}, process.env), () => undefined)
  assert.equal(provider.available(), true)
})
await check('is unavailable when no backend is enabled', () => {
  const provider = new FreeSearchProvider(() => ({ backends: [] }), () => undefined)
  assert.equal(provider.available(), false)
})
await check('is unavailable when resolveOptions throws', () => {
  const provider = new FreeSearchProvider(() => { throw new Error('bad config') }, () => undefined)
  assert.equal(provider.available(), false)
})

console.log('\nprovider: search behaviour')

/**
 * Options with an explicit backend chain.
 *
 * The default is now `bing` alone, so a test that wants to exercise fall-through
 * must say which chain it means. Spelling it out is also clearer than relying on
 * whatever the default happens to be — these tests are about ordering behaviour,
 * not about the default.
 *
 * @param chain - comma-separated backend names.
 * @param extra - additional config overrides.
 * @returns resolved options, isolated from any real settings file.
 */
function chainOptions(chain, extra = {}) {
  return resolveConfig({ backends: chain, ...extra }, { DSH_HOME: 'C:/nonexistent-probe-home' })
}

await check('serves a search through the first working backend', async () => {
  installFetch([
    { match: (url) => url.includes('searx.be'), respond: () => stubResponse({ status: 200, body: SEARXNG_JSON }) },
  ])
  const provider = new FreeSearchProvider(() => chainOptions('searxng'), () => undefined)
  const result = await provider.search({ query: 'python', maxResults: 2 })
  assert.equal(result.truncated, false)
  assert.equal(result.sources.length, 2)
  assert.equal(result.sources[0].url, 'https://www.python.org/')
})
await check('falls through searxng to duckduckgo when every instance fails', async () => {
  installFetch([
    { match: (url) => isSearxngRequest(url), respond: () => stubResponse({ status: 502, body: 'down' }) },
    { match: (url) => url.includes('html.duckduckgo.com'), respond: () => stubResponse({ status: 200, body: DDG_HTML_PAGE }) },
  ])
  const provider = new FreeSearchProvider(() => chainOptions('searxng,duckduckgo'), () => undefined)
  const result = await provider.search({ query: 'node', maxResults: 10 })
  assert.ok(result.sources.length >= 3)
  assert.ok(result.sources.some((source) => source.url === 'https://nodejs.org/api/'))
})
await check('falls all the way through to wikipedia when both general backends fail', async () => {
  installFetch([
    { match: (url) => url.includes('duckduckgo'), respond: () => stubResponse({ status: 429, body: 'blocked' }) },
    { match: (url) => url.includes('list=search'), respond: () => stubResponse({ status: 200, body: WIKI_SEARCH_JSON }) },
    { match: (url) => url.includes('prop=extracts'), respond: () => stubResponse({ status: 200, body: WIKI_DETAIL_JSON }) },
    { match: (url) => isSearxngRequest(url), respond: () => stubResponse({ status: 502, body: 'down' }) },
  ])
  const provider = new FreeSearchProvider(() => chainOptions('searxng,duckduckgo,wikipedia'), () => undefined)
  const result = await provider.search({ query: 'javascript', maxResults: 5 })
  assert.equal(result.sources[0].url, 'https://en.wikipedia.org/wiki/JavaScript')
})
await check('honours an explicit backend list', async () => {
  const calls = installFetch([
    { match: (url) => url.includes('list=search'), respond: () => stubResponse({ status: 200, body: WIKI_SEARCH_JSON }) },
    { match: (url) => url.includes('prop=extracts'), respond: () => stubResponse({ status: 200, body: WIKI_DETAIL_JSON }) },
  ])
  const provider = new FreeSearchProvider(() => resolveConfig({ backends: 'wikipedia' }, TEST_ENV), () => undefined)
  await provider.search({ query: 'javascript' })
  assert.equal(calls.length, 2, 'no general-engine request should have been made')
})
await check('tries bing before duckduckgo by default', async () => {
  const order = []
  installFetch([
    {
      match: (url) => isSearxngRequest(url),
      respond: () => stubResponse({ status: 502, body: 'searxng down' }),
    },
    {
      match: (url) => url.includes('bing.com/search'),
      respond: () => {
        order.push('bing')
        return stubResponse({ status: 200, body: BING_PAGE })
      },
    },
    {
      match: (url) => url.includes('duckduckgo'),
      respond: () => {
        order.push('duckduckgo')
        return stubResponse({ status: 200, body: DDG_HTML_PAGE })
      },
    },
  ])
  const provider = new FreeSearchProvider(() => chainOptions('bing,duckduckgo'), () => undefined)
  const result = await provider.search({ query: 'node', maxResults: 5 })
  assert.deepEqual(order, ['bing'], 'bing must answer, and duckduckgo must not be reached')
  assert.ok(result.sources.some((source) => source.url === 'https://nodejs.org/api/'))
})
await check('falls through bing to duckduckgo when bing is blocked', async () => {
  // The reason both scrape backends can be enabled together: they fail
  // independently, so one covers for the other.
  installFetch([
    { match: (url) => url.includes('bing.com/search'), respond: () => stubResponse({ status: 200, body: BING_BLOCK_PAGE }) },
    { match: (url) => url.includes('html.duckduckgo.com'), respond: () => stubResponse({ status: 200, body: DDG_HTML_PAGE }) },
  ])
  const provider = new FreeSearchProvider(() => chainOptions('bing,duckduckgo'), () => undefined)
  const result = await provider.search({ query: 'node', maxResults: 5 })
  assert.ok(result.sources.some((source) => source.url === 'https://nodejs.org/api/'), 'duckduckgo must cover for a blocked bing')
})
await check('falls through duckduckgo to bing when duckduckgo is blocked', async () => {
  installFetch([
    { match: (url) => url.includes('bing.com/search'), respond: () => stubResponse({ status: 200, body: BING_PAGE }) },
    { match: (url) => url.includes('duckduckgo'), respond: () => stubResponse({ status: 429, body: DDG_BLOCK_PAGE }) },
  ])
  const provider = new FreeSearchProvider(() => chainOptions('duckduckgo,bing'), () => undefined)
  const result = await provider.search({ query: 'node', maxResults: 5 })
  assert.ok(result.sources.some((source) => source.url === 'https://nodejs.org/api/'), 'bing must cover for a blocked duckduckgo')
})
await check('truncates to maxResults and asks backends for a small surplus', async () => {
  let requestedLimit
  installFetch([
    {
      match: (url) => url.includes('searx.be'),
      respond: (url) => {
        requestedLimit = new URL(url).searchParams.get('q')
        return stubResponse({ status: 200, body: SEARXNG_JSON })
      },
    },
  ])
  const provider = new FreeSearchProvider(() => chainOptions('searxng'), () => undefined)
  const result = await provider.search({ query: 'python', maxResults: 2 })
  assert.equal(result.sources.length, 2)
  assert.equal(requestedLimit, 'python')
})
await check('reports the aggregate failure when every backend is exhausted', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 500, body: 'down' }) }])
  const provider = new FreeSearchProvider(() => chainOptions('searxng,duckduckgo,wikipedia'), () => undefined)
  await assert.rejects(
    () => provider.search({ query: 'x' }),
    (error) =>
      error.message.includes('all enabled backends failed') &&
      error.message.includes('searxng') &&
      error.message.includes('duckduckgo') &&
      error.message.includes('wikipedia'),
  )
})
await check('rejects an empty query before any request', async () => {
  const calls = installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: SEARXNG_JSON }) }])
  const provider = new FreeSearchProvider(() => chainOptions('searxng'), () => undefined)
  await assert.rejects(() => provider.search({ query: '   ' }), /query is empty/)
  assert.equal(calls.length, 0)
})
await check('adds a plain-text digest only when digest is enabled', async () => {
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: SEARXNG_JSON }) }])
  const off = new FreeSearchProvider(() => chainOptions('searxng'), () => undefined)
  assert.equal((await off.search({ query: 'python' })).content, undefined)
  const on = new FreeSearchProvider(() => chainOptions('searxng', { digest: true }), () => undefined)
  const withDigest = await on.search({ query: 'python' })
  assert.match(withDigest.content, /Search results for "python"/)
  assert.match(withDigest.content, /1\. Welcome to Python\.org/)
})
await check('propagates a cancellation from the surrounding search', async () => {
  const controller = new AbortController()
  controller.abort()
  installFetch([{ match: () => true, respond: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) } }])
  const provider = new FreeSearchProvider(() => resolveConfig({}, process.env), () => undefined)
  await assert.rejects(() => provider.search({ query: 'x' }, controller.signal), (error) => error.kind === 'aborted')
})
await check('bounds total wall-clock time by the chain budget, not by the instance count', async () => {
  // This is the regression the shared deadline exists for: with a per-request
  // timeout only, five hung SearxNG instances would each burn a full timeout
  // (5 x 60ms here) before the chain even reached the next backend.
  installFetch([{ match: () => true, respond: (_url, init) => hangUntilAborted(init?.signal) }])
  const options = resolveConfig({ timeoutMs: 60, totalTimeoutMs: 150, backends: 'searxng,duckduckgo,wikipedia' }, TEST_ENV)
  const provider = new FreeSearchProvider(() => options, () => undefined)
  const started = Date.now()
  await assert.rejects(() => provider.search({ query: 'x' }))
  const elapsed = Date.now() - started
  // Generous ceiling: the point is that it is bounded by ~150ms, not ~11 x 60ms.
  assert.ok(elapsed < 400, `expected the search to give up within the 150ms budget, took ${elapsed}ms`)
})
await check('every backend gets a turn even when the first one hangs', async () => {
  // Measured against a real dead network: a naive shared deadline let five hung
  // SearxNG instances eat the whole budget, and the backends behind it were
  // reported as "skipped" — never tried. That is the worst failure mode, because
  // it is precisely the case the chain exists for.
  const tried = []
  const hang = (name) => (_url, init) => {
    tried.push(name)
    return hangUntilAborted(init?.signal, 5000)
  }
  installFetch([
    { match: isSearxngRequest, respond: hang('searxng') },
    { match: (url) => url.includes('bing.com/search'), respond: hang('bing') },
    { match: (url) => url.includes('duckduckgo'), respond: hang('duckduckgo') },
    { match: (url) => url.includes('api.php'), respond: hang('wikipedia') },
  ])
  // The backend list is pinned explicitly: this test is about the allocator, so
  // it must not silently change meaning when the default order gains a backend.
  const options = resolveConfig({ timeoutMs: 300, totalTimeoutMs: 800, backends: 'searxng,bing,duckduckgo,wikipedia' }, TEST_ENV)
  const provider = new FreeSearchProvider(() => options, () => undefined)
  await assert.rejects(() => provider.search({ query: 'x' }))
  assert.deepEqual(tried, ['searxng', 'bing', 'duckduckgo', 'wikipedia'], 'every configured backend must be attempted')
})
await check('a fast backend failure hands its unused time back to the pool', async () => {
  // The reservation must not slow down a healthy chain: when searxng and bing
  // fail instantly, duckduckgo should be reached quickly rather than waiting out
  // a reserved slice.
  let reachedAt
  installFetch([
    { match: isSearxngRequest, respond: () => stubResponse({ status: 502, body: 'down' }) },
    { match: (url) => url.includes('bing.com/search'), respond: () => stubResponse({ status: 200, body: BING_BLOCK_PAGE }) },
    {
      match: (url) => url.includes('html.duckduckgo.com'),
      respond: () => {
        reachedAt = Date.now()
        return stubResponse({ status: 200, body: DDG_HTML_PAGE })
      },
    },
  ])
  const options = resolveConfig({ timeoutMs: 300, totalTimeoutMs: 1000, backends: 'searxng,bing,duckduckgo' }, TEST_ENV)
  const provider = new FreeSearchProvider(() => options, () => undefined)
  const started = Date.now()
  const result = await provider.search({ query: 'node', maxResults: 5 })
  assert.ok(result.sources.length > 0)
  assert.ok(reachedAt - started < 300, 'a fast failure must not hold up the next backend')
})
await check('distinguishes our own deadline from a caller cancellation', async () => {
  // Both surface as AbortError, and conflating them is a real bug with a large
  // blast radius: the provider stops the whole fallback chain on a cancellation,
  // so mislabelling a timeout would let one slow instance disable every backend
  // behind it.
  const { requestText } = await import('../src/http.js')

  installFetch([{ match: () => true, respond: (_url, init) => hangUntilAborted(init?.signal) }])
  await assert.rejects(
    () => requestText('https://slow.example/', { timeoutMs: 40 }),
    (error) => {
      assert.equal(error.kind, 'timeout', 'a fired deadline must be a timeout, not an abort')
      return true
    },
  )

  const controller = new AbortController()
  controller.abort()
  installFetch([{ match: () => true, respond: (_url, init) => hangUntilAborted(init?.signal) }])
  await assert.rejects(
    () => requestText('https://slow.example/', { timeoutMs: 5000, signal: controller.signal }),
    (error) => {
      assert.equal(error.kind, 'aborted', 'a caller cancellation must be an abort')
      return true
    },
  )
})
await check('a timed-out backend does not stop the fallback chain', async () => {
  // The end-to-end consequence of the distinction above.
  installFetch([
    { match: (url) => url.includes('searx.be'), respond: (_url, init) => hangUntilAborted(init?.signal) },
    { match: (url) => url.includes('html.duckduckgo.com'), respond: () => stubResponse({ status: 200, body: DDG_HTML_PAGE }) },
  ])
  const options = resolveConfig({ timeoutMs: 60, totalTimeoutMs: 400, backends: 'searxng,duckduckgo' }, TEST_ENV)
  const provider = new FreeSearchProvider(() => options, () => undefined)
  const result = await provider.search({ query: 'node', maxResults: 5 })
  assert.ok(result.sources.some((source) => source.url === 'https://nodejs.org/api/'), 'duckduckgo must still be tried after a searxng timeout')
})

console.log('\nsettings routes')
await check('redactProxy leaves a bypass keyword alone', () => {
  // Regression: re-parsing "direct" treated it as a hostname and displayed
  // "http://direct:8080", which is both wrong and confusing in the UI.
  const { redactProxy, isDirectKeyword } = routesModule
  assert.equal(redactProxy('direct'), 'direct')
  assert.equal(redactProxy('none'), 'none')
  assert.equal(isDirectKeyword('DIRECT'), true)
  assert.equal(isDirectKeyword('127.0.0.1:7890'), false)
  // A real address is still normalized and masked.
  assert.equal(redactProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(redactProxy('http://u:p@h:1'), 'http://u:********@h:1')
})
await check('POST /settings saves a proxy and the config route reflects it', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  // Point DSH_HOME at a temp directory so the test never touches the real one.
  const home = path.join(os.tmpdir(), `dsh-fws-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const handler = createHandler({ resolveOptions: () => ({ ...resolveConfig({}, process.env), knownBackends: ['bing', 'baidu'] }), logger: {} })

    const saved = await callRoute(handler, 'POST', `${ROUTE_PREFIX}/settings`, {}, JSON.stringify({ proxy: '127.0.0.1:7890' }))
    assert.equal(saved.status, 200)
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.saved.proxy, '127.0.0.1:7890')
    assert.ok(fs.existsSync(path.join(home, 'dsh-free-web-search', 'settings.json')), 'the settings file must be written')

    // A fresh resolve must pick the saved value up. `process.env` is passed
    // explicitly because the settings file is located via `$DSH_HOME`, and an
    // empty env object would resolve a different home directory.
    const options = resolveConfig({ proxy: 'http://ignored:1' }, process.env)
    assert.equal(options.proxyUrl, '127.0.0.1:7890', 'the settings file must outrank the loader config')

    // And the route must report the saved proxy as the one in effect. (The
    // override itself is deliberately no longer surfaced in the API: it is an
    // implementation detail the settings page does not show.)
    const view = await callRoute(handler, 'GET', `${ROUTE_PREFIX}/config`)
    assert.equal(view.body.proxyConfigured, true)
    assert.match(view.body.proxy, /127\.0\.0\.1:7890/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
await check('POST /settings rejects an unusable proxy', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const home = path.join(os.tmpdir(), `dsh-fws-test-${Date.now()}`)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const handler = createHandler({ resolveOptions: () => resolveConfig({}, process.env), logger: {} })
    const res = await callRoute(handler, 'POST', `${ROUTE_PREFIX}/settings`, {}, JSON.stringify({ proxy: 'this is not a proxy' }))
    assert.equal(res.status, 400)
    assert.match(res.body.error, /not a usable proxy/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
await check('POST /settings rejects an unknown backend', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const home = path.join(os.tmpdir(), `dsh-fws-test-${Date.now()}`)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const handler = createHandler({ resolveOptions: () => resolveConfig({}, process.env), logger: {} })
    const res = await callRoute(handler, 'POST', `${ROUTE_PREFIX}/settings`, {}, JSON.stringify({ backends: ['bing', 'nosuchbackend'] }))
    assert.equal(res.status, 400)
    assert.match(res.body.error, /unknown backend/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
await check('POST /settings merges rather than replacing unrelated fields', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const home = path.join(os.tmpdir(), `dsh-fws-test-${Date.now()}`)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const handler = createHandler({ resolveOptions: () => ({ ...resolveConfig({}, process.env), knownBackends: ['bing', 'baidu'] }), logger: {} })
    await callRoute(handler, 'POST', `${ROUTE_PREFIX}/settings`, {}, JSON.stringify({ proxy: '127.0.0.1:7890' }))
    // A second save that only sets the backends must not drop the proxy.
    const second = await callRoute(handler, 'POST', `${ROUTE_PREFIX}/settings`, {}, JSON.stringify({ backends: ['bing'] }))
    assert.equal(second.status, 200)
    assert.equal(second.body.saved.proxy, '127.0.0.1:7890', 'the earlier proxy must survive')
    assert.deepEqual(second.body.saved.backends, ['bing'])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
await check('POST /settings/clear removes the override', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const home = path.join(os.tmpdir(), `dsh-fws-test-${Date.now()}`)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const handler = createHandler({ resolveOptions: () => resolveConfig({}, process.env), logger: {} })
    await callRoute(handler, 'POST', `${ROUTE_PREFIX}/settings`, {}, JSON.stringify({ proxy: '127.0.0.1:7890' }))
    const cleared = await callRoute(handler, 'POST', `${ROUTE_PREFIX}/settings/clear`, {}, '{}')
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.cleared, true)
    assert.ok(!fs.existsSync(path.join(home, 'dsh-free-web-search', 'settings.json')))
    // The loader config applies again.
    assert.equal(resolveConfig({ proxy: 'http://fromconfig:1' }, process.env).proxyUrl, 'http://fromconfig:1')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
await check('an explicit empty proxy in settings forces a direct connection', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const home = path.join(os.tmpdir(), `dsh-fws-test-${Date.now()}`)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const handler = createHandler({ resolveOptions: () => resolveConfig({}, process.env), logger: {} })
    // "Use direct" is stored as an empty string, which must override a proxy set
    // in cordis.patch.yml.
    await callRoute(handler, 'POST', `${ROUTE_PREFIX}/settings`, {}, JSON.stringify({ proxy: '' }))
    const options = resolveConfig({ proxy: 'http://fromconfig:1' }, process.env)
    assert.equal(options.proxyUrl, '', 'an explicit direct must beat the config file')
    assert.equal(options.proxyPolicy.for('bing'), undefined)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
await check('a corrupt settings file is ignored rather than fatal', () => {
  const home = path.join(os.tmpdir(), `dsh-fws-test-${Date.now()}`)
  const dir = path.join(home, 'dsh-free-web-search')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json')
  try {
    const options = resolveConfig({ proxy: 'http://fromconfig:1' }, { DSH_HOME: home })
    assert.equal(options.proxyUrl, 'http://fromconfig:1', 'a broken file must fall back to the config')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
await check('the config route reports the live configuration', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const handler = createHandler({
    resolveOptions: () => ({
      ...resolveConfig({}, { DSH_HOME: 'C:/nonexistent-probe-home' }),
      knownBackends: KNOWN_BACKENDS,
    }),
    logger: {},
  })
  const res = await callRoute(handler, 'GET', `${ROUTE_PREFIX}/config`)
  assert.equal(res.status, 200)
  // The enabled set defaults to bing, while every known backend is still offered
  // as a choice.
  assert.deepEqual(res.body.backends, ['bing'])
  assert.deepEqual(res.body.knownBackends, ['searxng', 'google', 'bing', 'baidu', 'yandex', 'duckduckgo', 'wikipedia'])
  assert.equal(res.body.proxyConfigured, false)
  assert.equal(res.body.proxy, '')
})
await check('the config route masks the password in the display field', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  // An isolated home is mandatory here: the settings file lives under `$DSH_HOME`,
  // and a test that resolves the *real* one will read — and in the write tests
  // below, overwrite — the user's actual configuration. That is not hypothetical:
  // it happened, and it silently replaced the user's configured proxy with
  // "direct".
  const home = path.join(os.tmpdir(), `dsh-fws-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const handler = createHandler({
      resolveOptions: () => ({ ...resolveConfig({ proxy: 'http://user:secret123@127.0.0.1:7890' }, process.env), knownBackends: [] }),
      logger: {},
    })
    const res = await callRoute(handler, 'GET', `${ROUTE_PREFIX}/config`)
    // `proxy` is the display value and must never contain the secret.
    assert.match(res.body.proxy, /^http:\/\/user:\*+@127\.0\.0\.1:7890$/)
    assert.ok(!res.body.proxy.includes('secret123'), 'the display field must not contain the password')
    assert.equal(res.body.proxyConfigured, true)

    // `proxyRaw` deliberately carries the real value so the edit field can be
    // seeded without a save overwriting the password with asterisks. That is a
    // considered trade-off: this route is loopback-only and fenced against
    // cross-site reads, and an unusable edit field would be worse.
    assert.equal(res.body.proxyRaw, 'http://user:secret123@127.0.0.1:7890', 'the edit field needs the real value')
    assert.equal(res.body.hasPerBackendProxy, false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
await check('rejects a non-loopback connection', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const handler = createHandler({ resolveOptions: () => resolveConfig({}, process.env), logger: {} })
  const res = await callRoute(handler, 'GET', `${ROUTE_PREFIX}/config`, { remoteAddress: '10.0.0.5' })
  assert.equal(res.status, 403)
})
await check('rejects a non-loopback Host header (DNS rebinding)', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const handler = createHandler({ resolveOptions: () => resolveConfig({}, process.env), logger: {} })
  const res = await callRoute(handler, 'GET', `${ROUTE_PREFIX}/config`, { host: 'evil.example:19387' })
  assert.equal(res.status, 403)
  assert.match(res.body.error, /127\.0\.0\.1/)
})
await check('rejects a request without the client marker header', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const handler = createHandler({ resolveOptions: () => resolveConfig({}, process.env), logger: {} })
  const res = await callRoute(handler, 'GET', `${ROUTE_PREFIX}/config`, { clientHeader: null })
  assert.equal(res.status, 403)
})
await check('the proxy check reports "not configured" without probing', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  // An empty env is deliberate: `resolveConfig` reads ambient proxy variables
  // (`HTTPS_PROXY` and friends), so passing `process.env` would make this depend
  // on the machine's own proxy settings rather than on the code under test.
  const handler = createHandler({ resolveOptions: () => resolveConfig({}, { DSH_HOME: 'C:/nonexistent-probe-home' }), logger: {} })
  const res = await callRoute(handler, 'POST', `${ROUTE_PREFIX}/proxy-check`, {}, '{}')
  assert.equal(res.status, 200)
  assert.equal(res.body.configured, false)
})
await check('the proxy check explains an unparseable proxy', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const handler = createHandler({ resolveOptions: () => resolveConfig({}, process.env), logger: {} })
  const res = await callRoute(handler, 'POST', `${ROUTE_PREFIX}/proxy-check`, {}, JSON.stringify({ proxy: 'nonsense proxy' }))
  assert.equal(res.status, 400)
  assert.match(res.body.error, /could not be parsed/)
})
await check('an unknown route is a 404, not a crash', async () => {
  const { createHandler, ROUTE_PREFIX } = await import('../src/routes.js')
  const handler = createHandler({ resolveOptions: () => resolveConfig({}, process.env), logger: {} })
  const res = await callRoute(handler, 'GET', `${ROUTE_PREFIX}/nope`)
  assert.equal(res.status, 404)
})
await check('proxy failures are turned into actionable advice', async () => {
  const { describeProxyFailure } = await import('../src/proxycheck.js')
  const proxy = parseProxy('http://127.0.0.1:7890')
  assert.match(describeProxyFailure(new Error('connect ECONNREFUSED'), proxy), /nothing is listening/)
  assert.match(describeProxyFailure(new Error('getaddrinfo ENOTFOUND host'), proxy), /could not be resolved/)
  assert.match(describeProxyFailure(new Error('proxy connect timed out'), proxy), /did not answer in time/)
  assert.match(describeProxyFailure(new Error('proxy requires authentication (HTTP 407)'), proxy), /add username:password/)
  assert.match(describeProxyFailure(new Error('socks5: CONNECT refused (connection refused)'), proxy), /refused the tunnel/)
})

console.log('\nplugin entry')
await check('declares the web seam as its only requirement', async () => {
  const module = await import('../index.js')
  assert.deepEqual(module.inject, ['web'])
  assert.equal(module.name, 'dsh-free-web-search')
})
await check('registers exactly one provider under the free-web id', async () => {
  const module = await import('../index.js')
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    web: { registerSearchProvider: (provider) => { registered.push(provider); return () => {} } },
    effect: () => {},
  }
  module.apply(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'free-web')
  assert.equal(typeof registered[0].search, 'function')
})
await check('survives a duplicate registration by warning instead of throwing', async () => {
  const module = await import('../index.js')
  const warnings = []
  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(String(message)), debug: () => {} },
    web: { registerSearchProvider: () => { throw Object.assign(new Error('already registered'), { code: 'WEB_DUPLICATE_PROVIDER' }) } },
    effect: () => {},
  }
  module.apply(ctx, {})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /already registered/)
})
await check('the registered provider works end to end against a stubbed fetch', async () => {
  const module = await import('../index.js')
  installFetch([{ match: () => true, respond: () => stubResponse({ status: 200, body: SEARXNG_JSON }) }])
  let provider
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    web: { registerSearchProvider: (value) => { provider = value; return () => {} } },
    effect: () => {},
  }
  // An explicit chain: the default is `bing` alone, so this must ask for the
  // backend whose fixture is being stubbed.
  module.apply(ctx, { backends: ['searxng'] })
  const result = await provider.search({ query: 'python', maxResults: 3 })
  assert.equal(result.sources.length, 3)
})

// Restore the real fetch so the process exits cleanly and later tooling is unaffected.
globalThis.fetch = originalFetch

// Final guard: the real settings file must be exactly as it was at suite start.
// The temp home is released first, so the comparison is made against the real one.
restoreHome()
await check('the suite left the real DSH_HOME untouched', () => {
  const after = snapshotRealSettings()
  assert.equal(
    after,
    REAL_SETTINGS_BEFORE,
    `a test modified the real settings file at ${REAL_SETTINGS}\n` +
      `  before: ${REAL_SETTINGS_BEFORE === null ? '(absent)' : REAL_SETTINGS_BEFORE.trim()}\n` +
      `  after:  ${after === null ? '(absent)' : after.trim()}`,
  )
  assert.equal(resolveHome(process.env), REAL_HOME, 'DSH_HOME was left modified by a test')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
