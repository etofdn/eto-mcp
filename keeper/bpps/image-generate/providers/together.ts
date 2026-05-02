/**
 * Together AI image-generation provider (FN-078).
 *
 * POSTs `/v1/images/generations` with `response_format: "b64_json"` and
 * decodes `data[0].b64_json` to bytes. Failures surface as
 * `provider_error: <reason>`; missing env as
 * `provider_unconfigured: together`.
 */

import type {
  GenerateRequest,
  GenerateResult,
  ImageProvider,
  ProviderDeps,
  TogetherProviderConfig,
} from "./types.js";

export const TOGETHER_API_URL =
  "https://api.together.xyz/v1/images/generations";
export const DEFAULT_TOGETHER_MODEL = "black-forest-labs/FLUX.1-schnell-Free";

interface TogetherResponse {
  readonly id?: string;
  readonly model?: string;
  readonly data?: ReadonlyArray<{
    readonly b64_json?: string;
    readonly url?: string;
  }>;
}

export class TogetherImageProvider implements ImageProvider {
  public readonly kind = "together";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: NonNullable<ProviderDeps["fetch"]>;

  public constructor(cfg: TogetherProviderConfig, deps: ProviderDeps = {}) {
    const key = cfg.apiKey ?? process.env.TOGETHER_API_KEY;
    if (!key) {
      throw new Error("provider_unconfigured: together");
    }
    this.apiKey = key;
    this.model = cfg.model ?? DEFAULT_TOGETHER_MODEL;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  public async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      prompt: req.prompt,
      width: req.width,
      height: req.height,
      steps: req.steps,
      n: 1,
      response_format: "b64_json",
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.negativePrompt !== undefined
        ? { negative_prompt: req.negativePrompt }
        : {}),
    };
    const resp = await this.fetchImpl(TOGETHER_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`provider_error: together ${resp.status} ${txt}`);
    }
    const data = (await resp.json()) as TogetherResponse;
    const first = data.data?.[0];
    if (!first?.b64_json) {
      throw new Error("provider_error: together response missing b64_json");
    }
    const bytes = decodeBase64(first.b64_json);
    return {
      bytes,
      mimeType: "image/png",
      providerJobId: data.id ?? `together-${Date.now()}`,
      modelId: data.model ?? this.model,
    };
  }
}

function decodeBase64(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
