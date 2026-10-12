/**
 * Dependency-free HTML helpers for the free search backends.
 *
 * The plugin deliberately ships no HTML parser dependency: a third-party DSH
 * plugin lives inside the profile's `node_modules`, and every extra runtime
 * dependency is one more thing that can collide with — or be deduped against —
 * whatever the host and the other installed plugins already bring. The search
 * backends only need three things, so they are implemented here directly:
 *
 *   - entity decoding (including numeric forms),
 *   - tag stripping for titles and snippets,
 *   - locating elements by CSS class, which is all the DuckDuckGo result pages
 *     require to be parsed reliably.
 *
 * None of this is a general-purpose parser. It is scoped to the shapes the
 * backends actually receive, and every function is total: malformed input
 * yields fewer results, never a throw.
 *
 * @module src/html.js
 */

/** Named entities that appear in search result markup, beyond the XML five. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  dagger: '†',
  prime: '′',
  Prime: '″',
  minus: '−',
  shy: '\u00ad',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
}

/**
 * Decode HTML character references.
 *
 * Unknown or malformed references are left exactly as they were found, which is
 * what a browser does with an unrecognised entity name — dropping them would
 * silently corrupt otherwise-fine result text.
 *
 * @param input - text that may contain `&amp;`-style references.
 * @returns the decoded text; `''` for non-string input.
 */
export function decodeEntities(input) {
  if (typeof input !== 'string' || input === '') return ''
  return input.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35 /* '#' */) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const digits = isHex ? body.slice(2) : body.slice(1)
      const code = Number.parseInt(digits, isHex ? 16 : 10)
      // Reject surrogates and out-of-range code points rather than emitting
      // U+FFFD: the raw reference is more informative than a replacement char.
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole
      if (code >= 0xd800 && code <= 0xdfff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = NAMED_ENTITIES[body]
    if (named !== undefined) return named
    // HTML entity names are case-sensitive, but the XML five are commonly
    // upper-cased in hand-written markup; accept that spelling too.
    const lower = NAMED_ENTITIES[body.toLowerCase()]
    return lower === undefined ? whole : lower
  })
}

/**
 * Strip tags and collapse whitespace, yielding display-ready plain text.
 *
 * Tags are removed *before* entity decoding so that an escaped `&lt;script&gt;`
 * in the source ends up as literal text instead of being re-read as markup.
 *
 * @param html - fragment that may contain tags.
 * @returns single-line plain text; `''` for non-string input.
 */
export function stripTags(html) {
  if (typeof html !== 'string' || html === '') return ''
  const withoutTags = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim()
}

/**
 * Read one attribute value out of a raw tag-attribute string.
 *
 * Handles double-quoted, single-quoted and bare values, and any attribute
 * order — result markup is not consistent about quoting between the two
 * DuckDuckGo endpoints.
 *
 * @param attrs - the text between the tag name and the closing `>`.
 * @param name - the attribute name to look up (case-insensitive).
 * @returns the decoded value, or `undefined` when absent.
 */
export function attrValue(attrs, name) {
  if (typeof attrs !== 'string' || attrs === '') return undefined
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const match = pattern.exec(attrs)
  if (match === null) return undefined
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '')
}

/**
 * Collect every opening tag whose `class` contains the given class name.
 *
 * Returns positions rather than extracted text so that a caller can pair a
 * title anchor with the snippet that follows it — the only structural
 * relationship the DuckDuckGo pages reliably provide.
 *
 * @param html - the document (or fragment) to scan.
 * @param className - one exact class token to match.
 * @returns matches in document order, each with its offset and raw attributes.
 */
export function collectClassMatches(html, className) {
  const out = []
  if (typeof html !== 'string' || html === '') return out
  const tagPattern = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g
  let match
  while ((match = tagPattern.exec(html)) !== null) {
    const attrs = match[2]
    const classes = attrValue(attrs, 'class')
    if (classes === undefined) continue
    // Exact token match: `result__a` must not be matched by `result__a--x`.
    if (!classes.split(/\s+/).includes(className)) continue
    out.push({
      index: match.index,
      openEnd: match.index + match[0].length,
      tag: match[1].toLowerCase(),
      attrs,
      href: attrValue(attrs, 'href'),
    })
  }
  return out
}

/**
 * Extract the inner HTML of a match produced by {@link collectClassMatches}.
 *
 * When no closing tag is found the slice is capped, so a truncated or
 * pathological document degrades to a short string instead of the whole page.
 *
 * @param html - the same document the match came from.
 * @param match - a match from {@link collectClassMatches}.
 * @returns the raw inner HTML (not yet tag-stripped).
 */
export function innerOf(html, match) {
  if (typeof html !== 'string' || match === undefined || match === null) return ''
  const from = match.openEnd
  if (from >= html.length) return ''
  const closeTag = `</${match.tag}>`
  let to = html.indexOf(closeTag, from)
  if (to < 0) to = Math.min(html.length, from + 1200)
  return html.slice(from, to)
}

/**
 * Drop duplicate sources, keeping the first occurrence of each URL.
 *
 * Several backends legitimately return the same page twice (mirrors, anchors,
 * or a repeated hit); the seam renders every entry it is given.
 *
 * @param sources - candidate sources in preference order.
 * @returns a new array with one entry per distinct URL.
 */
export function dedupeSources(sources) {
  const seen = new Set()
  const out = []
  for (const source of sources) {
    if (source === null || source === undefined) continue
    const url = typeof source.url === 'string' ? source.url : ''
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    out.push(source)
  }
  return out
}
