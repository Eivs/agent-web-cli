import { existsSync } from "node:fs";
import { configPath, maskProxyUrl, maskSecret, resolveSearchToken, type Config } from "../config";
import { describeProxy, proxyEnv, resolveProxy } from "../net/proxy";
import { httpGet, parseUrl } from "../net/http";
import { WebError } from "../util/errors";
import { searxngSearch } from "./search";
import { GLOBAL_HELP, bool, list, makeContext, parse, parseHeaders, str, timeoutMs } from "./common";
import type { CommandResult } from "./types";

export const DOCTOR_HELP = `web doctor [options]

Check the configuration, proxy resolution, a test fetch and a test search.

Options:
  --url <url>          URL for the test fetch (default https://example.com)
  --skip-search        Do not test SearXNG

${GLOBAL_HELP}
`;

export const DOCTOR_OPTIONS = {
  url: { type: "string" },
  "skip-search": { type: "boolean" },
} as const;

export async function runDoctor(argv: string[], config: Config): Promise<CommandResult> {
  const args = parse(argv, DOCTOR_OPTIONS, "doctor");
  if (bool(args.values, "help")) return { stdout: DOCTOR_HELP };

  const ctx = makeContext(args, config);
  const lines: string[] = [];
  let failures = 0;
  const ok = (m: string) => lines.push(`[ok]   ${m}`);
  const fail = (m: string, hint?: string) => {
    failures++;
    lines.push(`[fail] ${m}`);
    if (hint) lines.push(`       hint: ${hint}`);
  };
  const info = (m: string) => lines.push(`       ${m}`);

  const path = configPath();
  lines.push("agent-web doctor", "");
  existsSync(path) ? ok(`config file: ${path}`) : info(`config file: none at ${path} (using defaults and environment)`);

  // ---- proxy
  const env = proxyEnv();
  const envSeen = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]
    .filter((k) => env[k])
    .map((k) => `${k}=${k.toLowerCase().includes("no_proxy") ? env[k] : maskProxyUrl(env[k])}`);
  info(`proxy env: ${envSeen.length ? envSeen.join(" ") : "(none)"}`);
  info(`proxy config: ${config.proxy.url ? maskProxyUrl(config.proxy.url) : "(none)"}`);

  const testUrl = parseUrl(str(args.values, "url") ?? "https://example.com");
  try {
    const d = resolveProxy(testUrl, { flagProxy: ctx.proxyFlag, noProxyFlag: ctx.noProxyFlag, config });
    ok(`proxy for ${testUrl.hostname}: ${describeProxy(d)}`);
  } catch (e) {
    fail(`proxy settings are invalid: ${(e as Error).message}`, e instanceof WebError ? e.hint : undefined);
  }

  // ---- fetch
  try {
    const res = await httpGet(ctx, testUrl.href, {
      timeoutMs: timeoutMs(args) ?? 15_000,
      retries: 0,
      headers: parseHeaders(list(args.values, "header")),
    });
    res.status >= 200 && res.status < 400
      ? ok(`fetch ${testUrl.href}: HTTP ${res.status} in ${res.elapsedMs}ms via ${describeProxy(res.proxy)}`)
      : fail(`fetch ${testUrl.href}: HTTP ${res.status}`, "The site answered but refused or errored; try --url with another site to test the network itself.");
  } catch (e) {
    const we = e as WebError;
    fail(`fetch ${testUrl.href}: ${we.message}`, we.hint);
  }

  // ---- search
  if (!bool(args.values, "skip-search")) {
    if (!config.search.url) {
      fail("search: no SearXNG endpoint configured", "Run `web config init` and set search.url.");
    } else {
      const token = resolveSearchToken(config);
      info(`search endpoint: ${config.search.url}  token: ${token ? maskSecret(token) : "(none)"}  proxy: ${config.search.proxy}`);
      try {
        const r = await searxngSearch(ctx, { query: "test", limit: 3, timeoutMs: timeoutMs(args) ?? 20_000 });
        r.results.length > 0
          ? ok(`search: ${r.results.length} results in ${r.tookMs}ms${r.unresponsive.length ? ` (unresponsive engines: ${r.unresponsive.join(", ")})` : ""}`)
          : fail("search: SearXNG answered but returned no results", "Check which engines are enabled in SearXNG.");
      } catch (e) {
        const we = e as WebError;
        fail(`search: ${we.message}`, we.hint);
      }
    }
  }

  lines.push("", failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
  return { stdout: lines.join("\n") + "\n", exitCode: failures === 0 ? 0 : 3 };
}
