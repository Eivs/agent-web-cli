import { estimateTokens } from "../util/tokens";

export interface Block {
  text: string;
  start: number;
  end: number;
  tokens: number;
  heading?: { level: number; title: string };
}

function parseHeading(text: string): Block["heading"] {
  if (text.includes("\n")) return undefined;
  const m = text.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
  return m ? { level: m[1].length, title: m[2] } : undefined;
}

/**
 * Split markdown into paragraph-level blocks. Fenced code stays in one block and
 * every heading is its own block. Offsets index into the original string, so
 * slices can be taken without re-joining.
 */
export function splitBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let pos = 0;
  let curStart = -1;
  let curEnd = -1;
  let fence: { ch: string; len: number } | null = null;

  const flush = () => {
    if (curStart < 0) return;
    const text = md.slice(curStart, curEnd);
    blocks.push({ text, start: curStart, end: curEnd, tokens: estimateTokens(text), heading: parseHeading(text) });
    curStart = -1;
  };

  while (pos <= md.length) {
    let nl = md.indexOf("\n", pos);
    if (nl === -1) nl = md.length;
    const line = md.slice(pos, nl);
    const trimmed = line.trim();
    const open = trimmed.match(/^(`{3,}|~{3,})/);

    if (fence) {
      if (curStart < 0) curStart = pos;
      curEnd = nl;
      const close = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) {
        fence = null;
        flush();
      }
    } else if (open) {
      flush();
      curStart = pos;
      curEnd = nl;
      fence = { ch: open[1][0], len: open[1].length };
    } else if (trimmed === "") {
      flush();
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      curStart = pos;
      curEnd = nl;
      flush();
    } else {
      if (curStart < 0) curStart = pos;
      curEnd = nl;
    }
    pos = nl + 1;
  }
  flush();
  return blocks;
}

/** Break a block that is larger than the budget into line- or character-sized pieces. */
function splitOversize(md: string, b: Block, maxTokens: number): Block[] {
  const out: Block[] = [];
  const push = (start: number, end: number) => {
    if (end <= start) return;
    const text = md.slice(start, end);
    out.push({ text, start, end, tokens: estimateTokens(text) });
  };
  let pieceStart = b.start;
  let used = 0;
  let pos = b.start;
  const maxChars = Math.max(200, maxTokens * 3);
  while (pos < b.end) {
    let nl = md.indexOf("\n", pos);
    if (nl === -1 || nl > b.end) nl = b.end;
    const lineTokens = estimateTokens(md.slice(pos, nl)) + 1;
    if (lineTokens > maxTokens) {
      // A single huge line: flush what we have, then cut it by characters.
      push(pieceStart, pos);
      for (let s = pos; s < nl; s += maxChars) push(s, Math.min(nl, s + maxChars));
      pieceStart = nl + 1;
      used = 0;
    } else if (used + lineTokens > maxTokens) {
      push(pieceStart, pos > pieceStart ? pos - 1 : pos);
      pieceStart = pos;
      used = lineTokens;
    } else {
      used += lineTokens;
    }
    pos = nl + 1;
  }
  push(pieceStart, b.end);
  return out;
}

export interface Page {
  text: string;
  /** Offset of the first character returned. */
  start: number;
  /** Offset to pass as the next cursor, or null when everything has been returned. */
  nextOffset: number | null;
  shownTokens: number;
  remainingTokens: number;
  totalTokens: number;
}

/**
 * Return roughly `maxTokens` of `md` starting at `offset`, always ending on a
 * block boundary (and preferring to stop just before a heading once more than
 * half the budget is used).
 */
export function sliceByTokens(md: string, offset: number, maxTokens: number): Page {
  const totalTokens = estimateTokens(md);
  const start = Math.min(Math.max(0, offset), md.length);

  let units: Block[] = [];
  for (const b of splitBlocks(md)) {
    if (b.end <= start) continue;
    let unit = b;
    if (b.start < start) {
      const text = md.slice(start, b.end);
      unit = { text, start, end: b.end, tokens: estimateTokens(text), heading: undefined };
    }
    if (unit.tokens > maxTokens) units.push(...splitOversize(md, unit, maxTokens));
    else units.push(unit);
  }

  if (units.length === 0) {
    return { text: "", start, nextOffset: null, shownTokens: 0, remainingTokens: 0, totalTokens };
  }

  let used = 0;
  let take = 0;
  for (const u of units) {
    if (take > 0 && used + u.tokens > maxTokens) break;
    if (take > 0 && u.heading && used >= maxTokens * 0.5) break;
    used += u.tokens;
    take++;
  }

  const first = units[0];
  const last = units[take - 1];
  const text = md.slice(first.start, last.end);
  const nextOffset = take < units.length ? units[take].start : null;
  const remainingTokens = nextOffset === null ? 0 : estimateTokens(md.slice(nextOffset));
  return { text, start: first.start, nextOffset, shownTokens: estimateTokens(text), remainingTokens, totalTokens };
}

// ---------------------------------------------------------------- outline

export interface OutlineEntry {
  level: number;
  title: string;
  start: number;
  end: number;
  tokens: number;
}

export function outline(md: string): OutlineEntry[] {
  const blocks = splitBlocks(md);
  const heads = blocks.filter((b) => b.heading);
  const entries: OutlineEntry[] = [];

  const firstHead = heads[0];
  const introEnd = firstHead ? firstHead.start : md.length;
  const intro = md.slice(0, introEnd).trim();
  if (intro && firstHead) {
    entries.push({ level: 0, title: "(intro)", start: 0, end: introEnd, tokens: estimateTokens(intro) });
  }

  heads.forEach((h, i) => {
    const level = h.heading!.level;
    let end = md.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].heading!.level <= level) {
        end = heads[j].start;
        break;
      }
    }
    entries.push({
      level,
      title: h.heading!.title,
      start: h.start,
      end,
      tokens: estimateTokens(md.slice(h.start, end)),
    });
  });
  return entries;
}

const norm = (s: string) => s.toLowerCase().replace(/[*_`[\]]/g, "").replace(/\s+/g, " ").trim();

export function findSection(
  md: string,
  query: string,
): { entry: OutlineEntry; matches: number } | null {
  const q = norm(query);
  if (!q) return null;
  const entries = outline(md).filter((e) => e.level > 0);
  const exact = entries.filter((e) => norm(e.title) === q);
  const starts = entries.filter((e) => norm(e.title).startsWith(q));
  const contains = entries.filter((e) => norm(e.title).includes(q));
  const pool = exact.length ? exact : starts.length ? starts : contains;
  return pool.length ? { entry: pool[0], matches: pool.length } : null;
}

// ---------------------------------------------------------- relevance (BM25)

export interface Chunk {
  index: number;
  text: string;
  start: number;
  end: number;
  tokens: number;
  path: string;
}

export interface ScoredChunk extends Chunk {
  score: number;
}

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "and", "or", "is", "are", "was", "were", "for", "on", "with", "as", "by",
  "at", "it", "this", "that", "be", "from", "how", "what", "do", "does",
]);

const CJK_CLASS = "\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}";
const TOKEN_RE = new RegExp(`(?:${CJK_CLASS})+|(?:(?!${CJK_CLASS})[\\p{L}\\p{N}_])+`, "gu");
const IS_CJK = new RegExp(`^(?:${CJK_CLASS})`, "u");

export function tokenizeForSearch(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const w = m[0];
    if (IS_CJK.test(w)) {
      const chars = Array.from(w);
      if (chars.length === 1) out.push(chars[0]);
      else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
    } else if (!STOP.has(w) && (w.length > 1 || /\d/.test(w))) {
      out.push(w);
    }
  }
  return out;
}

export function buildChunks(md: string, targetTokens = 300): Chunk[] {
  const blocks = splitBlocks(md);
  const chunks: Chunk[] = [];
  const stack: { level: number; title: string }[] = [];
  const pathNow = () => stack.map((s) => s.title).join(" > ");

  let cur: { start: number; end: number; tokens: number; path: string } | null = null;
  const flush = () => {
    if (!cur) return;
    const text = md.slice(cur.start, cur.end);
    chunks.push({ index: chunks.length, text, start: cur.start, end: cur.end, tokens: estimateTokens(text), path: cur.path });
    cur = null;
  };

  for (const b of blocks) {
    if (b.heading) {
      while (stack.length && stack[stack.length - 1].level >= b.heading.level) stack.pop();
      stack.push({ level: b.heading.level, title: b.heading.title });
      if (cur && cur.tokens >= targetTokens * 0.3) flush();
    }
    if (cur && cur.tokens + b.tokens > targetTokens) flush();
    if (!cur) cur = { start: b.start, end: b.end, tokens: b.tokens, path: pathNow() };
    else {
      cur.end = b.end;
      cur.tokens += b.tokens;
    }
  }
  flush();
  return chunks;
}

export function rankChunks(chunks: Chunk[], query: string): ScoredChunk[] {
  const q = [...new Set(tokenizeForSearch(query))];
  if (q.length === 0 || chunks.length === 0) return chunks.map((c) => ({ ...c, score: 0 }));

  const docs = chunks.map((c) => tokenizeForSearch(`${c.path} ${c.text}`));
  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);

  const k1 = 1.2;
  const b = 0.75;
  return chunks.map((c, i) => {
    const d = docs[i];
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgLen));
    }
    return { ...c, score };
  });
}

/** Pick the best-scoring chunks that fit `maxTokens`, returned in document order. */
export function selectRelevant(
  md: string,
  query: string,
  maxTokens: number,
): { chunks: ScoredChunk[]; total: number } | null {
  const chunks = buildChunks(md);
  const ranked = rankChunks(chunks, query);
  const hits = ranked.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  if (hits.length === 0) return null;
  const picked: ScoredChunk[] = [];
  let used = 0;
  for (const c of hits) {
    if (picked.length > 0 && used + c.tokens > maxTokens) continue;
    picked.push(c);
    used += c.tokens;
  }
  picked.sort((a, b) => a.index - b.index);
  return { chunks: picked, total: chunks.length };
}
