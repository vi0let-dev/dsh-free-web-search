/**
 * Extract the real `@deepseek-ai/dsh-web` seam out of the installed
 * `app.asar`, so `real-seam.mjs` can test against the actual selection
 * algorithm instead of a stand-in.
 *
 * This script is a *verification aid*, not part of the plugin. It exists as a
 * separate step on purpose: the seam's source belongs to DeepSeek Harness, not
 * to this plugin, so it is not committed here — it is read from the user's own
 * installation, at the moment they choose to run the integration test.
 *
 *   node test/extract-real-seam.mjs
 *
 * Writes to `test/real/node_modules/@deepseek-ai/dsh-web/lib/index.js`, which is
 * the only path the integration test imports. Safe to re-run; it overwrites.
 *
 * @module test/extract-real-seam.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

/** Candidate locations for the harness archive, most specific first. */
const ASAR_CANDIDATES = [
  process.env.DSH_ASAR,
  'D:\\DeepSeek Harness\\resources\\app.asar',
  'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar',
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
].filter((value) => typeof value === 'string' && value !== '')

/** Where inside the archive the seam lives. */
const ENTRY = '/dsh/node_modules/@deepseek-ai/dsh-web/lib/index.js'

/** Where the test expects to find it. */
const DEST = path.join(import.meta.dirname, 'real', 'node_modules', '@deepseek-ai', 'dsh-web', 'lib', 'index.js')

/**
 * Read one file out of an asar archive.
 *
 * An asar is a JSON header (with a UInt32 payload size at offset 12) followed by
 * the concatenated file contents; each entry records its offset and size
 * relative to the end of the header. Only the header is parsed, so this stays
 * fast on a 120 MB archive.
 *
 * @param archive - path to the `.asar` file.
 * @param entryPath - absolute path of the entry inside the archive.
 * @returns the file contents.
 * @throws {Error} when the archive is unreadable or the entry is absent.
 */
function readAsarEntry(archive, entryPath) {
  const fd = fs.openSync(archive, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 16)
    const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
    const base = 16 + headerSize

    let node = header
    for (const segment of entryPath.split('/').filter(Boolean)) {
      node = node?.files?.[segment]
      if (node === undefined) throw new Error(`entry not found in the archive: ${entryPath}`)
    }
    if (node.files !== undefined) throw new Error(`entry is a directory, not a file: ${entryPath}`)

    const size = Number(node.size)
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, base + Number(node.offset))
    return buf
  } finally {
    fs.closeSync(fd)
  }
}

let source
for (const candidate of ASAR_CANDIDATES) {
  if (!fs.existsSync(candidate)) continue
  source = candidate
  break
}

if (source === undefined) {
  console.error('Could not find app.asar. Tried:')
  for (const candidate of ASAR_CANDIDATES) console.error(`  ${candidate}`)
  console.error('\nSet DSH_ASAR to the full path of app.asar and re-run.')
  process.exit(1)
}

let contents
try {
  contents = readAsarEntry(source, ENTRY)
} catch (error) {
  console.error(`Failed to read the seam from ${source}: ${error.message}`)
  process.exit(1)
}

fs.mkdirSync(path.dirname(DEST), { recursive: true })
fs.writeFileSync(DEST, contents)

console.log(`extracted the real ctx.web seam`)
console.log(`  from: ${source}`)
console.log(`  to:   ${DEST}`)
console.log(`  size: ${contents.length} bytes`)
console.log(`\nNow run: node test/real-seam.mjs`)
