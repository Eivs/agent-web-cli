import { parseArgs } from "node:util";
import type { Config } from "../config";
import type { NetContext } from "../net/http";
import { WebError } from "../util/errors";

/** Options every command accepts. */
export const GLOBAL_OPTIONS = {
  proxy: { type: "string" },
  "no-proxy": { type: "boolean" },
  "allow-private": { type: "boolean" },
  timeout: { type: "string" },
  header: { type: "string", multiple: true },
  "user-agent": { type: "string" },
  "no-cache": { type: "boolean" },
  verbose: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
} as const;

export type ParsedArgs = {
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
};

type OptionSpec = Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }>;

export function parse(argv: string[], extra: OptionSpec, command: string): ParsedArgs {
  try {
    const r = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...extra } as never,
      allowPositionals: true,
      strict: true,
    });
    return { values: r.values as ParsedArgs["values"], positionals: r.positionals };
  } catch (e) {
    throw new WebError("usage", (e as Error).message.replace(/\.$/, ""), {
      hint: `Run \`web ${command} --help\` for the options.`,
    });
  }
}

export function str(v: ParsedArgs["values"], name: string): string | undefined {
  const x = v[name];
  return typeof x === "string" ? x : undefined;
}

export function bool(v: ParsedArgs["values"], name: string): boolean {
  return v[name] === true;
}

export function list(v: ParsedArgs["values"], name: string): string[] {
  const x = v[name];
  return Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : typeof x === "string" ? [x] : [];
}

export function intOpt(v: ParsedArgs["values"], name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = str(v, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new WebError("usage", `--${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

export function enumOpt<T extends string>(v: ParsedArgs["values"], name: string, allowed: readonly T[], fallback: T): T {
  const raw = str(v, name);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new WebError("usage", `--${name} must be one of: ${allowed.join(", ")} (got "${raw}")`);
  }
  return raw as T;
}

export function parseHeaders(entries: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of entries) {
    const i = h.indexOf(":");
    if (i <= 0) throw new WebError("usage", `Invalid --header "${h}"`, { hint: 'Use the form --header "Name: value"' });
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

export function makeContext(args: ParsedArgs, config: Config): NetContext {
  const proxy = str(args.values, "proxy");
  if (proxy && bool(args.values, "no-proxy")) {
    throw new WebError("usage", "--proxy and --no-proxy cannot be used together");
  }
  const userAgent = str(args.values, "user-agent");
  const cfg = userAgent ? { ...config, fetch: { ...config.fetch, userAgent } } : config;
  return {
    config: cfg,
    proxyFlag: proxy,
    noProxyFlag: bool(args.values, "no-proxy"),
    allowPrivate: bool(args.values, "allow-private") ? true : undefined,
    verbose: bool(args.values, "verbose"),
  };
}

/** --timeout is given in seconds. */
export function timeoutMs(args: ParsedArgs): number | undefined {
  const raw = str(args.values, "timeout");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!(n > 0)) throw new WebError("usage", `--timeout must be a positive number of seconds (got "${raw}")`);
  return Math.round(n * 1000);
}

export const GLOBAL_HELP = `Global options:
  --proxy <url>        HTTP proxy for this call, e.g. http://127.0.0.1:1086 (overrides config and env)
  --no-proxy           Connect directly, ignoring any proxy settings
  --allow-private      Allow private, loopback and link-local targets (blocked by default)
  --timeout <sec>      Request timeout in seconds
  --header "K: V"      Extra request header (repeatable)
  --user-agent <ua>    Override the User-Agent
  --no-cache           Ignore cached pages (continuation cursors still use the cache)
  -v, --verbose        Log requests and proxy decisions to stderr
  -h, --help           Show help for this command`;

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
