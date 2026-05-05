/**
 * Public seam for the `data:analyze` analyser sub-package (FN-084).
 *
 * Mirrors `code:audit:solidity/auditors/index.ts`: exposes the orchestration
 * entry-point (`analyze`) plus the typed sub-modules for consumers that need
 * to inject individual pieces.
 */

export * from "./llm.js";
export * from "./profiler.js";
