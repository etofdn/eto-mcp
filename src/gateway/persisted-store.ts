import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

// Atomic JSON write: write to tmp, fsync-free rename into place. Same
// filesystem required (rename(2) is only atomic within a single mount).
// A half-written tmp file after a crash is ignored on the next load.
export function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadJsonArray<T>(path: string): T[] {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T[];
  } catch {
    return [];
  }
}
