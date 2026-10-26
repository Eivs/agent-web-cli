export type ErrorCode =
  | "usage"
  | "network"
  | "blocked"
  | "timeout"
  | "unsupported"
  | "ssrf"
  | "config"
  | "http"
  | "internal";

/** Stable exit codes. Documented in SKILL.md and README. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  internal: 1,
  usage: 2,
  network: 3,
  blocked: 4,
  timeout: 5,
  unsupported: 6,
  ssrf: 7,
  config: 8,
  http: 9,
};

export interface WebErrorOptions {
  hint?: string;
  status?: number;
  url?: string;
}

export class WebError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly status?: number;
  readonly url?: string;

  constructor(code: ErrorCode, message: string, opts: WebErrorOptions = {}) {
    super(message);
    this.name = "WebError";
    this.code = code;
    this.hint = opts.hint;
    this.status = opts.status;
    this.url = opts.url;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.url ? { url: this.url } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}
