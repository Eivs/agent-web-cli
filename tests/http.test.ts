import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { normalizeResultUrl, normalizeResults, buildSearchUrl, searxngSearch } from "../src/commands/search";
import { cacheKey, readCache, writeCache } from "../src/cache";
import { httpGet, type NetContext } from "../src/net/http";
import { WebError } from "../src/util/errors";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ReturnType<typeof Bun.serve>;
let base: string;
let flakyCount = 0;
let lastSearchHeaders: Headers | undefined;
let lastSearchUrl: URL | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/ok":
          return new Response("hello", { headers: { "content-type": "text/plain; charset=utf-8" } });
        case "/echo-headers":
          return Response.json(Object.fromEntries(req.headers));
        case "/redir":
          return new Response(null, { status: 302, headers: { location: "/ok" } });
        case "/loop":
          return new Response(null, { status: 302, headers: { location: "/loop" } });
        case "/redir-metadata":
          return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
        case "/redir-file":
          return new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
        case "/big":
          return new Response("x".repeat(100_000));
        case "/slow":
          await Bun.sleep(2000);
          return new Response("late");
        case "/flaky":
          flakyCount++;
          return flakyCount < 2 ? new Response("busy", { status: 503 }) : new Response("recovered");
        case "/always503":
          return new Response("busy", { status: 503 });
        case "/search": {
          lastSearchHeaders = req.headers;
          lastSearchUrl = url;
          const auth = req.headers.get("authorization");
          if (url.searchParams.get("q") === "forbidden" || auth !== "Bearer sekret") return new Response("no", { status: 403 });
          if (url.searchParams.get("q") === "html") return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
          return Response.json({
            results: [
              { title: "A", url: "https://www.example.com/a?utm_source=x&id=1#frag", content: "first", engines: ["google"], publishedDate: "2026-10-20T00:00:00" },
              { title: "A again", url: "https://example.com/a?id=1", content: "dup" },
              { title: "B", url: "https://example.com/b/", content: "second  \n snippet" },
              { title: "C", url: "https://other.org/c", content: "third" },
              { title: "bad", url: "javascript:alert(1)" },
              { title: "no url" },
            ],
            answers: [{ answer: "42" }, "plain answer"],
            suggestions: ["more", "less"],
            unresponsive_engines: [["bing", "timeout"]],
          });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const ctx = (over: Partial<NetContext> = {}): NetContext => ({ config: defaultConfig(), env: {}, allowPrivate: true, ...over });
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("httpGet", () => {
  test("basic GET returns status, headers and body", async () => {
    const r = await httpGet(ctx(), `${base}/ok`);
    expect(r.status).toBe(200);
    expect(text(r.body)).toBe("hello");
    expect(r.proxy.url).toBeUndefined();
  });

  test("sends browser-like default headers and honours overrides", async () => {
    const r = await httpGet(ctx(), `${base}/echo-headers`, { headers: { "Accept-Language": "zh-CN", "X-Test": "1" } });
    const h = JSON.parse(text(r.body));
    expect(h["user-agent"]).toContain("Mozilla/5.0");
    expect(h["accept"]).toContain("text/markdown");
    expect(h["accept-language"]).toBe("zh-CN");
    expect(h["x-test"]).toBe("1");
  });

  test("follows redirects and records the chain", async () => {
    const r = await httpGet(ctx(), `${base}/redir`);
    expect(text(r.body)).toBe("hello");
    expect(r.finalUrl).toBe(`${base}/ok`);
    expect(r.redirects).toEqual([`${base}/redir`]);
  });

  test("redirect loops stop with a network error", async () => {
    const err = await httpGet(ctx(), `${base}/loop`, { maxRedirects: 3, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(WebError);
    expect((err as WebError).message).toContain("redirects");
  });

  test("private targets are refused by default", async () => {
    const err = await httpGet(ctx({ allowPrivate: false }), `${base}/ok`).catch((e) => e);
    expect((err as WebError).code).toBe("ssrf");
  });

  test("a redirect to the cloud metadata address is blocked on that hop", async () => {
    const err = await httpGet(ctx({ allowPrivate: false }), `${base}/redir-metadata`, { allowHosts: ["127.0.0.1"] }).catch((e) => e);
    expect(err).toBeInstanceOf(WebError);
    expect((err as WebError).code).toBe("ssrf");
    expect((err as WebError).message).toContain("169.254.169.254");
  });

  test("a redirect to file:// is blocked", async () => {
    const err = await httpGet(ctx({ allowPrivate: false }), `${base}/redir-file`, { allowHosts: ["127.0.0.1"] }).catch((e) => e);
    expect((err as WebError).code).toBe("ssrf");
  });

  test("response size is capped and flagged", async () => {
    const r = await httpGet(ctx(), `${base}/big`, { maxBytes: 1000 });
    expect(r.body.length).toBe(1000);
    expect(r.bodyTruncated).toBe(true);
  });

  test("timeouts map to the timeout error", async () => {
    const err = await httpGet(ctx(), `${base}/slow`, { timeoutMs: 300, retries: 0 }).catch((e) => e);
    expect((err as WebError).code).toBe("timeout");
    expect(err.exitCode).toBe(5);
  });

  test("503 is retried and recovers", async () => {
    flakyCount = 0;
    const r = await httpGet(ctx(), `${base}/flaky`, { retries: 2 });
    expect(r.status).toBe(200);
    expect(text(r.body)).toBe("recovered");
    expect(flakyCount).toBe(2);
  });

  test("persistent 503 is returned after the retries are used up", async () => {
    const r = await httpGet(ctx(), `${base}/always503`, { retries: 1 });
    expect(r.status).toBe(503);
  });

  test("connection failures are network errors that mention the proxy when one is used", async () => {
    const dead = "http://127.0.0.1:9"; // discard port, nothing listens
    const direct = await httpGet(ctx(), `${dead}/`, { retries: 0, timeoutMs: 3000 }).catch((e) => e);
    expect((direct as WebError).code).toBe("network");
    expect((direct as WebError).hint).toContain("HTTPS_PROXY");

    const viaProxy = await httpGet(ctx({ proxyFlag: "http://127.0.0.1:9" }), "http://example.com/", { retries: 0, timeoutMs: 3000, allowHosts: [] }).catch((e) => e);
    expect(viaProxy).toBeInstanceOf(WebError);
    expect(["network", "timeout"]).toContain((viaProxy as WebError).code);
    if ((viaProxy as WebError).code === "network") expect((viaProxy as WebError).hint).toContain("proxy");
  });
});

describe("search URL and result normalisation", () => {
  test("tracking parameters and fragments are removed, www is ignored for dedupe", () => {
    const n = normalizeResultUrl("https://www.Example.com/a/?utm_source=x&id=1&fbclid=z#frag")!;
    expect(n.url).toBe("https://www.example.com/a/?id=1");
    expect(n.key).toBe("example.com/a?id=1");
    expect(normalizeResultUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeResultUrl("not a url")).toBeNull();
  });

  test("duplicates collapse, per-domain cap and limit apply, ranks are renumbered", () => {
    const raw = [
      { title: "1", url: "https://a.com/1" }, { title: "dup", url: "https://www.a.com/1?utm_medium=y" },
      { title: "2", url: "https://a.com/2" }, { title: "3", url: "https://a.com/3" }, { title: "4", url: "https://b.com/" },
    ];
    expect(normalizeResults(raw, { limit: 10 }).map((r) => r.title)).toEqual(["1", "2", "3", "4"]);
    expect(normalizeResults(raw, { limit: 10, perDomain: 2 }).map((r) => r.title)).toEqual(["1", "2", "4"]);
    const limited = normalizeResults(raw, { limit: 2 });
    expect(limited.map((r) => r.rank)).toEqual([1, 2]);
  });

  test("endpoint without a path gets /search", () => {
    expect(buildSearchUrl("https://searx.example.com").pathname).toBe("/search");
    expect(buildSearchUrl("https://searx.example.com/search").pathname).toBe("/search");
    expect(buildSearchUrl("searx.example.com/custom").pathname).toBe("/custom");
  });
});

describe("searxngSearch against a mock SearXNG", () => {
  const searchCtx = (token: string | undefined = "sekret") => {
    const config = defaultConfig();
    config.search.url = `${base}/search`;
    config.search.token = token;
    config.search.params = { language: "en" };
    // allowPrivate stays false: the endpoint host must be allowed implicitly.
    return { config, env: {} } as NetContext;
  };

  test("sends the Bearer token, format=json and configured parameters", async () => {
    const r = await searxngSearch(searchCtx(), { query: "rust async", limit: 5, time: "week", lang: "zh-CN", site: "doc.rust-lang.org" });
    expect(lastSearchHeaders!.get("authorization")).toBe("Bearer sekret");
    expect(lastSearchHeaders!.get("accept")).toBe("application/json");
    expect(lastSearchUrl!.searchParams.get("format")).toBe("json");
    expect(lastSearchUrl!.searchParams.get("q")).toBe("site:doc.rust-lang.org rust async");
    expect(lastSearchUrl!.searchParams.get("time_range")).toBe("week");
    expect(lastSearchUrl!.searchParams.get("language")).toBe("zh-CN"); // flag beats config params
    expect(r.results.length).toBeGreaterThan(0);
  });

  test("results are normalised: deduped, cleaned, with dates, answers and suggestions", async () => {
    const r = await searxngSearch(searchCtx(), { query: "x", limit: 10 });
    expect(r.results.map((x) => x.url)).toEqual(["https://www.example.com/a?id=1", "https://example.com/b/", "https://other.org/c"]);
    expect(r.results[0].date).toBe("2026-10-20");
    expect(r.results[1].snippet).toBe("second snippet");
    expect(r.answers).toEqual(["42", "plain answer"]);
    expect(r.suggestions).toEqual(["more", "less"]);
    expect(r.unresponsive).toEqual(["bing (timeout)"]);
  });

  test("custom auth header and scheme", async () => {
    const c = searchCtx("tok");
    c.config.search.authHeader = "X-Api-Key";
    c.config.search.authScheme = "";
    await searxngSearch(c, { query: "x", limit: 1 }).catch(() => {});
    expect(lastSearchHeaders!.get("x-api-key")).toBe("tok");
  });

  test("token from an environment variable", async () => {
    const c = searchCtx(undefined);
    c.config.search.tokenEnv = "WEB_TEST_TOKEN_VAR";
    process.env.WEB_TEST_TOKEN_VAR = "sekret";
    try {
      const r = await searxngSearch(c, { query: "x", limit: 1 });
      expect(r.results.length).toBe(1);
    } finally {
      delete process.env.WEB_TEST_TOKEN_VAR;
    }
  });

  test("403 explains both causes", async () => {
    const err = await searxngSearch(searchCtx("wrong"), { query: "x", limit: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(WebError);
    expect(err.code).toBe("blocked");
    expect(err.hint).toContain("settings.yml");
    expect(err.hint).toContain("token");
  });

  test("an HTML response is reported as not-JSON", async () => {
    const err = await searxngSearch(searchCtx(), { query: "html", limit: 1 }).catch((e) => e);
    expect(err.code).toBe("http");
    expect(err.message).toContain("JSON");
  });

  test("missing endpoint is a config error", async () => {
    const c = searchCtx();
    c.config.search.url = undefined;
    const err = await searxngSearch(c, { query: "x", limit: 1 }).catch((e) => e);
    expect(err.code).toBe("config");
    expect(err.exitCode).toBe(8);
  });
});

describe("cache", () => {
  test("round trip and expiry", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-web-cache-"));
    try {
      const doc = {
        meta: { url: "u", final_url: "u", status: 200, fetched_at: "t", mode: "http" as const, extractor: "x", tokens: 1, warnings: [] },
        markdown: "# hi",
      };
      const key = cacheKey({ a: 1 });
      expect(key).toBe(cacheKey({ a: 1 }));
      expect(key).not.toBe(cacheKey({ a: 2 }));
      expect(readCache(key, 60, dir)).toBeNull();
      writeCache(key, doc, dir);
      expect(readCache(key, 60, dir)?.markdown).toBe("# hi");
      expect(readCache(key, -1, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
