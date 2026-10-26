import { maskProxyUrl, type Config } from "../config";
import { WebError } from "../util/errors";
import { resolveProxy, type ProxyDecision } from "./proxy";
import { assertUrlAllowed } from "./ssrf";

export interface NetContext {
  config: Config;
  /** --proxy */
  proxyFlag?: string;
  /** --no-proxy */
  noProxyFlag?: boolean;
  /** --allow-private (or security.allowPrivate in the config) */
  allowPrivate?: boolean;
  env?: NodeJS.ProcessEnv;
  verbose?: boolean;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  retries?: number;
  /** Extra hostnames that skip the private-address check for this request. */
  allowHosts?: string[];
  /** Never use a proxy for this request. */
  forceDirect?: boolean;
}

export interface HttpResponse {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
  bodyTruncated: boolean;
  proxy: ProxyDecision;
  redirects: string[];
  elapsedMs: number;
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function logv(ctx: NetContext, msg: string) {
  if (ctx.verbose) process.stderr.write(`[web] ${msg}\n`);
}

export function parseUrl(raw: string): URL {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    throw new WebError("usage", `Invalid URL: ${raw}`, { hint: "Pass a full URL such as https://example.com/page" });
  }
}

function buildHeaders(ctx: NetContext, extra: Record<string, string> | undefined): Record<string, string> {
  const f = ctx.config.fetch;
  const merged: Record<string, string> = {
    "User-Agent": f.userAgent,
    Accept: f.accept,
    "Accept-Language": f.acceptLanguage,
  };
  const lowerToKey = new Map(Object.keys(merged).map((k) => [k.toLowerCase(), k]));
  for (const [k, v] of Object.entries(extra ?? {})) {
    const existing = lowerToKey.get(k.toLowerCase());
    if (existing) delete merged[existing];
    merged[k] = v;
  }
  return merged;
}

function classifyFetchError(e: unknown, url: URL, proxy: ProxyDecision, timeoutMs: number): WebError {
  const err = e as { name?: string; code?: string; message?: string };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new WebError("timeout", `Request timed out after ${timeoutMs}ms`, {
      url: url.href,
      hint: "Increase --timeout, or run `web doctor` to check the proxy and network.",
    });
  }
  const text = `${err?.code ?? ""} ${err?.message ?? String(e)}`.trim();
  if (/CERT|SSL|TLS|self.signed|unable to verify/i.test(text)) {
    return new WebError("network", `TLS error: ${text}`, {
      url: url.href,
      hint: "Certificate verification failed. If a proxy re-signs HTTPS traffic, trust its CA (NODE_EXTRA_CA_CERTS or SSL_CERT_FILE).",
    });
  }
  const hint = proxy.url
    ? `Could not connect through proxy ${maskProxyUrl(proxy.url)}. Check that it is running, or retry with --no-proxy.`
    : "Could not connect directly. If this network needs a proxy, set HTTPS_PROXY or pass --proxy http://127.0.0.1:1086.";
  return new WebError("network", `Connection failed: ${text}`, { url: url.href, hint });
}

async function readBody(
  res: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!res.body) return { body: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      const keep = maxBytes - total;
      if (keep > 0) chunks.push(value.subarray(0, keep));
      total += Math.max(keep, 0);
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.length;
  }
  return { body, truncated };
}

async function attempt(ctx: NetContext, rawUrl: string, opts: RequestOptions): Promise<HttpResponse> {
  const cfg = ctx.config;
  const timeoutMs = opts.timeoutMs ?? cfg.fetch.timeoutMs;
  const maxBytes = opts.maxBytes ?? cfg.fetch.maxBytes;
  const maxRedirects = opts.maxRedirects ?? cfg.fetch.maxRedirects;
  const started = Date.now();
  const headers = buildHeaders(ctx, opts.headers);
  const signal = AbortSignal.timeout(timeoutMs);

  let url = parseUrl(rawUrl);
  const redirects: string[] = [];

  for (let hop = 0; ; hop++) {
    const decision = resolveProxy(url, {
      flagProxy: ctx.proxyFlag,
      noProxyFlag: ctx.noProxyFlag,
      forceDirect: opts.forceDirect,
      config: cfg,
      env: ctx.env,
    });
    // Every hop is checked, so a redirect to 169.254.169.254 or localhost is refused.
    await assertUrlAllowed(url, {
      allowPrivate: ctx.allowPrivate ?? cfg.security.allowPrivate,
      allowHosts: [...cfg.security.allowHosts, ...(opts.allowHosts ?? [])],
      resolveLocally: !decision.url,
    });

    logv(ctx, `GET ${url.href} via ${decision.url ? maskProxyUrl(decision.url) : "direct"}`);
    let res: Response;
    try {
      res = await fetch(url.href, {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
        // Bun-specific option; ignored by other runtimes.
        ...(decision.url ? { proxy: decision.url } : {}),
      } as RequestInit);
    } catch (e) {
      throw classifyFetchError(e, url, decision, timeoutMs);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (location) {
        if (hop >= maxRedirects) {
          throw new WebError("network", `Too many redirects (more than ${maxRedirects})`, { url: rawUrl });
        }
        redirects.push(url.href);
        try {
          url = new URL(location, url);
        } catch {
          throw new WebError("network", `Invalid redirect target: ${location}`, { url: rawUrl });
        }
        continue;
      }
    }

    let body: Uint8Array;
    let truncated: boolean;
    try {
      ({ body, truncated } = await readBody(res, maxBytes));
    } catch (e) {
      throw classifyFetchError(e, url, decision, timeoutMs);
    }
    return {
      url: rawUrl,
      finalUrl: url.href,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body,
      bodyTruncated: truncated,
      proxy: decision,
      redirects,
      elapsedMs: Date.now() - started,
    };
  }
}

/**
 * GET with manual redirect handling (SSRF check on every hop), proxy
 * resolution, response size cap, and retry with backoff on network errors and
 * 429/502/503/504.
 */
export async function httpGet(ctx: NetContext, rawUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const retries = opts.retries ?? ctx.config.fetch.retries;
  for (let n = 0; ; n++) {
    try {
      const res = await attempt(ctx, rawUrl, opts);
      if (RETRY_STATUS.has(res.status) && n < retries) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** n;
        if (wait <= MAX_RETRY_AFTER_MS) {
          logv(ctx, `status ${res.status}, retrying in ${wait}ms`);
          await sleep(wait);
          continue;
        }
      }
      return res;
    } catch (e) {
      if (e instanceof WebError && e.code === "network" && n < retries && !/redirect|TLS|certificate/i.test(e.message)) {
        const wait = 500 * 2 ** n;
        logv(ctx, `${e.message}; retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}
