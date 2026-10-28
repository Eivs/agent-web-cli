import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { collapseWhitespace, stripInvisible, tidyMarkdown } from "../util/text";

export type LinkMode = "inline" | "none" | "index";
export type ImageMode = "alt" | "keep" | "none";

export interface HtmlOptions {
  links: LinkMode;
  images: ImageMode;
  /** CSS selector for the region to convert. Skips automatic extraction. */
  selector?: string;
  /** CSS selectors to delete before extraction. */
  exclude?: string[];
}

export interface HtmlResult {
  markdown: string;
  title?: string;
  author?: string;
  published?: string;
  lang?: string;
  description?: string;
  site?: string;
  extractor: "readability" | "selector" | "main" | "body";
  warnings: string[];
}

// linkedom's types are loose; the code below sticks to the standard DOM subset.
type Doc = ReturnType<typeof parseHTML>["document"];

const ALWAYS_REMOVE = ["script", "style", "noscript", "template", "iframe", "object", "embed", "canvas", "svg", "link", "meta"];
const CONTROL_REMOVE = ["input", "select", "textarea", "button", "[hidden]", '[aria-hidden="true"]'];
const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![\d.])|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$)|(?:left|top|text-indent)\s*:\s*-\d{4,}/i;
const CHROME_SELECTORS = [
  "nav", "aside", "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[role=complementary]", "[role=search]",
  "[aria-label*=cookie i]", "[id*=cookie i]", "[class*=cookie i]", "[id*=consent i]", "[class*=consent i]",
  "[class*=advert i]", "[id^=ad-]", "[class*=newsletter i]", "[class*=popup i]", "[class*=modal i]",
];

function removeAll(root: ParentNode, selector: string) {
  for (const el of Array.from(root.querySelectorAll(selector))) el.remove();
}

/** Remove scripts, controls and anything hidden from a human reader. */
function stripNoiseAndHidden(doc: Doc) {
  for (const sel of ALWAYS_REMOVE) removeAll(doc, sel);
  for (const sel of CONTROL_REMOVE) removeAll(doc, sel);
  for (const el of Array.from(doc.querySelectorAll("[style]"))) {
    if (HIDDEN_STYLE.test(el.getAttribute("style") ?? "")) el.remove();
  }
}

function textLen(el: { textContent: string | null } | null | undefined): number {
  return collapseWhitespace(el?.textContent ?? "").length;
}

/** Fallback cleanup used when Readability gives up: strip page chrome but keep the body. */
function stripChrome(doc: Doc) {
  const guarded = (el: Element) =>
    el === doc.documentElement ||
    el === doc.body ||
    !!el.querySelector("main, article") ||
    !!el.closest("main, article");
  for (const sel of CHROME_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(sel))) if (!guarded(el)) el.remove();
  }
  for (const el of Array.from(doc.querySelectorAll("header, footer"))) {
    if (!el.closest("article, main")) el.remove();
  }
}

function metaContent(doc: Doc, ...names: string[]): string | undefined {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return undefined;
}

interface LdInfo {
  published?: string;
  author?: string;
}

function readJsonLd(doc: Doc): LdInfo {
  const info: LdInfo = {};
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const o = node as Record<string, unknown>;
    if (!info.published && typeof o.datePublished === "string") info.published = o.datePublished;
    if (!info.author && o.author) {
      const a = Array.isArray(o.author) ? o.author[0] : o.author;
      if (typeof a === "string") info.author = a;
      else if (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string") {
        info.author = (a as { name: string }).name;
      }
    }
    if (o["@graph"]) visit(o["@graph"]);
  };
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      visit(JSON.parse(s.textContent ?? ""));
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return info;
}

function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

function firstSrcsetUrl(srcset: string | null): string | undefined {
  const first = srcset?.split(",")[0]?.trim().split(/\s+/)[0];
  return first || undefined;
}

/** Normalise links, images and tables in the chosen content, then return its HTML. */
function prepareFragment(
  contentHtml: string,
  base: string,
  opts: HtmlOptions,
): { html: string; warnings: string[]; links: string[] } {
  const { document: doc } = parseHTML(`<!doctype html><html><body><div id="__root">${contentHtml}</div></body></html>`);
  const root = doc.getElementById("__root")!;
  const warnings: string[] = [];

  // ---- links
  const index: string[] = [];
  for (const a of Array.from(root.querySelectorAll("a"))) {
    const href = a.getAttribute("href")?.trim();
    const text = collapseWhitespace(a.textContent ?? "");
    const hasImg = !!a.querySelector("img");
    if (!href || href.startsWith("#") || (!text && !hasImg)) {
      unwrap(a);
      continue;
    }
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      unwrap(a);
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:" && abs.protocol !== "mailto:") {
      unwrap(a);
      continue;
    }
    if (opts.links === "none") {
      unwrap(a);
    } else if (opts.links === "index") {
      let n = index.indexOf(abs.href) + 1;
      if (n === 0) {
        index.push(abs.href);
        n = index.length;
      }
      // Rendered by the Turndown rule below: a plain text node would come out
      // as "\[1\]", because Turndown escapes brackets in text.
      a.setAttribute("data-web-link", String(n));
      a.removeAttribute("title");
    } else {
      a.setAttribute("href", abs.href);
      a.removeAttribute("title");
    }
  }

  // ---- images
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const alt = collapseWhitespace(img.getAttribute("alt") ?? "");
    if (opts.images === "keep") {
      let src = img.getAttribute("src")?.trim() ?? "";
      if (!src || src.startsWith("data:")) {
        src = img.getAttribute("data-src") ?? img.getAttribute("data-original") ?? firstSrcsetUrl(img.getAttribute("srcset")) ?? "";
      }
      try {
        const abs = src && !src.startsWith("data:") ? new URL(src, base).href : "";
        if (abs) {
          img.setAttribute("src", abs);
          img.removeAttribute("title");
          continue;
        }
      } catch {
        // fall through to removal
      }
      img.remove();
    } else if (opts.images === "alt" && alt.length >= 2) {
      // Rendered by the Turndown rule below, so the brackets stay unescaped.
      img.setAttribute("data-web-image", "alt");
    } else {
      img.remove();
    }
  }

  // ---- tables: markdown tables need a header row, and cells must stay on one line
  for (const table of Array.from(root.querySelectorAll("table"))) {
    for (const br of Array.from(table.querySelectorAll("td br, th br"))) br.replaceWith(doc.createTextNode(" "));
    const firstRow = table.querySelector("tr");
    if (!firstRow) continue;
    for (const cell of Array.from(firstRow.children)) {
      if (cell.tagName.toLowerCase() === "td") {
        const th = doc.createElement("th");
        th.innerHTML = cell.innerHTML;
        cell.replaceWith(th);
      }
    }
  }

  return { html: root.innerHTML, warnings, links: index };
}

let turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (turndown) return turndown;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
    linkStyle: "inlined",
  });
  td.use(gfm);
  // These markers are rendered here rather than as text nodes: Turndown escapes
  // brackets in text ("\[image: alt\]", "\[1\]"), which diverges from the
  // documented output and from what agents expect.
  td.addRule("webImageAlt", {
    filter: (node) => node.nodeName === "IMG" && node.getAttribute("data-web-image") === "alt",
    replacement: (_content, node) => {
      const alt = collapseWhitespace(node.getAttribute("alt") ?? "");
      return alt ? `[image: ${alt.replace(/[[\]]/g, "\\$&")}]` : "";
    },
  });
  td.addRule("webLinkIndex", {
    filter: (node) => node.nodeName === "A" && node.getAttribute("data-web-link") !== null,
    replacement: (content, node) => {
      const n = node.getAttribute("data-web-link");
      return content ? `${content} [${n}]` : `[${n}]`;
    },
  });
  turndown = td;
  return td;
}

const SPA_MARKERS = /id=["'](?:root|__next|app|__nuxt)["']|__NEXT_DATA__|window\.__NUXT__|ng-version|data-reactroot/i;

export function htmlToMarkdown(html: string, pageUrl: string, opts: HtmlOptions): HtmlResult {
  const warnings: string[] = [];
  // Comments can hide instructions; drop them before parsing.
  const cleanedHtml = stripInvisible(html).replace(/<!--[\s\S]*?-->/g, "");

  const { document } = parseHTML(cleanedHtml);

  // ---- metadata (read before anything is removed)
  const ld = readJsonLd(document);
  const baseTag = document.querySelector("base[href]")?.getAttribute("href");
  let base = pageUrl;
  if (baseTag) {
    try {
      base = new URL(baseTag, pageUrl).href;
    } catch {
      // keep pageUrl
    }
  }
  const pageMeta = {
    title: metaContent(document, "og:title", "twitter:title") ?? (collapseWhitespace(document.title ?? "") || undefined),
    author: metaContent(document, "author", "article:author", "twitter:creator") ?? ld.author,
    published:
      metaContent(document, "article:published_time", "datePublished", "date", "pubdate", "og:article:published_time") ??
      ld.published ??
      document.querySelector("time[datetime]")?.getAttribute("datetime")?.trim(),
    lang: document.documentElement?.getAttribute("lang")?.trim() || undefined,
    description: metaContent(document, "description", "og:description", "twitter:description"),
    site: metaContent(document, "og:site_name", "application-name"),
  };

  stripNoiseAndHidden(document);
  for (const sel of opts.exclude ?? []) {
    try {
      removeAll(document, sel);
    } catch {
      warnings.push(`Ignored invalid --exclude selector: ${sel}`);
    }
  }

  let contentHtml = "";
  let extractor: HtmlResult["extractor"] = "body";
  let title = pageMeta.title;
  let byline = pageMeta.author;

  if (opts.selector) {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(opts.selector));
    } catch {
      // An unparsable selector is reported the same way as one that matches nothing.
      throw new SelectorMissError(opts.selector);
    }
    if (nodes.length === 0) throw new SelectorMissError(opts.selector);
    contentHtml = nodes.map((n) => n.outerHTML).join("\n");
    extractor = "selector";
  } else {
    // Readability mutates the document, so keep a second parse for the fallback.
    const fallbackDoc = parseHTML(document.documentElement.outerHTML).document;
    let article: ReturnType<Readability["parse"]> = null;
    try {
      // keepClasses keeps `class="language-js"` on <code>, which is what makes
      // Turndown emit a fenced block with its language.
      article = new Readability(document as unknown as Document, { charThreshold: 300, keepClasses: true }).parse();
    } catch {
      article = null;
    }

    stripChrome(fallbackDoc);
    const main =
      fallbackDoc.querySelector("main, [role=main]") ??
      Array.from(fallbackDoc.querySelectorAll("article")).sort((a, b) => textLen(b) - textLen(a))[0] ??
      null;
    const fallbackEl = main && textLen(main) >= 200 ? main : fallbackDoc.body;
    const fallbackLen = textLen(fallbackEl);
    const articleLen = collapseWhitespace(article?.textContent ?? "").length;

    if (article?.content && articleLen >= 300 && articleLen >= 0.25 * fallbackLen) {
      contentHtml = article.content;
      extractor = "readability";
      title = pageMeta.title ?? article.title ?? undefined;
      byline = byline ?? (article.byline ? collapseWhitespace(article.byline) : undefined);
    } else if (fallbackEl) {
      contentHtml = fallbackEl.innerHTML;
      extractor = fallbackEl === fallbackDoc.body ? "body" : "main";
    }
  }

  const prepared = prepareFragment(contentHtml, base, opts);
  warnings.push(...prepared.warnings);
  let markdown = tidyMarkdown(getTurndown().turndown(prepared.html));
  if (opts.links === "index" && prepared.links.length) {
    // Appended after conversion so Turndown cannot escape the "[1]" markers.
    markdown += "\n\n## Links\n\n" + prepared.links.map((u, i) => `[${i + 1}] ${u}`).join("\n");
  }

  if (markdown.length < 200) {
    warnings.push(
      SPA_MARKERS.test(html)
        ? "Page looks JavaScript-rendered and little text was extracted. This build fetches over HTTP only (no browser mode), so content may be incomplete."
        : "Very little text was extracted from this page.",
    );
  }

  return {
    markdown,
    title,
    author: byline,
    published: pageMeta.published,
    lang: pageMeta.lang,
    description: pageMeta.description,
    site: pageMeta.site,
    extractor,
    warnings,
  };
}

export class SelectorMissError extends Error {
  constructor(public selector: string) {
    super(`Selector matched nothing (or is not valid CSS): ${selector}`);
  }
}
