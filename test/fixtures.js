/**
 * Offline test fixtures.
 *
 * These are trimmed-down but structurally faithful copies of what each backend
 * actually receives. They are deliberately *not* idealized: the DuckDuckGo pages
 * include the redirector links, an ad slot, and internal navigation that the
 * parser is expected to discard, and the SearxNG payload includes an entry with
 * no URL. A fixture that only contained perfect input would test nothing.
 *
 * @module test/fixtures.js
 */

/** A `html.duckduckgo.com/html/` page: redirector links, one ad, one nav link. */
export const DDG_HTML_PAGE = `<!DOCTYPE html>
<html><body>
<div class="nav-link"><a href="https://duckduckgo.com/about">About</a></div>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F&rut=abc">Node.js API docs</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F">The official <b>Node.js</b> API reference &amp; documentation.</a>
</div>
<div class="result result--ad">
  <a class="result__a" href="https://ads.example.com/promo">Sponsored: buy something</a>
  <a class="result__snippet">An advertisement that must not be treated as a result.</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FJavaScript">MDN Web Docs &mdash; JavaScript</a>
  </h2>
  <a class="result__snippet">JavaScript (JS) is a lightweight interpreted language with first-class functions.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="https://example.org/no-snippet">A result with no snippet</a>
</div>
<div class="result results_links">
  <a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=internal">Internal DDG link</a>
  <a class="result__snippet">Should be filtered because it points back at DuckDuckGo.</a>
</div>
</body></html>`

/** A `lite.duckduckgo.com/lite/` page: table layout, different class names. */
export const DDG_LITE_PAGE = `<html><body><table>
<tr><td class="result-link"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2F">Rust Programming Language</a></td></tr>
<tr><td class="result-snippet">A language empowering everyone to build reliable and efficient software.</td></tr>
<tr><td class="result-link"><a href="https://en.wikipedia.org/wiki/Rust_(programming_language)">Rust (programming language) - Wikipedia</a></td></tr>
<tr><td class="result-snippet">Rust is a multi-paradigm, general-purpose programming language.</td></tr>
</table></body></html>`

/** The anti-automation interstitial. */
export const DDG_BLOCK_PAGE = `<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>`

/**
 * A `www.bing.com/search` page.
 *
 * Includes the three link shapes the parser must distinguish: a `ck/a` click
 * tracker carrying a base64url `u=` payload, a tracker with no recoverable
 * target (an ad), and a plain link. Also includes a header link outside any
 * `b_algo` block, and one result whose caption class is absent (falling back to
 * the `<p>`), which is the variant Bing serves for some result types.
 *
 * The base64url payloads below decode to the URLs named in each comment.
 */
export const BING_PAGE = `<!DOCTYPE html>
<html><head><title>test - Search</title></head><body>
<header><a href="https://www.bing.com/images/search?q=test">Images</a></header>
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc123&amp;u=a1aHR0cHM6Ly9ub2RlanMub3JnL2FwaS8&amp;ntb=1">Node.js API docs</a></h2>
    <div class="b_caption"><p>The official <strong>Node.js</strong> API reference &amp; documentation.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=ad999&amp;u=">Sponsored: buy something</a></h2>
    <div class="b_caption"><p>An advertisement with no recoverable target.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript">MDN Web Docs &mdash; JavaScript</a></h2>
    <div class="b_caption"><p>JavaScript (JS) is a lightweight interpreted language.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=xyz&amp;u=a1aHR0cHM6Ly93d3cucHl0aG9uLm9yZy8">Welcome to Python.org</a></h2>
    <p>The official home of the Python Programming Language.</p>
  </li>
  <li class="b_algo">
    <h2><a href="https://www.bing.com/maps?q=test">Bing Maps</a></h2>
    <div class="b_caption"><p>Internal Bing navigation, not a result.</p></div>
  </li>
</ol>
<aside><h2><a href="https://www.bing.com/search?q=related">Related searches</a></h2></aside>
</body></html>`

/** Bing's captcha / consent interstitial. */
export const BING_BLOCK_PAGE = `<html><body><form id="captcha"><h1>Verify you are human</h1></form></body></html>`

/** A Bing page that returned 200 but whose layout no longer yields results. */
export const BING_REDESIGNED_PAGE = `<html><body><div id="b_results"><div class="new-result-shape">redesigned</div></div></body></html>`

/**
 * Google's "JavaScript required" shell.
 *
 * A faithful reduction of what `www.google.com/search` actually returned through
 * a working proxy on this machine: ~93 KB, 2 `<div>`s, 0 `<h3>`, 0 `class="g"`,
 * and a `<noscript>` redirect to `/httpservice/retry/enablejs`. The results are
 * fetched by script afterwards, so nothing parseable is present.
 */
export const GOOGLE_JS_SHELL = `<!DOCTYPE html><html lang="en-JP"><head><title>Google Search</title><style>body{background-color:var(--xhUGwc)}</style><script nonce="x">window.google = window.google || {};</script></head><body><noscript><style>table,div,span,p{display:none}</style><meta content="0;url=/httpservice/retry/enablejs?sei=abc" http-equiv="refresh"><div style="display:block">Please click <a href="/httpservice/retry/enablejs?sei=abc">here</a> if you are not redirected within a few seconds.</div></noscript><script nonce="x">(function(){var sctm=false;})();</script></body></html>`

/** Google's consent wall. */
export const GOOGLE_CONSENT_PAGE = `<html><head><title>Before you continue</title></head><body><form action="https://consent.google.com/m"><input name="continue"></form></body></html>`

/** A SearxNG `/search?format=json` response, including an entry with no URL. */
export const SEARXNG_JSON = {
  query: 'test',
  number_of_results: 4,
  results: [
    {
      url: 'https://www.python.org/',
      title: 'Welcome to Python.org',
      content: 'The official home of the Python Programming Language.',
      engine: 'google',
      publishedDate: '2024-01-02T00:00:00',
    },
    { url: 'https://docs.python.org/3/', title: 'Python 3 documentation', content: 'Official documentation.', engine: 'bing' },
    { url: '', title: 'Broken entry with no URL', content: 'Must be skipped.' },
    { title: 'Also broken: no url field at all', content: 'Must be skipped.' },
    { url: 'https://peps.python.org/', title: 'PEP Index', engine: 'duckduckgo' },
  ],
}

/** SearxNG's HTML error page, served with HTTP 200 when JSON output is disabled. */
export const SEARXNG_HTML_ERROR = `<!DOCTYPE html><html><body><h1>Error!</h1><p>Invalid format.</p></body></html>`

/** A Wikipedia `list=search` response. */
export const WIKI_SEARCH_JSON = {
  batchcomplete: '',
  query: {
    search: [
      { ns: 0, title: 'JavaScript', snippet: '<span class="searchmatch">JavaScript</span> is a programming language.', timestamp: '2024-05-01T12:00:00Z' },
      { ns: 0, title: 'ECMAScript', snippet: 'Specification for <span class="searchmatch">JavaScript</span>.', timestamp: '2024-04-01T12:00:00Z' },
    ],
  },
}

/** The batched Wikipedia `prop=extracts|info` response. */
export const WIKI_DETAIL_JSON = {
  query: {
    pages: {
      '1': {
        pageid: 1,
        title: 'JavaScript',
        fullurl: 'https://en.wikipedia.org/wiki/JavaScript',
        extract: 'JavaScript, often abbreviated as JS, is a programming language and core technology of the Web.',
      },
      '2': {
        pageid: 2,
        title: 'ECMAScript',
        fullurl: 'https://en.wikipedia.org/wiki/ECMAScript',
        extract: 'ECMAScript is a standard for scripting languages.',
      },
    },
  },
}
