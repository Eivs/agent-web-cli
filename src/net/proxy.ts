import { isIP } from "node:net";
import type { Config } from "../config";
import { maskProxyUrl } from "../config";
import { WebError } from "../util/errors";

export interface ProxyDecision {
  /** Proxy URL to use, or undefined for a direct connection. */
  url?: string;
  source: "flag" | "config" | "env" | "none" | "bypass";
  reason?: string;
}

export interface ProxyInput {
  /** Value of --proxy. Wins over everything, including NO_PROXY. */
  flagProxy?: string;
  /** --no-proxy: always connect directly. */
  noProxyFlag?: boolean;
  /** Used by callers that must never proxy (e.g. search.proxy = "direct"). */
  forceDirect?: boolean;
  config: Config;
  env?: NodeJS.ProcessEnv;
}

export function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new WebError("config", `Invalid proxy URL: ${raw}`, {
      hint: "Use a form like http://127.0.0.1:1086",
    });
  }
  if (u.protocol === "socks5:" || u.protocol === "socks5h:" || u.protocol === "socks4:" || u.protocol === "socks:") {
    throw new WebError("config", `SOCKS proxies are not supported (got ${maskProxyUrl(withScheme)})`, {
      hint: "This build only speaks HTTP/HTTPS proxies. Use the HTTP port of your proxy tool, e.g. http://127.0.0.1:1086.",
    });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new WebError("config", `Unsupported proxy scheme: ${u.protocol}`, {
      hint: "Use an http:// or https:// proxy URL.",
    });
  }
  return u.toString().replace(/\/$/, "");
}

const PROXY_ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
/** Holds the original proxy variables on the re-executed child. */
const SNAPSHOT_VAR = "WEB_PROXY_ENV_SNAPSHOT";
let capturedEnv: NodeJS.ProcessEnv | null = null;

/**
 * Bun's fetch reads HTTP(S)_PROXY / NO_PROXY from the environment and lets them
 * override both `--no-proxy` and an explicit `proxy` option. Routing must stay
 * under this tool's control, so the shell's values are snapshotted and removed,
 * and `resolveProxy` reads the snapshot.
 *
 * The removal has to happen before the process starts: Bun freezes these
 * variables at launch, so deleting them from `process.env` afterwards has no
 * effect on fetch(), and a launch-time NO_PROXY still beats an explicit `proxy`
 * option (oven-sh/bun#35003, still open as of Bun 1.4.4). When any of them is
 * present, re-exec once with a clean environment and hand the original values
 * over in SNAPSHOT_VAR.
 */
export async function sanitizeProxyEnv(): Promise<void> {
  if (capturedEnv) return;

  const snapRaw = process.env[SNAPSHOT_VAR];
  if (snapRaw) {
    try {
      capturedEnv = JSON.parse(snapRaw) as NodeJS.ProcessEnv;
    } catch {
      capturedEnv = {};
    }
    for (const k of PROXY_ENV_KEYS) delete process.env[k];
    return;
  }

  const snapshot: NodeJS.ProcessEnv = {};
  for (const k of PROXY_ENV_KEYS) {
    if (process.env[k] !== undefined) snapshot[k] = process.env[k];
    delete process.env[k];
  }
  capturedEnv = snapshot;
  if (Object.keys(snapshot).length === 0) return;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env[SNAPSHOT_VAR] = JSON.stringify(snapshot);
  // Dev:      argv = [bunPath, script, ...args]  -> keep the script path.
  // Compiled: argv = ["bun", "/$bunfs/root/<name>", ...args] -> drop the entry.
  const args = process.argv[0] === process.execPath ? process.argv.slice(1) : process.argv.slice(2);
  const child = Bun.spawn([process.execPath, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env,
  });
  process.exit(await child.exited);
}

/** The shell's proxy variables (the startup snapshot when one was taken). */
export function proxyEnv(): NodeJS.ProcessEnv {
  return capturedEnv ?? process.env;
}

function envProxyFor(target: URL, env: NodeJS.ProcessEnv): string | undefined {
  const pick = (...names: string[]) => {
    for (const n of names) if (env[n]) return env[n];
    return undefined;
  };
  if (target.protocol === "https:") return pick("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy");
  return pick("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function cidrMatch(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function portOf(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

/**
 * NO_PROXY matching. Supports "*", exact hosts, domain suffixes (with or
 * without a leading dot or "*."), host:port entries and IPv4 CIDR ranges.
 */
export function noProxyMatches(hostname: string, port: number, list: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const hostIsV4 = isIP(host) === 4;
  for (const raw of list.split(",")) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    if (entry.includes("/")) {
      if (hostIsV4 && cidrMatch(host, entry)) return true;
      continue;
    }
    const colons = entry.match(/:/g)?.length ?? 0;
    if (colons === 1) {
      const m = entry.match(/^(.*):(\d+)$/);
      if (m) {
        if (Number(m[2]) !== port) continue;
        entry = m[1];
      }
    }
    entry = entry.replace(/^\*?\./, "").replace(/^\[|\]$/g, "");
    if (!entry) continue;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) return h === "::1";
  return false;
}

/**
 * Decide how to reach `target`.
 * Priority: --no-proxy > --proxy > config file > environment (HTTPS_PROXY,
 * ALL_PROXY, ...). NO_PROXY (config `proxy.noProxy` first, then env) applies to
 * everything except an explicit --proxy. Loopback targets are never proxied.
 */
export function resolveProxy(target: URL, input: ProxyInput): ProxyDecision {
  const env = input.env ?? proxyEnv();
  if (input.noProxyFlag) return { source: "none", reason: "--no-proxy" };
  if (input.forceDirect) return { source: "none", reason: "direct connection requested" };
  if (isLoopbackHost(target.hostname)) return { source: "bypass", reason: "loopback target" };

  let raw: string | undefined;
  let source: ProxyDecision["source"] = "none";
  if (input.flagProxy) {
    raw = input.flagProxy;
    source = "flag";
  } else if (input.config.proxy.url) {
    raw = input.config.proxy.url;
    source = "config";
  } else {
    raw = envProxyFor(target, env);
    if (raw) source = "env";
  }
  if (!raw) return { source: "none" };

  const url = normalizeProxyUrl(raw);
  if (source !== "flag") {
    const noProxy = input.config.proxy.noProxy ?? env.NO_PROXY ?? env.no_proxy;
    if (noProxy && noProxyMatches(target.hostname, portOf(target), noProxy)) {
      return { source: "bypass", reason: "matched NO_PROXY" };
    }
  }
  return { url, source };
}

export function describeProxy(d: ProxyDecision): string {
  if (!d.url) return d.reason ? `direct (${d.reason})` : "direct";
  return `${maskProxyUrl(d.url)} (from ${d.source})`;
}
