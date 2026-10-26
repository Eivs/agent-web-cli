import { resolveSearchToken, type Config } from "../config";
import { httpGet, type NetContext } from "../net/http";
import type { PageOptions } from "../pipeline";
import { BEGIN_MARK, END_MARK, frontMatter, sanitizeBoundary } from "../render";
import { WebError } from "../util/errors";
import { truncateChars } from "../util/text";
import {
  GLOBAL_HELP,
  bool,
  enumOpt,
  intOpt,
  list,
  makeContext,
  mapPool,
  parse,
  parseHeaders,
  str,
  timeoutMs,
} from "./common";
import type { CommandResult } from "./types";

export const SEARCH_HELP = `web search <query...> [options]

Search the web through your SearXNG instance (configure with \`web config init\`).

Options:
  --limit <n>          Number of results to return (default 8)
  --site <domain>      Restrict to a site (adds "site:<domain>")
  --time <range>       day | week | month | year
  --lang <code>        Language, e.g. en, zh-CN (SearXNG "language" parameter)
  --categories <list>  e.g. general, news, it, science (comma separated)
  --engines <list>     Restrict to specific engines (comma separated)
  --page <n>           Result page (SearXNG "pageno")
  --safesearch <0|1|2> 0 off, 1 moderate, 2 strict
  --param key=value    Extra SearXNG parameter (repeatable)
  --per-domain <n>     Keep at most n results per domain (default: no limit)
  --read <n>           Also fetch and include the top n results as markdown
  --max-tokens <n>     Budget per page when using --read (default 1500)
  --json               Output JSON instead of text

${GLOBAL_HELP}

Examples:
  web search "bun compile single file executable"
  web search "rust async book" --site doc.rust-lang.org --limit 5
  web search "OpenAI latest announcement" --time week --read 2
`;

export const SEARCH_OPTIONS = {
  limit: { type: "string" },
  site: { type: "string" },
  time: { type: "string" },
  lang: { type: "string" },
  categories: { type: "string" },
  engines: { type: "string" },
  page: { type: "string" },
  safesearch: { type: "string" },
  param: { type: "string", multiple: true },
  "per-domain": { type: "string" },
  read: { type: "string" },
  "max-tokens": { type: "string" },
  json: { type: "boolean" },
} as const;

export interface SearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  date?: string;
  engines: string[];
  domain: string;
}

interface RawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  publishedDate?: unknown;
  engine?: unknown;
  engines?: unknown;
}

const TRACKING = /^(utm_.+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|ref_src|ref|spm|share|source)$/i;

/** Strip tracking parameters and fragments so duplicates collapse. */
export function normalizeResultUrl(raw: string): { url: string; key: string; domain: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  for (const k of Array.from(u.searchParams.keys())) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const key = `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  return { url: u.toString(), key, domain: host };
}

export function normalizeResults(raw: RawResult[], opts: { limit: number; perDomain?: number }): SearchResult[] {
  const seen = new Set<string>();
  const perDomain = new Map<string, number>();
  const out: SearchResult[] = [];
  for (const r of raw) {
    if (typeof r.url !== "string") continue;
    const n = normalizeResultUrl(r.url);
    if (!n || seen.has(n.key)) continue;
    if (opts.perDomain && (perDomain.get(n.domain) ?? 0) >= opts.perDomain) continue;
    seen.add(n.key);
    perDomain.set(n.domain, (perDomain.get(n.domain) ?? 0) + 1);
    const engines = Array.isArray(r.engines)
      ? r.engines.filter((e): e is string => typeof e === "string")
      : typeof r.engine === "string"
        ? [r.engine]
        : [];
    out.push({
      rank: out.length + 1,
      title: truncateChars(String(r.title ?? n.url).replace(/\s+/g, " ").trim(), 160),
      url: n.url,
      snippet: truncateChars(String(r.content ?? "").replace(/\s+/g, " ").trim(), 300),
      date: typeof r.publishedDate === "string" && r.publishedDate ? r.publishedDate.slice(0, 10) : undefined,
      engines,
      domain: n.domain,
    });
    if (out.length >= opts.limit) break;
  }
  return out;
}

export function buildSearchUrl(endpoint: string): URL {
  const u = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`);
  if (u.pathname === "" || u.pathname === "/") u.pathname = "/search";
  return u;
}

export interface SearchRequest {
  query: string;
  site?: string;
  time?: string;
  lang?: string;
  categories?: string;
  engines?: string;
  page?: number;
  safesearch?: string;
  params?: Record<string, string>;
  /** Fetch more than the final limit so de-duplication still leaves enough. */
  limit: number;
  perDomain?: number;
  timeoutMs?: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  answers: string[];
  suggestions: string[];
  unresponsive: string[];
  tookMs: number;
}

export async function searxngSearch(ctx: NetContext, req: SearchRequest): Promise<SearchResponse> {
  const cfg = ctx.config;
  if (!cfg.search.url) {
    throw new WebError("config", "No SearXNG endpoint configured", {
      hint: "Run `web config init`, then set search.url in the config file (or set WEB_SEARXNG_URL).",
    });
  }
  let endpoint: URL;
  try {
    endpoint = buildSearchUrl(cfg.search.url);
  } catch {
    throw new WebError("config", `Invalid search.url: ${cfg.search.url}`, { hint: "Use a full URL such as https://searx.example.com/search" });
  }

  const q = req.site ? `site:${req.site} ${req.query}` : req.query;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(cfg.search.params)) params.set(k, String(v));
  params.set("q", q);
  params.set("format", "json");
  if (req.lang) params.set("language", req.lang);
  if (req.time) params.set("time_range", req.time);
  if (req.categories) params.set("categories", req.categories);
  if (req.engines) params.set("engines", req.engines);
  if (req.page && req.page > 1) params.set("pageno", String(req.page));
  if (req.safesearch) params.set("safesearch", req.safesearch);
  for (const [k, v] of Object.entries(req.params ?? {})) params.set(k, v);
  for (const [k, v] of params) endpoint.searchParams.set(k, v);

  const headers: Record<string, string> = { Accept: "application/json", ...cfg.search.headers };
  const token = resolveSearchToken(cfg);
  if (token) headers[cfg.search.authHeader] = cfg.search.authScheme ? `${cfg.search.authScheme} ${token}` : token;

  const res = await httpGet(ctx, endpoint.href, {
    headers,
    timeoutMs: req.timeoutMs ?? cfg.search.timeoutMs,
    retries: 1,
    // The user chose this host, so it may be private (e.g. a SearXNG on the LAN).
    allowHosts: [endpoint.hostname.toLowerCase()],
    forceDirect: cfg.search.proxy === "direct",
  });

  if (res.status === 401) {
    throw new WebError("blocked", "SearXNG rejected the credentials (HTTP 401)", {
      status: 401,
      hint: "Check search.token / search.tokenEnv, search.authHeader and search.authScheme in the config.",
    });
  }
  if (res.status === 403) {
    throw new WebError("blocked", "SearXNG refused the request (HTTP 403)", {
      status: 403,
      hint: "Either the token is wrong, or the JSON format is disabled: add `json` to `search.formats` in SearXNG's settings.yml.",
    });
  }
  if (res.status === 429) {
    throw new WebError("blocked", "SearXNG is rate limiting this client (HTTP 429)", {
      status: 429,
      hint: "Wait a moment, or relax the limiter in SearXNG (server.limiter / botdetection).",
    });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new WebError("http", `SearXNG returned HTTP ${res.status}`, {
      status: res.status,
      hint: res.status === 404 ? "Check search.url; it should end in /search." : "Check the SearXNG logs.",
    });
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
  } catch {
    throw new WebError("http", "SearXNG did not return JSON", {
      hint: "Check search.url, and make sure `json` is listed under `search.formats` in settings.yml.",
    });
  }

  const rawResults = Array.isArray(data.results) ? (data.results as RawResult[]) : [];
  const results = normalizeResults(rawResults, { limit: req.limit, perDomain: req.perDomain });
  const answers = (Array.isArray(data.answers) ? data.answers : [])
    .map((a) => (typeof a === "string" ? a : typeof (a as { answer?: unknown })?.answer === "string" ? (a as { answer: string }).answer : ""))
    .filter(Boolean)
    .map((a) => truncateChars(a.replace(/\s+/g, " "), 300));
  const suggestions = (Array.isArray(data.suggestions) ? data.suggestions : []).filter((s): s is string => typeof s === "string").slice(0, 8);
  const unresponsive = (Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [])
    .map((e) => (Array.isArray(e) ? `${e[0]}${e[1] ? ` (${e[1]})` : ""}` : String(e)))
    .slice(0, 8);

  return { query: req.query, results, answers, suggestions, unresponsive, tookMs: res.elapsedMs };
}

function renderText(r: SearchResponse): string {
  const lines: string[] = [];
  for (const a of r.answers) lines.push(`Answer: ${a}`);
  if (r.answers.length) lines.push("");
  if (r.results.length === 0) lines.push("(no results)");
  for (const x of r.results) {
    lines.push(`${x.rank}. ${x.title}${x.date ? ` (${x.date})` : ""}`);
    lines.push(`   ${x.url}`);
    if (x.snippet) lines.push(`   ${x.snippet}`);
  }
  if (r.suggestions.length) lines.push("", `Related searches: ${r.suggestions.join("; ")}`);
  return lines.join("\n");
}

export async function runSearch(argv: string[], config: Config): Promise<CommandResult> {
  const args = parse(argv, SEARCH_OPTIONS, "search");
  if (bool(args.values, "help")) return { stdout: SEARCH_HELP };

  const query = args.positionals.join(" ").trim();
  if (!query) throw new WebError("usage", "No search query given", { hint: 'Usage: web search "your query" [options]' });

  const ctx = makeContext(args, config);
  const limit = intOpt(args.values, "limit", 8, 1, 50);
  const readN = intOpt(args.values, "read", 0, 0, 10);
  const time = str(args.values, "time");
  if (time && !["day", "week", "month", "year"].includes(time)) {
    throw new WebError("usage", `--time must be one of: day, week, month, year (got "${time}")`);
  }
  const extraParams: Record<string, string> = {};
  for (const p of list(args.values, "param")) {
    const i = p.indexOf("=");
    if (i <= 0) throw new WebError("usage", `Invalid --param "${p}"`, { hint: "Use --param key=value" });
    extraParams[p.slice(0, i)] = p.slice(i + 1);
  }

  const resp = await searxngSearch(ctx, {
    query,
    site: str(args.values, "site"),
    time,
    lang: str(args.values, "lang"),
    categories: str(args.values, "categories"),
    engines: str(args.values, "engines"),
    page: intOpt(args.values, "page", 1, 1, 100),
    safesearch: str(args.values, "safesearch"),
    params: extraParams,
    limit,
    perDomain: str(args.values, "per-domain") ? intOpt(args.values, "per-domain", 0, 1, 50) : undefined,
    timeoutMs: timeoutMs(args),
  });

  // Optionally read the top results in the same call.
  let pages: string[] = [];
  if (readN > 0 && resp.results.length) {
    // Loaded lazily: plain searches never need the HTML extraction stack.
    const { fetchPage, DEFAULT_PAGE_OPTIONS } = await import("../pipeline");
    const pageOpts: PageOptions = {
      ...DEFAULT_PAGE_OPTIONS,
      maxTokens: intOpt(args.values, "max-tokens", 1500, 200, 50_000),
      maxTokensExplicit: str(args.values, "max-tokens") !== undefined,
      noCache: bool(args.values, "no-cache"),
      headers: parseHeaders(list(args.values, "header")),
      timeoutMs: timeoutMs(args),
      format: "md",
    };
    pages = await mapPool(resp.results.slice(0, readN), 3, async (r) => {
      try {
        return (await fetchPage(ctx, r.url, pageOpts)).text.trimEnd();
      } catch (e) {
        const we = e instanceof WebError ? e : new WebError("internal", (e as Error).message);
        return frontMatter({ url: r.url, error: we.code, status: we.status, message: we.message, hint: we.hint });
      }
    });
  }

  if (bool(args.values, "json")) {
    const out = {
      query: resp.query,
      engine: "searxng",
      took_ms: resp.tookMs,
      untrusted: true,
      results: resp.results,
      answers: resp.answers,
      suggestions: resp.suggestions,
      unresponsive_engines: resp.unresponsive,
      ...(pages.length ? { pages } : {}),
    };
    return { stdout: JSON.stringify(out) + "\n" };
  }

  const header = frontMatter({
    query: resp.query,
    results: resp.results.length,
    engine: "searxng",
    took_ms: resp.tookMs,
    unresponsive_engines: resp.unresponsive,
  });
  const body = sanitizeBoundary(renderText(resp));
  let out = [header, BEGIN_MARK, "", body, "", END_MARK].join("\n") + "\n";
  if (pages.length) out += "\n" + pages.join("\n\n") + "\n";
  return { stdout: out };
}
