/**
 * Characters that are invisible to a human reader but can carry hidden
 * instructions to a model: zero-width characters, bidi controls, and the
 * Unicode "tag" block used for ASCII smuggling.
 *
 * ZWNJ/ZWJ (U+200C/U+200D) are legitimate in several scripts and emoji, so they
 * are only stripped when they appear in runs of two or more.
 */
const INVISIBLE = /[​⁠-⁤﻿‪-‮⁦-⁩­]|[\u{E0000}-\u{E007F}]|[‌‍]{2,}/gu;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, "");
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Tidy converted markdown: no trailing spaces, at most one blank line in a row. */
export function tidyMarkdown(md: string): string {
  return stripInvisible(md)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*\[\]\([^)]*\)\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}
