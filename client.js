/**
 * dsh-free-web-search — browser half.
 *
 * A settings panel in three sections:
 *
 *   1. **Proxy** — type a host and port, test it, save it, or clear the override.
 *   2. **Backends** — tick the engines to enable and order them, then save.
 *   3. **Speed test** — probe every enabled backend and show a ranked report with
 *      a recommendation the user can apply with one click.
 *
 * ## Where edits are saved
 *
 * Not into `cordis.patch.yml`. That file belongs to the DSH loader, holds the
 * user's other plugin entries, and is hand-edited; a plugin rewriting it could
 * corrupt the profile. Saves go to the plugin's own file instead:
 *
 *     $DSH_HOME/dsh-free-web-search/settings.json
 *
 * That file takes precedence over `cordis.patch.yml`, and the panel says so and
 * offers "clear override" to hand control back. Nothing is changed silently:
 * every section has an explicit save, and the speed test only *offers* an order.
 *
 * ## Layout
 *
 * `grid-template-columns: repeat(auto-fit, minmax(...))` and `flex-wrap` rather
 * than media queries, so the panel adapts to the settings pane's own width rather
 * than the window's. Colours come from `currentColor` and inherited text styles,
 * so light and dark themes both work without special-casing.
 */

window.__ModuleLoader__.load({
  id: 'dsh-free-web-search',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dshFreeWebSearch'
    const API = '/api/dsh-free-web-search'
    const inject = ['slots', 'locale']

    /** Human-readable names, so the UI is not a list of ids. */
    const BACKEND_LABELS = {
      searxng: { zh: 'SearxNG（元搜索，需配实例）', en: 'SearxNG (metasearch, needs an instance)' },
      google: { zh: 'Google（通常需要代理）', en: 'Google (usually needs a proxy)' },
      bing: { zh: 'Bing', en: 'Bing' },
      baidu: { zh: '百度（中文最佳）', en: 'Baidu (best for Chinese)' },
      yandex: { zh: 'Yandex（常被验证码拦）', en: 'Yandex (often captcha-blocked)' },
      duckduckgo: { zh: 'DuckDuckGo', en: 'DuckDuckGo' },
      wikipedia: { zh: 'Wikipedia（仅百科类）', en: 'Wikipedia (encyclopedic only)' },
    }

    // ── Copy ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '免费搜索',
        title: '免费 Web 搜索',
        subtitle: '无需 API key 的搜索后端。这里的修改只写入本插件自己的设置文件，不会改动 cordis.patch.yml。',
        loading: '正在读取配置…',
        loadFailed: '读取配置失败',
        retry: '重试',

        sectionProvider: '默认搜索服务',
        providerHelp:
          '决定 web_search 用哪家搜索。DeepSeek 官方搜索需要 API key 或账号登录态；本插件的搜索不需要。官方提供方即使没有 key 也会自称「可用」，所以缝隙会一直优先选它——必须在这里手动切换。',
        providerFreeActive: '本插件搜索（免密钥）',
        providerOfficialActive: 'DeepSeek 官方搜索',
        providerMakeDefault: '设为本插件搜索',
        providerRestoreOfficial: '恢复 DeepSeek 官方',
        providerWorking: '正在切换…',
        providerSaved: '已切换',
        providerNoOfficial:
          '提示：当前没有注册其它搜索提供方。恢复后仍会继续使用本插件（缝隙会退回「只有一个可用提供方」的规则），搜索不会中断。',

        sectionProxy: '代理',
        proxyConfigured: '已配置',
        proxyNone: '未配置（直连）',
        proxyHostLabel: '代理地址',
        proxyPlaceholder: '例如 127.0.0.1:7890',
        proxyHelp: '填 host:port 即可，默认按 HTTP 代理处理；也支持 http://、https://、socks5://、socks5h://。清空并保存表示强制直连。',
        proxySave: '保存代理',
        proxySaving: '正在保存…',
        proxySaved: '已保存',
        proxyTest: '测试代理',
        proxyTesting: '正在测试…',
        proxyOk: '代理可用',
        proxyFail: '代理不可用',
        proxyUseDirect: '改为直连',

        sectionBackends: '搜索后端',
        backendsHelp: '勾选要启用的后端，用箭头调整顺序。靠前的先被尝试，第一个给出结果的胜出。',
        backendsSave: '保存顺序',
        backendsSaved: '已保存',
        backendsReset: '恢复默认',
        backendsEmpty: '至少要勾选一个后端。',
        unusedHint: '未启用的后端不会参与搜索，也不会被测速。',

        sectionSpeed: '延迟测试',
        speedHelp: '点击按钮后，逐个连接每个已启用后端的服务器，测量 TCP 连接、TLS 握手与首字节时间。不发任何搜索请求，也不使用查询词。',
        speedRun: '开始测速',
        speedRunning: '正在测速…（并发探测，最多约 {n} 秒）',
        speedFailed: '测速失败',
        speedNeedsBackends: '请先勾选至少一个后端。',
        colBackend: '后端',
        colStatus: '状态',
        colLatency: '总延迟',
        colConnect: '连接',
        colTls: 'TLS',
        colProxy: '代理',
        colDetail: '说明',
        statusOk: '可达',
        statusTimeout: '超时',
        statusUnreachable: '不可达',
        statusError: '失败',
        statusAborted: '已取消',
        best: '最快',
        suggested: '按延迟排序',
        unchanged: '与当前顺序一致',
        changed: '与当前顺序不同',
        applySuggestion: '采用此顺序',
        applied: '已采用',
        reasoning: '判断依据',
        snippet: '配置片段（供参考，可粘贴到 cordis.patch.yml）',
        copy: '复制',
        copied: '已复制',
        penalty: '排序依据：仅按总延迟；未响应的后端排最后。',
        notApplied: '测速不会改动任何配置；只有点击「采用此顺序」才会保存。',
        reachabilityCaveat:
          '注意：这只测「能不能连通、有多快」，不代表「能不能搜到结果」。实测中 Google 会返回不含结果的 JavaScript 空壳页、Yandex 会返回验证码、公开 SearxNG 实例可能关闭了 JSON 输出——它们都可能显示为「可达」。所以仅按延迟排序，可能把一个快但不可用的后端排到前面。',
        noteDirect: '直连',
      },
      en: {
        nav: 'Free search',
        title: 'Free web search',
        subtitle: 'Key-less search backends. Changes here go to this plugin\'s own settings file and never touch cordis.patch.yml.',
        loading: 'Reading configuration…',
        loadFailed: 'Could not read the configuration',
        retry: 'Retry',

        sectionProvider: 'Default search service',
        providerHelp:
          'Decides which service answers web_search. DeepSeek\'s official search needs an API key or an account sign-in; this plugin\'s search needs neither. The official provider reports itself as available even without a key, so the seam keeps preferring it — switching has to be explicit.',
        providerFreeActive: 'This plugin (key-less)',
        providerOfficialActive: 'DeepSeek official search',
        providerMakeDefault: 'Use this plugin',
        providerRestoreOfficial: 'Restore DeepSeek official',
        providerWorking: 'Switching…',
        providerSaved: 'Switched',
        providerNoOfficial:
          'Note: no other search provider is registered. Restoring still keeps this plugin in use — the seam falls back to its "exactly one usable provider" rule — so search is not interrupted.',

        sectionProxy: 'Proxy',
        proxyConfigured: 'configured',
        proxyNone: 'not configured (direct)',
        proxyHostLabel: 'Proxy address',
        proxyPlaceholder: 'e.g. 127.0.0.1:7890',
        proxyHelp: 'host:port is enough and is treated as an HTTP proxy; http://, https://, socks5:// and socks5h:// also work. Saving an empty value forces direct connections.',
        proxySave: 'Save proxy',
        proxySaving: 'Saving…',
        proxySaved: 'Saved',
        proxyTest: 'Test proxy',
        proxyTesting: 'Testing…',
        proxyOk: 'Proxy works',
        proxyFail: 'Proxy failed',
        proxyUseDirect: 'Use direct',

        sectionBackends: 'Backends',
        backendsHelp: 'Tick the engines to enable and reorder them with the arrows. Earlier backends are tried first; the first to return results wins.',
        backendsSave: 'Save order',
        backendsSaved: 'Saved',
        backendsReset: 'Restore defaults',
        backendsEmpty: 'Select at least one backend.',
        unusedHint: 'Disabled backends are not searched and are not probed.',

        sectionSpeed: 'Latency test',
        speedHelp: 'Connects to each enabled backend\'s own server and times the TCP connect, the TLS handshake and the first byte. It sends no search request and uses no query term.',
        speedRun: 'Run latency test',
        speedRunning: 'Testing… (concurrent probes, up to about {n}s)',
        speedFailed: 'Latency test failed',
        speedNeedsBackends: 'Select at least one backend first.',
        colBackend: 'Backend',
        colStatus: 'Status',
        colLatency: 'Total',
        colConnect: 'Connect',
        colTls: 'TLS',
        colProxy: 'Proxy',
        colDetail: 'Detail',
        statusOk: 'reachable',
        statusTimeout: 'timed out',
        statusUnreachable: 'unreachable',
        statusError: 'failed',
        statusAborted: 'cancelled',
        best: 'fastest',
        suggested: 'Ordered by latency',
        unchanged: 'matches the current order',
        changed: 'differs from the current order',
        applySuggestion: 'Apply this order',
        applied: 'Applied',
        reasoning: 'Why',
        snippet: 'Config snippet (for reference; pasteable into cordis.patch.yml)',
        copy: 'Copy',
        copied: 'Copied',
        penalty: 'Ordered by total latency alone; backends that did not respond sort last.',
        notApplied: 'The test changes nothing; only “Apply this order” saves.',
        reachabilityCaveat:
          'Note: this measures reachability and speed only, not whether results can actually be returned. Measured in practice: Google answers with a JavaScript-only page containing no results, Yandex answers with a captcha, and a public SearxNG instance may have JSON output disabled — all of which can still show as "reachable". Ordering purely by latency can therefore put a fast but unusable backend first.',
        noteDirect: 'direct',
      },
    }

    // ── Same-origin API ─────────────────────────────────────────────────────
    /**
     * The host requires this marker header. A cross-site request cannot set a
     * custom header without a CORS preflight, and the host never answers one, so
     * this closes the "any page silently reconfigures your search" path.
     */
    const CLIENT_HEADERS = { 'x-dsh-free-web-search': '1' }

    async function api(pathname, body) {
      const response = await fetch(`${API}${pathname}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { ...CLIENT_HEADERS } : { ...CLIENT_HEADERS, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        payload = { error: text.slice(0, 300) }
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    // ── Styles ──────────────────────────────────────────────────────────────
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 2px 32px', maxWidth: '980px' },
      header: { display: 'flex', flexDirection: 'column', gap: '4px' },
      h: { margin: 0, fontSize: '16px', fontWeight: 600 },
      sub: { margin: 0, fontSize: '12px', opacity: 0.65, lineHeight: 1.65 },
      card: {
        border: '1px solid currentColor',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        minWidth: 0,
      },
      cardSoft: {
        border: '1px solid currentColor',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        minWidth: 0,
        opacity: 0.96,
      },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
      sectionTitle: { fontSize: '13px', fontWeight: 600, letterSpacing: '0.01em' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      label: { fontSize: '12px', fontWeight: 600, opacity: 0.85 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px', wordBreak: 'break-all' },
      muted: { fontSize: '12px', opacity: 0.65, lineHeight: 1.65 },
      input: {
        flex: '1 1 220px',
        minWidth: '180px',
        padding: '6px 9px',
        border: '1px solid currentColor',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12.5px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      },
      button: {
        border: '1px solid currentColor',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        padding: '5px 12px',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        border: '1px solid currentColor',
        borderRadius: '6px',
        // A translucent fill with inherited text. See `pillStrong` for why
        // `background: currentColor` + `color: Canvas` was invisible.
        background: 'rgba(127,127,127,0.22)',
        color: 'inherit',
        padding: '5px 12px',
        fontSize: '12px',
        cursor: 'pointer',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      },
      buttonSmall: {
        border: '1px solid currentColor',
        borderRadius: '5px',
        background: 'transparent',
        color: 'inherit',
        padding: '2px 7px',
        fontSize: '11px',
        cursor: 'pointer',
        lineHeight: 1.5,
      },
      buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' },
      pill: { border: '1px solid currentColor', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', whiteSpace: 'nowrap' },
      /**
       * A filled pill.
       *
       * The fill is a translucent grey rather than `currentColor`, and the text is
       * `inherit`. `background: currentColor` would resolve to this element's OWN
       * `color` — and pairing that with `color: Canvas` made background and text the
       * same colour, so the pill (and every primary button, which shared the bug)
       * rendered invisible in both light and dark themes.
       */
      pillStrong: {
        border: '1px solid currentColor',
        borderRadius: '999px',
        padding: '1px 8px',
        fontSize: '11px',
        background: 'rgba(127,127,127,0.22)',
        color: 'inherit',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: {
        textAlign: 'left',
        padding: '6px 8px',
        borderBottom: '1px solid currentColor',
        fontWeight: 600,
        fontSize: '11px',
        opacity: 0.75,
        whiteSpace: 'nowrap',
      },
      thNum: {
        textAlign: 'right',
        padding: '6px 8px',
        borderBottom: '1px solid currentColor',
        fontWeight: 600,
        fontSize: '11px',
        opacity: 0.75,
        whiteSpace: 'nowrap',
      },
      td: { padding: '6px 8px', borderBottom: '1px solid currentColor', verticalAlign: 'top' },
      tdNum: {
        padding: '6px 8px',
        borderBottom: '1px solid currentColor',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      pre: {
        margin: 0,
        padding: '10px 12px',
        border: '1px solid currentColor',
        borderRadius: '6px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11.5px',
        lineHeight: 1.6,
        overflowX: 'auto',
        whiteSpace: 'pre',
      },
      list: { margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: 1.7, opacity: 0.85 },
      notice: { border: '1px solid currentColor', borderRadius: '6px', padding: '8px 11px', fontSize: '12px', lineHeight: 1.6 },
      backendRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        padding: '6px 8px',
        border: '1px solid currentColor',
        borderRadius: '6px',
        minWidth: 0,
      },
      backendName: { flex: '1 1 auto', minWidth: 0, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      checkbox: { width: '14px', height: '14px', margin: 0, flex: '0 0 auto', accentColor: 'currentColor' },
      orderBadge: { flex: '0 0 auto', fontSize: '11px', opacity: 0.55, fontVariantNumeric: 'tabular-nums', minWidth: '16px', textAlign: 'right' },
      savedFlash: { fontSize: '11.5px', opacity: 0.75 },
    }

    /** Human-readable duration. */
    function formatMs(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      if (ms < 1000) return `${Math.round(ms)} ms`
      return `${(ms / 1000).toFixed(2)} s`
    }

    /** Which status pill style to use. */
    function statusStyle(status) {
      return status === 'ok' ? S.pillStrong : S.pill
    }

    /** Translate a probe status. */
    function statusLabel(status, t) {
      const map = {
        ok: 'statusOk',
        timeout: 'statusTimeout',
        unreachable: 'statusUnreachable',
        error: 'statusError',
        aborted: 'statusAborted',
      }
      return t(map[status] ?? 'statusError')
    }

    /** A backend's display name, falling back to its id. */
    function backendLabel(backend, locale) {
      const entry = BACKEND_LABELS[backend]
      if (entry === undefined) return backend
      return entry[locale] ?? entry.en
    }

    /** A button that renders its own disabled state. */
    function Button({ style, disabled, onClick, children, primary, small }) {
      const base = primary ? S.buttonPrimary : small ? S.buttonSmall : S.button
      return h(
        'button',
        {
          type: 'button',
          style: disabled === true ? { ...base, ...S.buttonDisabled } : base,
          disabled: disabled === true,
          onClick: disabled === true ? undefined : onClick,
        },
        children,
      )
    }

    /** A short-lived "saved" indicator. */
    function useFlash(timeoutMs = 1800) {
      const [on, setOn] = useState(false)
      const timer = useRef(null)
      const flash = useCallback(() => {
        setOn(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => setOn(false), timeoutMs)
      }, [timeoutMs])
      useEffect(
        () => () => {
          if (timer.current !== null) clearTimeout(timer.current)
        },
        [],
      )
      return [on, flash]
    }

    // ── Panel ───────────────────────────────────────────────────────────────
    function FreeSearchPage(props) {
      const t = props?.t ?? ((key) => key)
      const locale = typeof props?.locale === 'string' && props.locale.startsWith('zh') ? 'zh' : 'en'

      const [config, setConfig] = useState(null)
      const [loadError, setLoadError] = useState(null)

      // Proxy editing.
      const [proxyInput, setProxyInput] = useState('')
      const [proxyBusy, setProxyBusy] = useState(false)
      const [proxyResult, setProxyResult] = useState(null)
      const [proxySaved, flashProxySaved] = useFlash()

      // Which provider answers web_search.
      const [providerBusy, setProviderBusy] = useState(false)
      const [providerError, setProviderError] = useState(null)
      const [providerSaved, flashProviderSaved] = useFlash()

      // Backend selection.
      const [selected, setSelected] = useState([])
      const [backendsSaved, flashBackendsSaved] = useFlash()

      // Speed test.
      const [busy, setBusy] = useState(false)
      const [report, setReport] = useState(null)
      const [testError, setTestError] = useState(null)
      const [copied, setCopied] = useState(false)
      const [applied, flashApplied] = useFlash()

      /** Load the configuration and seed the editable fields from it. */
      const load = useCallback(async () => {
        setLoadError(null)
        try {
          const next = await api('/config')
          setConfig(next)
          // Seed from `proxyRaw`, not the redacted `proxy`: the redacted form
          // contains `********`, and saving that back would overwrite the real
          // password with asterisks.
          setProxyInput(typeof next.proxyRaw === 'string' ? next.proxyRaw : '')
          setSelected(Array.isArray(next.backends) ? [...next.backends] : [])
        } catch (error) {
          setLoadError(error?.message ?? String(error))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const testProxy = useCallback(async (candidate) => {
        setProxyBusy(true)
        setProxyResult(null)
        try {
          const payload = candidate === undefined || candidate === '' ? {} : { proxy: candidate }
          setProxyResult(await api('/proxy-check', payload))
        } catch (error) {
          setProxyResult({ reachable: false, message: error?.message ?? String(error) })
        } finally {
          setProxyBusy(false)
        }
      }, [])

      /** Save settings, then reload so the UI shows what actually took effect. */
      const save = useCallback(
        async (patch) => {
          const result = await api('/settings', patch)
          await load()
          return result
        },
        [load],
      )

      const saveProxy = useCallback(async () => {
        setProxyBusy(true)
        try {
          await save({ proxy: proxyInput })
          flashProxySaved()
          setProxyResult(null)
        } catch (error) {
          setProxyResult({ reachable: false, message: error?.message ?? String(error) })
        } finally {
          setProxyBusy(false)
        }
      }, [proxyInput, save, flashProxySaved])

      const useDirect = useCallback(async () => {
        setProxyBusy(true)
        try {
          await save({ proxy: '' })
          flashProxySaved()
          setProxyResult(null)
        } catch (error) {
          setProxyResult({ reachable: false, message: error?.message ?? String(error) })
        } finally {
          setProxyBusy(false)
        }
      }, [save, flashProxySaved])

      /** Make this plugin the provider the seam uses. */
      const makeDefault = useCallback(async () => {
        setProviderBusy(true)
        setProviderError(null)
        try {
          await api('/provider/default', {})
          await load()
          flashProviderSaved()
        } catch (error) {
          setProviderError(error?.message ?? String(error))
        } finally {
          setProviderBusy(false)
        }
      }, [load, flashProviderSaved])

      /** Hand selection back to the seam's own default (the official provider). */
      const restoreOfficial = useCallback(async () => {
        setProviderBusy(true)
        setProviderError(null)
        try {
          await api('/provider/official', {})
          await load()
          flashProviderSaved()
        } catch (error) {
          setProviderError(error?.message ?? String(error))
        } finally {
          setProviderBusy(false)
        }
      }, [load, flashProviderSaved])

      const saveBackends = useCallback(async () => {
        if (selected.length === 0) {
          setTestError(t('backendsEmpty'))
          return
        }
        try {
          await save({ backends: selected })
          flashBackendsSaved()
          setTestError(null)
        } catch (error) {
          setTestError(error?.message ?? String(error))
        }
      }, [selected, save, flashBackendsSaved, t])

      /** Move a backend within the selection. */
      const move = useCallback((index, delta) => {
        setSelected((current) => {
          const target = index + delta
          if (target < 0 || target >= current.length) return current
          const next = [...current]
          const [item] = next.splice(index, 1)
          next.splice(target, 0, item)
          return next
        })
      }, [])

      /** Toggle a backend's membership in the selection. */
      const toggle = useCallback((backend) => {
        setSelected((current) =>
          current.includes(backend) ? current.filter((entry) => entry !== backend) : [...current, backend],
        )
      }, [])

      const runTest = useCallback(async () => {
        if (selected.length === 0) {
          setTestError(t('speedNeedsBackends'))
          return
        }
        setBusy(true)
        setTestError(null)
        try {
          // Probe exactly what is selected, so the test matches the user's intent
          // rather than the last saved configuration.
          setReport(await api('/latency', { backends: selected }))
        } catch (error) {
          setTestError(error?.message ?? String(error))
        } finally {
          setBusy(false)
        }
      }, [selected, t])

      const applySuggestion = useCallback(async () => {
        if (report?.suggestedOrder === undefined) return
        try {
          await save({ backends: report.suggestedOrder })
          flashApplied()
        } catch (error) {
          setTestError(error?.message ?? String(error))
        }
      }, [report, save, flashApplied])

      const copySnippet = useCallback(async () => {
        if (report?.snippet === undefined) return
        try {
          await navigator.clipboard.writeText(report.snippet)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard unavailable: the text is on screen anyway */
        }
      }, [report])

      const estimateSeconds = useMemo(() => {
        const perBackend = report?.timeoutMs ?? 8000
        return Math.ceil(perBackend / 1000) + 2
      }, [report])

      if (config === null && loadError === null) {
        return h('div', { style: S.wrap }, h('div', { style: S.muted }, t('loading')))
      }
      if (loadError !== null) {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.notice }, `${t('loadFailed')}: ${loadError}`),
          h('div', { style: S.row }, h(Button, { onClick: () => void load() }, t('retry'))),
        )
      }

      const known =
        Array.isArray(config.knownBackends) && config.knownBackends.length > 0
          ? config.knownBackends
          : ['searxng', 'google', 'bing', 'baidu', 'yandex', 'duckduckgo', 'wikipedia']
      // "Restore defaults" must restore the plugin's *fresh-install* default, which
      // is a small subset of `known` — not every backend. The list comes from the
      // host so it cannot drift from `DEFAULT_BACKEND_ORDER`.
      const defaultBackends =
        Array.isArray(config.defaultBackends) && config.defaultBackends.length > 0
          ? config.defaultBackends
          : ['bing']
      const hasProxy = config.proxyConfigured === true
      const freeActive = config.freeActive === true
      // Whether there is another provider to hand control back to. Restoring when
      // there is none would set a configured id that is not registered, and the seam
      // then fails EVERY search with WEB_PROVIDER_CONFIGURED_MISSING — strictly
      // worse than leaving this plugin in place, so the button is disabled.
      const canRestore = config.officialAvailable !== false
      // Known backends that are not selected still need a row, so they can be
      // re-enabled; selected ones come first, in the user's chosen order.
      const unselected = known.filter((backend) => !selected.includes(backend))

      return h(
        'div',
        { style: S.wrap },

        // ── Header ──
        h('div', { style: S.header }, h('h3', { style: S.h }, t('title')), h('p', { style: S.sub }, t('subtitle'))),

        // ── Which provider answers web_search ──
        // Placed first because it is the switch that decides whether this plugin is
        // used at all. It exists because the seam keeps preferring the official
        // provider even when that provider has no credential — see the README.
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.cardHead },
            h('span', { style: S.sectionTitle }, t('sectionProvider')),
            h(
              'span',
              { style: freeActive ? S.pillStrong : S.pill },
              freeActive ? t('providerFreeActive') : t('providerOfficialActive'),
            ),
          ),
          h('div', { style: S.muted }, t('providerHelp')),

          providerError !== null ? h('div', { style: S.notice }, providerError) : null,

          h(
            'div',
            { style: S.row },
            h(
              Button,
              { primary: !freeActive, disabled: providerBusy || freeActive, onClick: () => void makeDefault() },
              providerBusy ? t('providerWorking') : freeActive ? `✓ ${t('providerFreeActive')}` : t('providerMakeDefault'),
            ),
            h(
              Button,
              {
                // Only gated on whether this plugin is active — there is nothing to
                // restore *from* otherwise. It is deliberately NOT disabled when no
                // other provider is registered: clearing the id is harmless there
                // (the seam falls back to its "exactly one usable provider" rule and
                // keeps using this plugin), verified against the real seam.
                disabled: providerBusy || !freeActive,
                onClick: () => void restoreOfficial(),
              },
              t('providerRestoreOfficial'),
            ),
            providerSaved ? h('span', { style: S.savedFlash }, `✓ ${t('providerSaved')}`) : null,
          ),

          // Say what the restore means when nothing else is registered, without
          // pretending the action is unavailable.
          canRestore ? null : h('div', { style: S.muted }, t('providerNoOfficial')),
        ),

        // ── Proxy ──
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.cardHead },
            h('span', { style: S.sectionTitle }, t('sectionProxy')),
            h('span', { style: hasProxy ? S.pillStrong : S.pill }, hasProxy ? t('proxyConfigured') : t('proxyNone')),
          ),

          h(
            'div',
            { style: S.row },
            h('input', {
              type: 'text',
              style: S.input,
              value: proxyInput,
              placeholder: t('proxyPlaceholder'),
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': t('proxyHostLabel'),
              onChange: (event) => setProxyInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void saveProxy()
              },
            }),
            h(Button, { primary: true, disabled: proxyBusy, onClick: () => void saveProxy() }, proxyBusy ? t('proxySaving') : t('proxySave')),
            h(
              Button,
              { disabled: proxyBusy, onClick: () => void testProxy(proxyInput) },
              proxyBusy ? t('proxyTesting') : t('proxyTest'),
            ),
            h(Button, { disabled: proxyBusy, onClick: () => void useDirect() }, t('proxyUseDirect')),
          ),

          proxySaved ? h('div', { style: S.savedFlash }, `✓ ${t('proxySaved')}`) : null,

          h('div', { style: S.muted }, t('proxyHelp')),

          proxyResult !== null
            ? h(
                'div',
                { style: S.notice },
                h('div', { style: S.label }, proxyResult.reachable === true ? t('proxyOk') : t('proxyFail')),
                h('div', { style: S.muted }, proxyResult.message ?? ''),
                typeof proxyResult.latencyMs === 'number' && proxyResult.reachable === true
                  ? h('div', { style: S.muted }, `${t('colLatency')}: ${formatMs(proxyResult.latencyMs)}`)
                  : null,
              )
            : null,
        ),

        // ── Backends ──
        h(
          'div',
          { style: S.card },
          // No "current order" line here: the list below already shows the order,
          // with a numbered badge on each row, so repeating it above was noise.
          h('div', { style: S.cardHead }, h('span', { style: S.sectionTitle }, t('sectionBackends'))),
          h('div', { style: S.muted }, t('backendsHelp')),

          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            // Selected, in order, with reorder controls.
            selected.map((backend, index) =>
              h(
                'div',
                { key: backend, style: S.backendRow },
                h('input', {
                  type: 'checkbox',
                  style: S.checkbox,
                  checked: true,
                  'aria-label': backendLabel(backend, locale),
                  onChange: () => toggle(backend),
                }),
                h('span', { style: S.orderBadge }, String(index + 1)),
                h('span', { style: S.backendName, title: backend }, backendLabel(backend, locale)),
                h(Button, { small: true, disabled: index === 0, onClick: () => move(index, -1) }, '↑'),
                h(Button, { small: true, disabled: index === selected.length - 1, onClick: () => move(index, 1) }, '↓'),
              ),
            ),
            // Known but disabled, so they can be re-enabled.
            unselected.map((backend) =>
              h(
                'div',
                { key: backend, style: { ...S.backendRow, opacity: 0.55 } },
                h('input', {
                  type: 'checkbox',
                  style: S.checkbox,
                  checked: false,
                  'aria-label': backendLabel(backend, locale),
                  onChange: () => toggle(backend),
                }),
                h('span', { style: S.orderBadge }, '–'),
                h('span', { style: S.backendName, title: backend }, backendLabel(backend, locale)),
              ),
            ),
          ),
          unselected.length > 0 ? h('div', { style: S.muted }, t('unusedHint')) : null,

          h(
            'div',
            { style: S.row },
            h(Button, { primary: true, onClick: () => void saveBackends() }, t('backendsSave')),
            h(Button, { onClick: () => setSelected([...defaultBackends]) }, t('backendsReset')),
            backendsSaved ? h('span', { style: S.savedFlash }, `✓ ${t('backendsSaved')}`) : null,
          ),
        ),

        // ── Speed test ──
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.cardHead },
            h('span', { style: S.sectionTitle }, t('sectionSpeed')),
            h(
              Button,
              { primary: true, disabled: busy, onClick: () => void runTest() },
              busy ? t('speedRunning').replace('{n}', String(estimateSeconds)) : t('speedRun'),
            ),
          ),
          h('div', { style: S.muted }, t('speedHelp')),

          testError !== null ? h('div', { style: S.notice }, `${t('speedFailed')}: ${testError}`) : null,

          report !== null
            ? h(SpeedReport, { report, t, copied, onCopy: copySnippet, onApply: applySuggestion, applied })
            : null,
        ),
      )
    }

    /** The ranked table, the recommendation, and the snippet. */
    function SpeedReport({ report, t, copied, onCopy, onApply, applied }) {
      const results = report.results ?? []
      const bestName = report.best ?? null
      const suggested = report.suggestedOrder ?? []

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },

        h(
          'table',
          { style: S.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { style: S.th }, t('colBackend')),
              h('th', { style: S.th }, t('colStatus')),
              h('th', { style: S.thNum }, t('colLatency')),
              h('th', { style: S.thNum }, t('colConnect')),
              h('th', { style: S.thNum }, t('colTls')),
              h('th', { style: S.th }, t('colProxy')),
              h('th', { style: S.th }, t('colDetail')),
            ),
          ),
          h(
            'tbody',
            null,
            results.map((result) =>
              h(
                'tr',
                { key: result.backend },
                h(
                  'td',
                  { style: S.td },
                  h('span', { style: S.mono }, result.backend),
                  result.backend === bestName ? h('span', { style: { ...S.pillStrong, marginLeft: '6px' } }, t('best')) : null,
                ),
                h('td', { style: S.td }, h('span', { style: statusStyle(result.status) }, statusLabel(result.status, t))),
                h('td', { style: S.tdNum }, result.status === 'ok' ? formatMs(result.totalMs) : '—'),
                h('td', { style: S.tdNum }, result.status === 'ok' ? formatMs(result.connectMs) : '—'),
                h('td', { style: S.tdNum }, result.status === 'ok' && typeof result.tlsMs === 'number' ? formatMs(result.tlsMs - result.connectMs) : '—'),
                h('td', { style: S.td }, h('span', { style: S.mono }, result.usedProxy ?? t('noteDirect'))),
                h('td', { style: { ...S.td, ...S.muted } }, result.error ?? result.detail ?? ''),
              ),
            ),
          ),
        ),

        h('div', { style: S.muted }, t('penalty')),
        // The caveat is shown in the panel, not only in the docs: recommending a
        // fast-but-unusable backend would be a harmful suggestion.
        h('div', { style: S.notice }, t('reachabilityCaveat')),

        // ── Recommendation ──
        h(
          'div',
          { style: S.cardSoft },
          h(
            'div',
            { style: S.cardHead },
            h('span', { style: S.label }, t('suggested')),
            h('span', { style: report.changed === true ? S.pillStrong : S.pill }, report.changed === true ? t('changed') : t('unchanged')),
          ),
          h('div', { style: S.mono }, suggested.join(' → ')),

          Array.isArray(report.reasoning) && report.reasoning.length > 0
            ? h(
                'div',
                null,
                h('div', { style: S.label }, t('reasoning')),
                h('ul', { style: S.list }, report.reasoning.map((line, index) => h('li', { key: index }, line))),
              )
            : null,

          h(
            'div',
            { style: S.row },
            h(
              Button,
              { primary: true, disabled: report.changed !== true, onClick: () => void onApply() },
              applied ? `✓ ${t('applied')}` : t('applySuggestion'),
            ),
          ),

          h('div', { style: S.label }, t('snippet')),
          h('pre', { style: S.pre }, report.snippet ?? ''),
          h('div', { style: S.row }, h(Button, { onClick: () => void onCopy() }, copied ? t('copied') : t('copy'))),
          h('div', { style: S.muted }, t('notApplied')),
        ),
      )
    }

    // ── Navigation icon ─────────────────────────────────────────────────────
    /**
     * The shell draws a gear next to every settings section, so this plugin's
     * entry looked identical to "General settings". The shell offers no way to
     * supply an icon, so the gear is hidden and a magnifier drawn in its place.
     *
     * Mechanism: tag the nav button that carries this section's label, then use
     * CSS — `display:none` on the shell's `<svg>`, plus a `::before` masked with
     * our own glyph. `background-color: currentColor` makes the mask pick up the
     * theme's text colour, so it works in light and dark themes and in the
     * selected/unselected states without any colour hardcoding.
     *
     * The label match is what keeps this safe: the modal's own "Settings" trigger
     * is also a `<svg>` + `<span>` button, and it is left alone because its text
     * does not match this section's name.
     */
    const NAV_ATTR = 'data-dsh-free-web-search-nav'

    /** A magnifier, drawn to match the shell's own 16px stroke icons. */
    const SEARCH_GLYPH = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="11" cy="11" r="7"/>' +
        '<path d="M20 20l-3.6-3.6"/>' +
        '</svg>',
    )

    const NAV_ICON_CSS = [
      `button[${NAV_ATTR}] > svg { display: none !important; }`,
      `button[${NAV_ATTR}]::before {`,
      '  content: "";',
      '  flex: none;',
      '  width: 16px;',
      '  height: 16px;',
      '  background-color: currentColor;',
      `  -webkit-mask: url("data:image/svg+xml;charset=utf-8,${SEARCH_GLYPH}") center / 16px 16px no-repeat;`,
      `  mask: url("data:image/svg+xml;charset=utf-8,${SEARCH_GLYPH}") center / 16px 16px no-repeat;`,
      '}',
    ].join('\n')

    /**
     * Tag the nav button whose label matches this section.
     *
     * Only buttons shaped like a nav row are considered: an `<svg>` plus a
     * `<span>` whose text matches. Idempotent, so it is safe to re-run.
     *
     * @param root - what to search (the document, in a browser).
     * @param labels - the possible section labels, in every locale.
     * @returns how many buttons were newly tagged.
     */
    function tagNavButtons(root, labels) {
      if (!root || typeof root.querySelectorAll !== 'function') return 0
      let tagged = 0
      for (const button of root.querySelectorAll('button')) {
        if (button.getAttribute(NAV_ATTR) === '1') continue
        let hasIcon = false
        let label = ''
        for (const child of button.children ?? []) {
          const tag = String(child.tagName ?? '').toLowerCase()
          if (tag === 'svg') hasIcon = true
          else if (tag === 'span') label = child.textContent ?? ''
        }
        if (!hasIcon || !labels.includes(label.trim())) continue
        button.setAttribute(NAV_ATTR, '1')
        tagged += 1
      }
      return tagged
    }

    // ── Registration ────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-free-web-search: dictionaries')

      // Swap the shell's gear for a magnifier. Tied to the plugin's lifetime: the
      // style element is removed and the button tags are dropped on unload.
      ctx.effect(() => {
        if (typeof document === 'undefined' || !document.head) return () => {}
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-free-web-search')
        style.textContent = NAV_ICON_CSS
        document.head.appendChild(style)

        const labels = [DICT.zh.nav, DICT.en.nav]
        const patch = () => {
          try {
            tagNavButtons(document, labels)
          } catch {
            /* the shell changed shape: keep the gear, lose nothing else */
          }
        }
        patch()

        // The settings modal is portalled onto `body`, so watching body's direct
        // children catches each open and close. `subtree` is deliberately off: it
        // would fire on every DOM change during streaming.
        const timers = []
        let queued = 0
        const schedule = () => {
          if (queued !== 0) return
          queued = setTimeout(() => {
            queued = 0
            patch()
          }, 50)
        }
        let observer = null
        if (typeof MutationObserver === 'function' && document.body) {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true })
        }
        // Backstop for a mount that races React's batched commit.
        for (const delay of [120, 400, 1000]) timers.push(setTimeout(patch, delay))

        return () => {
          observer?.disconnect()
          if (queued !== 0) clearTimeout(queued)
          for (const timer of timers) clearTimeout(timer)
          style.remove()
          for (const button of document.querySelectorAll(`button[${NAV_ATTR}]`)) {
            button.removeAttribute(NAV_ATTR)
          }
        }
      }, 'dsh-free-web-search: nav icon')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-free-web-search',
            order: 42,
            label: () => t('nav'),
            locale: NS,
          },
          (props) => h(FreeSearchPage, { ...props, t }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-free-web-search'
    exports.__test = { FreeSearchPage, SpeedReport, formatMs, statusLabel, backendLabel, api, DICT, BACKEND_LABELS, NAV_ICON_CSS, NAV_ATTR, tagNavButtons }
    return module.exports
  },
})
