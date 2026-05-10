/**
 * `loadSystemPrompt(...)` — synchronously reads the BPP-specific
 * `system.md` next to a caller's module (FN-080, T-2.7.3.1).
 *
 * Usage from a per-BPP handler:
 *
 *   import { loadSystemPrompt } from "../../templates/bpp/index.js";
 *   const SYSTEM = loadSystemPrompt(new URL("./system.md", import.meta.url));
 *
 * The helper is intentionally synchronous — `system.md` is small,
 * read once at module-load time, and downstream code (LLM clients in
 * FN-075..FN-079) treats the prompt as a constant string. Centralising
 * the read here keeps every BPP loading its prompt the same way; if
 * the storage location changes (e.g. embedded in a registry), only
 * this function needs updating.
 *
 * The file MUST exist and MUST be valid UTF-8; on any failure the
 * helper throws synchronously so a misconfigured BPP fails fast at
 * import time instead of mid-task.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Either an absolute path string, a `file://` URL, or a `URL` object. */
export type SystemPromptLocation = string | URL;

export function loadSystemPrompt(location: SystemPromptLocation): string {
  const path =
    typeof location === "string"
      ? location.startsWith("file:")
        ? fileURLToPath(location)
        : location
      : fileURLToPath(location);
  const content = readFileSync(path, "utf8");
  if (content.trim().length === 0) {
    throw new Error(`loadSystemPrompt: empty system prompt at ${path}`);
  }
  return content;
}
