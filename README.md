# dsh-free-web-search

给 **DeepSeek Harness** 加一个**不需要任何 API key** 的 Web 搜索提供方，附带**代理支持**与**延迟测试**。

官方搜索走 DeepSeek 的 Anthropic 兼容接口，需要一个 `DEEPSEEK_API_KEY`（或账号登录态）。这个插件换一条路：向 `ctx.web` 搜索缝隙注册一个 `free-web` 提供方，由**公开的免费后端**来回答搜索。

```
free-web-search
      │
      ├─ 0. bing        bing.com/search（默认启用：无需配置、无需代理、实测稳定）
      │
      │  以下为可选后端，在设置页勾选后启用：
      ├─ 1. searxng     公开实例的 JSON API（元搜索，一次请求聚合多引擎）
      ├─ 2. google      google.com/search（通用覆盖最好；通常需要代理）
      ├─ 3. baidu       baidu.com/s（中文查询最强；实测可直连）
      ├─ 4. yandex      yandex.com/search（俄语有用；常被验证码拦）
      ├─ 5. duckduckgo  html / lite 结果页（无需配置，抓取型）
      └─ 6. wikipedia   MediaWiki 官方 API（最稳，但只覆盖百科类）
```

**默认只启用 `bing`。** 它是唯一「不需要配置实例、不需要代理」且实测能稳定回答的后端，所以新装即可用，不会把延迟预算花在当前网络里根本答不了的后端上。其余后端都在设置页里，一个勾选框之遥；延迟测试会告诉你哪些在你这儿可达。

按顺序尝试，第一个给出可用结果的胜出。**可选项的顺序按可靠性而非结果质量排**：能稳定回答的普通引擎，胜过经常失败的高级引擎——因为失败要先用延迟买单才能轮到下一个。

## 三个特性

### 1. 多后端（含 Google / 百度 / Yandex）

| 后端 | 类型 | 实测（本机，无代理） |
| --- | --- | --- |
| searxng | JSON API | ❌ 5 个公开实例全超时 |
| **google** | 抓取 | ⚠️ 见下（**JavaScript 壳页**） |
| **bing** | 抓取 | ✅ 10 条 / 546ms |
| **baidu** | 抓取 | ✅ 5 条 / 1077ms（中文结果正确） |
| **yandex** | 抓取 | ⚠️ HTTP 200 但是验证码页 |
| duckduckgo | 抓取 | ❌ 两端点全超时 |
| wikipedia | JSON API | ❌ 超时 |

**Baidu 的解析基于实测而非猜测。** 抓下真实结果页（1.2MB）后发现：结果容器带 `mu="真实URL"` 属性，所以**不需要跟随跳转**就能拿到目标地址。这很关键——另一种做法（逐个解析 `baidu.com/link?url=` 跳转）会把请求数乘以结果条数。

同时实测到 `c-container` 这个类名在页面里出现 **105 次**，大部分在嵌入的 CSS 和一个反馈表单里，所以解析器**要求容器必须带 `mu=` 属性**，而不是只匹配类名。

**Yandex 的结果解析器未经验证**（抓取时只拿到验证码页，没有结果标记可对照）。这一点在 `src/backends/yandex.js` 里明确写了。已验证的是**验证码路径**——这反而更重要，因为它让"被拦"被如实报告，而不是误报成"页面改版"。

### Google 的实测结论（重要）

配上可用代理后重测（代理 CONNECT 6ms 成功），Google **仍然拿不到结果**，但原因不是网络也不是解析器：

```
status: 200   最终 URL 正确   93,468 字节
<h3> 数量: 0      class="g" 数量: 0      <div> 数量: 2
<noscript> 重定向到 /httpservice/retry/enablejs
```

**Google 对这个客户端返回的是「需要 JavaScript」的空壳页**，结果由脚本异步拉取，HTML 里根本没有任何结果可解析。

而且这不是某个参数的问题——实测以下**全部**变体都返回同一个 93KB 空壳：默认请求、`gbv=1`、`udm=14`、`gbv=1&udm=14`、`nojs=1`、`complete=0`、`lite=1`、Android 客户端串、`source=hp`、以及纯 HTTP。**没有可回退的服务端渲染版本。**

所以插件把它识别为**独立的一种结果**，报错明确说：

> Google served a JavaScript-only page with no results in the HTML (the /httpservice/retry/enablejs shell).

而不是含糊地报 `layout may have changed`——后者会让人去改解析器，而问题不在解析器。这条诊断是实测驱动的，`isGoogleJavaScriptShell()` 有专门的测试和夹具。

**实际含义**：Google 后端的可用性取决于出口 IP 与客户端指纹，配代理**可能**有帮助（改变被分类的方式），但不保证。要可靠就用 SearxNG 实例（由实例去面对 Google），或者接受用 Bing / 百度。

### 2. 代理（默认空 = 直连）

`undici` 在 DSH 宿主运行时**无法导入**（`ERR_MODULE_NOT_FOUND`，已实测），所以 `fetch` + `ProxyAgent` 这条路走不通。Node 的实验性 `NODE_USE_ENV_PROXY` 也不能用：它在进程启动时读取一次，而这是个可能后来才拿到代理的长驻进程。

所以隧道是**手写的**（`node:net` / `node:tls` / `node:http`），依赖数仍然为 0：

- **HTTP / HTTPS 代理** — 走 `CONNECT`（Squid、mitmproxy、Charles、Fiddler、Clash HTTP 模式、企业代理）
- **SOCKS5 / SOCKS5H** — 走 SOCKS5 `CONNECT`（Clash、V2Ray、Shadowsocks 常只开 SOCKS 端口）
- **认证** — 两者都支持 `user:pass@`（HTTP Basic / SOCKS5 用户名密码子协商）
- **不支持的**：SOCKS4（无法远程解析域名，已被 socks5h 取代）、PAC 文件、代理客户端证书

配置：**全局代理 + 可按后端覆盖**

```yaml
- id: free-web-search
  name: 'dsh-free-web-search'
  config:
    proxy: 'http://127.0.0.1:7890'          # 全局默认，留空即直连
    proxyByBackend:
      baidu: 'direct'                        # 百度直连更快，不绕代理
      google: 'socks5://127.0.0.1:1080'      # 谷歌走 SOCKS5
    noProxy: ['internal.corp']               # 这些域名始终直连
```

也支持环境变量，且**已有的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 会被自动识别**（`useEnvProxy: false` 可关闭）。

### 3. 延迟测试（**只给建议，不改配置**）

点击「开始测速」后，插件**逐个连接每个已启用后端的服务器**，测量分段耗时：

| 阶段 | 含义 |
| --- | --- |
| **连接** | TCP 连接，或经代理的隧道建立（HTTP CONNECT / SOCKS5） |
| **TLS** | TLS 握手 |
| **总延迟** | 上述之和，加上首字节时间 |

**它不发任何搜索请求，也不使用查询词**——探测的是各服务的首页（`HEAD /`）。这里要回答的是「从这台机器访问这个服务有多快」，而不是「能搜到什么」。用 `HEAD` 而不是 `GET`，是因为首页动辄几百 KB，为了测延迟把七个页面都拉下来既慢又不礼貌；服务器回 `405` 也算可达。

**排序仅按总延迟**，未响应的后端排最后。插件只给建议 + 可复制的配置片段，决定权在你。

> ⚠️ **可达 ≠ 可用**，这一点界面上也会明说。实测中：Google 返回不含结果的 JavaScript 空壳页、Yandex 返回验证码、公开 SearxNG 实例可能关闭了 JSON 输出——**它们都会被测成「可达」**。所以只按延迟排序，可能把一个快但搜不到东西的后端排到前面。这也是插件不自动应用建议的原因。

## 设置页 UI

在 DSH 设置页新增「免费搜索」面板，四个分区：

1. **默认搜索服务** —— 两个按钮：设为本插件搜索 / 恢复 DeepSeek 官方。**这一项决定 web_search 到底用谁**，原因见上一节。
2. **代理** —— 输入框填 `host:port`，可保存 / 测试 / 改为直连。
3. **搜索后端** —— 勾选启用的后端，用箭头调序；显示人类可读名称。默认只勾 `bing`。
4. **延迟测试** —— 点击按钮探测，出排名表 + 建议 + 「采用此顺序」。

**侧栏图标**：外壳给每个设置分区画同一个齿轮，本插件那一项因此和「通用设置」长得一样。外壳没有提供设定图标的接口，所以插件把自己的导航按钮打上标记，用 CSS 隐藏齿轮、以 `mask` 画一个**放大镜**代替。图形用 `currentColor` 取色，明暗主题与选中态都自动适配；定位靠匹配分区名称，所以不会误伤弹窗自己的「设置」按钮。

「单独测试代理」是独立功能，因为「搜索失败」有两种原因、修法完全不同：**代理不通**（改代理）vs **代理正常但引擎拦截**（改代理没用）。混在一起报会让人去修错的东西。

### 修改写到哪里

**不写 `cordis.patch.yml`。** 那是 loader 的文件，还存着你其它插件条目，第三方插件去改写它既意外又容易写坏 profile。所以改动写入插件自己的文件：

```
$DSH_HOME/dsh-free-web-search/settings.json
```

优先级（低 → 高）：

```
内置默认值  <  环境变量  <  cordis.patch.yml  <  settings.json
```

设置文件优先，因为它是你在界面上的最近一次明确操作。**这是实现细节，界面不展示**——你在设置页看到的只有代理输入框和后端勾选框；文件路径、覆盖状态、清除按钮都已移除，避免把内部机制摊在用户面前。想回到配置文件的值，直接删除该文件即可。

## 安装

```powershell
cd $env:DSH_PROFILE_DIR
# package.json 的 dependencies 加一行：
#   "dsh-free-web-search": "<插件所在路径>"
# dsh.profile.bundles 加一行：
#   "dsh-free-web-search"
pnpm install
# 重启 DSH
```

> ⚠️ 本插件默认是**兜底姿态**：只在「显式选中」或「当前没有别的可用搜索提供方」时接管。你原本的 DeepSeek 搜索若正常，它会安静待命。要强制用它：`DSH_WEB_SEARCH_PROVIDER=free-web`。

## 配置项

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `backends` | `['bing']` | 启用的后端与顺序。未知名字丢弃并告警；**你给的顺序会被保留**，不再重排。 |
| `proxy` | `''`（直连） | 全局代理：`http://` `https://` `socks5://` `socks5h://` |
| `proxyByBackend` | `{}` | 按后端覆盖；`direct`/`none`/`off` = 该后端直连 |
| `noProxy` | `[]` | 始终直连的域名（父域名匹配） |
| `useEnvProxy` | `true` | 是否读取 `HTTPS_PROXY` 等环境变量 |
| `searxngInstances` | 5 个公开实例 | **建议换成自己搭的** |
| `timeoutMs` | `12000` | **单请求**超时（上限 60000） |
| `totalTimeoutMs` | `timeoutMs × 2` | **整条链**总预算（上限 120000） |
| `maxResults` | `5` | 结果条数（上限 20） |
| `wikipediaLang` | `en` | 中文用 `zh` |
| `takeover` | `false` | `true` = 无条件抢占搜索槽位 |
| `digest` | `false` | `true` = 额外把结果渲染成纯文本放进 `content` |

环境变量前缀 `DSH_FREE_WEB_SEARCH_`：`BACKENDS` `TIMEOUT_MS` `TOTAL_TIMEOUT_MS` `SEARXNG_INSTANCES` `WIKIPEDIA_LANG` `MAX_RESULTS` `TAKEOVER` `DIGEST` `PROXY` `NO_PROXY` `PROXY_BY_BACKEND`（形如 `google=http://a:1,baidu=direct`）`USE_ENV_PROXY`。

### 预算为什么是「预留式分配」

只设单请求超时不够：链上每多一个后端，最坏情况就多一份超时时间，几个后端就能把一次搜索拖到一分多钟。

但**单纯共享一个 deadline 也不够**——这是实测出来的：4 个后端、24s 预算时，5 个卡住的 SearxNG 实例把预算全吃光，后面三个后端全部报 `skipped`，**根本没被尝试**。这恰恰是最糟的失效模式，因为「第一个挂了、后面某个本来能work」正是这条链存在的唯一理由。

所以预算是**预留式**：每个后端只拿「剩余 − 给后面每个预留的一份」；快速失败把时间**还回池子**；预算小到无法预留时改为**平均分配**（短尝试还可能成功，不尝试必然失败）。

## 测试

```powershell
node test/smoke.mjs              # 离线单元测试，150 项，无需网络
node test/proxy-e2e.mjs          # 代理端到端，13 项，起真实本地代理
node test/client-render.mjs      # 设置页渲染，13 项，无需浏览器
node test/extract-real-seam.mjs  # 从你的 app.asar 抽出真实 ctx.web
node test/real-seam.mjs          # 对真实缝隙的集成测试，16 项
node test/live.mjs               # 联网体检（只报告不判定）
node test/live-new-backends.mjs  # 新后端 + 延迟测试的联网体检
node test/live-proxy.mjs 127.0.0.1:7890   # 带代理的联网体检
```

合计 **192 项**。

### 实测：本地 HTTP/SOCKS5 混合端口代理（`127.0.0.1:<port>`）

用真实代理跑过一轮，结论如下。

**写法**：`127.0.0.1:<port>` 直接可用——不带 scheme 会被按 HTTP 代理处理。Clash Verge 等混合端口同时支持 HTTP CONNECT 和 SOCKS5，所以下面四种写法都能用：

| 写法 | 解析结果 |
| --- | --- |
| `127.0.0.1:<port>` | `http://127.0.0.1:<port>` |
| `http://127.0.0.1:<port>` | `http://127.0.0.1:<port>` |
| `socks5://127.0.0.1:<port>` | `socks5://127.0.0.1:<port>` |
| `socks5h://127.0.0.1:<port>` | `socks5h://127.0.0.1:<port>` |

**代理确实生效**：实测出口 IP 在直连与走节点时**不同**（具体地址不外记录，见下）。

> 隐私说明：本文档早期版本写入了实测时的**真实出口 IP 与代理节点 IP**，以及本机用户名与工作区绝对路径。这些已在审计中移除——它们属于个人网络拓扑信息，对读者也毫无价值：你只需知道「直连与走代理的出口 IP 不同」即可判断代理是否生效，具体地址请用 `node test/live-proxy.mjs <你的代理>` 自己测。

**通过代理后的可用性**（实测，非推断）：

| 后端 | 直连 | 走代理 |
| --- | --- | --- |
| bing | ✅ | ✅ 3/3，约 700ms |
| baidu | ✅ | ✅（偶尔被拦） |
| **duckduckgo** | ❌ 超时 | ✅ **3/3，约 1100ms，10 条** |
| **wikipedia** | ❌ 超时 | ✅ **3/3，约 1750ms，5 条** |
| google | ❌ 超时 | ⚠️ HTTP 200 但是 JS 空壳页（见上） |
| searxng | ❌ 超时 | ⚠️ 能连上实例，但实例本身拒绝（JSON 关闭 / 403 / 429） |
| yandex | ⚠️ 验证码 | ⚠️ 仍是验证码 |

结论：**代理是有用的**——它把 DuckDuckGo 和 Wikipedia 从完全不可用变成了可用。

**这一轮实测抓出一个真 bug（已修）**：`searxng` / `bing` / `duckduckgo` / `wikipedia` 这四个**原有后端没有把 `proxy` 传给 HTTP 层**。我给新增的 google/baidu/yandex 加了代理支持，却漏了这四个，于是它们悄悄走直连，在任何"被墙"的网络里必然超时。

这个 bug 特别隐蔽：**桩掉 transport 的单元测试发现不了**——桩无论走不走代理都会回答。是拿真实代理跑才暴露的（wikipedia 走 `requestText` 6/6 成功、走 backend 0/6 失败，同一秒内交替测试）。现在 `smoke.mjs` 里有一条专门的回归测试，断言**每个后端都把 proxy 传下去**，并且我做了变异验证：把 bug 塞回去，测试确实会失败。

### 代理为什么要有端到端测试

**解析一个代理 URL 正确，完全不能证明请求能穿过它。** 手写的 CONNECT/SOCKS5 实现要在握手字节、认证子协商、TLS 分层上全部正确，而这些失败**在桩掉 socket 的单元测试里根本不会出现**。

所以 `proxy-e2e.mjs` 在回环上起**真实**的 HTTP CONNECT 代理和 SOCKS5 代理（都带认证），用运行时的 `node:crypto` 手搓一张自签证书起真实 HTTPS 源站，然后让插件的 HTTP 层真的穿过去。它覆盖：CONNECT 隧道、SOCKS5 隧道、Basic 认证、SOCKS5 用户名密码、407 / 凭据被拒 / 代理要求认证但没配、**域名以 0x03 地址类型发送**（证明是让代理解析而非本地解析）。

这套测试当场抓出两个真 bug：**插件把 `rejectUnauthorized` 硬编码成 `true`**（会静默破坏私有 CA 和企业拦截代理），以及测试自身泄漏 tunnel socket 导致 `server.close()` 永久挂起（现在有 90 秒看门狗把挂起变成可见失败）。

### 设置页为什么要渲染测试

**能通过语法检查的 bundle，不等于能用的 bundle。** 真正的失效模式是：字典缺一个键、某个 prop 是 undefined、嵌套组件在定义前被引用——这些都会让设置页渲染成一片空白，而 `node --check` 全都看不出来。

`client-render.mjs` 用 `test/react-shim.mjs` 真正渲染整棵组件树，并用 stub 的 fetch 走完「加载配置 → 显示」这条异步路径，断言代理、后端顺序、按钮、以及 host 报错都被渲染出来。它还校验 **zh/en 两份字典的键完全一致**——缺键正是最典型的空白页成因。

> React 不在工作区也不在 DSH 运行时里（由外壳在浏览器提供），所以 shim 是必需的。诚实地说：**渲染测试通过只说明面板逻辑没问题，不代表 markup 完美**——它不会发现非法的 DOM 属性或无障碍问题。这一点写在 shim 的文件注释里。

### 缝隙集成测试

`ctx.web` 的选人算法不属于本插件，用自己写的替身去测「我不会造成冲突」只能证明替身同意我的看法。所以 `real-seam.mjs` 直接从**你本机的 `app.asar`** 抽出 `@deepseek-ai/dsh-web` 的真实实现来驱动，验证官方提供方在场时搜索**仍然成功**（无 `WEB_PROVIDER_AMBIGUOUS`）。

> 抽出的缝隙源码是 DeepSeek Harness 的，不是本插件的，所以不入库——由 `extract-real-seam.mjs` 按需读取，已加进 `.gitignore`。

## 与已装插件共存，以及为什么必须手动切换

`ctx.web` 的选择逻辑**与注册顺序无关**，且**拒绝猜**：没配置 id 且有多个可用提供方时抛 `WEB_PROVIDER_AMBIGUOUS`。

本插件注册为**兜底**：只在显式选中、或没有别的可用搜索提供方时接管。

| id | 归属 |
| --- | --- |
| `deepseek-official` | DSH 自带搜索 |
| `http` | DSH 自带抓取 |
| **`free-web`** | **本插件** ✅ |

已核验：本 profile 里已装的两个第三方插件（`dsh-session-trash`、`dsh-our-free-model`）**都不碰 `ctx.web`**。**依赖数为 0**。

### 但兜底不会自动生效（重要）

最初的设想是：官方提供方没有 API key 时会报告自己不可用，于是兜底自动接管。**这个假设是错的**，实测从 `app.asar` 里读到的官方实现是：

```js
available() {
  return ((options.apiKey?.length ?? 0) > 0
       || options.resolveApiKey !== void 0        // 插件总是传函数 → 恒为真
       || options.resolveAccountToken !== void 0  // 同理 → 恒为真
  ) && URL.canParse(...) && ...
}
```

那两个 `!== void 0` **恒为真**（插件总会传入 resolver 函数），所以**官方提供方即使没有 key 也永远自称「可用」**，只在真正搜索时才抛 `WEB_PROVIDER_CREDENTIAL_MISSING`。

后果：在一台没有 DeepSeek 凭据的机器上，装了这个能用的免密钥搜索插件，**搜索仍然是坏的** —— 因为缝隙永远选官方，官方永远失败。

所以设置页第一项是 **「默认搜索服务」**，两个按钮：

- **设为本插件搜索** —— 让缝隙改用本插件
- **恢复 DeepSeek 官方** —— 交还控制权

切换是**立即生效**的：缝隙在**每次搜索时**读取 `searchProviderId`，不需要重启。

「恢复官方」的实现是**清除该 id**，而不是写入字面量 `deepseek-official`。后者在不曾注册官方提供方的组合里会让每次搜索都抛 `WEB_PROVIDER_CONFIGURED_MISSING`。清除则让缝隙回到自己的选择逻辑——并且如果此时只有本插件注册，缝隙会退回「恰好一个可用提供方」规则**继续用本插件**，搜索不中断（这一点是在真实缝隙上验证过的，所以那个按钮**不会**被禁用）。

设置页路由有三道闸（回环、Host 字面量防 DNS rebinding、自定义头防跨站）。

## 已知限制（说实话）

**1. 本机网络是选择性可达的。** 实测：bing ✅、baidu ✅、google ❌（无代理超时）、yandex ⚠️ 验证码、searxng/ddg/wikipedia ❌ 超时。所以是**这些域名的 DNS 或出网被拦**，不是整机断网。（这修正了我早先"整机没网"的错误判断——当时只有三个后端全部失败这一个样本。）

**2. Google 返回 JavaScript 空壳页，配代理也不一定能用。** 见上方「Google 的实测结论」。代理已实测可用（CONNECT 6ms），Google 仍返回无结果的空壳。要可靠请用 SearxNG。

**3. Yandex 结果解析器未经验证**（见上）。它默认启用但排在较后；若确认不可用，用 `backends` 去掉即可。

**4. 抓取型后端会因改版失效。** google / bing / baidu / yandex / duckduckgo 都是解析结果页。失效时报 `layout may have changed`——这条错误就是需要改代码的信号。搜索引擎改版是常态，这是抓取路线的固有代价。

**5. 默认公开 SearxNG 实例不保证可用。** 志愿者在跑，随时可能限流或下线。要稳定就自己搭一个。

**6. 后端顺序尝试，没有并发。** 并发更快，但会让"哪个后端答的"不确定，也会在第一个成功时浪费已发出的请求。用可预测性换确定性。

**7. 延迟测试结果只代表当下，且只反映可达性。** 延迟随网络状况和公开实例负载变化；更重要的是它**不检验能否搜到结果**（见上方「可达 ≠ 可用」），所以采纳建议前建议重跑，并结合实际搜索结果判断。

**8. 代理不支持的形态**：SOCKS4（无法远程解析域名）、PAC 文件、代理客户端证书。HTTP/HTTPS/SOCKS5/SOCKS5H 都支持。

## 结构

```
dsh-free-web-search/
├── index.js                     插件入口：注册提供方 + 挂载设置页 API
├── client.js                    浏览器半身：设置页面板（代理 / 后端选择 / 延迟测试）
├── cordis.patch.yml             bundle patch：一行 insert
├── package.json
├── src/
│   ├── provider.js              提供方实现 + 兜底/接管 + 预算预留分配
│   ├── config.js                配置归一化（手写，无 schema 库）
│   ├── http.js                  统一 HTTP 层：node:http 实现，支持代理与手写重定向
│   ├── proxy.js                 代理：CONNECT 隧道 + SOCKS5 握手 + 策略解析
│   ├── proxycheck.js            代理连通性探测与失败归因
│   ├── routes.js                设置页 API（三道安全闸 + 密码脱敏）
│   ├── latency.js               延迟测试：连接/TLS/首字节，只建议不改配置
│   ├── settings.js              运行时设置读写（不碰 cordis.patch.yml）
│   ├── provider-control.js      切换 web_search 用哪个提供方（立即生效）
│   ├── html.js                  零依赖 HTML 工具
│   ├── urls.js                  共享 URL 校验 + base64url 解码
│   └── backends/
│       ├── index.js             后端契约与默认顺序
│       ├── searxng.js           JSON API，多实例回退
│       ├── google.js            google.com/search + /url?q= 解包
│       ├── bing.js              bing.com/search + ck/a 解包
│       ├── baidu.js             baidu.com/s + mu= 真实地址
│       ├── yandex.js            yandex.com/search + 验证码识别
│       ├── duckduckgo.js        html + lite 双端点
│       └── wikipedia.js         MediaWiki API
└── test/
    ├── smoke.mjs                离线单元测试（149 项）
    ├── fixtures.js              测试夹具（含广告位、坏数据、Google 空壳页等真实样本）
    ├── proxy-e2e.mjs            代理端到端（13 项，真实本地代理 + 自签 HTTPS 源站）
    ├── client-render.mjs        设置页渲染（13 项）
    ├── react-shim.mjs           极简 React 兼容层（仅供渲染测试）
    ├── real-seam.mjs            对真实 ctx.web 的集成测试（16 项）
    ├── extract-real-seam.mjs    从 app.asar 抽出真实缝隙
    ├── live.mjs                 联网体检
    ├── live-new-backends.mjs    新后端 + 延迟测试的联网体检
    ├── tls-origin.mjs           测试用的本地自签 HTTPS 源站
    └── live-proxy.mjs           带代理的联网体检
```

## 许可

MIT
