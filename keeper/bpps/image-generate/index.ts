/**
 * Public barrel for the `image:generate` reference BPP (FN-078).
 *
 * Downstream consumers should import from this module:
 *
 *   import {
 *     config, tags,
 *     createImageGenerateHandler,
 *     SigningRuntimeChain,
 *     selectProvider, selectIpfsPinner,
 *     zImageGenerateInput, zImageGenerateOutput,
 *   } from "@eto/mcp/keeper/bpps/image-generate";
 */

export {
  config,
  tags,
  buildConfig,
  resolveAuthority,
  DEV_AUTHORITY_PUBKEY,
} from "./config.js";

export {
  createImageGenerateHandler,
  sha256Hex,
  type CreateImageGenerateHandlerDeps,
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
  selectProvider,
  resolveProviderConfigFromEnv,
  ReplicateImageProvider,
  TogetherImageProvider,
  StabilityImageProvider,
  FakeImageProvider,
  REPLICATE_API_BASE,
  TOGETHER_API_URL,
  STABILITY_API_URL,
  DEFAULT_REPLICATE_MODEL,
  DEFAULT_TOGETHER_MODEL,
  DEFAULT_STABILITY_MODEL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  type ImageProvider,
  type GenerateRequest,
  type GenerateResult,
  type ProviderConfig,
  type ProviderDeps,
  type ReplicateProviderConfig,
  type TogetherProviderConfig,
  type StabilityProviderConfig,
  type FetchLike as ProviderFetchLike,
} from "./providers/index.js";

export {
  selectIpfsPinner,
  Web3StoragePinner,
  PinataPinner,
  InMemoryBytesPinner,
  WEB3_STORAGE_UPLOAD_URL,
  PINATA_PIN_FILE_URL,
  type BppIpfsPinner,
  type PinResult,
  type PinOpts,
  type InMemoryPinRecord,
  type PinnerEnv,
  type PinnerDeps,
} from "./ipfs.js";

export {
  zImageGenerateInput,
  zImageGenerateOutput,
  zArtifact,
  PROMPT_MAX_CHARS,
  NEGATIVE_PROMPT_MAX_CHARS,
  ALLOWED_DIMENSIONS,
  DEFAULT_DIMENSION,
  DEFAULT_STEPS,
  MAX_STEPS,
  SUPPORTED_PROVIDERS,
  SUPPORTED_OUTPUT_FORMATS,
  SUPPORTED_MIME_TYPES,
  type ImageGenerateInput,
  type ImageGenerateOutput,
  type Artifact,
  type AllowedDimension,
  type ImageFormat,
  type ImageMimeType,
  type ProviderKind,
} from "./types.js";

export { main } from "./main.js";
