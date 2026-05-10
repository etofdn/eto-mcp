/**
 * LLM analyser seam for the `data:analyze` BPP (FN-084 layout alignment).
 *
 * Re-exports from `../analyzer.ts` — the Anthropic-backed analyser that
 * produces a structured `AnalysisReport` + Markdown from a `DatasetProfile`.
 *
 * Mirrors the `code:audit:solidity` layout where the LLM call lives in
 * `auditors/llm.ts`. The root `analyzer.ts` is the canonical source;
 * this module is the stable public seam under the `analyzers/` subdir.
 */

export {
  analyze,
  sha256Hex,
  AnthropicLlmClient,
  type LlmClient,
  type LlmRequest,
  type AnthropicLike,
  type AnalyzeOpts,
  type AnalyzeDeps,
  type AnalyzeResult,
} from "../analyzer.js";
