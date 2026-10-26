import { describe, expect, test } from "bun:test";
import { defaultConfig, mergeDeep } from "../src/config";
import { noProxyMatches, normalizeProxyUrl, resolveProxy } from "../src/net/proxy";
import { assertUrlAllowed, checkHostnameStatic, isPrivateIp, isPrivateIPv4, isPrivateIPv6 } from "../src/net/ssrf";
import { WebError } from "../src/util/errors";

const cfg = () => defaultConfig();
const u = (s: string) => new URL(s);

describe("private address detection", () => {
  test.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "198.18.0.5", "224.0.0.1", "255.255.255.255",
  ])("IPv4 %s is private", (ip) => expect(isPrivateIPv4(ip)).toBe(true));

  test.each(["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34", "100.63.0.1"])(
    "IPv4 %s is public",
    (ip) => expect(isPrivateIPv4(ip)).toBe(false),
  );

  test.each([
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::1",
  ])("IPv6 %s is private", (ip) => expect(isPrivateIPv6(ip)).toBe(true));

  test.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])("IPv6 %s is public", (ip) =>
    expect(isPrivateIPv6(ip)).toBe(false),
  );

  test("garbage fails closed", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIPv6("1:2:3")).toBe(true);
  });
});

describe("hostname checks", () => {
  test.each(["localhost", "app.localhost", "printer.local", "metadata.google.internal", "intranet", "x.home.arpa"])(
    "%s is blocked by name",
    (h) => expect(checkHostnameStatic(h)).not.toBeNull(),
  );
  test.each(["example.com", "sub.example.co.uk"])("%s is allowed by name", (h) =>
    expect(checkHostnameStatic(h)).toBeNull(),
  );
});

describe("assertUrlAllowed", () => {
  const base = { allowPrivate: false, allowHosts: [] as string[], resolveLocally: true };

  const blocked = async (url: string, o = base) => {
    try {
      await assertUrlAllowed(u(url), o);
    } catch (e) {
      expect(e).toBeInstanceOf(WebError);
      expect((e as WebError).code).toBe("ssrf");
      return;
    }
    throw new Error(`expected ${url} to be blocked`);
  };

  test("blocks non-http schemes", async () => {
    await blocked("file:///etc/passwd");
    await blocked("ftp://example.com/");
    await blocked("javascript:alert(1)");
  });
  test("blocks credentials in the URL", () => blocked("https://user:pw@example.com/"));
  test("blocks loopback, metadata and private literals", async () => {
    await blocked("http://127.0.0.1/");
    await blocked("http://localhost:8080/");
    await blocked("http://169.254.169.254/latest/meta-data/");
    await blocked("http://[::1]/");
    await blocked("http://192.168.0.10/admin");
  });
  test("blocks obfuscated IPv4 forms", async () => {
    await blocked("http://2130706433/"); // decimal 127.0.0.1
    await blocked("http://0x7f.1/");
    await blocked("http://017700000001/");
  });
  test("blocks hostnames that resolve to private addresses (direct mode)", () =>
    blocked("http://rebind.example.com/", { ...base, resolveLocally: true }).catch(() => {}).then(async () => {
      try {
        await assertUrlAllowed(u("http://rebind.example.com/"), { ...base, lookupFn: async () => ["10.0.0.5"] });
      } catch (e) {
        expect((e as WebError).code).toBe("ssrf");
        expect((e as WebError).message).toContain("10.0.0.5");
        return;
      }
      throw new Error("expected block");
    }));
  test("does not resolve locally when a proxy is in use", async () => {
    let called = false;
    await assertUrlAllowed(u("http://fakeip.example.com/"), {
      ...base,
      resolveLocally: false,
      lookupFn: async () => {
        called = true;
        return ["198.18.0.9"];
      },
    });
    expect(called).toBe(false);
  });
  test("lookup failure is left to the real request", async () => {
    await assertUrlAllowed(u("http://nx.example.com/"), {
      ...base,
      lookupFn: async () => {
        throw new Error("ENOTFOUND");
      },
    });
  });
  test("allowPrivate and allowHosts open the door", async () => {
    await assertUrlAllowed(u("http://127.0.0.1:3000/"), { ...base, allowPrivate: true });
    await assertUrlAllowed(u("http://searx.lan/"), { ...base, allowHosts: ["searx.lan"] });
  });
  test("public URLs pass", async () => {
    await assertUrlAllowed(u("https://example.com/a?b=c"), { ...base, lookupFn: async () => ["93.184.216.34"] });
    await assertUrlAllowed(u("http://93.184.216.34/"), base);
  });
});

describe("NO_PROXY matching", () => {
  test("wildcards, suffixes and exact hosts", () => {
    expect(noProxyMatches("a.b.example.com", 443, "example.com")).toBe(true);
    expect(noProxyMatches("example.com", 443, ".example.com")).toBe(true);
    expect(noProxyMatches("x.example.com", 443, "*.example.com")).toBe(true);
    expect(noProxyMatches("notexample.com", 443, "example.com")).toBe(false);
    expect(noProxyMatches("anything.org", 80, "*")).toBe(true);
    expect(noProxyMatches("anything.org", 80, "")).toBe(false);
  });
  test("ports", () => {
    expect(noProxyMatches("example.com", 8080, "example.com:8080")).toBe(true);
    expect(noProxyMatches("example.com", 443, "example.com:8080")).toBe(false);
  });
  test("IPv4 CIDR", () => {
    expect(noProxyMatches("10.2.3.4", 80, "10.0.0.0/8")).toBe(true);
    expect(noProxyMatches("11.2.3.4", 80, "10.0.0.0/8")).toBe(false);
    expect(noProxyMatches("192.168.1.9", 80, "192.168.0.0/16,10.0.0.0/8")).toBe(true);
  });
});

describe("proxy resolution", () => {
  const target = u("https://example.com/");

  test("no proxy configured anywhere", () => {
    expect(resolveProxy(target, { config: cfg(), env: {} })).toEqual({ source: "none" });
  });
  test("env: HTTPS_PROXY for https, HTTP_PROXY for http, ALL_PROXY as fallback", () => {
    expect(resolveProxy(target, { config: cfg(), env: { HTTPS_PROXY: "http://127.0.0.1:1086" } }).url).toBe("http://127.0.0.1:1086");
    expect(resolveProxy(u("http://example.com/"), { config: cfg(), env: { https_proxy: "http://a:1" } }).url).toBeUndefined();
    expect(resolveProxy(u("http://example.com/"), { config: cfg(), env: { http_proxy: "http://b:2" } }).url).toBe("http://b:2");
    expect(resolveProxy(target, { config: cfg(), env: { ALL_PROXY: "http://c:3" } }).url).toBe("http://c:3");
  });
  test("priority: flag > config > env", () => {
    const c = cfg();
    c.proxy.url = "http://127.0.0.1:1086";
    const env = { HTTPS_PROXY: "http://env:1" };
    expect(resolveProxy(target, { config: c, env })).toMatchObject({ url: "http://127.0.0.1:1086", source: "config" });
    expect(resolveProxy(target, { config: c, env, flagProxy: "http://flag:9" })).toMatchObject({ url: "http://flag:9", source: "flag" });
    expect(resolveProxy(target, { config: c, env, noProxyFlag: true }).url).toBeUndefined();
  });
  test("NO_PROXY bypasses env/config proxies but not an explicit --proxy", () => {
    const env = { HTTPS_PROXY: "http://p:1", NO_PROXY: "example.com" };
    expect(resolveProxy(target, { config: cfg(), env })).toMatchObject({ source: "bypass" });
    expect(resolveProxy(target, { config: cfg(), env, flagProxy: "http://f:2" }).url).toBe("http://f:2");
  });
  test("config noProxy overrides the NO_PROXY env var", () => {
    const c = cfg();
    c.proxy.noProxy = "internal.corp";
    const env = { HTTPS_PROXY: "http://p:1", NO_PROXY: "example.com" };
    expect(resolveProxy(target, { config: c, env }).url).toBe("http://p:1");
  });
  test("loopback targets are never proxied", () => {
    const env = { HTTPS_PROXY: "http://p:1" };
    expect(resolveProxy(u("http://127.0.0.1:3000/"), { config: cfg(), env }).url).toBeUndefined();
    expect(resolveProxy(u("http://localhost/"), { config: cfg(), env, flagProxy: "http://f:2" }).url).toBeUndefined();
  });
  test("forceDirect", () => {
    expect(resolveProxy(target, { config: cfg(), env: { HTTPS_PROXY: "http://p:1" }, forceDirect: true }).url).toBeUndefined();
  });
  test("normalisation and SOCKS rejection", () => {
    expect(normalizeProxyUrl("127.0.0.1:1086")).toBe("http://127.0.0.1:1086");
    expect(normalizeProxyUrl("localhost:1086")).toBe("http://localhost:1086");
    expect(normalizeProxyUrl("http://user:pw@proxy:8080/")).toBe("http://user:pw@proxy:8080");
    expect(() => normalizeProxyUrl("socks5://127.0.0.1:1080")).toThrow(WebError);
    expect(() => normalizeProxyUrl("ftp://x")).toThrow(WebError);
  });
});

describe("config merging", () => {
  test("deep merge keeps defaults for unspecified keys", () => {
    const merged = mergeDeep(defaultConfig(), { search: { url: "https://s/search" }, fetch: { maxTokens: 1234 } });
    expect(merged.search.url).toBe("https://s/search");
    expect(merged.search.authScheme).toBe("Bearer");
    expect(merged.fetch.maxTokens).toBe(1234);
    expect(merged.fetch.retries).toBe(2);
  });
});
