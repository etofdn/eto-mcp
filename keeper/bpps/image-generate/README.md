# `image:generate` BPP (FN-078)

A reference Beckn Provider Platform (BPP) for the `image:generate`
capability, composed on top of the FN-073 Keeper BPP template.

The BPP advertises an `AgentCard` for `image:generate` v1.0.0,
accepts a Beckn `Init` task whose input is a text prompt plus
generation parameters, calls a third-party image-generation provider
(Replicate / Together AI / Stability AI behind a single swappable
`ImageProvider` interface), pins the resulting image bytes to IPFS,
and returns the `ipfs://CID` URI as a structured `Artifact`. Results
flow back to the BAP via a signed `CompleteTask` (or `FailTask`)
through the runtime's chain adapter.

> **Status:** dev-time tooling. Excluded from the published `dist/`
> (see `tsconfig.build.json`). Real RPC chain wiring lands in
> FN-082 / FN-085. Real FROST signer lands in FN-082.

## Capability tag JSON

```json
{
  "domain": "image",
  "action": "generate",
  "version": "1.0.0",
  "price": { "amount": "0.50", "currency": "ETO" },
  "requiredCredentials": [],
  "description": "Generate an image from a text prompt and pin the resulting bytes to IPFS, returning the ipfs:// URI as a signed artifact. Supports Replicate / Together / Stability behind a single ImageProvider seam."
}
```

> `requiredCredentials` is intentionally empty today. **TODO(FN-081):**
> once the verified-human credential schema lands, this BPP must
> require it so anonymous BAPs cannot enqueue tasks.

## `ImageGenerateInput`

```ts
{
  prompt: string,                          // 1–4000 chars
  negativePrompt?: string,                 // ≤ 2000 chars
  width?:  256 | 512 | 768 | 1024 | 1280 | 1536, // default 1024
  height?: 256 | 512 | 768 | 1024 | 1280 | 1536, // default 1024
  steps?: number,                          // 1–50, default 8
  seed?:  number,                          // ≥ 0
  outputFormat?: "png" | "jpeg" | "webp",
  provider?: "replicate" | "together" | "stability",
}
```

Example:

```json
{
  "prompt": "a serene tabby cat in a sunlit window",
  "width": 1024, "height": 1024, "steps": 4,
  "outputFormat": "png", "provider": "replicate"
}
```

## `ImageGenerateOutput`

```ts
{
  artifact: {
    mimeType: "image/png" | "image/jpeg" | "image/webp",
    ipfsUri:  `ipfs://${string}`,
    cid:      string,            // CIDv1 string from the pinner
    sha256:   string,            // 64 lowercase hex of the bytes
    sizeBytes: number,
    producedAtSec: number,
    prompt:   string,
  },
  provider:      string,         // "replicate" | "together" | "stability" | "fake"
  modelId:       string,
  providerJobId: string,
  durationMs:    number,
}
```

Failures are surfaced via `chain.failTask({ reason })` with one of
these stable codes:

| Code                     | Cause                                          |
|--------------------------|------------------------------------------------|
| `input_invalid`          | request payload failed `zImageGenerateInput`   |
| `provider_unconfigured`  | provider's API key/env missing                 |
| `provider_error`         | provider returned a non-success state          |
| `provider_timeout`       | provider exceeded its poll budget              |
| `ipfs_unconfigured`      | no pinner could be selected from env           |
| `ipfs_error`             | pinner POST failed                             |
| `internal_error`         | anything else                                  |

## Environment variables

### Provider selection

| Env                          | Used by                       |
|------------------------------|-------------------------------|
| `REPLICATE_API_TOKEN`        | `ReplicateImageProvider`      |
| `REPLICATE_MODEL`            | optional model slug override  |
| `TOGETHER_API_KEY`           | `TogetherImageProvider`       |
| `TOGETHER_MODEL`             | optional model id override    |
| `STABILITY_API_KEY`          | `StabilityImageProvider`      |
| `IMAGE_GENERATE_PROVIDER`    | force `replicate`/`together`/`stability` (otherwise auto from token presence) |

### IPFS pinner

| Env                  | Used by                               |
|----------------------|---------------------------------------|
| `WEB3_STORAGE_TOKEN` | `Web3StoragePinner`                   |
| `PINATA_JWT`         | `PinataPinner`                        |
| `IPFS_PINNER`        | `web3.storage` / `pinata` / `inmemory` (override auto-pick) |

### BPP runtime

| Env                          | Used by                                                       |
|------------------------------|---------------------------------------------------------------|
| `IMAGE_GENERATE_AUTHORITY`   | `BppConfig.authority` (otherwise the dev pubkey constant)     |
| `IMAGE_GENERATE_MODEL`       | `BppConfig.modelId` (default `flux-schnell`)                  |
| `IMAGE_GENERATE_FAKE`        | when `1`, `main.ts` uses `FakeImageProvider` + `InMemoryBytesPinner` so the example runs offline |

## Running the example

Offline (no network, deterministic):

```sh
IMAGE_GENERATE_FAKE=1 bun run keeper/bpps/image-generate/main.ts
```

With a real provider + pinner:

```sh
export REPLICATE_API_TOKEN=...
export PINATA_JWT=...        # or WEB3_STORAGE_TOKEN
bun run keeper/bpps/image-generate/main.ts
```

The example registers an `AgentCard` against a stub registration
chain, builds a `SigningRuntimeChain` over `InMemoryChain`, and pumps
two synthetic events through `runBpp`. Completed tasks print their
`taskId → ipfs://…` URI.

## Canonical signing-payload schema

Every `completeTask` / `failTask` call is signed over the canonical
JSON serialisation of:

```ts
// completeTask
{ taskId: string, status: "success", output: ImageGenerateOutput, producedAtSec: number }

// failTask
{ taskId: string, status: "failure", reason: string,             producedAtSec: number }
```

`canonicalJson` sorts object keys ascending at every level and skips
`undefined` values. `SigningRuntimeChain` records both the signed
payload and the resulting `{ signature, signerPubkey }` envelope on
its public `signedComplete` / `signedFail` arrays so downstream
verifiers (FN-085) can re-derive the on-chain bytes without forking
serialisation logic.

## TODOs

- **TODO(FN-081):** require the verified-human credential in
  `tags.requiredCredentials` once the schema lands.
- **TODO(real signer via eto-signing-service):** replace
  `makeStubSigner` with a FROST threshold-Ed25519 client over
  `eto-mcp/signing-service`.
- **TODO(post-FN-053):** swap `InMemoryEventSource` for the real
  Beckn-program RPC log subscription, and `InMemoryChain` for the
  actual SVM tx submitter.
- **TODO(real CID encoding):** `InMemoryBytesPinner` returns a
  test-only synthetic `bafy<sha256>` CID. Production pinners
  (`Web3StoragePinner`, `PinataPinner`) return real CIDv1 strings
  from their API responses, so no client-side CID encoder is
  required at runtime.
