#!/usr/bin/env bun
import pkg from "../package.json";
import SKILL from "../skill/web-cli/SKILL.md" with { type: "text" };
import { runConfig, CONFIG_HELP } from "./commands/config";
import type { CommandResult } from "./commands/types";
import { defaultConfig, loadConfig } from "./config";
import { sanitizeProxyEnv } from "./net/proxy";
import { EXIT_CODES, WebError } from "./util/errors";

const HELP = `web ${pkg.version} - web access for AI agents (HTTP only, proxy aware)

Usage: web <command> [options]

Commands:
  fetch <url...>     Read pages as markdown (outline, section, query, paging)
  search <query>     Search the web through your SearXNG instance
  map <url>          List a site's URLs (sitemap first, then page links)
  doctor             Check config, proxy, a test fetch and a test search
  config             Show or initialise configuration
  guide              Print the usage guide meant for agents
  help [command]     Show help

Run \`web <command> --help\` for options. Output goes to stdout; errors are one JSON
object on stderr. Exit codes: ${Object.entries(EXIT_CODES)
  .filter(([k]) => k !== "internal")
  .map(([k, v]) => `${v}=${k}`)
  .join(" ")}, 1=internal.
`;

function guideText(): string {
  return SKILL.replace(/^---[\s\S]*?---\s*/, "");
}

async function writeOut(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!process.stdout.write(text)) process.stdout.once("drain", () => resolve());
    else resolve();
  });
}

async function dispatch(argv: string[]): Promise<CommandResult> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    if (command === "help" && rest[0]) return dispatch([rest[0], "--help"]);
    return { stdout: HELP };
  }
  if (command === "--version" || command === "-V" || command === "version") return { stdout: `${pkg.version}\n` };
  if (command === "guide") return { stdout: guideText() };

  if (command === "config") {
    // `web config` works even when the config file is broken enough to fail loadConfig.
    if (rest[0] === "path" || rest[0] === "init" || rest[0] === "--help" || rest[0] === "-h") {
      const cfg = (() => {
        try {
          return loadConfig();
        } catch {
          return null;
        }
      })();
      if (rest[0] === "--help" || rest[0] === "-h") return { stdout: CONFIG_HELP };
      return runConfig(rest, cfg ?? defaultConfig());
    }
    return runConfig(rest, loadConfig());
  }

  // Commands are loaded on demand so `web help`, `web config` and friends start
  // instantly and never touch the HTML/DOM libraries.
  const config = loadConfig();
  switch (command) {
    case "fetch":
      return (await import("./commands/fetch")).runFetch(rest, config);
    case "search":
      return (await import("./commands/search")).runSearch(rest, config);
    case "map":
      return (await import("./commands/map")).runMap(rest, config);
    case "doctor":
      return (await import("./commands/doctor")).runDoctor(rest, config);
    default:
      throw new WebError("usage", `Unknown command: ${command}`, { hint: "Run `web help` to see the commands." });
  }
}

async function main(): Promise<number> {
  try {
    await sanitizeProxyEnv();
    const result = await dispatch(process.argv.slice(2));
    await writeOut(result.stdout);
    return result.exitCode ?? 0;
  } catch (e) {
    const err = e instanceof WebError ? e : new WebError("internal", (e as Error)?.message ?? String(e));
    process.stderr.write(JSON.stringify(err.toJSON()) + "\n");
    if (process.env.WEB_DEBUG && e instanceof Error && e.stack) process.stderr.write(e.stack + "\n");
    return err.exitCode;
  }
}

main().then((code) => process.exit(code));
