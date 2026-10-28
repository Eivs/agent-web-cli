import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WebError } from "./util/errors";

export interface Config {
  proxy: {
    /** e.g. http://127.0.0.1:1086. Used when no --proxy flag is given. */
    url?: string;
    /** Comma separated, same syntax as NO_PROXY. Overrides the env NO_PROXY when set. */
    noProxy?: string;
  };
  search: {
    /** Full SearXNG search endpoint, e.g. https://searx.example.com/search */
    url?: string;
    /** Bearer token (or whatever authScheme says). Prefer tokenEnv for secrets. */
    token?: string;
    /** Name of an environment variable that holds the token. */
    tokenEnv?: string;
    authHeader: string;
    /** "Bearer", "Basic", or "" to send the raw token. */
    authScheme: string;
    headers: Record<string, string>;
    /** Extra query parameters sent on every search, e.g. { "language": "en" }. */
    params: Record<string, string>;
    /** "inherit" follows the normal proxy rules, "direct" never uses a proxy for SearXNG. */
    proxy: "inherit" | "direct";
    timeoutMs: number;
  };
  fetch: {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    retries: number;
    userAgent: string;
    accept: string;
    acceptLanguage: string;
    maxTokens: number;
    cacheTtlSec: number;
  };
  security: {
    allowPrivate: boolean;
    /** Hostnames that skip the private-address check (exact match). */
    allowHosts: string[];
  };
}

export const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export function defaultConfig(): Config {
  return {
    proxy: {},
    search: {
      authHeader: "Authorization",
      authScheme: "Bearer",
      headers: {},
      params: {},
      proxy: "inherit",
      timeoutMs: 20_000,
    },
    fetch: {
      timeoutMs: 30_000,
      maxBytes: 10 * 1024 * 1024,
      maxRedirects: 8,
      retries: 2,
      userAgent: DEFAULT_UA,
      accept:
        "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/xml;q=0.8, */*;q=0.5",
      acceptLanguage: "en-US,en;q=0.9",
      maxTokens: 6000,
      cacheTtlSec: 900,
    },
    security: { allowPrivate: false, allowHosts: [] },
  };
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WEB_CONFIG) return env.WEB_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "agent-web-cli", "config.json");
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "agent-web-cli");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge of plain objects; arrays and scalars from `over` replace `base`. */
export function mergeDeep<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? mergeDeep(out[k], v) : v;
  }
  return out as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let cfg = defaultConfig();
  const path = configPath(env);
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new WebError("config", `Cannot parse config file ${path}: ${(e as Error).message}`, {
        hint: "Fix the JSON syntax or delete the file. Run `web config init` to write a fresh template.",
      });
    }
    cfg = mergeDeep(cfg, parsed);
  }
  if (env.WEB_PROXY) cfg.proxy.url = env.WEB_PROXY;
  if (env.WEB_SEARXNG_URL) cfg.search.url = env.WEB_SEARXNG_URL;
  if (env.WEB_SEARXNG_TOKEN) cfg.search.token = env.WEB_SEARXNG_TOKEN;
  return cfg;
}

export function resolveSearchToken(cfg: Config, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cfg.search.token) return cfg.search.token;
  if (cfg.search.tokenEnv) return env[cfg.search.tokenEnv] || undefined;
  return undefined;
}

export const CONFIG_TEMPLATE = {
  proxy: {
    url: "http://127.0.0.1:1086",
    noProxy: "localhost,127.0.0.1,::1",
  },
  search: {
    url: "https://searx.example.com/search",
    tokenEnv: "SEARXNG_TOKEN",
    authHeader: "Authorization",
    authScheme: "Bearer",
    params: { language: "en" },
    proxy: "inherit",
  },
  fetch: {
    maxTokens: 6000,
    cacheTtlSec: 900,
  },
  security: {
    allowPrivate: false,
    allowHosts: [],
  },
};

export function writeConfigTemplate(env: NodeJS.ProcessEnv = process.env, force = false): string {
  const path = configPath(env);
  if (existsSync(path) && !force) {
    throw new WebError("config", `Config already exists: ${path}`, {
      hint: "Edit it directly, or pass --force to overwrite.",
    });
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export function maskSecret(s: string | undefined): string | undefined {
  if (!s) return s;
  if (s.length <= 8) return "***";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

/** Hide credentials embedded in a proxy URL for display. */
export function maskProxyUrl(u: string | undefined): string | undefined {
  if (!u) return u;
  try {
    const url = new URL(u);
    if (url.username || url.password) {
      url.username = "***";
      url.password = url.password ? "***" : "";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}
