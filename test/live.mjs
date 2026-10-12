/**
 * Live smoke test — makes real network requests to the free backends.
 *
 * This is deliberately **not** part of `npm test`. The offline suite is the one
 * that must always pass, because the plugin's own logic is verifiable without a
 * network; this script exists to answer the different question "is the internet
 * reachable from here, and are the backends currently answering?". It therefore
 * reports rather than asserts by default: a backend being rate-limited or
 * offline is a fact about the world, not a bug in the plugin.
 *
 *   node test/live.mjs                 # report on every backend
 *   node test/live.mjs --strict        # exit non-zero if no backend worked
 *   node test/live.mjs --query "..."   # use a different query
 *
 * @module test/live.mjs
 */

import { searchBing } from '../src/backends/bing.js'
import { searchDuckDuckGo } from '../src/backends/duckduckgo.js'
import { searchSearxng } from '../src/backends/searxng.js'
import { searchWikipedia } from '../src/backends/wikipedia.js'
import { resolveConfig } from '../src/config.js'
import { FreeSearchProvider } from '../src/provider.js'

const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const queryIndex = argv.indexOf('--query')
const query = queryIndex >= 0 && argv[queryIndex + 1] !== undefined ? argv[queryIndex + 1] : 'DeepSeek Harness'

const options = resolveConfig({}, process.env)
const timeoutMs = options.timeoutMs
// Each probe below is an *independent* diagnostic, so each gets its own fresh
// deadline: sharing one would let a slow first probe consume the budget and
// report the rest as "skipped", which says nothing about those backends. The
// integrated chain behaviour — where the budget *is* shared and reserved — is
// reported separately by the provider section at the end.
const probeDeadline = () => Date.now() + options.totalTimeoutMs

console.log(`\ndsh-free-web-search — live backend check`)
console.log(`query: "${query}"  per-request timeout: ${timeoutMs}ms  per-probe budget: ${options.totalTimeoutMs}ms  strict: ${strict}\n`)

/** Run one backend and print a one-line verdict. */
async function probe(label, run) {
  const started = Date.now()
  try {
    const { sources, detail } = await run()
    const elapsed = Date.now() - started
    console.log(`  ok    ${label.padEnd(12)} ${String(sources.length).padStart(2)} sources in ${String(elapsed).padStart(5)}ms  (${detail})`)
    for (const source of sources.slice(0, 3)) {
      console.log(`          - ${source.title ?? '(no title)'}`)
      console.log(`            ${source.url}`)
    }
    return true
  } catch (error) {
    const elapsed = Date.now() - started
    console.log(`  FAIL  ${label.padEnd(12)} ${String(elapsed).padStart(5)}ms  ${error?.message ?? error}`)
    return false
  }
}

const results = []
results.push(
  await probe('searxng', async () => {
    const { sources, usedInstance } = await searchSearxng(query, {
      instances: options.searxngInstances,
      timeoutMs,
      deadline: probeDeadline(),
      userAgent: options.userAgent,
    })
    return { sources, detail: usedInstance }
  }),
)
results.push(
  await probe('bing', async () => {
    const { sources, usedEndpoint } = await searchBing(query, {
      timeoutMs,
      deadline: probeDeadline(),
      userAgent: options.userAgent,
      limit: options.maxResults,
    })
    return { sources, detail: `bing/${usedEndpoint}` }
  }),
)
results.push(
  await probe('duckduckgo', async () => {
    const { sources, usedEndpoint } = await searchDuckDuckGo(query, { timeoutMs, deadline: probeDeadline(), userAgent: options.userAgent })
    return { sources, detail: `duckduckgo/${usedEndpoint}` }
  }),
)
results.push(
  await probe('wikipedia', async () => {
    const { sources } = await searchWikipedia(query, {
      lang: options.wikipediaLang,
      timeoutMs,
      deadline: probeDeadline(),
      userAgent: options.userAgent,
    })
    return { sources, detail: `wikipedia/${options.wikipediaLang}` }
  }),
)

console.log('\nprovider chain (what a real web_search call would do)')
const provider = new FreeSearchProvider(() => options, () => undefined)
console.log(`  available(): ${provider.available()}`)
try {
  const result = await provider.search({ query, maxResults: 5 })
  console.log(`  resolved with ${result.sources.length} sources:`)
  for (const source of result.sources) console.log(`    - ${source.title ?? '(no title)'}\n      ${source.url}`)
} catch (error) {
  console.log(`  FAILED: ${error?.message ?? error}`)
}

const worked = results.filter(Boolean).length
console.log(`\n${worked}/${results.length} backends answered\n`)

if (strict && worked === 0) {
  console.error('strict mode: no backend answered')
  process.exit(1)
}
