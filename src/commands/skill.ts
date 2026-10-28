import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import SKILL from "../../skill/web-cli/SKILL.md" with { type: "text" };
import { WebError } from "../util/errors";
import { bool, parse, str } from "./common";
import type { CommandResult } from "./types";

export const SKILL_HELP = `web skill install [options]

Install the agent skill (SKILL.md) so Claude Code and other agents know how to
use this CLI. The file is embedded in the binary, so no network is needed.

Options:
  --dir <path>   Target directory (default: ~/.claude/skills/web-cli)
  --force        Overwrite a modified copy
  -h, --help     Show this help

Examples:
  web skill install
  web skill install --dir .claude/skills/web-cli
`;

const SKILL_OPTIONS = {
  dir: { type: "string" },
  force: { type: "boolean" },
} as const;

export function defaultSkillDir(): string {
  return join(homedir(), ".claude", "skills", "web-cli");
}

export function runSkill(argv: string[]): CommandResult {
  const args = parse(argv, SKILL_OPTIONS, "skill");
  if (bool(args.values, "help")) return { stdout: SKILL_HELP };

  const sub = args.positionals[0];
  if (sub && sub !== "install") {
    throw new WebError("usage", `Unknown skill command: ${sub}`, { hint: "Run `web skill install`, or `web skill --help`." });
  }

  const dir = resolve(str(args.values, "dir") ?? defaultSkillDir());
  const file = join(dir, "SKILL.md");

  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // not installed yet
  }
  if (existing === SKILL) return { stdout: `Skill already up to date: ${file}\n` };
  if (existing !== null && !bool(args.values, "force")) {
    throw new WebError("usage", `Refusing to overwrite a modified skill: ${file}`, {
      hint: "Pass --force to replace it with the embedded copy.",
    });
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, SKILL);
  return {
    stdout: `Installed web-cli skill: ${file}\n${existing === null ? "" : "Replaced an older or modified copy.\n"}Start a new agent session to pick it up.\n`,
  };
}
