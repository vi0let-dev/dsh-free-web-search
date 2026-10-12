/**
 * Runtime settings store.
 *
 * ## Why this exists, and what it deliberately does not touch
 *
 * The settings page lets the user edit the proxy and choose backends, which means
 * the plugin must be able to **persist configuration**. The obvious place would be
 * `cordis.patch.yml` — but that file belongs to the DSH loader, holds the user's
 * other plugin entries, and is edited by hand. A third-party plugin rewriting it
 * would be surprising, and a bad write would corrupt the profile.
 *
 * So settings go to a file the plugin owns:
 *
 *     $DSH_HOME/dsh-free-web-search/settings.json
 *
 * The loader's config is never written to. Precedence, lowest to highest:
 *
 *     built-in defaults  <  environment  <  cordis.patch.yml  <  settings.json
 *
 * The UI value wins because it is the user's most recent explicit action, and the
 * page states this plainly so the precedence is never a mystery. A "clear
 * override" action removes the file, handing control back to `cordis.patch.yml`.
 *
 * ## Failure posture
 *
 * Every read is tolerant: a missing, empty, unreadable or corrupt file yields
 * "no overrides" rather than an error, because a bad settings file must never stop
 * the search provider from working. Every write is validated first, so a malformed
 * value cannot reach the file in the first place.
 *
 * @module src/settings.js
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parseProxy } from './proxy.js'
// The validation vocabulary, not the default-enabled set: a user must be able to
// select any backend the plugin knows, not only those enabled on a fresh install.
// Imported from the registry rather than `config.js`, because `config.js` imports
// this module — going the other way would create a cycle.
import { KNOWN_BACKENDS } from './backends/index.js'

/** Directory and file name under `$DSH_HOME`. */
const DIR_NAME = 'dsh-free-web-search'
const FILE_NAME = 'settings.json'

/** Refuse to read a settings file larger than this; it is a small JSON object. */
const MAX_FILE_BYTES = 64 * 1024

/**
 * Resolve `$DSH_HOME`, matching how the rest of the harness does it.
 *
 * @param env - an environment-like object.
 * @returns the absolute home directory.
 */
export function resolveHome(env = process.env) {
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * The settings file path for a home directory.
 *
 * @param home - the resolved home directory.
 * @returns the absolute path.
 */
export function settingsPath(home) {
  return path.join(home, DIR_NAME, FILE_NAME)
}

/** Coerce a boolean, accepting the spellings a JSON/hand-edited file may contain. */
function boolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true
    if (['0', 'false', 'no', 'off', ''].includes(lowered)) return false
  }
  return undefined
}

/**
 * Normalize a proxy value from settings.
 *
 * Three distinct outcomes, and the difference between them matters:
 *
 *   - `null`/`undefined` → **no override**. The key is dropped, so the loader
 *     config (or the environment) decides.
 *   - `''` or a bypass keyword (`direct`, `none`, …) → **an explicit bypass**,
 *     stored as `''`. This overrides a proxy configured in `cordis.patch.yml`,
 *     which is exactly what the UI's "Use direct" button must do. Getting this
 *     wrong (dropping the key instead) made that button silently do nothing.
 *   - a valid address → stored as written.
 *
 * @param value - the raw value.
 * @returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function normalizeProxySetting(value) {
  if (value === null || value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string') return { ok: false, error: 'the proxy must be a string' }
  const trimmed = value.trim()
  // An empty string is a deliberate "no proxy" override, not an absent setting.
  if (trimmed === '') return { ok: true, value: '' }
  if (['direct', 'none', 'off', 'no', 'bypass'].includes(trimmed.toLowerCase())) return { ok: true, value: '' }
  if (parseProxy(trimmed) === undefined) {
    return {
      ok: false,
      error: `"${trimmed}" is not a usable proxy (expected host:port, or http://, https://, socks5://, socks5h://)`,
    }
  }
  return { ok: true, value: trimmed }
}

/**
 * Normalize a per-backend proxy map from settings.
 *
 * @param value - the raw value.
 * @returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function normalizePerBackendSetting(value) {
  if (value === null || value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'proxyByBackend must be an object' }
  const out = {}
  for (const [backend, entry] of Object.entries(value)) {
    if (!KNOWN_BACKENDS.includes(backend)) return { ok: false, error: `unknown backend "${backend}"` }
    if (entry === null || entry === undefined || entry === '') {
      out[backend] = ''
      continue
    }
    const normalized = normalizeProxySetting(entry)
    if (!normalized.ok) return { ok: false, error: `${backend}: ${normalized.error}` }
    if (normalized.value !== undefined) out[backend] = normalized.value
  }
  return { ok: true, value: out }
}

/**
 * Normalize a backend order from settings.
 *
 * Unknown names are rejected rather than dropped: silently ignoring a typo would
 * make the saved order differ from what the user selected.
 *
 * @param value - the raw value.
 * @returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function normalizeBackendsSetting(value) {
  if (value === null || value === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(value)) return { ok: false, error: 'backends must be an array' }
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, error: 'every backend must be a string' }
    const name = entry.trim()
    if (!KNOWN_BACKENDS.includes(name)) return { ok: false, error: `unknown backend "${name}"` }
    if (out.includes(name)) continue
    out.push(name)
  }
  if (out.length === 0) return { ok: false, error: 'at least one backend must be selected' }
  return { ok: true, value: out }
}

/**
 * Normalize a whole settings object.
 *
 * @param raw - the parsed file contents, or any candidate object.
 * @returns `{ ok: true, settings }` or `{ ok: false, error }`.
 */
export function normalizeSettings(raw) {
  if (raw === null || raw === undefined) return { ok: true, settings: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'settings must be a JSON object' }

  const settings = {}

  if ('proxy' in raw) {
    const result = normalizeProxySetting(raw.proxy)
    if (!result.ok) return result
    // `undefined` means "no override"; `''` means "explicitly direct". Both must
    // be preserved distinctly, so this checks for `undefined` rather than falsy.
    if (result.value !== undefined) settings.proxy = result.value
  }
  if ('proxyByBackend' in raw) {
    const result = normalizePerBackendSetting(raw.proxyByBackend)
    if (!result.ok) return result
    if (result.value !== undefined) settings.proxyByBackend = result.value
  }
  if ('backends' in raw) {
    const result = normalizeBackendsSetting(raw.backends)
    if (!result.ok) return result
    if (result.value !== undefined) settings.backends = result.value
  }
  if ('noProxy' in raw) {
    const value = raw.noProxy
    if (value !== null && value !== undefined) {
      if (!Array.isArray(value)) return { ok: false, error: 'noProxy must be an array' }
      settings.noProxy = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
    }
  }
  for (const key of ['takeover', 'digest']) {
    if (key in raw) {
      const value = boolean(raw[key])
      if (value !== undefined) settings[key] = value
    }
  }
  if ('maxResults' in raw) {
    const value = Number.parseInt(String(raw.maxResults ?? ''), 10)
    if (Number.isInteger(value) && value > 0) settings.maxResults = Math.min(20, value)
  }
  if ('searchProvider' in raw) {
    const value = raw.searchProvider
    if (value === null || value === undefined || value === '') {
      // Absent / cleared means "no override": the seam keeps its own selection.
      // Not stored at all, so a cleared choice is indistinguishable from one that
      // was never made — which is exactly right.
    } else if (value === 'free-web') {
      settings.searchProvider = 'free-web'
    } else if (value === 'official') {
      // A sentinel rather than a provider id: "restore the official default" is a
      // *reversion*, and writing the literal `deepseek-official` would be wrong for
      // a composition that never registered it (the seam would then raise
      // WEB_PROVIDER_CONFIGURED_MISSING on every search). `official` means "clear
      // the override"; see `provider-control.js`.
      settings.searchProvider = 'official'
    } else {
      return { ok: false, error: `unknown searchProvider "${value}" (expected "free-web" or "official")` }
    }
  }

  return { ok: true, settings }
}

/**
 * Read the settings file.
 *
 * Never throws: a missing or corrupt file means "no overrides", which is exactly
 * how the plugin behaved before this feature existed.
 *
 * @param home - the resolved home directory.
 * @param logger - optional logger, used to report a corrupt file.
 * @returns the normalized settings object (possibly empty).
 */
export function readSettings(home, logger) {
  const file = settingsPath(home)
  let text
  try {
    const stat = fs.statSync(file)
    if (stat.size > MAX_FILE_BYTES) {
      logger?.warn?.(`free-web-search: ignoring ${file} — it is larger than ${MAX_FILE_BYTES} bytes`)
      return {}
    }
    // Strip a BOM: an editor may add one, and JSON.parse rejects it, which would
    // silently look like "the user's settings vanished".
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    logger?.warn?.(`free-web-search: ignoring ${file} — it is not valid JSON (${error.message})`)
    return {}
  }
  const result = normalizeSettings(parsed)
  if (!result.ok) {
    logger?.warn?.(`free-web-search: ignoring ${file} — ${result.error}`)
    return {}
  }
  return result.settings
}

/**
 * Write the settings file atomically.
 *
 * Writes to a temporary file in the same directory and renames it, so a crash
 * mid-write cannot leave a half-written file that would then read as corrupt.
 *
 * @param home - the resolved home directory.
 * @param settings - the validated settings object.
 * @throws {Error} when the file cannot be written.
 */
export async function writeSettings(home, settings) {
  const file = settingsPath(home)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await fsp.rename(temp, file)
}

/**
 * Delete the settings file, handing control back to `cordis.patch.yml`.
 *
 * @param home - the resolved home directory.
 * @returns true when a file was removed.
 */
export async function clearSettings(home) {
  try {
    await fsp.rm(settingsPath(home), { force: true })
    return true
  } catch {
    return false
  }
}

export { DIR_NAME, FILE_NAME }
