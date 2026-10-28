# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目性质

`web` 是一个给 LLM agent 用的网页访问 CLI（Bun + TypeScript，ESM）。它只做 HTTP 请求，把页面转成带 YAML 头的 markdown，并通过用户自己的 SearXNG 搜索。产物是单文件二进制，不是库——所有能力都通过 argv、stdout 和退出码暴露。

范围之外（设计文档明确不做的）：JavaScript 渲染、登录态、PDF、验证码、SOCKS 代理、多搜索后端。新增功能前先看 `DESIGN.md` 第 6 节的路线图。

## 常用命令

```bash
bun install                              # 依赖：@mozilla/readability、linkedom、turndown
bun run src/cli.ts help                  # 开发模式直接运行（等价于 bun run dev）
bun test                                 # 全部测试
bun test tests/net.test.ts               # 单文件
bun test -t "proxy resolution"           # 按 describe/test 名称过滤
bun run typecheck                        # tsc --noEmit
bash scripts/build.sh                    # 本机单文件二进制 -> dist/web
bash scripts/build.sh all                # 交叉编译 5 个目标（需联网下载运行时）
```

没有 lint 脚本，`tsc --noEmit` 是唯一的静态检查。

## 架构

```
src/cli.ts                     入口：captureProxyEnv() → 按命令动态 import → 统一错误输出
  commands/fetch.ts            fetch 的参数解析、批量抓取、--out-dir
    └─ pipeline.ts             fetch 主流程：缓存 → 网络 → 转换 → outline/section/query/分页 → 渲染
         ├─ net/http.ts        GET：逐跳代理决策 + SSRF 检查、手动重定向、重试、大小上限
         ├─ net/proxy.ts       resolveProxy()：--no-proxy > --proxy > 配置 > 环境变量
         ├─ net/ssrf.ts        assertUrlAllowed()：IP 字面量、主机名、DNS（仅直连）
         ├─ cache.ts           磁盘缓存（sha1 key，24h 清理）
         ├─ extract/process.ts 类型识别 → 解码 → html/json/feed/text 转 markdown → 注入扫描
         └─ render.ts          YAML 头 + [BEGIN/END EXTERNAL WEB CONTENT] 边界标记
  commands/search.ts           SearXNG 调用、结果规范化、--read 复用 fetchPage
  commands/map.ts              sitemap 优先，页面链接兜底
  commands/doctor.ts           配置 / 代理 / 试抓取 / 试搜索
  extract/paginate.ts          block 切分、token 分页、大纲、章节、BM25 相关段落
  skill/web-cli/SKILL.md       给 agent 的使用说明，编译进二进制并由 `web guide` 打印
```

### 必须保持的不变量

- **stdout 只有内容，stderr 只有错误**。失败时 stderr 输出一行 JSON（`{error,message,status,url,hint}`）。日志写 stderr，测试也依赖这个约定。
- **退出码唯一来源是 `src/util/errors.ts` 的 `EXIT_CODES`**。同一张表同时写在 `README.md` 和 `skill/web-cli/SKILL.md`，改代码时要三处一起改。`hint` 是写给"会照着做的模型"的下一步动作，不是给人看的解释。
- **每一次重定向都要重新做 SSRF 检查**（`net/http.ts` 的 `attempt` 循环），新增任何请求路径都不能绕过它。
- **缓存键和 cursor 必须包含 `allowPrivate`**。否则先用 `--allow-private` 抓过的内网内容会被普通调用从缓存里读到，跳过 SSRF 检查（`pipeline.ts:259`）。
- **代理环境变量必须在进程启动前清掉**（`net/proxy.ts:sanitizeProxyEnv`）。Bun 在启动时固化 `HTTP(S)_PROXY`/`NO_PROXY`：之后 `delete process.env.*` 对 `fetch` 无效，启动时的 `NO_PROXY` 还会压过显式 `proxy` 选项（oven-sh/bun#35003）。所以检测到这些变量时，工具会用干净环境重新执行自身，并通过 `WEB_PROXY_ENV_SNAPSHOT` 把原值交给子进程；路由必须完全由 `resolveProxy` 决定。
- **页面内容是不可信输入**：正文必须经 `sanitizeBoundary()` 包进边界标记，`--format json` 输出必须带 `untrusted: true`，注入扫描只做提示、不删文本。

### 关键机制

- **按需加载**：`cli.ts` 用 `await import()` 加载命令；`extract/process.ts` 只在 HTML/feed 时加载 DOM 栈。`help`、`config`、`search`、JSON 页面都不该触发这些依赖——新增 import 时注意别把它变成顶层静态依赖。
- **分页与续读**：`extract/paginate.ts` 按 block（标题独立成块、围栏代码块不拆）累加 token；cursor 是 base64url 的 `{v,k,o,s,p}`，续读直接读缓存、不重新请求；头里的 `next:` 命令是自包含的（重复 `--max-tokens`、`--links`、`--selector`、`--allow-private` 等影响内容的参数）。新增影响内容的选项时，要同步加进 `pipeline.ts:nextCommand`。
- **token 估算**：`util/tokens.ts` 是便宜估算（CJK 1 字/token，其余 4 字符/token），用于预算而不是精确计费，输出里一律标 `~`。
- **HTML 提取顺序**：元数据 → 去脚本/隐藏元素 → Readability → 与 `main`/`article` 兜底结果比较（太短则用兜底）→ 规范化链接/图片/表格 → Turndown(GFM)。细节见 `DESIGN.md` 3.4。
- **搜索端点自动加入 SSRF 白名单**（`commands/search.ts:200`），因为 SearXNG 常在内网。

### 改行为时的联动点

用户可见行为（命令、选项、退出码、输出格式、安全模型）变化时，需要同步：

1. 对应 `src/commands/*.ts` 里的 `*_HELP` 文本；
2. `cli.ts` 顶部的 `HELP`（新增命令时）；
3. `skill/web-cli/SKILL.md`（它被 `cli.ts` 以 `with { type: "text" }` 内嵌，`web guide` 直接打印）；
4. `README.md`，必要时 `DESIGN.md`。

新增命令的套路：`src/commands/<name>.ts` 导出 `run<Name>(argv, config)`、`<NAME>_HELP`、`<NAME>_OPTIONS`，复用 `commands/common.ts` 的 `parse`/`makeContext`/`mapPool` 和全局选项，然后在 `cli.ts` 的 `switch` 里动态 import。

## 测试

- `tests/net.test.ts` — 私网判断（含 IPv6/混淆写法）、主机名、`assertUrlAllowed`、NO_PROXY、代理优先级、配置合并。
- `tests/paginate.test.ts` — 分页无缺口无重叠、大纲/章节/BM25（含中文）、不可见字符、注入扫描、边界标记伪造、内容类型识别、编码、sitemap。
- `tests/http.test.ts` — 对本地 `Bun.serve` 测重定向、大小上限、超时、重试、请求头；mock SearXNG；缓存。
- `tests/cli.test.ts` — 以子进程运行真实 CLI，覆盖退出码、分页续读（执行输出里的 `next` 命令并核对拼接结果）、批量、代理组合、doctor。改 CLI 行为后优先看这里。
- `tests/html.test.ts` — 依赖真实 DOM 库的 HTML/feed/map 测试。断言多用 `toContain`，失败通常意味着真实行为有问题而不是格式细节。

测试全部走 `127.0.0.1` 上的临时 mock 服务器，不需要外网，也不需要 SearXNG。
