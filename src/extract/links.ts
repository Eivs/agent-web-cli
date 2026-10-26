import { parseHTML } from "linkedom";
import { collapseWhitespace } from "../util/text";

export interface PageLink {
  url: string;
  text: string;
}

/** All http(s) links on a page, resolved against `base`, de-duplicated, fragments removed. */
export function extractLinks(html: string, base: string): PageLink[] {
  const { document } = parseHTML(html.replace(/<!--[\s\S]*?-->/g, ""));
  let baseUrl = base;
  const baseTag = document.querySelector("base[href]")?.getAttribute("href");
  if (baseTag) {
    try {
      baseUrl = new URL(baseTag, base).href;
    } catch {
      // keep base
    }
  }
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href")?.trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    u.hash = "";
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ url: u.href, text: collapseWhitespace(a.textContent ?? "") });
  }
  return out;
}
