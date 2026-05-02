/**
 * `ImageProvider` seam for the `image:generate` BPP (FN-078).
 *
 * The handler depends on this single interface; concrete providers
 * (`replicate.ts`, `together.ts`, `stability.ts`) and the test
 * `FakeImageProvider` all conform to it. `selectProvider` (in
 * `index.ts`) is the runtime factory that picks one based on
 * `ProviderConfig.kind`.
 */

import type { ImageMimeType } from "../types.js";

export interface GenerateRequest {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly width: number;
  readonly height: number;
  readonly steps: number;
  readonly seed?: number;
}

export interface GenerateResult {
  readonly bytes: Uint8Array;
  readonly mimeType: ImageMimeType;
  readonly providerJobId: string;
  readonly modelId: string;
}

export interface ImageProvider {
  /** Provider-stable id (`replicate` / `together` / `stability` / `fake`). */
  readonly kind: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/* -------------------------------------------------------------------------- */
/* ProviderConfig discriminated union                                         */
/* -------------------------------------------------------------------------- */

export interface ReplicateProviderConfig {
  readonly kind: "replicate";
  /** `model` slug, e.g. `black-forest-labs/flux-schnell`. */
  readonly model?: string;
  /** API token override (otherwise read from env). */
  readonly apiToken?: string;
  /** Per-request poll budget (ms). Default 120_000. */
  readonly pollTimeoutMs?: number;
  /** Poll interval (ms). Default 1000. */
  readonly pollIntervalMs?: number;
}

export interface TogetherProviderConfig {
  readonly kind: "together";
  readonly model?: string;
  readonly apiKey?: string;
}

export interface StabilityProviderConfig {
  readonly kind: "stability";
  readonly apiKey?: string;
}

export type ProviderConfig =
  | ReplicateProviderConfig
  | TogetherProviderConfig
  | StabilityProviderConfig;

/* -------------------------------------------------------------------------- */
/* Provider deps (injectable for tests)                                       */
/* -------------------------------------------------------------------------- */

export type FetchLike = typeof globalThis.fetch;

export interface ProviderDeps {
  /** Fetch implementation (defaults to `globalThis.fetch`). */
  readonly fetch?: FetchLike;
  /** Wall-clock ms (defaults to `Date.now`). Used for poll timeouts. */
  readonly nowMs?: () => number;
  /** Sleep implementation (used between polls). */
  readonly sleep?: (ms: number) => Promise<void>;
}
