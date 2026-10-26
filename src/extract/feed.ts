import { DOMParser } from "linkedom";
import { collapseWhitespace, truncateChars } from "../util/text";

function childText(el: Element, ...names: string[]): string | undefined {
  for (const child of Array.from(el.children)) {
    const name = (child.localName ?? child.tagName).toLowerCase();
    if (names.includes(name)) {
      const t = collapseWhitespace(child.textContent ?? "");
      if (t) return t;
    }
  }
  return undefined;
}

function entryLink(el: Element): string | undefined {
  let fallback: string | undefined;
  for (const child of Array.from(el.children)) {
    if ((child.localName ?? child.tagName).toLowerCase() !== "link") continue;
    const href = child.getAttribute("href");
    const text = collapseWhitespace(child.textContent ?? "");
    const rel = child.getAttribute("rel");
    if (href && (!rel || rel === "alternate")) return href;
    if (href && !fallback) fallback = href;
    if (!href && text) return text;
  }
  return fallback;
}

function plain(s: string | undefined): string {
  if (!s) return "";
  return collapseWhitespace(s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&"));
}

/** RSS 2.0, Atom and RDF feeds become a flat list of entries. Returns null if the XML is not a feed. */
export function feedToMarkdown(xml: string): { markdown: string; title?: string } | null {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml.slice(0, 2000))) return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    return null;
  }
  const entries = Array.from(doc.querySelectorAll("item, entry"));
  const channel = doc.querySelector("channel, feed");
  const title = channel ? childText(channel, "title") : undefined;

  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, "");
  entries.forEach((e) => {
    const t = childText(e, "title") ?? "(untitled)";
    const link = entryLink(e);
    const date = childText(e, "pubdate", "published", "updated", "date");
    const summary = truncateChars(plain(childText(e, "description", "summary", "content", "encoded")), 280);
    lines.push(`- ${link ? `[${t}](${link})` : t}${date ? ` (${date})` : ""}`);
    if (summary) lines.push(`  ${summary}`);
  });
  if (entries.length === 0) lines.push("(feed has no entries)");
  return { markdown: lines.join("\n"), title };
}
