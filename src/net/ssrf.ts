import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WebError } from "../util/errors";

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

export function isPrivateIPv4(ip: string): boolean {
  const o = parseIPv4(ip);
  if (!o) return true; // fail closed
  const [a, b, c] = o;
  if (a === 0) return true; // "this" network
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // documentation
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking, also fake-ip DNS
  if (a === 198 && b === 51 && c === 100) return true; // documentation
  if (a === 203 && b === 0 && c === 113) return true; // documentation
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Returns eight 16-bit groups, or null when the text is not a valid IPv6 address. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v4 = parseIPv4(m[1]);
    if (!v4) return null;
    s = s.slice(0, -m[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => (part === "" ? [] : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if ([...head, ...tail].some((n) => Number.isNaN(n))) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...Array<number>(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (!g) return true; // fail closed
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateIPv4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeros(0, 6)) return isPrivateIPv4(embeddedV4(g[6], g[7])); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateIPv4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedV4(g[1], g[2])); // 6to4
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true;
}

/** Name-based checks that need no DNS. Returns a reason when blocked. */
export function checkHostnameStatic(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost";
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localdomain") || h.endsWith(".home.arpa")) {
    return "internal hostname";
  }
  if (!h.includes(".")) return "single-label hostname (resolves via local search domains)";
  return null;
}

export interface SsrfOptions {
  allowPrivate: boolean;
  /** Exact hostnames that skip the private-address checks. */
  allowHosts: string[];
  /**
   * Resolve the hostname locally and check every address. Only meaningful for
   * direct connections: behind a proxy the proxy does the resolving, so a local
   * lookup would check the wrong answer (and breaks with fake-ip DNS setups).
   */
  resolveLocally: boolean;
  /** Test hook. */
  lookupFn?: (host: string) => Promise<string[]>;
}

const BLOCK_HINT =
  "Private, loopback, link-local and cloud-metadata addresses are blocked by default. If you control this target, re-run with --allow-private.";

export function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export async function assertUrlAllowed(url: URL, o: SsrfOptions): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebError("ssrf", `Blocked URL scheme: ${url.protocol}`, {
      hint: "Only http and https URLs are allowed.",
      url: url.href,
    });
  }
  if (url.username || url.password) {
    throw new WebError("ssrf", "URLs with embedded credentials are not allowed", {
      hint: "Pass credentials with --header \"Authorization: ...\" instead.",
      url: url.href,
    });
  }
  if (o.allowPrivate) return;

  const host = hostnameOf(url);
  if (o.allowHosts.includes(host)) return;

  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new WebError("ssrf", `Blocked private address: ${host}`, { hint: BLOCK_HINT, url: url.href });
    }
    return;
  }

  const reason = checkHostnameStatic(host);
  if (reason) {
    throw new WebError("ssrf", `Blocked host ${host}: ${reason}`, { hint: BLOCK_HINT, url: url.href });
  }

  if (o.resolveLocally) {
    let addrs: string[] = [];
    try {
      addrs = o.lookupFn
        ? await o.lookupFn(host)
        : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      return; // let the real request report DNS failures
    }
    const bad = addrs.find((a) => isPrivateIp(a));
    if (bad) {
      throw new WebError("ssrf", `Blocked: ${host} resolves to private address ${bad}`, {
        hint: BLOCK_HINT,
        url: url.href,
      });
    }
  }
}
