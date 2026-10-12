/**
 * Render the browser half's settings panel and assert on the output.
 *
 * A bundle that *parses* is not a bundle that *works*: the failure mode this
 * catches is a panel that throws on render because a dictionary key is missing, a
 * prop is undefined, or a nested component is referenced before it is defined.
 * None of those show up in a syntax check.
 *
 * React is not installed anywhere in this workspace or in the DSH runtime — the
 * shell supplies it in the browser — so `test/react-shim.mjs` provides the subset
 * the panel uses. See that file for what a pass here does and does not prove.
 *
 *   node test/client-render.mjs
 *
 * @module test/client-render.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as React from './react-shim.mjs'

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

console.log('\ndsh-free-web-search — browser half render check\n')

const CLIENT = path.join(import.meta.dirname, '..', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

// Load the bundle the way the shell does: a ModuleLoader shim plus `react`.
let captured = null
globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }

// `client.js` is a classic script, not a module; evaluate it in this context.
const evaluate = new Function('window', 'require', source)
evaluate(globalThis.window, (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require("${name}")`)
})

await check('the bundle registers itself under the package name', () => {
  assert.equal(captured?.id, 'dsh-free-web-search')
  assert.equal(typeof captured?.factory, 'function')
})

const module = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require("${name}")`)
})

await check('exports the shape the shell binds to', () => {
  assert.equal(module.name, 'dsh-free-web-search')
  assert.deepEqual(module.inject, ['slots', 'locale'])
  assert.equal(typeof module.apply, 'function')
})

/** A minimal translation function over the bundle's own dictionary. */
function makeT(locale) {
  const dict = module.__test.DICT[locale]
  return (key) => {
    const value = dict[key]
    if (value === undefined) throw new Error(`missing ${locale} dictionary key: ${key}`)
    return value
  }
}

await check('every dictionary key exists in both locales', () => {
  const zh = Object.keys(module.__test.DICT.zh).sort()
  const en = Object.keys(module.__test.DICT.en).sort()
  const missingInEn = zh.filter((key) => !en.includes(key))
  const missingInZh = en.filter((key) => !zh.includes(key))
  assert.deepEqual(missingInEn, [], `keys missing from en: ${missingInEn.join(', ')}`)
  assert.deepEqual(missingInZh, [], `keys missing from zh: ${missingInZh.join(', ')}`)
})

for (const locale of ['zh', 'en']) {
  await check(`renders the loading state (${locale})`, () => {
    // Before the config request resolves, the panel shows a loading line. This is
    // also the only render path that does not touch fetch.
    const html = React.renderToStaticMarkup(React.createElement(module.__test.FreeSearchPage, { t: makeT(locale) }))
    assert.match(html, new RegExp(makeT(locale)('loading').replace(/[…]/g, '.')))
  })
}

await check('renders the latency report with results, advice and snippet', () => {
  const t = makeT('en')
  const report = {
    timeoutMs: 8000,
    results: [
      { backend: 'bing', status: 'ok', connectMs: 36, tlsMs: 87, totalMs: 197, statusCode: 302, usedProxy: 'direct', detail: 'www.bing.com/ → HTTP 302' },
      { backend: 'baidu', status: 'ok', connectMs: 36, tlsMs: 95, totalMs: 112, statusCode: 200, usedProxy: 'direct', detail: 'www.baidu.com/ → HTTP 200' },
      { backend: 'google', status: 'timeout', totalMs: 8004, usedProxy: 'http://127.0.0.1:7890', error: 'www.google.com/: connect timed out' },
      { backend: 'yandex', status: 'unreachable', totalMs: 794, usedProxy: 'direct', error: 'yandex.com/: ECONNREFUSED' },
    ],
    best: 'baidu',
    suggestedOrder: ['baidu', 'bing', 'google', 'yandex'],
    changed: true,
    reasoning: ['2 of 4 backend(s) responded.', 'This is a suggestion only.'],
    snippet: "- id: free-web-search\n  config:\n    backends: ['baidu', 'bing']",
  }
  const html = React.renderToStaticMarkup(React.createElement(module.__test.SpeedReport, { report, t, copied: false, onCopy: () => {}, onApply: () => {}, applied: false }))
  assert.match(html, /bing/)
  assert.match(html, /baidu/)
  assert.match(html, /fastest/, 'the best backend must be marked')
  assert.match(html, /timed out/, 'the timeout status must be shown')
  assert.match(html, /unreachable/, 'the unreachable status must be shown')
  assert.match(html, /197 ms/)
  assert.match(html, /112 ms/)
  assert.match(html, /suggestion only/, 'the reasoning must be rendered')
  // The caveat must be on screen, not only in the docs.
  assert.match(html, /reachability and speed only/, 'the reachability caveat must be rendered')
  assert.match(html, /backends: \[&#x27;baidu&#x27;/, 'the config snippet must be rendered')
  assert.match(html, /Apply this order/, 'the apply button must be offered')
  // The stage breakdown columns must be present.
  assert.match(html, /Connect/)
  assert.match(html, /TLS/)
  // The old search-based column must be gone.
  assert.ok(!html.includes('>Results<'), 'the results-count column must be gone')
})

await check('renders a report where every backend failed', () => {
  const t = makeT('en')
  const report = {
    timeoutMs: 8000,
    results: [{ backend: 'google', status: 'timeout', totalMs: 8000, usedProxy: 'direct', error: 'timed out' }],
    best: null,
    suggestedOrder: ['google'],
    changed: false,
    reasoning: ['No backend answered. This is a connectivity or proxy problem.'],
    snippet: '- id: free-web-search',
  }
  const html = React.renderToStaticMarkup(React.createElement(module.__test.SpeedReport, { report, t, copied: false, onCopy: () => {}, onApply: () => {}, applied: false }))
  assert.match(html, /connectivity or proxy problem/)
})

await check('formatMs and statusLabel behave', () => {
  const { formatMs, statusLabel } = module.__test
  assert.equal(formatMs(500), '500 ms')
  assert.equal(formatMs(1500), '1.50 s')
  assert.equal(formatMs(undefined), '—')
  const t = makeT('en')
  assert.equal(statusLabel('ok', t), 'reachable')
  assert.equal(statusLabel('unreachable', t), 'unreachable')
  assert.equal(statusLabel('timeout', t), 'timed out')
  assert.equal(statusLabel('unknown-status', t), 'failed', 'an unknown status must fall back, not print a key')
})

await check('apply() registers a settings section', () => {
  const registrations = []
  const effects = []
  const ctx = {
    locale: { bind: () => (key) => key, register: () => {} },
    effect: (fn) => effects.push(fn),
    slots: {
      inject: (name, fn) => {
        registrations.push(name)
        fn()
      },
      register: (meta, component) => {
        registrations.push(meta)
        assert.equal(typeof component, 'function')
      },
    },
  }
  module.apply(ctx)
  assert.ok(registrations.includes('settings.section'))
  const meta = registrations.find((entry) => typeof entry === 'object')
  assert.equal(meta.id, 'dsh-free-web-search')
  assert.equal(meta.name, 'settings.section')
  assert.ok(typeof meta.order === 'number')
})

// ── The real data path ────────────────────────────────────────────────────────
// The panel's `useEffect` loads the config over fetch. These tests stub fetch and
// render the panel to completion, which is the only way to reach the markup that
// actually matters — the loaded state.

/** Install a fetch stub that answers the plugin's routes. */
function stubApi(routes) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, method: init.method ?? 'GET', init })
    for (const route of routes) {
      if (href.includes(route.match)) {
        const payload = route.respond(href, init)
        return {
          ok: payload.status === undefined || (payload.status >= 200 && payload.status < 300),
          status: payload.status ?? 200,
          text: async () => JSON.stringify(payload.body ?? {}),
        }
      }
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no stub for ${href}` }) }
  }
  return calls
}

const CONFIG_PAYLOAD = {
  ok: true,
  // The enabled set is `bing` alone by default; every other backend is still
  // offered as a choice via `knownBackends`.
  backends: ['bing'],
  timeoutMs: 12000,
  totalTimeoutMs: 24000,
  maxResults: 5,
  wikipediaLang: 'en',
  searxngInstances: ['https://searx.be'],
  takeover: false,
  digest: false,
  proxy: 'http://user:********@127.0.0.1:7890',
  proxyRaw: 'http://user:realpass@127.0.0.1:7890',
  proxyConfigured: true,
  proxyByBackend: {},
  hasPerBackendProxy: false,
  noProxy: [],
  knownBackends: ['searxng', 'google', 'bing', 'baidu', 'yandex', 'duckduckgo', 'wikipedia'],
  defaultBackends: ['bing'],
  freeActive: false,
  officialAvailable: true,
}

await check('renders the loaded panel with the proxy and backend order', async () => {
  stubApi([{ match: '/config', respond: () => ({ body: CONFIG_PAYLOAD }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  assert.match(html, /Free web search/, 'the title must render')
  assert.match(html, /127\.0\.0\.1:7890/, 'the proxy must be shown')
  assert.match(html, /configured/, 'the proxy status pill must render')
  // The order is conveyed by the numbered rows below, not by a redundant summary
  // line above them. Every backend must still be listed.
  assert.match(html, /Bing/, 'the enabled backend must be listed')
  assert.match(html, /SearxNG/, 'the other backends must be offered too')
  assert.ok(
    !html.includes('searxng → google'),
    'the redundant order line must be gone; the numbered rows carry the order',
  )
  assert.match(html, /Run latency test/, 'the latency test button must render')
  assert.match(html, /Test proxy/, 'the proxy test button must render')
  assert.match(html, /Save proxy/, 'the proxy save button must render')
  assert.match(html, /Save order/, 'the backend save button must render')
  // The test sends no query, so no probe term may appear anywhere in the panel —
  // not even when the host still reports one in its payload.
  assert.ok(!html.includes('deepseek'), 'no probe query term may be shown')
  assert.ok(!/Probe query/i.test(html), 'there must be no probe-query label')
})

await check('the proxy field is seeded with the editable value, not the redacted one', async () => {
  // Seeding the input with `********` would let a save overwrite the real password
  // with asterisks, so the raw value must be used here.
  stubApi([{ match: '/config', respond: () => ({ body: CONFIG_PAYLOAD }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  assert.match(html, /value="http:\/\/user:realpass@127\.0\.0\.1:7890"/, 'the input must hold the real value')
  assert.ok(!html.includes('value="http://user:********@127.0.0.1:7890"'), 'the input must not hold the masked value')
})

await check('the backend list renders a row per backend with order controls', async () => {
  stubApi([{ match: '/config', respond: () => ({ body: CONFIG_PAYLOAD }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  // Human-readable labels, not bare ids.
  assert.match(html, /Bing/)
  assert.match(html, /Baidu \(best for Chinese\)/)
  assert.match(html, /Google \(usually needs a proxy\)/)
  // Reorder controls and checkboxes.
  assert.match(html, /↑/)
  assert.match(html, /↓/)
  assert.match(html, /type="checkbox"/)
  // Selected rows carry an order badge; unselected rows carry a dash. With the
  // default being `bing` alone there is exactly one numbered row.
  assert.match(html, />1</, 'the single enabled backend must be numbered 1')
  assert.ok(!/>7</.test(html), 'there must not be a seventh numbered row with only one backend enabled')
  // The disabled ones are marked distinctly rather than numbered.
  assert.match(html, />–</, 'disabled backends must show a dash instead of a number')
})

await check('a disabled backend still gets a row so it can be re-enabled', async () => {
  // The panel must not hide a backend the user turned off, or it could never be
  // turned back on.
  stubApi([{ match: '/config', respond: () => ({ body: { ...CONFIG_PAYLOAD, backends: ['bing', 'baidu'] } }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  assert.match(html, /Google \(usually needs a proxy\)/, 'the disabled backend must still be listed')
  assert.match(html, /Disabled backends are not searched/, 'the hint about disabled backends must show')
})

await check('renders the direct-connection state when no proxy is set', async () => {
  stubApi([{ match: '/config', respond: () => ({ body: { ...CONFIG_PAYLOAD, proxy: '', proxyRaw: '', proxyConfigured: false } }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  assert.match(html, /not configured \(direct\)/)
})

await check('the proxy section does not expose settings-file plumbing', async () => {
  // The override pill, the "clear settings file" button and the file path were
  // removed as noise: persistence is an implementation detail, and the proxy
  // controls are what the user came for. The settings file is still *used* — this
  // asserts only that it is not surfaced.
  stubApi([{ match: '/config', respond: () => ({ body: CONFIG_PAYLOAD }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  assert.ok(!html.includes('overrides the config file'), 'the override pill must be gone')
  assert.ok(!html.includes('Clear settings file'), 'the clear button must be gone')
  assert.ok(!html.includes('settings.json'), 'the settings path must not be shown')
  // The proxy controls themselves must remain.
  assert.match(html, /Save proxy/)
  assert.match(html, /Test proxy/)
  assert.match(html, /Use direct/)
})

await check('renders the failure state when the host API is unreachable', async () => {
  stubApi([{ match: '/config', respond: () => ({ status: 500, body: { error: 'backend missing' } }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  assert.match(html, /Could not read the configuration/)
  assert.match(html, /backend missing/, 'the host error must be surfaced')
  assert.match(html, /Retry/, 'a retry affordance must be offered')
})

await check('the config request carries the client marker header', async () => {
  const calls = stubApi([{ match: '/config', respond: () => ({ body: CONFIG_PAYLOAD }) }])
  await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t: makeT('en') }))
  assert.equal(calls.length >= 1, true)
  assert.equal(calls[0].init.headers['x-dsh-free-web-search'], '1', 'the cross-site fence header is required by the host')
})

await check('the latency test button is rendered as a real, enabled button', async () => {
  // The button must be an actual <button>, not merely the label appearing in some
  // text, and it must be clickable while idle.
  stubApi([{ match: '/config', respond: () => ({ body: CONFIG_PAYLOAD }) }])
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t: makeT('en') }))
  const match = /<button([^>]*)>([^<]*Run latency test[^<]*)<\/button>/.exec(html)
  assert.ok(match !== null, 'the "Run latency test" button must be rendered as a button element')
  // Note: a click handler is not observable here — React (and this shim) do not
  // serialise event handlers into HTML attributes. The `onClick` wiring is
  // asserted by the interaction test below instead.
  assert.ok(!/disabled/.test(match[1]), 'the button must not be disabled before a test is running')
})

await check('clicking the latency test button calls the /latency route', async () => {
  // The behavioural check: actually invoke the handler the button was given.
  // Rendering alone cannot prove the button is wired to the right endpoint.
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, method: init.method ?? 'GET' })
    const body = href.includes('/config')
      ? CONFIG_PAYLOAD
      : { ok: true, timeoutMs: 8000, results: [], best: null, suggestedOrder: [], changed: false, reasoning: [], snippet: '' }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }

  // Capture the element tree instead of HTML so the props are reachable.
  const nodes = []
  const capturing = {
    ...React,
    createElement: (type, props, ...children) => {
      const node = { type, props: props ?? {}, children }
      nodes.push(node)
      return React.createElement(type, props, ...children)
    },
  }
  // Re-evaluate the bundle against the capturing React so the tree is recorded.
  const source = (await import('node:fs')).readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (d) => { captured = d } } }
  new Function('window', 'require', source)(globalThis.window, (name) => {
    if (name === 'react') return capturing
    throw new Error(name)
  })
  const bundle = captured.factory((name) => {
    if (name === 'react') return capturing
    throw new Error(name)
  })

  await React.renderAsync(capturing.createElement(bundle.__test.FreeSearchPage, { t: makeT('en') }))

  // Find the button whose child text is the run label, and invoke its handler.
  const runLabel = makeT('en')('speedRun')
  const button = nodes.find(
    (node) =>
      node.type === 'button' &&
      typeof node.props.onClick === 'function' &&
      JSON.stringify(node.children).includes(runLabel),
  )
  assert.ok(button !== undefined, 'the latency test button must have an onClick handler')

  await button.props.onClick()
  // Let the async handler's fetch settle.
  await new Promise((resolve) => setTimeout(resolve, 30))

  const latencyCall = calls.find((call) => call.url.includes('/latency'))
  assert.ok(latencyCall !== undefined, `clicking must POST to /latency; saw: ${calls.map((c) => c.url).join(', ')}`)
  assert.equal(latencyCall.method, 'POST', 'the latency test must be a POST')
})

await check('every button is visible: no element has matching text and background', async () => {
  // Regression. The shipped styles paired `background: currentColor` with
  // `color: Canvas`. `currentColor` on `background` resolves to the element's OWN
  // colour, so both became `Canvas` — white on white in a light theme — and every
  // primary button, including the latency test button, rendered invisible. That is
  // exactly why the button appeared to be missing.
  //
  // This checks the whole rendered panel, so any future style that makes text the
  // same colour as its own background fails here rather than in the browser.
  stubApi([{ match: '/config', respond: () => ({ body: CONFIG_PAYLOAD }) }])
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t: makeT('en') }))

  const buttons = [...html.matchAll(/<button([^>]*)>/g)]
  assert.ok(buttons.length >= 5, `expected several buttons, found ${buttons.length}`)

  for (const [, attrs] of buttons) {
    const style = /style="([^"]*)"/.exec(attrs)?.[1] ?? ''
    const declarations = Object.fromEntries(
      style
        .split(';')
        .filter(Boolean)
        .map((entry) => {
          const index = entry.indexOf(':')
          return [entry.slice(0, index).trim(), entry.slice(index + 1).trim()]
        }),
    )
    assert.notEqual(
      declarations.background,
      'currentColor',
      'a button uses "background: currentColor", which resolves to its own text colour',
    )
    assert.notEqual(declarations.color, 'Canvas', 'a button uses "color: Canvas", which can match its own fill')
    if (declarations.background !== undefined && declarations.color !== undefined) {
      assert.notEqual(
        declarations.background.toLowerCase(),
        declarations.color.toLowerCase(),
        `a button has identical text and background colours: ${declarations.background}`,
      )
    }
  }
  console.log(`     ${buttons.length} buttons checked for contrast`)
})

await check('the nav icon replaces the shell gear with a magnifier', () => {
  const { NAV_ICON_CSS, NAV_ATTR, tagNavButtons } = module.__test
  // The shell has no icon API, so the gear is hidden and our glyph drawn in its
  // place via a mask. Without this the section showed the same gear as "General
  // settings".
  assert.match(NAV_ICON_CSS, /display:\s*none\s*!important/, 'the shell icon must be hidden')
  assert.match(NAV_ICON_CSS, /-webkit-mask:/, 'a mask must draw the replacement')
  assert.match(NAV_ICON_CSS, /mask:/, 'the standard mask property must be set too')
  assert.match(NAV_ICON_CSS, /background-color:\s*currentColor/, 'the glyph must inherit the theme colour')
  const glyph = decodeURIComponent(NAV_ICON_CSS)
  assert.match(glyph, /<circle/, 'the glyph must contain the lens')
  assert.match(glyph, /M20 20l/, 'the glyph must contain the handle')

  // Tagging must hit only the search row: the modal's own "Settings" trigger is
  // also an svg+span button and must be left alone.
  const makeButton = (label, withSvg = true) => ({
    _attrs: {},
    children: [...(withSvg ? [{ tagName: 'svg' }] : []), { tagName: 'span', textContent: label }],
    getAttribute(name) {
      return this._attrs[name] ?? null
    },
    setAttribute(name, value) {
      this._attrs[name] = value
    },
  })
  const search = makeButton('Free search')
  const generic = makeButton('General settings')
  const trigger = makeButton('Settings')
  const root = { querySelectorAll: () => [search, generic, trigger] }

  assert.equal(tagNavButtons(root, ['免费搜索', 'Free search']), 1, 'exactly one row must be tagged')
  assert.equal(search._attrs[NAV_ATTR], '1')
  assert.equal(generic._attrs[NAV_ATTR], undefined, '"General settings" must keep the gear')
  assert.equal(trigger._attrs[NAV_ATTR], undefined, 'the modal trigger must be left alone')
  assert.equal(tagNavButtons(root, ['Free search']), 0, 'tagging must be idempotent')
})

await check('the provider section offers both switches and shows which is active', async () => {
  // This is the control that decides whether the plugin is used at all: the seam
  // keeps preferring the official provider even when it has no credential, so the
  // switch has to be explicit.
  stubApi([{ match: '/config', respond: () => ({ body: { ...CONFIG_PAYLOAD, freeActive: false, officialAvailable: true } }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  assert.match(html, /Default search service/, 'the section must render')
  assert.match(html, /Use this plugin/, 'the "make default" button must be offered')
  assert.match(html, /Restore DeepSeek official/, 'the restore button must be offered')
  assert.match(html, /DeepSeek official search/, 'the active provider must be shown')
})

await check('the provider section reflects this plugin being active', async () => {
  stubApi([{ match: '/config', respond: () => ({ body: { ...CONFIG_PAYLOAD, freeActive: true, officialAvailable: true } }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  assert.match(html, /This plugin \(key-less\)/, 'the active pill must say this plugin is in use')
  // Once active, the make-default button is disabled and its label becomes the
  // active marker rather than inviting a no-op click.
  assert.ok(
    !/<button(?![^>]*disabled)[^>]*>Use this plugin<\/button>/.test(html),
    'the make-default button must not be clickable when already active',
  )
})

await check('the provider section explains a restore when nothing else is registered', async () => {
  // The restore is NOT disabled in this case, and that is deliberate: clearing the
  // seam's id is harmless when only this plugin is registered, because the seam
  // falls back to its "exactly one usable provider" rule and keeps using it. This
  // was verified against the real seam, so the UI must not forbid the action — it
  // only explains the outcome.
  stubApi([{ match: '/config', respond: () => ({ body: { ...CONFIG_PAYLOAD, freeActive: true, officialAvailable: false } }) }])
  const t = makeT('en')
  const html = await React.renderAsync(React.createElement(module.__test.FreeSearchPage, { t }))
  assert.match(html, /no other search provider is registered/, 'the outcome must be explained')
  const restore = /<button([^>]*)>Restore DeepSeek official<\/button>/.exec(html)
  assert.ok(restore !== null, 'the restore button must still be rendered')
  assert.ok(!/disabled/.test(restore[1]), 'the restore button must stay usable — the action is harmless')
})

await check('clicking "use this plugin" posts to the provider route', async () => {
  // Rendering alone cannot prove the button is wired to the right endpoint.
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, method: init.method ?? 'GET' })
    const body = href.includes('/config')
      ? { ...CONFIG_PAYLOAD, freeActive: false, officialAvailable: true }
      : { ok: true }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }

  const nodes = []
  const capturing = {
    ...React,
    createElement: (type, props, ...children) => {
      nodes.push({ type, props: props ?? {}, children })
      return React.createElement(type, props, ...children)
    },
  }
  const source = (await import('node:fs')).readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (d) => { captured = d } } }
  new Function('window', 'require', source)(globalThis.window, (name) => {
    if (name === 'react') return capturing
    throw new Error(name)
  })
  const bundle = captured.factory((name) => {
    if (name === 'react') return capturing
    throw new Error(name)
  })
  await React.renderAsync(capturing.createElement(bundle.__test.FreeSearchPage, { t: makeT('en') }))

  const label = makeT('en')('providerMakeDefault')
  const button = nodes.find(
    (node) =>
      node.type === 'button' && typeof node.props.onClick === 'function' && JSON.stringify(node.children).includes(label),
  )
  assert.ok(button !== undefined, 'the make-default button must have a click handler')
  await button.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const call = calls.find((entry) => entry.url.includes('/provider/default'))
  assert.ok(call !== undefined, `clicking must POST to /provider/default; saw: ${calls.map((c) => c.url).join(', ')}`)
  assert.equal(call.method, 'POST')
})

await check('"restore defaults" selects the default backends, not every backend', async () => {
  // Regression. The button used to do `setSelected([...known])` — "select all" —
  // which is a different action from "restore defaults". With `bing` as the only
  // default, clicking it turned every backend on, contradicting both the label and
  // the plugin's own default.
  //
  // The button is clicked for real, because the bug lived in the handler and a
  // render-only assertion would never have caught it.
  const nodes = []
  const capturing = {
    ...React,
    createElement: (type, props, ...children) => {
      nodes.push({ type, props: props ?? {}, children })
      return React.createElement(type, props, ...children)
    },
  }
  const source = (await import('node:fs')).readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (d) => { captured = d } } }
  new Function('window', 'require', source)(globalThis.window, (name) => {
    if (name === 'react') return capturing
    throw new Error(name)
  })
  const bundle = captured.factory((name) => {
    if (name === 'react') return capturing
    throw new Error(name)
  })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(CONFIG_PAYLOAD),
  })

  await React.renderAsync(capturing.createElement(bundle.__test.FreeSearchPage, { t: makeT('en') }))
  const label = makeT('en')('backendsReset')
  const button = nodes.find(
    (node) =>
      node.type === 'button' && typeof node.props.onClick === 'function' && JSON.stringify(node.children).includes(label),
  )
  assert.ok(button !== undefined, 'the restore-defaults button must have a click handler')
  button.props.onClick()

  // Re-render to observe the new selection, then read the order shown in the header
  // of the backends section — the numbered list reflects `selected`.
  nodes.length = 0
  await React.renderAsync(capturing.createElement(bundle.__test.FreeSearchPage, { t: makeT('en') }))

  // Count the checked checkboxes: only the default set may be enabled.
  const html = await React.renderAsync(capturing.createElement(bundle.__test.FreeSearchPage, { t: makeT('en') }))
  const checked = (html.match(/type="checkbox"[^>]*checked/g) ?? []).length
  assert.equal(checked, CONFIG_PAYLOAD.defaultBackends.length, `expected ${CONFIG_PAYLOAD.defaultBackends.length} enabled backend(s), saw ${checked}`)
  assert.equal(checked < CONFIG_PAYLOAD.knownBackends.length, true, 'restoring defaults must not select every backend')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
