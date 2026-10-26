import { gunzipSync } from "node:zlib";
import type { Config } from "../config";
import { tokenizeForSearch } from "../extract/paginate";
import { parseSitemap, sitemapsFromRobots } from "../extract/sitemap";
import { decodeBody } from "../net/decode";
import { httpGet, parseUrl, type NetContext } from "../net/http";
import { BEGIN_MARK, END_MARK, frontMatter, sanitizeBoundary } from "../render";
import { WebError } from "../util/errors";
import { GLOBAL_HELP, bool, intOpt, list, makeContext, mapPool, parse, parseHeaders, str, timeoutMs } from "./common";
import type { CommandResult } from "./types";

export const MAP_HELP = `web map <url> [options]

List the URLs of a site: sitemap.xml (found via robots.txt) first, then links on the
page as a fallback. If <url> has a path (e.g. /docs), only URLs under it are kept.

Options:
  --search <text>        Keep only URLs matching these words, best matches first
  --limit <n>            Maximum URLs to return (default 100)
  --include-subdomains   Also include URLs on subdomains of the host
  --no-sitemap           Skip sitemaps and use links from the page only
  --json                 Output JSON

${GLOBAL_HELP}

Examples:
  web map https://docs.example.com
  web map https://example.com/blog --search "release notes" --limit 20
`;

export const MAP_OPTIONS = {
  search: { type: "string" },
  limit: { type: "string" },
  "include-subdomains": { type: "boolean" },
  "no-sitemap": { type: "boolean" },
  json: { type: "boolean" },
} as const;

const ASSET_EXT = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|eot|mp[34]|webm|zip|gz|tar|exe|dmg)(?:$|\?)/i;
const MAX_SITEMAPS = 25;
const MAX_URLS = 50_000;

interface Candidate {
  url: string;
  lastmod?: string;
  text?: string;
}

function sameScope(host: string, target: string, subdomains: boolean): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const t = target.toLowerCase().replace(/^www\./, "");
  return h === t || (subdomains && h.endsWith(`.${t}`));
}

async function fetchText(ctx: NetContext, url: string, timeout?: number, headers?: Record<string, string>): Promise<{ text: string; status: number } | null> {
  try {
    const res = await httpGet(ctx, url, { timeoutMs: timeout, retries: 1, headers });
    if (res.status < 200 || res.status >= 300) return { text: "", status: res.status };
    let bytes = res.body;
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try {
        bytes = new Uint8Array(gunzipSync(bytes));
      } catch {
        return null;
      }
    }
    return { text: decodeBody(bytes, res.headers.get("content-type")).text, status: res.status };
  } catch (e) {
    // Policy errors must surface; plain network failures just mean "no sitemap here".
    if (e instanceof WebError && (e.code === "ssrf" || e.code === "config")) throw e;
    return null;
  }
}

function score(c: Candidate, terms: string[]): number {
  if (terms.length === 0) return 0;
  let haystack = c.url;
  try {
    haystack = decodeURIComponent(c.url);
  } catch {
    // keep raw
  }
  const tokens = new Set(tokenizeForSearch(`${haystack} ${c.text ?? ""}`.replace(/[/_.-]+/g, " ")));
  const lower = `${haystack} ${c.text ?? ""}`.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (tokens.has(t)) s += 2;
    else if (lower.includes(t)) s += 1;
  }
  return s;
}

export async function runMap(argv: string[], config: Config): Promise<CommandResult> {
  const args = parse(argv, MAP_OPTIONS, "map");
  if (bool(args.values, "help")) return { stdout: MAP_HELP };
  const [rawUrl] = args.positionals;
  if (!rawUrl) throw new WebError("usage", "No URL given", { hint: "Usage: web map <url> [options]" });

  const ctx = makeContext(args, config);
  const start = parseUrl(rawUrl);
  const limit = intOpt(args.values, "limit", 100, 1, 5000);
  const subdomains = bool(args.values, "include-subdomains");
  const timeout = timeoutMs(args);
  const headers = parseHeaders(list(args.values, "header"));
  const query = str(args.values, "search");
  const terms = query ? [...new Set(tokenizeForSearch(query))] : [];

  const pathPrefix = start.pathname === "/" ? "" : start.pathname.replace(/\/+$/, "");
  const inScope = (u: URL) => sameScope(u.hostname, start.hostname, subdomains) && (!pathPrefix || u.pathname === pathPrefix || u.pathname.startsWith(`${pathPrefix}/`));

  const found = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    let u: URL;
    try {
      u = new URL(c.url);
    } catch {
      return;
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || ASSET_EXT.test(u.pathname) || !inScope(u)) return;
    u.hash = "";
    const key = u.href;
    if (!found.has(key) && found.size < MAX_URLS) found.set(key, { ...c, url: key });
  };

  const sources = new Set<string>();
  let sitemapsRead = 0;

  if (!bool(args.values, "no-sitemap")) {
    const robots = await fetchText(ctx, `${start.origin}/robots.txt`, timeout, headers);
    const queue = robots?.text ? sitemapsFromRobots(robots.text) : [];
    if (queue.length === 0) queue.push(`${start.origin}/sitemap.xml`, `${start.origin}/sitemap_index.xml`);

    const visited = new Set<string>();
    while (queue.length && sitemapsRead < MAX_SITEMAPS) {
      const batch = queue.splice(0, 4).filter((u) => !visited.has(u));
      batch.forEach((u) => visited.add(u));
      const texts = await mapPool(batch, 4, (u) => fetchText(ctx, u, timeout, headers));
      texts.forEach((t) => {
        if (!t?.text) return;
        sitemapsRead++;
        const parsed = parseSitemap(t.text, MAX_URLS);
        for (const child of parsed.sitemaps) {
          try {
            // Only follow child sitemaps on the host being mapped.
            if (sameScope(new URL(child).hostname, start.hostname, subdomains) && !visited.has(child)) queue.push(child);
          } catch {
            // ignore malformed locations
          }
        }
        for (const e of parsed.urls) add({ url: e.loc, lastmod: e.lastmod });
        if (parsed.urls.length) sources.add("sitemap");
      });
    }
  }

  // Fall back to (or supplement with) links from the page itself.
  if (found.size === 0) {
    const page = await fetchText(ctx, start.href, timeout, headers);
    if (page?.text) {
      // Loaded lazily: only this fallback needs the HTML parser.
      const { extractLinks } = await import("../extract/links");
      for (const l of extractLinks(page.text, start.href)) add({ url: l.url, text: l.text });
      if (found.size) sources.add("page-links");
    } else if (page && page.status >= 400) {
      throw new WebError("http", `HTTP ${page.status} while reading ${start.href}`, {
        status: page.status,
        hint: "Check the URL, or try a different entry page.",
      });
    }
  }

  let items = [...found.values()];
  // The page you asked about is always first when present.
  const startKey = (() => {
    const u = new URL(start.href);
    u.hash = "";
    return u.href;
  })();
  items.sort((a, b) => (a.url === startKey ? -1 : b.url === startKey ? 1 : 0));

  if (terms.length) {
    items = items
      .map((c) => ({ c, s: score(c, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.c.url.length - b.c.url.length)
      .map((x) => x.c);
  }
  const total = items.length;
  items = items.slice(0, limit);

  if (bool(args.values, "json")) {
    return {
      stdout:
        JSON.stringify({
          url: start.href,
          total_found: total,
          returned: items.length,
          sources: [...sources],
          untrusted: true,
          urls: items.map((i) => ({ url: i.url, ...(i.lastmod ? { lastmod: i.lastmod } : {}) })),
        }) + "\n",
    };
  }

  const header = frontMatter({
    url: start.href,
    returned: items.length,
    total_found: total,
    source: [...sources].join("+") || "none",
    sitemaps_read: sitemapsRead || undefined,
    search: query,
    truncated: total > items.length ? true : undefined,
    warnings: items.length === 0 ? ["No URLs found. Try a different entry URL, or drop --search."] : undefined,
  });
  const body = items.map((i) => (i.lastmod ? `${i.url}  (${i.lastmod.slice(0, 10)})` : i.url)).join("\n");
  return { stdout: [header, BEGIN_MARK, "", sanitizeBoundary(body), "", END_MARK].join("\n") + "\n" };
}
