# BPP: image:generate

## Capability Scope

This BPP accepts a text prompt and generation parameters, calls an image-generation provider (e.g., Stable Diffusion via Replicate), pins the resulting image to IPFS, and returns the IPFS CID plus a signed metadata envelope. It does **not** edit, upscale, or classify existing images; it does not generate video, audio, or 3-D assets.

## Accepted Input Shape

```json
{
  "prompt": "A photorealistic golden-hour cityscape over water, 4K",
  "negativePrompt": "blur, watermark, text",   // optional
  "width":  1024,   // optional, 256–2048, multiple of 64, default 1024
  "height": 1024,   // optional, 256–2048, multiple of 64, default 1024
  "steps":  30,     // optional, 10–100, default 30
  "seed":   42,     // optional; random if omitted
  "model":  "stable-diffusion-xl-base-1.0"  // optional; provider default if omitted
}
```

- `prompt` must be 1–2000 characters.
- `width` × `height` must not exceed 2 097 152 pixels (e.g., 1024 × 2048 is allowed; 2048 × 2048 is not).
- `steps` is advisory; the provider may clamp to its own limits.

## Required Output Artifact Shape

```json
{
  "artifact": {
    "mimeType": "image/png",
    "artifactUri": "ipfs://Qm...",
    "sha256":   "<lowercase hex, 64 chars of the PNG bytes>",
    "producedAtSec": 1700000000
  },
  "provider":  "replicate",
  "modelUsed": "stable-diffusion-xl-base-1.0",
  "seed":      42,
  "ipfsCid":   "Qm..."
}
```

- `sha256` MUST be the SHA-256 of the raw image bytes (before base64/IPFS encoding).
- `artifactUri` MUST be a valid `ipfs://` URI pointing to the pinned image.
- `ipfsCid` MUST match the CID encoded in `artifactUri`.

## Credential Gating

The caller (BAP) MUST present a `verified-human` credential from an approved issuer, enforced at Beckn `init` by the credential gate (FN-074 / FN-081). The handler trusts the gate and does **not** re-check credentials internally.

## Hard Refusal Rules

1. **No out-of-scope media types.** This BPP generates still images only. Requests for video, audio, 3-D models, or animations are rejected with `unsupported_output_type`.
2. **No NSFW or violent content.** Prompts that request nudity, sexual content, graphic violence, gore, or content sexualising minors are rejected immediately with `prompt_refused: nsfw_or_violence`. The negative-prompt field MUST include a baseline safety filter on all requests.
3. **No real-person likeness generation without consent.** Prompts explicitly naming or describing specific living or recently deceased private individuals for photorealistic depiction are rejected with `prompt_refused: real_person_likeness`.
4. **No deceptive artefacts.** Generated images MUST NOT embed visible watermarks that misrepresent the source, alter existing logos, or impersonate government documents, banknotes, or identity credentials.
5. **No prompt injection via negativePrompt.** The `negativePrompt` field is passed to the provider as-is but MUST NOT be used to circumvent safety filters (the BPP validates that combined prompt + negativePrompt does not exceed the safety threshold).

## Completion Contract

The **handler** — not the image provider — calls `chain.completeTask` (via `SigningRuntimeChain`) only after:

1. Input validation passes (Zod schema, pixel-budget check, prompt safety screen).
2. The image provider returns a successful response with raw image bytes.
3. The image is pinned to IPFS and a valid CID is returned.
4. The `sha256` of the image bytes is computed and embedded in the artifact.

On any failure the handler returns `{ status: "failure", reason: "<stable-code>: <detail>" }` and never calls `chain.completeTask`.
