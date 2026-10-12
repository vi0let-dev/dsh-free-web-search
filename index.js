/**
 * dsh-free-web-search — Host half.
 *
 * Adds a key-less web search provider to DeepSeek Harness by registering one
 * `WebSearchProvider` with the `ctx.web` capability seam. No account, no API
 * key, no billing: searches are served by public, free backends.
 *
 * ## Why this is a provider and not a tool
 *
 * The harness already owns the `web_search` tool, its permission prompt, its
 * result card, and the `maxResults` truncation. Registering into `ctx.web`
 * therefore reuses all of that instead of adding a second, parallel search tool
 * that would need its own UI and its own place in the model's prompt. The seam
 * picks the provider; the tool stays exactly as it was.
 *
 * ## Coexistence with the search providers that are already installed
 *
 * This is the part that needs care, because the seam refuses to guess between
 * two usable providers (`WEB_PROVIDER_AMBIGUOUS`). A plugin that registered
 * itself as unconditionally available would break a working installation the
 * moment it was enabled. The provider here is consequently a **fallback**: it
 * claims the slot only when it was explicitly selected, or when no other usable
 * search provider is registered. See `src/provider.js` for the full rules, and
 * the README for the two settings that change them.
 *
 * ## The provider id
 *
 * `free-web`. It is checked against the ids the host ships (`deepseek-official`
 * for search, `http` for fetch) and against the two third-party plugins in this
 * profile; it collides with none of them. The seam keys providers by id and
 * throws `WEB_DUPLICATE_PROVIDER` on a repeat, so this is the one identifier
 * that must stay unique.
 *
 * @module index.js
 */

import { resolveConfig, KNOWN_BACKENDS } from './src/config.js'
import { DEFAULT_BACKEND_ORDER } from './src/backends/index.js'
import { FREE_SEARCH_PROVIDER_ID, FreeSearchProvider } from './src/provider.js'
import { createProviderControl } from './src/provider-control.js'
import { readSettings, resolveHome } from './src/settings.js'
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, ROUTE_PREFIX, createHandler } from './src/routes.js'

/** Cordis plugin name, used by loader diagnostics. Must match the package name. */
export const name = 'dsh-free-web-search'

/**
 * The one service this plugin cannot exist without.
 *
 * Declaring `web` (rather than reaching for it opportunistically) makes the
 * loader keep this plugin dormant until the web capability seam is published,
 * and re-activate it if the seam is ever replaced. Nothing else is injected, so
 * a composition without a web server or a browser half simply has no search
 * provider to register.
 */
export const inject = ['web']

/** Re-exported so the id can be asserted in tests and referenced in config. */
export { FREE_SEARCH_PROVIDER_ID }

/**
 * Plugin entry point.
 *
 * @param ctx - the cordis context.
 * @param config - the loader's config object for this plugin.
 */
export function apply(ctx, config = {}) {
  const logger = ctx?.logger

  // Resolve lazily, on every operation, so a config change (or a re-`apply`
  // after the loader re-evaluates this entry) takes effect without needing to
  // unregister and re-register the provider — which would make the seam's
  // provider selection visibly flicker between calls.
  const resolveOptions = () => resolveConfig(config, process.env, logger)

  const getWeb = () => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get('web') : undefined
    } catch {
      return undefined
    }
  }

  const provider = new FreeSearchProvider(resolveOptions, getWeb)

  // `registerSearchProvider` returns a disposer. The seam also ties the
  // registration to the calling fiber, so the disposer is only needed for an
  // explicit early teardown; `ctx.effect` gives this plugin exactly that, and
  // makes the registration disappear cleanly if the plugin is unloaded.
  try {
    const dispose = ctx.web.registerSearchProvider(provider)
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => dispose, 'dsh-free-web-search: search provider')
    }
  } catch (error) {
    // The only expected failure is `WEB_DUPLICATE_PROVIDER`, which means an
    // earlier generation of this same plugin is still registered. Reporting it
    // as a warning leaves the host running with the previous provider rather
    // than failing the whole composition.
    logger?.warn?.(`free-web-search: could not register the search provider: ${error?.message ?? error}`)
    return
  }

  const options = resolveOptions()
  logger?.info?.(
    `free-web-search: registered search provider "${FREE_SEARCH_PROVIDER_ID}" ` +
      `(backends: ${options.backends.join(' -> ')}; takeover: ${options.takeover}; ` +
      `proxy: ${options.proxyUrl === '' ? 'direct' : 'configured'})`,
  )

  // The seam reads `searchProviderId` on every search, so this switch needs no
  // restart. It is the whole reason the settings page can offer "make default" and
  // "restore official" — see `src/provider-control.js` for why the automatic
  // fallback cannot be relied on instead.
  const control = createProviderControl({ getWeb, logger })

  // Re-apply a saved choice. Runs after registration so the seam can see us.
  try {
    control.applySaved(readSettings(resolveHome(process.env), logger))
  } catch (error) {
    logger?.warn?.(`free-web-search: could not apply the saved provider choice: ${error?.message ?? error}`)
  }

  // The settings page's API. Mounted only when a web server exists, so a headless
  // composition keeps working with the provider alone — the UI is a convenience,
  // not a requirement. `ctx.inject` is also optional: a context without it (a bare
  // test harness, or a minimal composition) simply gets no settings API.
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.webServer
      if (!server || typeof server.register !== 'function') return
      const handler = createHandler({
        // The route resolves options per request, so the page shows live
        // configuration rather than a snapshot taken at load.
        resolveOptions: () => ({
          ...resolveOptions(),
          knownBackends: [...KNOWN_BACKENDS],
          // The fresh-install default, so the UI's "restore defaults" cannot drift
          // from what the plugin actually defaults to.
          defaultBackends: [...DEFAULT_BACKEND_ORDER],
        }),
        control,
        logger,
      })
      scoped.effect(
        () => server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
        'dsh-free-web-search: routes',
      )
      logger?.info?.(`free-web-search: settings API mounted at ${ROUTE_PREFIX}`)
    })
  }
}

/** Exposed for the offline test suite; not part of the plugin's public surface. */
export const __internal = {
  FreeSearchProvider,
  resolveConfig,
  FREE_SEARCH_PROVIDER_ID,
  KNOWN_BACKENDS,
  ROUTE_PREFIX,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  createProviderControl,
}
