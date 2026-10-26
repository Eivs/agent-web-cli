import { cacheKey, readCache, writeCache } from "./cache";
import type { HtmlOptions, ImageMode, LinkMode } from "./extract/html";
import { findSection, outline, selectRelevant, sliceByTokens } from "./extract/paginate";
import { processResponse } from "./extract/process";
import type { Doc, DocMeta } from "./extract/types";
import { httpGet, parseUrl, type HttpResponse, type NetContext } from "./net/http";
import { renderDocument, sanitizeBoundary } from "./render";
import { WebError } from "./util/errors";
import { truncateChars } from "./util/text";
import { estimateTokens } from "./util/tokens";

export interface PageOptions {
  maxTokens: number;
  /** True when the caller passed --max-tokens (so it is repeated in the `next` command). */
  maxTokensExplicit: boolean;
  cursor?: string;
  outline: boolean;
  section?: string;
  query?: string;
  selector?: string;
  exclude: string[];
  links: LinkMode;
  images: ImageMode;
  raw: boolean;
  noCache: boolean;
  headers: Record<string, string>;
  timeoutMs?: number;
  format: "md" | "json";
}

export interface PageResult {
  text: string;
  meta: DocMeta;
  next?: string;
  truncated: boolean;
}

export const DEFAULT_PAGE_OPTIONS: Omit<PageOptions, "maxTokens"> = {
  maxTokensExplicit: false,
  outline: false,
  exclude: [],
  links: "inline",
  images: "alt",
  raw: false,
  noCache: false,
  headers: {},
  format: "md",
};

// ------------------------------------------------------------------ cursor

interface CursorState {
  v: 1;
  /** cache key of the converted document */
  k: string;
  /** character offset of the next page */
  o: number;
  /** section title, when the pages are slices of one section */
  s?: string;
  /** the document was fetched with private-network access enabled */
  p?: 1;
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

export function decodeCursor(raw: string): CursorState {
  try {
    const s = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as CursorState;
    if (s.v === 1 && typeof s.k === "string" && Number.isInteger(s.o) && s.o >= 0) return s;
  } catch {
    // fall through
  }
  throw new WebError("usage", "Invalid --cursor value", {
    hint: "Copy the cursor from the `next:` line of the previous output, without changing it.",
  });
}

// ------------------------------------------------------------ http -> doc

const CHALLENGE = /cf-chl|just a moment|challenge-platform|captcha|attention required|access denied|verify you are human/i;

function statusError(res: HttpResponse): WebError {
  const url = res.finalUrl;
  const status = res.status;
  const bodyHead = new TextDecoder().decode(res.body.subarray(0, 4096));
  if (status === 401 || status === 403 || status === 429 || (status === 503 && CHALLENGE.test(bodyHead))) {
    const challenge = CHALLENGE.test(bodyHead);
    return new WebError("blocked", `HTTP ${status}${challenge ? " (looks like a bot-challenge page)" : ""}`, {
      url,
      status,
      hint:
        status === 429
          ? "Rate limited. Wait before retrying, or fetch a different source."
          : status === 401
            ? "Login required. This build has no login support; look for a public copy of the page."
            : "The site refused this request. Try another network exit (--proxy), or use a different source for the same information. This build has no browser mode for challenge pages.",
    });
  }
  if (status === 404 || status === 410) {
    return new WebError("http", `HTTP ${status} not found`, {
      url,
      status,
      hint: "Check the URL. Use `web search` or `web map <site>` to find the right page.",
    });
  }
  return new WebError("http", `HTTP ${status} ${res.statusText}`.trim(), {
    url,
    status,
    hint: status >= 500 ? "Server error. Retrying later may help." : "Unexpected response status.",
  });
}

async function networkDoc(ctx: NetContext, url: URL, o: PageOptions): Promise<Doc> {
  const res = await httpGet(ctx, url.href, { headers: o.headers, timeoutMs: o.timeoutMs });
  if (res.status < 200 || res.status >= 300) throw statusError(res);
  const htmlOpts: HtmlOptions = { links: o.links, images: o.images, selector: o.selector, exclude: o.exclude };
  const doc = await processResponse(res, { ...htmlOpts, raw: o.raw });
  if (res.redirects.length) doc.meta.warnings.push(`Redirected ${res.redirects.length} time(s) to ${res.finalUrl}`);
  return doc;
}

// ---------------------------------------------------------------- present

function shq(s: string): string {
  return /^[\w./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function nextCommand(url: string, cursor: string, o: PageOptions, allowPrivateFlag: boolean): string {
  const parts = ["web", "fetch", shq(url), "--cursor", cursor];
  if (allowPrivateFlag) parts.push("--allow-private");
  if (o.maxTokensExplicit) parts.push("--max-tokens", String(o.maxTokens));
  if (o.links !== "inline") parts.push("--links", o.links);
  if (o.images !== "alt") parts.push("--images", o.images);
  if (o.selector) parts.push("--selector", shq(o.selector));
  for (const e of o.exclude) parts.push("--exclude", shq(e));
  if (o.raw) parts.push("--raw");
  if (o.format !== "md") parts.push("--format", o.format);
  return parts.join(" ");
}

function renderOutline(doc: Doc): string {
  const entries = outline(doc.markdown);
  if (entries.length === 0) {
    return "No headings found. Read in order with --cursor paging, or use --query \"...\" to pull the relevant parts.";
  }
  const lines = [
    `Outline (total ~${doc.meta.tokens} tokens). Read one part with --section "<title>".`,
    "",
    ...entries.map((e) => `${"  ".repeat(Math.max(0, e.level - 1))}- ${truncateChars(e.title, 100)} (~${e.tokens} tok)`),
  ];
  return lines.join("\n");
}

function toJson(meta: DocMeta, content: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ ...meta, untrusted: true, ...extra, content: sanitizeBoundary(content) });
}

interface PrivateAccess {
  /** private-network access is in effect (flag or config) */
  allowed: boolean;
  /** it came from --allow-private, so the `next` command must repeat the flag */
  flag: boolean;
}

function present(
  doc: Doc,
  url: URL,
  key: string,
  o: PageOptions,
  cursor: ReturnType<typeof decodeCursor> | undefined,
  refetched: boolean,
  priv: PrivateAccess,
): PageResult {
  const meta: DocMeta = { ...doc.meta, warnings: [...doc.meta.warnings] };
  if (refetched) meta.warnings.push("Cached copy expired, so the page was fetched again; the cursor position may be slightly off.");

  const finish = (body: string, extra: Record<string, unknown> = {}, next?: string, footer?: string): PageResult => {
    const truncated = extra.truncated === true;
    const text =
      o.format === "json"
        ? toJson(meta, body, { ...extra, next: next ?? null })
        : renderDocument({ meta, body, extra: { ...extra, next }, footer });
    return { text: text.endsWith("\n") ? text : text + "\n", meta, next, truncated };
  };

  if (o.outline) return finish(renderOutline(doc), { outline: true });

  let md = doc.markdown;
  const extra: Record<string, unknown> = {};

  const sectionTitle = o.section ?? cursor?.s;
  if (sectionTitle) {
    const found = findSection(md, sectionTitle);
    if (!found) {
      const titles = outline(md)
        .filter((e) => e.level > 0)
        .slice(0, 15)
        .map((e) => truncateChars(e.title, 60));
      throw new WebError("usage", `No section matches "${truncateChars(sectionTitle, 80)}"`, {
        url: url.href,
        hint: titles.length ? `Sections on this page: ${titles.join(" | ")}. Use --outline to see all.` : "This page has no headings.",
      });
    }
    md = md.slice(found.entry.start, found.entry.end);
    extra.section = found.entry.title;
    if (found.matches > 1) extra.section_matches = found.matches;
  }

  if (o.query && !cursor) {
    const sel = selectRelevant(md, o.query, o.maxTokens);
    if (sel) {
      const body = sel.chunks
        .map((c) => `[chunk ${c.index + 1}/${sel.total}${c.path ? ` · ${truncateChars(c.path, 80)}` : ""}]\n\n${c.text}`)
        .join("\n\n---\n\n");
      return finish(
        body,
        { ...extra, query: o.query, chunks: `${sel.chunks.length}/${sel.total}`, shown_tokens: `~${estimateTokens(body)}` },
        undefined,
        "[Showing only the best-matching chunks. Drop --query to read the page in order, or use --section.]",
      );
    }
    meta.warnings.push(`No part of the page matched --query "${truncateChars(o.query, 60)}"; showing the start of the page.`);
  }

  const page = sliceByTokens(md, cursor?.o ?? 0, o.maxTokens);
  if (cursor && page.text === "") {
    throw new WebError("usage", "Cursor is past the end of the document", { url: url.href, hint: "You already have the whole page." });
  }
  extra.shown_tokens = `~${page.shownTokens}`;
  let next: string | undefined;
  if (page.nextOffset !== null) {
    extra.truncated = true;
    extra.remaining_tokens = `~${page.remainingTokens}`;
    const c = encodeCursor({
      v: 1,
      k: key,
      o: page.nextOffset,
      ...(sectionTitle ? { s: sectionTitle } : {}),
      ...(priv.allowed ? { p: 1 as const } : {}),
    });
    next = nextCommand(url.href, c, o, priv.flag);
  }
  return finish(page.text, extra, next, next ? `[Truncated: ~${page.remainingTokens} tokens remain. Continue with the \`next\` command in the header.]` : undefined);
}

// ------------------------------------------------------------------ entry

/** Fetch a URL (or continue a cursor) and return rendered output for the agent. */
export async function fetchPage(ctx: NetContext, rawUrl: string, o: PageOptions): Promise<PageResult> {
  const url = parseUrl(rawUrl);
  const cursor = o.cursor ? decodeCursor(o.cursor) : undefined;
  const allowed = ctx.allowPrivate ?? ctx.config.security.allowPrivate;
  const priv: PrivateAccess = { allowed, flag: ctx.allowPrivate === true };
  // Content fetched with private-network access must never be served to a call
  // that does not have it, so the permission is part of the cache key and of
  // every cursor. (Otherwise a cache hit would skip the SSRF checks entirely.)
  const key = cacheKey({ v: 2, u: url.href, links: o.links, images: o.images, sel: o.selector, ex: o.exclude, raw: o.raw, ap: allowed });
  if (cursor?.p && !allowed) {
    throw new WebError("ssrf", "This cursor belongs to a page fetched with private-network access", {
      url: url.href,
      hint: "Run the same command with --allow-private.",
    });
  }
  const ttl = ctx.config.fetch.cacheTtlSec;

  let doc: Doc | null = null;
  let refetched = false;
  if (cursor) doc = readCache(cursor.k, 3600);
  else if (!o.noCache) doc = readCache(key, ttl);

  if (!doc) {
    doc = await networkDoc(ctx, url, o);
    writeCache(key, doc);
    refetched = !!cursor;
  }
  return present(doc, url, refetched ? key : (cursor?.k ?? key), o, cursor, refetched, priv);
}
