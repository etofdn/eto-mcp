/**
 * Stability AI image-generation provider (FN-078).
 *
 * POSTs multipart `/v2beta/stable-image/generate/core` with
 * `Accept: image/*`; the response body is the raw image bytes. The
 * `content-type` response header determines the artifact mime.
 *
 * No external multipart helper is added — `FormData` + `Blob` are
 * built into Node ≥ 20.
 */

import type { ImageMimeType } from "../types.js";
import type {
  GenerateRequest,
  GenerateResult,
  ImageProvider,
  ProviderDeps,
  StabilityProviderConfig,
} from "./types.js";

export const STABILITY_API_URL =
  "https://api.stability.ai/v2beta/stable-image/generate/core";
export const DEFAULT_STABILITY_MODEL = "stable-image-core";

export class StabilityImageProvider implements ImageProvider {
  public readonly kind = "stability";
  private readonly apiKey: string;
  private readonly fetchImpl: NonNullable<ProviderDeps["fetch"]>;

  public constructor(cfg: StabilityProviderConfig, deps: ProviderDeps = {}) {
    const key = cfg.apiKey ?? process.env.STABILITY_API_KEY;
    if (!key) {
      throw new Error("provider_unconfigured: stability");
    }
    this.apiKey = key;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  public async generate(req: GenerateRequest): Promise<GenerateResult> {
    const fd = new FormData();
    fd.append("prompt", req.prompt);
    fd.append("output_format", "png");
    // Stability expects `aspect_ratio` rather than width/height; for the
    // common square / 16:9 / 9:16 cases derive it; otherwise pass `1:1`
    // (Stability snaps to its own native dimensions).
    fd.append("aspect_ratio", aspectRatioFor(req.width, req.height));
    if (req.negativePrompt !== undefined) {
      fd.append("negative_prompt", req.negativePrompt);
    }
    if (req.seed !== undefined) {
      fd.append("seed", String(req.seed));
    }
    const resp = await this.fetchImpl(STABILITY_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "image/*",
      },
      body: fd,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`provider_error: stability ${resp.status} ${txt}`);
    }
    const ct = resp.headers.get("content-type") ?? "image/png";
    const ab = await resp.arrayBuffer();
    return {
      bytes: new Uint8Array(ab),
      mimeType: normaliseMime(ct),
      providerJobId:
        resp.headers.get("x-request-id") ??
        resp.headers.get("x-stability-request-id") ??
        `stability-${Date.now()}`,
      modelId: DEFAULT_STABILITY_MODEL,
    };
  }
}

function aspectRatioFor(w: number, h: number): string {
  if (w === h) return "1:1";
  if (w > h) {
    const r = w / h;
    if (Math.abs(r - 16 / 9) < 0.05) return "16:9";
    if (Math.abs(r - 3 / 2) < 0.05) return "3:2";
    if (Math.abs(r - 4 / 3) < 0.05) return "4:3";
    return "16:9";
  }
  const r = h / w;
  if (Math.abs(r - 16 / 9) < 0.05) return "9:16";
  if (Math.abs(r - 3 / 2) < 0.05) return "2:3";
  if (Math.abs(r - 4 / 3) < 0.05) return "3:4";
  return "9:16";
}

function normaliseMime(ct: string): ImageMimeType {
  const lc = ct.toLowerCase();
  if (lc.includes("jpeg") || lc.includes("jpg")) return "image/jpeg";
  if (lc.includes("webp")) return "image/webp";
  return "image/png";
}
