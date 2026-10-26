# 设计说明

## 1. 目标与取舍

使用者是 LLM，不是人。所以和 curl、浏览器相比，设计上优先考虑：

1. **省 token**：只输出有用内容；长页面可以先看大纲、按章节或按问题取一部分。
2. **输出可预测**：固定的元数据头、固定的退出码、错误里带“下一步该做什么”的 hint。
3. **可续读**：输出被截断时，头里直接给出可执行的续读命令。
4. **默认安全**：网页是不可信输入，既要防 SSRF，也要防 prompt injection。
5. **网络可控**：能走本地网络或指定的 HTTP 代理，路由规则可预期。

明确不做（当前版本）：JavaScript 渲染、登录态、PDF、验证码、SOCKS 代理、多搜索后端。搜索只对接用户自己的 SearXNG。

## 2. 数据流

```
fetch <url>
  │
  ├─ 解析 URL，计算缓存键（URL + 提取选项 + 是否允许私网）
  ├─ 命中缓存？──是──┐
  │                  │
  └─ 否 → net/http ──┤   每一跳：解析代理 → SSRF 检查 → 请求（手动处理重定向）
        │            │
        │   状态码检查（401/403/429/挑战页 → blocked，404 → http …）
        ▼            │
  extract/process    │   类型识别 → 解码（charset）→ html/json/feed/text 转 markdown
        │            │   清洗（隐藏文本、不可见字符）→ 注入扫描
        ▼            │
      写缓存 ────────┘
        ▼
  pipeline.present   outline │ section │ query(BM25) │ 按 token 分页（block 边界）
        ▼
  render             YAML 头 + 边界标记 + 正文 (+ next 命令)
```

HTML 和 feed 转换器依赖 DOM 库，按需加载（`await import`）：`help`、`config`、`search`、JSON/文本页面都不会加载它们，启动更快，也让这部分和纯逻辑解耦、便于测试。

## 3. 关键设计

### 3.1 输出格式

YAML 头（`url`、`final_url`、`title`、`author`、`published`、`lang`、`status`、`fetched_at`、`mode`、`extractor`、`tokens`、`truncated`、`next`、`warnings`、`injection_suspected`）加边界标记包住的正文。空字段不输出。含冒号、空格等的值用 JSON 字符串转义（合法 YAML）。

`--format json` 输出单个 JSON 对象，同样带 `untrusted: true`。

### 3.2 分页与 cursor

- 先把 markdown 切成 **block**（段落、标题单独成块、围栏代码块不拆），按 token 预算累加；超过一半预算后遇到标题就提前收尾，让下一页从标题开始。
- 单个 block 超过预算时按行、再按字符切开，避免丢内容。
- cursor 是 base64url 的 JSON：`{v, k(缓存键), o(字符偏移), s(章节标题), p(是否带 allow-private)}`。续读直接读缓存里的转换结果，不重新请求；缓存过期（续读最长 1 小时）才会重抓，并在头里提示位置可能有偏差。
- `next` 命令是**自包含**的：带上 `--max-tokens`、`--links`、`--selector`、`--allow-private` 等影响内容的参数，agent 原样执行即可。

### 3.3 大纲、章节、相关段落

- `--outline`：标题层级 + 各节估算 token 数，让 agent 先看结构再决定读哪里。
- `--section`：按标题匹配（精确 → 前缀 → 包含，忽略大小写），取到下一个同级或更高级标题为止；可再分页。
- `--query`：把文档切成约 300 token 的块，用 BM25 排序，在预算内取得分最高的块并按文档顺序返回。分词对拉丁文按词、对 CJK 按字符二元组。没有命中时退回到页面开头并给出警告。这是纯本地算法，不需要向量模型。

### 3.4 HTML 提取

顺序：先读元数据（og:title、meta、JSON-LD、`<time>`）→ 删除脚本/控件/隐藏元素 → Readability 提取正文 → 与“`main`/`article`/`body` 去页面框架”的兜底结果比较，Readability 结果太短（< 300 字符，或不到兜底的 1/4）时用兜底 → 规范化链接/图片/表格 → Turndown（GFM）。

细节：

- 链接转绝对地址（尊重 `<base href>`），页内锚点和 `javascript:` 链接只留文字；`--links index` 把链接收成编号表放文末。
- 图片默认只留 `[image: alt]`，省 token；`--images keep` 才带 URL。
- 无表头的表格把第一行改成表头，否则 Turndown 会把整张表保留成 HTML。
- 空页面时判断是否 SPA 外壳，给出“需要浏览器模式”的警告，而不是静默返回空内容。

### 3.5 网络层

- **代理路由**：`--no-proxy` > `--proxy` > 配置 > 环境变量；`NO_PROXY` 支持后缀/端口/CIDR；回环直连。
- **为什么启动时移除环境里的代理变量**：实测 Bun 的 `fetch` 每次调用都读 `process.env` 里的 `HTTP(S)_PROXY`/`NO_PROXY`，并且 `proxy: ""` 或 `undefined` 关不掉；环境里的 `NO_PROXY` 匹配目标时，甚至会让显式传入的 `proxy` 选项失效。这样 `--no-proxy`、`--proxy` 和 NO_PROXY 例外都会被 Bun 悄悄覆盖。所以 CLI 启动时快照这些变量再删除，路由决定完全由 `resolveProxy` 做，并通过 `proxy` 选项显式传给 `fetch`。端到端测试覆盖了这几种组合。
- **请求**：手动处理重定向（最多 8 跳，每跳都做 SSRF 检查）；响应体 10 MB 上限，超出则截断并在头里警告；超时默认 30 秒；网络错误和 429/502/503/504 指数退避重试（默认 2 次，`Retry-After` 超过 5 秒则不等）。
- **默认请求头**：浏览器风格的 User-Agent；`Accept` 把 `text/markdown` 排在最前，部分站点会直接返回 markdown，这样可以跳过 HTML 转换。
- **编码**：按 `Content-Type` charset、BOM、`<meta charset>` 解码；GBK、Big5、Shift_JIS 等已验证可用；不认识的编码退回 UTF-8 并警告。

### 3.6 SSRF 防护

见 README “安全模型”。要点：

- 先检查 URL 字面量（含十进制/十六进制/八进制混淆写法，WHATWG URL 会先规范化），再检查主机名，直连时再解析 DNS 并检查**所有**返回的地址。
- IPv6 做了完整解析：`::ffff:a.b.c.d`、NAT64 `64:ff9b::/96`、6to4 `2002::/16`、ULA、link-local、组播、文档地址都按其中嵌入的 IPv4 或类型判断；无法解析的一律当作私网（fail closed）。
- 走代理时不做本地解析（理由见 README 已知限制）。
- 重定向每一跳重检；`file://`、`ftp://`、`javascript:` 等协议一律拒绝，包括重定向到它们。
- 缓存键和 cursor 包含 `allowPrivate`：这是测试里发现的问题——最初缓存命中会跳过检查，导致先用 `--allow-private` 抓过的内容可以被不带该参数的调用读到。

### 3.7 搜索

- 只对接 SearXNG：`GET <url>?q=...&format=json`，认证头、scheme、额外参数、请求头都可配置。
- SearXNG 端点所在主机自动加入 SSRF 白名单（它是用户自己指定的，可能在内网）。
- 结果规范化：去掉 `utm_*`、`fbclid` 等跟踪参数和 fragment，按（去 www 的主机 + 路径 + 查询）去重，可限制每个域名的条数；保留日期、answers、suggestions、不响应的引擎。
- 403 的 hint 同时提示两种常见原因：token 错误，或 `settings.yml` 里没有启用 `json` 格式。
- `--read N` 复用 fetch 管线并发抓取前 N 条，每页默认 1500 token；失败的页面以错误块形式返回，不影响整体。

### 3.8 错误模型

`WebError(code, message, {hint, status, url})`，每个 code 对应固定退出码。错误 hint 写成“下一步做什么”（换代理、换来源、加 `--allow-private`、检查 `settings.yml` …），因为调用方是会照着做的模型。多 URL 抓取时失败的页面以头里带 `error:` 的块返回，只要有一个成功退出码就是 0。

## 4. 测试策略

- `tests/net.test.ts`：私网判断（IPv4/IPv6/混淆写法）、主机名、`assertUrlAllowed`、NO_PROXY、代理优先级、配置合并。
- `tests/paginate.test.ts`：分页覆盖无缺口无重叠、大纲、章节、BM25（含中文）、不可见字符、注入扫描、边界标记伪造、内容类型识别、编码、sitemap。
- `tests/http.test.ts`：对本地服务器测试重定向、重定向到元数据地址/`file://`、大小上限、超时、重试、请求头；对 mock SearXNG 测试认证、规范化、错误映射；缓存。
- `tests/cli.test.ts`：把真实 CLI 作为子进程运行，覆盖退出码、分页续读（执行输出里的 `next` 命令并核对拼接结果）、搜索、批量、配置、doctor，以及用 mock HTTP 代理验证 `--proxy`、环境变量、`--no-proxy`、`NO_PROXY`、SOCKS 报错。
- `tests/html.test.ts`：HTML/feed/map 的真实依赖测试，**尚未运行**（见 README）。

对关键断言做过变异检查（故意改坏代码确认测试会失败）。

## 5. 与 Firecrawl 的差距（当前版本）

已覆盖：scrape（HTTP）、search + 抓取、map、批量抓取、多种输出控制。
未覆盖：crawl（整站异步任务）、JS 渲染与页面动作（click/scroll/wait）、交互式浏览（interact/agent）、LLM 结构化抽取（刻意不做：调用方就是 LLM）、托管反爬与代理池、PDF。

## 6. 后续路线

1. **v0.2**：真实页面回归（修 HTML 提取问题）、PDF 文本提取、`--exclude` 之外的 `--include`、feed 自动发现。
2. **v0.3 浏览器模式**：Playwright 无头 Chromium，`--mode auto|http|browser`，检测到 SPA 外壳时自动切换；拦截图片/字体加速；常驻 daemon 避免冷启动。注意：加入后需要重新审视 SSRF（浏览器自己会发子请求）和“移除环境代理变量”的做法。
3. **v0.4**：`crawl`（同域、限深度、限页数、异步任务 + 状态查询）、`web browse` 有状态会话（带编号的可访问性树快照）、登录 profile。
4. 可选：搜索结果二次排序、内容变更对比、MCP server 外壳。
