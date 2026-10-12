/**
 * Live verification of the new backends and the speed test.
 *
 * Not part of `npm test`: this one really does hit the network, and its results
 * are facts about the current network rather than assertions about the code.
 */
import { searchBaidu } from '../src/backends/baidu.js'
import { searchBing } from '../src/backends/bing.js'
import { searchGoogle } from '../src/backends/google.js'
import { searchYandex } from '../src/backends/yandex.js'
import { resolveConfig } from '../src/config.js'
import { runLatencyTest } from '../src/latency.js'

const query = process.argv[2] ?? 'DeepSeek Harness'
const options = resolveConfig({}, process.env)

console.log(`\nlive check — query: "${query}"\n`)

for (const [name, fn] of [
  ['google', searchGoogle],
  ['baidu', searchBaidu],
  ['yandex', searchYandex],
  ['bing', searchBing],
]) {
  const started = Date.now()
  try {
    const { sources } = await fn(query, { timeoutMs: 12000, limit: 5 })
    console.log(`  ok    ${name.padEnd(8)} ${String(sources.length).padStart(2)} sources in ${String(Date.now() - started).padStart(5)}ms`)
    for (const source of sources.slice(0, 2)) {
      console.log(`          - ${(source.title ?? '(no title)').slice(0, 80)}`)
      console.log(`            ${source.url.slice(0, 100)}`)
      if (source.snippet) console.log(`            ${source.snippet.slice(0, 110)}`)
    }
  } catch (error) {
    console.log(`  FAIL  ${name.padEnd(8)} ${String(Date.now() - started).padStart(5)}ms  ${(error?.message ?? error).slice(0, 160)}`)
  }
}

console.log('\n--- latency test (what the settings page runs; sends no query) ---')
const report = await runLatencyTest({ ...options, timeoutMs: 8000 })
for (const result of report.results) {
  const stage = result.status === 'ok' ? `connect=${result.connectMs}ms tls=${result.tlsMs - result.connectMs}ms` : ''
  console.log(
    `  ${result.backend.padEnd(11)} ${result.status.padEnd(12)} ${(result.status === 'ok' ? `${result.totalMs}ms` : '-').padStart(8)}  ` +
      `${stage.padEnd(28)} proxy=${result.usedProxy}` +
      (result.error ? `  ${result.error.slice(0, 60)}` : ''),
  )
}
console.log(`\nbest: ${report.best?.backend ?? '(none)'}`)
console.log(`suggested: ${report.suggestedOrder.join(' -> ')}`)
console.log(`changed: ${report.changed}`)
console.log('reasoning:')
for (const line of report.reasoning) console.log(`  - ${line}`)
