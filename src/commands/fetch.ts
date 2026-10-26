import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config";
import type { ImageMode, LinkMode } from "../extract/html";
import { fetchPage, DEFAULT_PAGE_OPTIONS, type PageOptions } from "../pipeline";
import { frontMatter } from "../render";
import { WebError } from "../util/errors";
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
  type ParsedArgs,
} from "./common";
import type { CommandResult } from "./types";

export const FETCH_HELP = `web fetch <url...> [options]

Read a page and return clean markdown with a metadata header. Output is capped at
--max-tokens; when the page is longer, the header has a \`next:\` command to continue.

Options:
  --max-tokens <n>     Output budget per page (default from config, 6000; 3000 when fetching several URLs)
  --cursor <token>     Continue from the \`next:\` line of a previous result
  --outline            Return only the heading outline with approximate token counts
  --section <title>    Return only the section whose heading matches <title>
  --query <text>       Return only the chunks most relevant to <text> (BM25 ranking)
  --selector <css>     Convert only the region matching this CSS selector
  --exclude <css>      Remove elements matching this selector first (repeatable)
  --links <mode>       inline (default) | none | index (numbered list at the end)
  --images <mode>      alt (default, "[image: alt]") | keep (with URLs) | none
  --raw                Skip extraction: decoded body as-is
  --format <fmt>       md (default) | json
  --urls-file <path>   Read URLs from a file, one per line ("-" for stdin)
  --out-dir <dir>      With several URLs: write each page to <dir> and print an index
  --concurrency <n>    Parallel fetches for several URLs (default 4)

${GLOBAL_HELP}

Examples:
  web fetch https://example.com/docs/intro
  web fetch https://example.com/docs --outline
  web fetch https://example.com/docs --section "Authentication"
  web fetch https://example.com/pricing --query "enterprise plan price"
  web fetch https://example.com/long --cursor eyJ2IjoxLC4uLn0
`;

export const FETCH_OPTIONS = {
  "max-tokens": { type: "string" },
  cursor: { type: "string" },
  outline: { type: "boolean" },
  section: { type: "string" },
  query: { type: "string" },
  selector: { type: "string" },
  exclude: { type: "string", multiple: true },
  links: { type: "string" },
  images: { type: "string" },
  raw: { type: "boolean" },
  format: { type: "string" },
  "urls-file": { type: "string" },
  "out-dir": { type: "string" },
  concurrency: { type: "string" },
} as const;

export function pageOptionsFrom(args: ParsedArgs, config: Config, multi: boolean): PageOptions {
  const explicit = str(args.values, "max-tokens") !== undefined;
  const fallbackTokens = multi ? Math.min(config.fetch.maxTokens, 3000) : config.fetch.maxTokens;
  return {
    ...DEFAULT_PAGE_OPTIONS,
    maxTokens: intOpt(args.values, "max-tokens", fallbackTokens, 200, 200_000),
    maxTokensExplicit: explicit,
    cursor: str(args.values, "cursor"),
    outline: bool(args.values, "outline"),
    section: str(args.values, "section"),
    query: str(args.values, "query"),
    selector: str(args.values, "selector"),
    exclude: list(args.values, "exclude"),
    links: enumOpt<LinkMode>(args.values, "links", ["inline", "none", "index"], "inline"),
    images: enumOpt<ImageMode>(args.values, "images", ["alt", "keep", "none"], "alt"),
    raw: bool(args.values, "raw"),
    noCache: bool(args.values, "no-cache"),
    headers: parseHeaders(list(args.values, "header")),
    timeoutMs: timeoutMs(args),
    format: enumOpt<"md" | "json">(args.values, "format", ["md", "json"], "md"),
  };
}

function readUrlsFile(path: string): string[] {
  const text = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function slug(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
  } catch {
    return "page";
  }
}

function errorBlock(url: string, e: unknown): { text: string; code: number } {
  const we = e instanceof WebError ? e : new WebError("internal", (e as Error).message ?? String(e));
  return {
    text:
      frontMatter({ url, error: we.code, status: we.status, message: we.message, hint: we.hint }) + "\n",
    code: we.exitCode,
  };
}

export async function runFetch(argv: string[], config: Config): Promise<CommandResult> {
  const args = parse(argv, FETCH_OPTIONS, "fetch");
  if (bool(args.values, "help")) return { stdout: FETCH_HELP };

  let urls = [...args.positionals];
  const file = str(args.values, "urls-file");
  if (file) urls.push(...readUrlsFile(file));
  if (urls.length === 0) {
    throw new WebError("usage", "No URL given", { hint: "Usage: web fetch <url> [options]. Run `web fetch --help`." });
  }
  urls = [...new Set(urls)];

  const multi = urls.length > 1;
  const ctx = makeContext(args, config);
  const opts = pageOptionsFrom(args, config, multi);

  if (!multi) {
    const r = await fetchPage(ctx, urls[0], opts);
    return { stdout: r.text };
  }

  if (opts.cursor) throw new WebError("usage", "--cursor works with a single URL only");
  const outDir = str(args.values, "out-dir");
  const concurrency = intOpt(args.values, "concurrency", 4, 1, 16);

  const results = await mapPool(urls, concurrency, async (url) => {
    try {
      const r = await fetchPage(ctx, url, opts);
      return { url, ok: true as const, text: r.text, tokens: r.meta.tokens, truncated: r.truncated };
    } catch (e) {
      const eb = errorBlock(url, e);
      return { url, ok: false as const, text: eb.text, code: eb.code, message: (e as Error).message };
    }
  });

  const okCount = results.filter((r) => r.ok).length;
  const firstFailure = results.find((r) => !r.ok);
  const exitCode = okCount === 0 && firstFailure && !firstFailure.ok ? firstFailure.code : 0;

  if (outDir) {
    const dir = resolve(outDir);
    mkdirSync(dir, { recursive: true });
    const lines = [`Fetched ${urls.length} pages (${okCount} ok, ${urls.length - okCount} failed) -> ${dir}`, ""];
    results.forEach((r, i) => {
      const n = String(i + 1).padStart(3, "0");
      if (r.ok) {
        const file = join(dir, `${n}-${slug(r.url)}.md`);
        writeFileSync(file, r.text);
        lines.push(`${n} ok     ~${r.tokens} tok${r.truncated ? " (truncated)" : ""}  ${r.url}  ->  ${file}`);
      } else {
        lines.push(`${n} error  ${r.message}  ${r.url}`);
      }
    });
    return { stdout: lines.join("\n") + "\n", exitCode };
  }

  if (opts.format === "json") {
    return { stdout: results.map((r) => r.text.trimEnd()).join("\n") + "\n", exitCode };
  }
  return { stdout: results.map((r) => r.text.trimEnd()).join("\n\n") + "\n", exitCode };
}
