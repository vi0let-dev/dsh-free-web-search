/**
 * A minimal React-compatible shim, for testing the browser half without a browser.
 *
 * ## Why this exists
 *
 * The plugin's `client.js` is a browser bundle that requires the `react` the DSH
 * shell provides. Neither this workspace nor the DSH runtime ships React, and the
 * plugin deliberately has no dependencies, so there is nothing to import in a
 * Node test. This shim fills that gap.
 *
 * ## What it is and is not
 *
 * It implements exactly what the panel uses — `createElement`, function
 * components, and the five hooks (`useState`, `useEffect`, `useCallback`,
 * `useMemo`, plus `useRef`) — and renders a tree to a string.
 *
 * It is **not** React. It will not catch invalid DOM attributes, accessibility
 * problems, or hook-order violations across re-renders. What it *does* catch is
 * the realistic failure class for this file: a missing dictionary key, a prop
 * that is undefined, a nested component referenced before it is defined, or a
 * conditional branch that throws. Those are the bugs that make a settings panel
 * render as a blank page, and they are all detectable from a single render pass.
 *
 * The honest summary: a pass here means the panel's logic is sound, not that the
 * markup is perfect.
 *
 * @module test/react-shim.mjs
 */

/**
 * Create a virtual element.
 *
 * @param type - a tag name, or a function component.
 * @param props - the element's props (may be null).
 * @param children - variadic children.
 * @returns a vnode.
 */
export function createElement(type, props, ...children) {
  const flattened = []
  for (const child of children) {
    if (Array.isArray(child)) flattened.push(...child.flat(Infinity))
    else if (child !== null && child !== undefined && child !== false) flattened.push(child)
  }
  return { type, props: { ...(props ?? {}), children: flattened.length === 1 ? flattened[0] : flattened } }
}

/** The hook state, persisted across render passes so a re-render keeps state. */
let currentHooks = []
let hookIndex = 0
/** Effects collected during the pass, run once afterwards. */
let pendingEffects = []
/** State updates requested during the pass (used to drive a second render). */
let pendingState = []
/** Force the next pass to run effects even if their deps are unchanged. */
let forceEffects = false

/** Set up a fresh render pass. Hook state persists; the read cursor does not. */
function beginPass({ reset = false } = {}) {
  if (reset) currentHooks = []
  hookIndex = 0
  pendingEffects = []
  forceEffects = false
  // Note: `pendingState` is deliberately NOT cleared here. It is the channel by
  // which a setter called during an async effect reaches the next pass, and
  // clearing it at the start of every pass would drop exactly those updates.
}

/**
 * Render one pass: reset the hook cursor, render, and collect what happened.
 *
 * Every render must go through this. Calling `renderNode` directly leaves
 * `hookIndex` where the previous pass ended, so the next pass reads *new* hook
 * slots instead of the same ones — state appears to reset and effects re-run on
 * every render.
 *
 * @param element - the root element.
 * @returns the HTML for this pass.
 */
function renderPass(element) {
  beginPass()
  return renderNode(element)
}

/** Take the next hook slot. */
function nextSlot(initial) {
  const index = hookIndex
  hookIndex += 1
  if (currentHooks[index] === undefined) currentHooks[index] = { value: initial, deps: undefined }
  return currentHooks[index]
}

export function useState(initial) {
  const slot = nextSlot(typeof initial === 'function' ? initial() : initial)
  const setter = (value) => {
    const next = typeof value === 'function' ? value(slot.value) : value
    if (next !== slot.value) pendingState.push({ slot, next })
  }
  return [slot.value, setter]
}

export function useRef(initial) {
  const slot = nextSlot({ current: initial })
  return slot.value
}

export function useMemo(factory, deps) {
  const slot = nextSlot(undefined)
  if (slot.value === undefined || !sameDeps(slot.deps, deps)) {
    slot.value = { result: factory() }
    slot.deps = deps
  }
  return slot.value.result
}

export function useCallback(fn, deps) {
  return useMemo(() => fn, deps)
}

export function useEffect(effect, deps) {
  const slot = nextSlot(undefined)
  if (forceEffects || slot.deps === undefined || !sameDeps(slot.deps, deps)) {
    slot.deps = deps
    pendingEffects.push(effect)
  }
}

/** Compare dependency arrays. */
function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/** Escape text for HTML output. */
function escape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/**
 * Render a value to an HTML string.
 *
 * Text is escaped, so a test can assert on `&#x27;` for a quote exactly as
 * `react-dom/server` would produce it.
 */
function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escape(node)
  if (Array.isArray(node)) return node.map(renderNode).join('')

  const { type, props } = node
  if (typeof type === 'function') return renderNode(type(props))

  // A host element.
  const attributes = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || value === undefined || value === null || value === false) continue
    if (key === 'key' || key === 'ref') continue
    if (typeof value === 'function') continue
    if (key === 'style' && typeof value === 'object') {
      // React serialises a style object to a CSS string.
      const css = Object.entries(value)
        .map(([prop, cssValue]) => `${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${cssValue}`)
        .join(';')
      attributes.push(`style="${escape(css)}"`)
      continue
    }
    if (value === true) {
      attributes.push(key)
      continue
    }
    attributes.push(`${key}="${escape(value)}"`)
  }
  const open = attributes.length > 0 ? `<${type} ${attributes.join(' ')}>` : `<${type}>`
  return `${open}${renderNode(props.children)}</${type}>`
}

/**
 * Render a component tree to a static HTML string.
 *
 * Runs effects after the pass and applies any synchronous state updates, then
 * renders again. For the panel's "load configuration, then show it" path, whose
 * effect is async, use {@link renderAsync} instead — this function cannot await.
 *
 * @param element - the root element.
 * @param options - `{ reset }` to start from fresh hook state.
 * @returns the HTML string.
 */
export function renderToStaticMarkup(element, options = {}) {
  if (options.reset === true) currentHooks = []
  pendingState = []
  let html = renderPass(element)
  for (const effect of pendingEffects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  }
  if (pendingState.length > 0) {
    for (const { slot, next } of pendingState) slot.value = next
    pendingState = []
    html = renderPass(element)
  }
  return html
}

/**
 * Render, then flush async effects, then render again — repeatedly.
 *
 * This is what makes the panel's real data path testable: its `useEffect` calls
 * an async loader and stores the result with `useState`, so the interesting markup
 * only exists after the promise settles. Each round awaits the pending effects,
 * flushes the microtask/macrotask queue until no new state lands, applies the
 * updates, and re-renders.
 *
 * The flush has to be generous. An effect written as `() => { void load() }`
 * returns `undefined` immediately while `load()` is still awaiting `fetch`, then
 * `response.text()`, then `JSON.parse` — so a single `await` is not enough and the
 * render would stay stuck on its loading state.
 *
 * @param element - the root element.
 * @param options - `{ rounds, settleTicks, reset }`.
 * @returns the final HTML string.
 */
export async function renderAsync(element, options = {}) {
  const rounds = Number.isInteger(options.rounds) ? options.rounds : 8
  const settleTicks = Number.isInteger(options.settleTicks) ? options.settleTicks : 20

  /**
   * Let queued promises and timers run to completion.
   *
   * Two details matter, and both were learned by getting them wrong:
   *
   *   - It must not return early when `pendingState` happens to be empty: an async
   *     effect is still in flight at that instant, and bailing out there is exactly
   *     what leaves a component stuck on its loading state.
   *   - It must yield to *timers*, not only to `setImmediate`. A chain of
   *     `setImmediate` ticks can complete in well under a millisecond, so an
   *     effect awaiting even a short `setTimeout` would not have finished.
   *
   * So each tick awaits a real (zero-delay) timer, which drains both the microtask
   * queue and any timer already due.
   */
  const settle = async () => {
    for (let tick = 0; tick < settleTicks; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  beginPass({ reset: true })
  pendingState = []
  let html = renderPass(element)

  for (let round = 0; round < rounds; round += 1) {
    const effects = pendingEffects
    pendingEffects = []

    for (const effect of effects) {
      effect()
    }
    // Let whatever the effects started actually finish before looking for updates.
    if (effects.length > 0) await settle()

    if (pendingState.length === 0) {
      // Nothing changed and nothing is pending: the tree is stable.
      if (effects.length === 0) break
      continue
    }

    for (const { slot, next } of pendingState) slot.value = next
    pendingState = []
    html = renderPass(element)
  }
  return html
}

/** Exposed so tests can inspect hook state if they need to. */
export const __internals = { escape, sameDeps }
