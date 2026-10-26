/** Minimal sitemap.xml / sitemap index / robots.txt parsing. No XML parser needed. */

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

export interface SitemapParse {
  /** Child sitemaps when the file is a sitemap index. */
  sitemaps: string[];
  urls: SitemapEntry[];
}

function unescapeXml(s: string): string {
  return s
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? unescapeXml(m[1]) : undefined;
}

export function parseSitemap(xml: string, maxUrls = 50_000): SitemapParse {
  const out: SitemapParse = { sitemaps: [], urls: [] };
  for (const m of xml.matchAll(/<sitemap[\s>]([\s\S]*?)<\/sitemap>/gi)) {
    const loc = tag(m[1], "loc");
    if (loc) out.sitemaps.push(loc);
  }
  for (const m of xml.matchAll(/<url[\s>]([\s\S]*?)<\/url>/gi)) {
    const loc = tag(m[1], "loc");
    if (!loc) continue;
    out.urls.push({ loc, lastmod: tag(m[1], "lastmod") });
    if (out.urls.length >= maxUrls) break;
  }
  return out;
}

/** `Sitemap:` lines from a robots.txt body. */
export function sitemapsFromRobots(robots: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m) out.push(m[1]);
  }
  return out;
}
