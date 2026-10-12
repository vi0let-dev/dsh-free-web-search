/**
 * Runtime control over which search provider the seam selects.
 *
 * ## The problem this solves
 *
 * The seam picks a provider by these rules (from `@deepseek-ai/dsh-web`):
 *
 *   - a configured id that is registered and `available()` → that provider;
 *   - no id configured, exactly one usable provider → that one;
 *   - no id configured, several usable → `WEB_PROVIDER_AMBIGUOUS`.
 *
 * This plugin was designed as a *fallback*: it reports `available()` only when no
 * other provider is usable, so that installing it on a working setup changes
 * nothing. That reasoning depended on the official provider honestly reporting
 * itself unavailable when it has no credential — and **it does not**:
 *
 *     available() {
 *       return ((options.apiKey?.length ?? 0) > 0
 *            || options.resolveApiKey !== void 0      // always a function → true
 *            || options.resolveAccountToken !== void 0 // always a function → true
 *       ) && URL.canParse(...) && ...
 *     }
 *
 * The provider always supplies those two resolver functions, so both checks are
 * constant-true. The official provider therefore claims to be usable even with no
 * API key, and only fails once a search actually runs — with
 * `WEB_PROVIDER_CREDENTIAL_MISSING`.
 *
 * The consequence for a user: on a machine with no DeepSeek credential, adding a
 * working key-less provider changes nothing, because the seam still prefers the
 * official one and it still fails. Hence the two explicit actions below.
 *
 * ## How the switch is performed
 *
 * `WebRuntime.search()` reads `this.searchProviderId` on **every call**, not at
 * construction, so assigning to that field takes effect immediately and needs no
 * restart. This is the same field the seam itself reads, and reading it is already
 * how `available()` decides whether to stay dormant.
 *
 * The value in effect *before* this plugin touches anything is captured once and
 * remembered, so "restore official" puts back whatever the composition actually
 * had — including `undefined`, which is the true unconfigured default, and
 * including a value that came from `$DSH_WEB_SEARCH_PROVIDER`. Hardcoding
 * `deepseek-official` would be wrong both for a composition that never registered
 * it and for one that was pointed somewhere else deliberately.
 *
 * @module src/provider-control.js
 */

import { FREE_SEARCH_PROVIDER_ID } from './provider.js'

/** A stable id, so `settings.searchProvider` has one accepted value. */
export const FREE_PROVIDER_ALIAS = FREE_SEARCH_PROVIDER_ID

/**
 * Create the control object.
 *
 * @param options - `{ getWeb, logger }`, where `getWeb()` returns the live seam.
 * @returns the control surface used by the routes and by `apply()`.
 */
export function createProviderControl({ getWeb, logger } = {}) {
  /**
   * The id that was in effect before this plugin first changed it.
   *
   * `undefined` is a meaningful value — it means "nothing was configured", which
   * is the seam's real default. A boolean "captured yet?" flag is therefore kept
   * separately rather than testing this for `undefined`.
   */
  let originalId
  let captured = false

  /** Read the live seam, tolerating its absence. */
  const web = () => {
    try {
      return getWeb?.()
    } catch {
      return undefined
    }
  }

  /** Read the seam's current selection. */
  const currentId = () => {
    const service = web()
    try {
      const id = service?.searchProviderId
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Remember what was selected before we interfere.
   *
   * Called before every change. It deliberately does **not** record this plugin's
   * own id: after a hot reload the seam may still hold our value from the previous
   * generation, and recording that would make "restore official" restore *us*.
   */
  const capture = () => {
    const id = currentId()
    if (id === FREE_PROVIDER_ALIAS) return
    if (captured) return
    originalId = id
    captured = true
  }

  /** Write a selection, reporting whether the seam was reachable. */
  const assign = (id) => {
    const service = web()
    if (service === undefined) return { ok: false, error: 'the web capability seam is not available' }
    try {
      service.searchProviderId = id
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `could not set the search provider: ${error?.message ?? error}` }
    }
  }

  return {
    /** Every registered provider id, for display and for validation. */
    registered() {
      const service = web()
      try {
        const store = service?.searchProviders
        return store instanceof Map ? [...store.keys()] : []
      } catch {
        return []
      }
    },

    /** The id currently selected, or `undefined` when the seam would choose. */
    current: currentId,

    /** True when this plugin's provider is the one in effect. */
    isFreeActive() {
      return currentId() === FREE_PROVIDER_ALIAS
    },

    /**
     * Whether the official provider is registered here at all.
     *
     * Reported so the UI can warn honestly instead of offering a restore that
     * would fail: setting a configured id that is not registered raises
     * `WEB_PROVIDER_CONFIGURED_MISSING`.
     */
    hasOfficial() {
      const ids = this.registered()
      return ids.some((id) => id !== FREE_PROVIDER_ALIAS)
    },

    /**
     * Make this plugin's provider the default.
     *
     * @returns `{ ok, current }` or `{ ok: false, error }`.
     */
    setDefault() {
      capture()
      const result = assign(FREE_PROVIDER_ALIAS)
      if (!result.ok) return result
      logger?.info?.(`free-web-search: search provider set to "${FREE_PROVIDER_ALIAS}"`)
      return { ok: true, current: FREE_PROVIDER_ALIAS }
    },

    /**
     * Hand selection back to whatever was in effect before.
     *
     * Restoring `undefined` removes the explicit choice, so the seam resumes its
     * own selection — which picks the official provider, because this plugin
     * deliberately reports itself unavailable while another provider is usable.
     *
     * @returns `{ ok, current, restored }` or `{ ok: false, error }`.
     */
    restoreOfficial() {
      const target = captured ? originalId : undefined
      const result = assign(target)
      if (!result.ok) return result
      logger?.info?.(
        `free-web-search: search provider restored to ${target === undefined ? 'the seam default (unconfigured)' : `"${target}"`}`,
      )
      return { ok: true, current: target, restored: target ?? null }
    },

    /**
     * Apply a persisted choice on load.
     *
     * Only `free-web` is acted on. The stored `official` is a *reversion marker*
     * meaning "the user chose the official default", and the way to honour that is
     * to leave `searchProviderId` alone so the seam selects normally — not to write
     * the literal id, which would break a composition that never registered it.
     *
     * @param settings - the settings object read from disk.
     */
    applySaved(settings) {
      capture()
      if (settings?.searchProvider === FREE_PROVIDER_ALIAS) {
        assign(FREE_PROVIDER_ALIAS)
      }
      // `official`, or nothing stored: leave the seam exactly as configured.
    },

    /** Exposed so a test can assert the captured value. */
    capturedOriginal() {
      return captured ? originalId : undefined
    },
  }
}
