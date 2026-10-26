/**
 * Heuristic scan for text that tries to instruct the model rather than inform
 * the reader. This is advisory only: it adds a flag to the output header so the
 * calling agent is reminded to treat the page as data. It does not remove text,
 * and it will miss anything phrased creatively. The real mitigations are the
 * content boundary markers and stripping of hidden text.
 */
const PATTERNS: [string, RegExp][] = [
  [
    "ignore-previous-instructions",
    /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules?|context|directions?)\b/i,
  ],
  [
    "role-reassignment",
    /\byou are now (?:an? |the )?(?:ai|assistant|chatbot|language model|dan|in developer mode|unrestricted)/i,
  ],
  [
    "prompt-exfiltration",
    /\b(?:reveal|print|show|output|repeat|leak)\b[^.\n]{0,30}\b(?:system prompt|hidden instructions|your instructions|your prompt)\b/i,
  ],
  ["fake-chat-markup", /<\/?(?:system|assistant|im_start|im_end|instructions?)>|\[\/?INST\]|<\|(?:im_start|im_end|system)\|>/i],
  ["new-instructions", /\b(?:new|updated|additional|important) instructions?\s*(?:for (?:the )?(?:ai|assistant|agent|model))?\s*:/i],
  [
    "agent-directive",
    /\b(?:ai|llm|assistant|agent|language model)s?\b[^.\n]{0,40}\b(?:must|should|are required to|have to|need to)\b[^.\n]{0,60}\b(?:send|email|post|upload|exfiltrate|visit|navigate|run|execute|download|forward)\b/i,
  ],
];

export function scanInjection(text: string): string[] {
  const hits: string[] = [];
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(name);
  return hits;
}
