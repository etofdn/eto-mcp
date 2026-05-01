/**
 * Public barrel for the `text:summarize` reference BPP (FN-075).
 *
 * Downstream consumers (FN-082 end-to-end test, FN-085 RPC wiring,
 * sibling reference BPPs that copy this layout) should import from
 * this module:
 *
 *   import {
 *     config, tags,
 *     createTextSummarizeHandler,
 *     SigningRuntimeChain,
 *     zSummarizeInput, zSummarizeOutput,
 *   } from "@eto/mcp/keeper/bpps/text-summarize";
 */

export { config, tags, buildConfig, resolveAuthority, DEV_AUTHORITY_PUBKEY } from "./config.js";
export {
  createTextSummarizeHandler,
  buildHandlerFromPrimitives,
  type CreateHandlerDeps,
} from "./handler.js";
export {
  SigningRuntimeChain,
  makeStubSigner,
  canonicalJson,
  type Signer,
  type SignedEnvelope,
  type SignedCompletePayload,
  type SignedFailPayload,
  type SignedCallRecord,
  type SigningRuntimeChainOpts,
} from "./chain-adapter.js";
export {
  fetchSource,
  stripHtml,
  noopPdfExtractor,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  type FetchLike,
  type FetchLikeResponse,
  type FetchSourceDeps,
  type FetchedSource,
  type PdfExtractor,
} from "./fetcher.js";
export {
  summarize,
  sha256Hex,
  AnthropicLlmClient,
  type LlmClient,
  type LlmRequest,
  type AnthropicLike,
  type SummarizeOpts,
  type SummarizeDeps,
  type SummarizeResult,
} from "./summarizer.js";
export {
  zSummarizeInput,
  zSummarizeOutput,
  zSummarizeSource,
  zArtifact,
  decodedBase64Bytes,
  URL_MAX_CHARS,
  TEXT_MAX_BYTES,
  PDF_MAX_BYTES,
  DEFAULT_TARGET_LENGTH_WORDS,
  MAX_TARGET_LENGTH_WORDS,
  type Artifact,
  type SummarizeInput,
  type SummarizeInputUrl,
  type SummarizeInputPdf,
  type SummarizeInputText,
  type SummarizeSource,
  type SummarizeOutput,
  type SummarizeStyle,
} from "./types.js";
export { main } from "./main.js";
