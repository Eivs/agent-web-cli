import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./config";
import type { Doc } from "./extract/types";

export function cacheKey(parts: unknown): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

interface Stored {
  fetchedAt: number;
  doc: Doc;
}

export function readCache(key: string, maxAgeSec: number, dir = cacheDir()): Doc | null {
  const file = join(dir, `${key}.json`);
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Stored;
    if (Date.now() - stored.fetchedAt > maxAgeSec * 1000) return null;
    return stored.doc;
  } catch {
    return null;
  }
}

export function writeCache(key: string, doc: Doc, dir = cacheDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${key}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), doc } satisfies Stored), { mode: 0o600 });
    renameSync(tmp, file);
    prune(dir);
  } catch {
    // The cache is best-effort; never fail a command because of it.
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function prune(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > DAY_MS) unlinkSync(file);
    }
  } catch {
    // ignore
  }
}
