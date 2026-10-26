import { decodeBody } from "../net/decode";
import type { HttpResponse } from "../net/http";
import { scanInjection } from "../security/inject";
import { WebError } from "../util/errors";
import { stripInvisible, tidyMarkdown } from "../util/text";
import { estimateTokens } from "../util/tokens";
import { detectKind } from "./detect";
import type { HtmlOptions } from "./html";
import type { Doc } from "./types";

export interface ProcessOptions extends HtmlOptions {
  /** Return the decoded body unchanged (still stripped of invisible characters). */
  raw?: boolean;
}

/**
 * Turn an HTTP response into a markdown document plus metadata.
 *
 * The HTML and feed converters pull in a DOM implementation, so they are loaded
 * only when a page actually needs them (faster start for JSON, text, errors).
 */
export async function processResponse(res: HttpResponse, opts: ProcessOptions): Promise<Doc> {
  const contentType = res.headers.get("content-type");
  const headProbe = new TextDecoder("latin1").decode(res.body.subarray(0, 2048));
  const kind = detectKind(contentType, headProbe, res.body);

  if (kind === "pdf") {
    throw new WebError("unsupported", "PDF content is not supported in this version", {
      url: res.finalUrl,
      status: res.status,
      hint: "Download the file separately, or look for an HTML version of the document.",
    });
  }
  if (kind === "binary") {
    throw new WebError("unsupported", `Binary content (${contentType ?? "unknown type"}) cannot be converted to text`, {
      url: res.finalUrl,
      status: res.status,
      hint: "This tool reads text-based pages only (HTML, Markdown, JSON, plain text, RSS/Atom).",
    });
  }

  const decoded = decodeBody(res.body, contentType);
  const warnings: string[] = [];
  if (decoded.warning) warnings.push(decoded.warning);
  if (res.bodyTruncated) {
    warnings.push("Response exceeded the size limit and was cut off before conversion.");
  }

  let markdown = "";
  let extractor: string = kind;
  let title: string | undefined;
  let extra: Partial<Doc["meta"]> = {};

  if (opts.raw) {
    markdown = tidyMarkdown(decoded.text);
    extractor = "raw";
  } else if (kind === "html") {
    const { htmlToMarkdown, SelectorMissError } = await import("./html");
    try {
      const r = htmlToMarkdown(decoded.text, res.finalUrl, opts);
      markdown = r.markdown;
      extractor = r.extractor;
      title = r.title;
      warnings.push(...r.warnings);
      extra = { author: r.author, published: r.published, lang: r.lang, description: r.description, site: r.site };
    } catch (e) {
      if (e instanceof SelectorMissError) {
        throw new WebError("usage", e.message, {
          url: res.finalUrl,
          hint: "Check the selector, or drop --selector to use automatic extraction.",
        });
      }
      throw e;
    }
  } else if (kind === "json") {
    let pretty = decoded.text;
    try {
      pretty = JSON.stringify(JSON.parse(decoded.text), null, 2);
    } catch {
      warnings.push("Body was labelled JSON but did not parse; returned as-is.");
    }
    markdown = "```json\n" + stripInvisible(pretty) + "\n```";
  } else if (kind === "feed") {
    const { feedToMarkdown } = await import("./feed");
    const feed = feedToMarkdown(decoded.text);
    if (feed) {
      markdown = tidyMarkdown(feed.markdown);
      title = feed.title;
    } else {
      markdown = tidyMarkdown(decoded.text);
      extractor = "text";
    }
  } else {
    markdown = tidyMarkdown(decoded.text);
  }

  const injection = scanInjection(markdown);
  return {
    meta: {
      url: res.url,
      final_url: res.finalUrl,
      title,
      status: res.status,
      content_type: contentType?.split(";")[0].trim() || undefined,
      fetched_at: new Date().toISOString(),
      mode: "http",
      extractor,
      tokens: estimateTokens(markdown),
      warnings,
      injection_suspected: injection.length ? injection : undefined,
      ...extra,
    },
    markdown,
  };
}
