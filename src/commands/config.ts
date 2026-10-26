import { configPath, maskProxyUrl, maskSecret, resolveSearchToken, writeConfigTemplate, type Config } from "../config";
import { WebError } from "../util/errors";
import type { CommandResult } from "./types";

export const CONFIG_HELP = `web config [path | init [--force]]

  (no argument)   Show the effective configuration (secrets masked)
  path            Print the config file location
  init            Write a template config file (use --force to overwrite)

Config file: ${configPath()}   (override with WEB_CONFIG)
Environment overrides: WEB_PROXY, WEB_SEARXNG_URL, WEB_SEARXNG_TOKEN
`;

export function runConfig(argv: string[], config: Config): CommandResult {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h") return { stdout: CONFIG_HELP };
  if (sub === "path") return { stdout: configPath() + "\n" };
  if (sub === "init") {
    const path = writeConfigTemplate(process.env, rest.includes("--force"));
    return {
      stdout: `Wrote ${path}\nEdit it to set your proxy and SearXNG endpoint, then run \`web doctor\`.\n`,
    };
  }
  if (sub !== undefined) {
    throw new WebError("usage", `Unknown config subcommand: ${sub}`, { hint: "Use: web config [path | init]" });
  }
  const token = resolveSearchToken(config);
  const view = {
    config_file: configPath(),
    ...config,
    proxy: { ...config.proxy, url: maskProxyUrl(config.proxy.url) },
    search: {
      ...config.search,
      token: maskSecret(config.search.token),
      token_resolved: token ? maskSecret(token) : null,
    },
  };
  return { stdout: JSON.stringify(view, null, 2) + "\n" };
}
