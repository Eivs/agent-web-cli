const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g;

/**
 * Cheap token estimate that needs no tokenizer: roughly one token per CJK
 * character and one per four other characters. Good enough for budgeting;
 * the CLI always labels the numbers as approximate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
