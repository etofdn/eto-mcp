/**
 * Replicate.com image-generation provider (FN-078).
 *
 * Implementation:
 *   1. POST /v1/predictions with `{ version: <model>, input: {...} }`
 *   2. Poll the returned `urls.get` endpoint until status is
 *      `succeeded` (or `failed`/`canceled`) or until the poll budget
 *      runs out.
 *   3. On success, GET the first output URL and return its bytes.
 *
 * Provider failures surface as `Error("provider_error: <reason>")`;
 * missing env surfaces as `Error("provider_unconfigured: replicate")`.
 *
 * `fetch`, `nowMs`, and `sleep` are injectable so unit tests can stub
 * the entire HTTP / timing surface.
 */

import type { ImageMimeType } from "../types.js";
import type {
  GenerateRequest,
  GenerateResult,
  ImageProvider,
  ProviderDeps,
  ReplicateProviderConfig,
} from "./types.js";

export const REPLICATE_API_BASE = "https://api.replicate.com/v1";
export const DEFAULT_REPLICATE_MODEL = "black-forest-labs/flux-schnell";
export const DEFAULT_POLL_TIMEOUT_MS = 120_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

interface PredictionResponse {
  readonly id: string;
  readonly status:
    | "starting"
    | "processing"
    | "succeeded"
    | "failed"
    | "canceled";
  readonly output?: string | readonly string[] | null;
  readonly error?: string | null;
  readonly urls?: { readonly get?: string };
}

export class ReplicateImageProvider implements ImageProvider {
  public readonly kind = "replicate";

  private readonly model: string;
  private readonly apiToken: string;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: NonNullable<ProviderDeps["fetch"]>;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(cfg: ReplicateProviderConfig, deps: ProviderDeps = {}) {
    const token = cfg.apiToken ?? process.env.REPLICATE_API_TOKEN;
    if (!token) {
      throw new Error("provider_unconfigured: replicate");
    }
    this.apiToken = token;
    this.model = cfg.model ?? DEFAULT_REPLICATE_MODEL;
    this.pollTimeoutMs = cfg.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.pollIntervalMs = cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.sleep =
      deps.sleep ??
      ((ms) => new Promise<void>((res) => setTimeout(res, ms).unref?.()));
  }

  public async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      version: this.model,
      input: {
        prompt: req.prompt,
        width: req.width,
        height: req.height,
        num_inference_steps: req.steps,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        ...(req.negativePrompt !== undefined
          ? { negative_prompt: req.negativePrompt }
          : {}),
      },
    };

    const created = await this.postJson<PredictionResponse>(
      `${REPLICATE_API_BASE}/predictions`,
      body,
    );
    const pollUrl = created.urls?.get ?? `${REPLICATE_API_BASE}/predictions/${created.id}`;

    const final = await this.pollUntilDone(pollUrl);
    if (final.status === "failed" || final.status === "canceled") {
      throw new Error(`provider_error: ${final.error ?? final.status}`);
    }
    const outputUrl = pickOutputUrl(final.output);
    if (!outputUrl) {
      throw new Error("provider_error: no output url");
    }

    const imgResp = await this.fetchImpl(outputUrl);
    if (!imgResp.ok) {
      throw new Error(`provider_error: output fetch ${imgResp.status}`);
    }
    const ab = await imgResp.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const ct = imgResp.headers.get("content-type") ?? "image/png";
    const mimeType = normaliseMime(ct);

    return {
      bytes,
      mimeType,
      providerJobId: created.id,
      modelId: this.model,
    };
  }

  private async pollUntilDone(url: string): Promise<PredictionResponse> {
    const deadline = this.nowMs() + this.pollTimeoutMs;
    while (this.nowMs() < deadline) {
      const resp = await this.fetchImpl(url, {
        headers: this.authHeaders(),
      });
      if (!resp.ok) {
        throw new Error(`provider_error: poll ${resp.status}`);
      }
      const body = (await resp.json()) as PredictionResponse;
      if (
        body.status === "succeeded" ||
        body.status === "failed" ||
        body.status === "canceled"
      ) {
        return body;
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error("provider_timeout: replicate poll budget exceeded");
  }

  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const resp = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`provider_error: replicate POST ${resp.status} ${txt}`);
    }
    return (await resp.json()) as T;
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiToken}` };
  }
}

function pickOutputUrl(
  out: PredictionResponse["output"],
): string | undefined {
  if (typeof out === "string") return out;
  if (Array.isArray(out) && out.length > 0 && typeof out[0] === "string") {
    return out[0];
  }
  return undefined;
}

function normaliseMime(ct: string): ImageMimeType {
  const lc = ct.toLowerCase();
  if (lc.includes("jpeg") || lc.includes("jpg")) return "image/jpeg";
  if (lc.includes("webp")) return "image/webp";
  return "image/png";
}
