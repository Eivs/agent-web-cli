export type Kind = "html" | "markdown" | "text" | "json" | "feed" | "pdf" | "binary";

function looksLikeHtml(head: string): boolean {
  return /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(head);
}

function looksLikeFeed(head: string): boolean {
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(head.slice(0, 2000));
}

/**
 * Decide how to convert a response. `head` is the first couple of KB decoded as
 * text; it is only used to sniff when the Content-Type is missing or generic.
 */
export function detectKind(contentType: string | null, head: string, bytes: Uint8Array): Kind {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();

  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (mime === "application/pdf") return "pdf";

  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime === "application/rss+xml" || mime === "application/atom+xml" || mime === "application/rdf+xml") return "feed";
  if (mime === "application/xml" || mime === "text/xml") return looksLikeFeed(head) ? "feed" : "text";
  if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || mime.startsWith("font/")) {
    return "binary";
  }
  if (mime.startsWith("text/")) return looksLikeHtml(head) ? "html" : "text";

  // Missing or generic type: sniff.
  if (looksLikeHtml(head)) return "html";
  if (looksLikeFeed(head)) return "feed";
  const trimmed = head.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(new TextDecoder().decode(bytes));
      return "json";
    } catch {
      // fall through
    }
  }
  if (mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    // Treat as text only when the head has no control characters.
    return /[\u0000-\u0008\u000e-\u001f]/.test(head) ? "binary" : "text";
  }
  return "binary";
}
