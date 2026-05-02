/**
 * Unit tests for the `image:generate` reference BPP (FN-078).
 *
 * Coverage:
 *   - `zImageGenerateInput` validation (success + four failure modes).
 *   - `config` parses against the FN-073 `zBppConfig`.
 *   - Each provider's HTTP shape (with stubbed fetch).
 *   - `FakeImageProvider` determinism.
 *   - Each pinner's HTTP shape; `InMemoryBytesPinner` determinism.
 *   - `selectIpfsPinner` env wiring.
 *   - Handler success / input-invalid / provider-error / ipfs-error.
 *   - Signing chain wraps complete + fail with non-empty signatures.
 *   - End-to-end `runBpp` drive: 2 successes (different CIDs) + 1 fail.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  defaultCredentialGate,
  InMemoryChain,
  InMemoryEventSource,
  runBpp,
  zBppConfig,
  type BeckonInitEvent,
  type Logger,
} from "../../keeper/templates/bpp/index.js";
import {
  config,
  tags,
  buildConfig,
  DEV_AUTHORITY_PUBKEY,
} from "../../keeper/bpps/image-generate/config.js";
import {
  zImageGenerateInput,
  PROMPT_MAX_CHARS,
} from "../../keeper/bpps/image-generate/types.js";
import {
  FakeImageProvider,
  ReplicateImageProvider,
  TogetherImageProvider,
  StabilityImageProvider,
  selectProvider,
  REPLICATE_API_BASE,
  TOGETHER_API_URL,
  STABILITY_API_URL,
  DEFAULT_REPLICATE_MODEL,
  DEFAULT_TOGETHER_MODEL,
  type ProviderConfig,
} from "../../keeper/bpps/image-generate/providers/index.js";
import {
  Web3StoragePinner,
  PinataPinner,
  InMemoryBytesPinner,
  WEB3_STORAGE_UPLOAD_URL,
  PINATA_PIN_FILE_URL,
  selectIpfsPinner,
} from "../../keeper/bpps/image-generate/ipfs.js";
import {
  createImageGenerateHandler,
} from "../../keeper/bpps/image-generate/handler.js";
import {
  canonicalJson,
  makeStubSigner,
  SigningRuntimeChain,
} from "../../keeper/bpps/image-generate/chain-adapter.js";
import type {
  ImageGenerateInput,
  ImageGenerateOutput,
} from "../../keeper/bpps/image-generate/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(
  bytes: Uint8Array,
  init: { status?: number; contentType?: string } = {},
): Response {
  // Copy into an isolated ArrayBuffer to avoid SharedArrayBuffer typing snags.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Response(ab, {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "image/png" },
  });
}

const sha256 = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

/* -------------------------------------------------------------------------- */
/* Step 1: types + config                                                     */
/* -------------------------------------------------------------------------- */

describe("zImageGenerateInput", () => {
  it("accepts a minimal valid input", () => {
    expect(
      zImageGenerateInput.safeParse({ prompt: "a cat" }).success,
    ).toBe(true);
  });

  it("accepts a fully-specified input", () => {
    const r = zImageGenerateInput.safeParse({
      prompt: "a cat",
      negativePrompt: "blurry",
      width: 1024,
      height: 1024,
      steps: 8,
      seed: 42,
      outputFormat: "png",
      provider: "replicate",
    });
    expect(r.success).toBe(true);
  });

  it("rejects oversized prompt", () => {
    const big = "x".repeat(PROMPT_MAX_CHARS + 1);
    expect(
      zImageGenerateInput.safeParse({ prompt: big }).success,
    ).toBe(false);
  });

  it("rejects illegal width", () => {
    expect(
      zImageGenerateInput.safeParse({ prompt: "a", width: 999 }).success,
    ).toBe(false);
  });

  it("rejects negative seed", () => {
    expect(
      zImageGenerateInput.safeParse({ prompt: "a", seed: -1 }).success,
    ).toBe(false);
  });

  it("rejects unknown provider", () => {
    expect(
      zImageGenerateInput.safeParse({ prompt: "a", provider: "midjourney" })
        .success,
    ).toBe(false);
  });
});

describe("config", () => {
  it("matches the canonical capability tags", () => {
    expect(tags.domain).toBe("image");
    expect(tags.action).toBe("generate");
    expect(tags.version).toBe("1.0.0");
    expect(tags.price.currency).toBe("ETO");
    expect(tags.requiredCredentials).toEqual([]);
  });

  it("parses against zBppConfig", () => {
    expect(zBppConfig.safeParse(config).success).toBe(true);
  });

  it("buildConfig honours env overrides", () => {
    const prev = process.env.IMAGE_GENERATE_AUTHORITY;
    process.env.IMAGE_GENERATE_AUTHORITY = "OverrideAuthority1234567890123456789012";
    try {
      expect(buildConfig().authority).toBe(
        "OverrideAuthority1234567890123456789012",
      );
    } finally {
      if (prev === undefined) delete process.env.IMAGE_GENERATE_AUTHORITY;
      else process.env.IMAGE_GENERATE_AUTHORITY = prev;
    }
  });

  it("default authority is the dev pubkey", () => {
    expect(buildConfig().authority).toBe(DEV_AUTHORITY_PUBKEY);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 2: providers                                                          */
/* -------------------------------------------------------------------------- */

describe("ReplicateImageProvider", () => {
  it("throws provider_unconfigured when token missing", () => {
    const prev = process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_TOKEN;
    try {
      expect(() => new ReplicateImageProvider({ kind: "replicate" })).toThrow(
        /provider_unconfigured: replicate/,
      );
    } finally {
      if (prev !== undefined) process.env.REPLICATE_API_TOKEN = prev;
    }
  });

  it("posts then polls then fetches the output URL", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const png = new Uint8Array([1, 2, 3, 4, 5]);
    let pollCount = 0;
    const fetchStub = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, ...(init !== undefined ? { init } : {}) });
      if (u === `${REPLICATE_API_BASE}/predictions`) {
        return jsonResponse({
          id: "pred-1",
          status: "starting",
          urls: { get: `${REPLICATE_API_BASE}/predictions/pred-1` },
        });
      }
      if (u === `${REPLICATE_API_BASE}/predictions/pred-1`) {
        pollCount += 1;
        if (pollCount < 2) {
          return jsonResponse({ id: "pred-1", status: "processing" });
        }
        return jsonResponse({
          id: "pred-1",
          status: "succeeded",
          output: ["https://cdn.replicate.com/img.png"],
        });
      }
      if (u === "https://cdn.replicate.com/img.png") {
        return bytesResponse(png, { contentType: "image/png" });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const provider = new ReplicateImageProvider(
      { kind: "replicate", apiToken: "tok-1", pollIntervalMs: 0 },
      { fetch: fetchStub, sleep: async () => undefined },
    );
    const r = await provider.generate({
      prompt: "a cat",
      width: 512,
      height: 512,
      steps: 4,
    });
    expect(Array.from(r.bytes)).toEqual(Array.from(png));
    expect(r.providerJobId).toBe("pred-1");
    expect(r.modelId).toBe(DEFAULT_REPLICATE_MODEL);

    // First call POSTs JSON with auth bearer.
    const post = calls[0]!;
    expect(post.url).toBe(`${REPLICATE_API_BASE}/predictions`);
    expect((post.init?.method ?? "GET")).toBe("POST");
    const headers = post.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-1");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(post.init?.body as string);
    expect(body.version).toBe(DEFAULT_REPLICATE_MODEL);
    expect(body.input.prompt).toBe("a cat");
    expect(body.input.width).toBe(512);
    expect(body.input.num_inference_steps).toBe(4);
  });

  it("surfaces provider failures as provider_error", async () => {
    const fetchStub = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/predictions")) {
        return jsonResponse({
          id: "p2",
          status: "starting",
          urls: { get: `${REPLICATE_API_BASE}/predictions/p2` },
        });
      }
      return jsonResponse({
        id: "p2",
        status: "failed",
        error: "model crashed",
      });
    }) as unknown as typeof globalThis.fetch;
    const provider = new ReplicateImageProvider(
      { kind: "replicate", apiToken: "tok", pollIntervalMs: 0 },
      { fetch: fetchStub, sleep: async () => undefined },
    );
    await expect(
      provider.generate({ prompt: "x", width: 256, height: 256, steps: 1 }),
    ).rejects.toThrow(/provider_error: model crashed/);
  });

  it("times out when poll budget exceeded", async () => {
    const fetchStub = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/predictions")) {
        return jsonResponse({
          id: "p3",
          status: "starting",
          urls: { get: `${REPLICATE_API_BASE}/predictions/p3` },
        });
      }
      return jsonResponse({ id: "p3", status: "processing" });
    }) as unknown as typeof globalThis.fetch;
    let t = 0;
    const provider = new ReplicateImageProvider(
      {
        kind: "replicate",
        apiToken: "tok",
        pollTimeoutMs: 5,
        pollIntervalMs: 0,
      },
      {
        fetch: fetchStub,
        nowMs: () => {
          t += 10;
          return t;
        },
        sleep: async () => undefined,
      },
    );
    await expect(
      provider.generate({ prompt: "y", width: 256, height: 256, steps: 1 }),
    ).rejects.toThrow(/provider_timeout/);
  });
});

describe("TogetherImageProvider", () => {
  it("throws provider_unconfigured when key missing", () => {
    const prev = process.env.TOGETHER_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    try {
      expect(() => new TogetherImageProvider({ kind: "together" })).toThrow(
        /provider_unconfigured: together/,
      );
    } finally {
      if (prev !== undefined) process.env.TOGETHER_API_KEY = prev;
    }
  });

  it("decodes base64 output and validates request shape", async () => {
    const png = new Uint8Array([9, 8, 7, 6]);
    const b64 = Buffer.from(png).toString("base64");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, ...(init !== undefined ? { init } : {}) });
      return jsonResponse({
        id: "tg-1",
        model: DEFAULT_TOGETHER_MODEL,
        data: [{ b64_json: b64 }],
      });
    }) as unknown as typeof globalThis.fetch;
    const provider = new TogetherImageProvider(
      { kind: "together", apiKey: "tk" },
      { fetch: fetchStub },
    );
    const r = await provider.generate({
      prompt: "p",
      width: 1024,
      height: 1024,
      steps: 4,
      seed: 7,
    });
    expect(Array.from(r.bytes)).toEqual(Array.from(png));
    expect(r.providerJobId).toBe("tg-1");
    expect(r.modelId).toBe(DEFAULT_TOGETHER_MODEL);

    const c = calls[0]!;
    expect(c.url).toBe(TOGETHER_API_URL);
    const headers = c.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tk");
    const body = JSON.parse(c.init?.body as string);
    expect(body.response_format).toBe("b64_json");
    expect(body.seed).toBe(7);
  });

  it("surfaces missing data as provider_error", async () => {
    const fetchStub = (async () =>
      jsonResponse({ data: [] })) as unknown as typeof globalThis.fetch;
    const provider = new TogetherImageProvider(
      { kind: "together", apiKey: "tk" },
      { fetch: fetchStub },
    );
    await expect(
      provider.generate({ prompt: "p", width: 256, height: 256, steps: 1 }),
    ).rejects.toThrow(/provider_error/);
  });
});

describe("StabilityImageProvider", () => {
  it("throws provider_unconfigured when key missing", () => {
    const prev = process.env.STABILITY_API_KEY;
    delete process.env.STABILITY_API_KEY;
    try {
      expect(() => new StabilityImageProvider({ kind: "stability" })).toThrow(
        /provider_unconfigured: stability/,
      );
    } finally {
      if (prev !== undefined) process.env.STABILITY_API_KEY = prev;
    }
  });

  it("posts multipart and reads raw image bytes", async () => {
    const png = new Uint8Array([1, 1, 2, 3, 5, 8, 13]);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, ...(init !== undefined ? { init } : {}) });
      return bytesResponse(png, { contentType: "image/jpeg" });
    }) as unknown as typeof globalThis.fetch;
    const provider = new StabilityImageProvider(
      { kind: "stability", apiKey: "sk" },
      { fetch: fetchStub },
    );
    const r = await provider.generate({
      prompt: "p",
      width: 1024,
      height: 1024,
      steps: 4,
    });
    expect(Array.from(r.bytes)).toEqual(Array.from(png));
    expect(r.mimeType).toBe("image/jpeg");
    const c = calls[0]!;
    expect(c.url).toBe(STABILITY_API_URL);
    expect(c.init?.method).toBe("POST");
    expect(c.init?.body).toBeInstanceOf(FormData);
    const fd = c.init?.body as FormData;
    expect(fd.get("prompt")).toBe("p");
    expect(fd.get("aspect_ratio")).toBe("1:1");
    const headers = c.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk");
  });
});

describe("FakeImageProvider", () => {
  it("is deterministic for the same prompt", async () => {
    const p = new FakeImageProvider();
    const a = await p.generate({
      prompt: "same",
      width: 256,
      height: 256,
      steps: 1,
    });
    const b = await p.generate({
      prompt: "same",
      width: 256,
      height: 256,
      steps: 1,
    });
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });

  it("varies across prompts", async () => {
    const p = new FakeImageProvider();
    const a = await p.generate({
      prompt: "alpha",
      width: 256,
      height: 256,
      steps: 1,
    });
    const b = await p.generate({
      prompt: "beta",
      width: 256,
      height: 256,
      steps: 1,
    });
    expect(Array.from(a.bytes)).not.toEqual(Array.from(b.bytes));
  });
});

describe("selectProvider", () => {
  it("dispatches on cfg.kind", () => {
    expect(
      selectProvider({ kind: "replicate", apiToken: "x" } as ProviderConfig).kind,
    ).toBe("replicate");
    expect(
      selectProvider({ kind: "together", apiKey: "x" } as ProviderConfig).kind,
    ).toBe("together");
    expect(
      selectProvider({ kind: "stability", apiKey: "x" } as ProviderConfig).kind,
    ).toBe("stability");
  });
});

/* -------------------------------------------------------------------------- */
/* Step 3: pinners                                                            */
/* -------------------------------------------------------------------------- */

describe("Web3StoragePinner", () => {
  it("posts bytes and returns ipfs:// URI", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, ...(init !== undefined ? { init } : {}) });
      return jsonResponse({ cid: "bafkreiabc" });
    }) as unknown as typeof globalThis.fetch;
    const pinner = new Web3StoragePinner(
      { token: "tok" },
      { fetch: fetchStub },
    );
    const r = await pinner.pinBytes(new Uint8Array([1, 2, 3]), {
      mimeType: "image/png",
    });
    expect(r.uri).toBe("ipfs://bafkreiabc");
    expect(r.cid).toBe("bafkreiabc");
    expect(r.size).toBe(3);
    const c = calls[0]!;
    expect(c.url).toBe(WEB3_STORAGE_UPLOAD_URL);
    const headers = c.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
  });

  it("throws ipfs_unconfigured when no token", () => {
    const prev = process.env.WEB3_STORAGE_TOKEN;
    delete process.env.WEB3_STORAGE_TOKEN;
    try {
      expect(() => new Web3StoragePinner()).toThrow(/ipfs_unconfigured/);
    } finally {
      if (prev !== undefined) process.env.WEB3_STORAGE_TOKEN = prev;
    }
  });
});

describe("PinataPinner", () => {
  it("posts multipart and returns ipfs:// URI", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, ...(init !== undefined ? { init } : {}) });
      return jsonResponse({ IpfsHash: "QmFakeHash", PinSize: 3 });
    }) as unknown as typeof globalThis.fetch;
    const pinner = new PinataPinner({ jwt: "jwt-1" }, { fetch: fetchStub });
    const r = await pinner.pinBytes(new Uint8Array([1, 2, 3]), {
      mimeType: "image/png",
      filename: "x.png",
    });
    expect(r.uri).toBe("ipfs://QmFakeHash");
    expect(r.cid).toBe("QmFakeHash");
    expect(r.size).toBe(3);
    const c = calls[0]!;
    expect(c.url).toBe(PINATA_PIN_FILE_URL);
    expect(c.init?.body).toBeInstanceOf(FormData);
    const headers = c.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer jwt-1");
  });

  it("throws ipfs_unconfigured when no JWT", () => {
    const prev = process.env.PINATA_JWT;
    delete process.env.PINATA_JWT;
    try {
      expect(() => new PinataPinner()).toThrow(/ipfs_unconfigured/);
    } finally {
      if (prev !== undefined) process.env.PINATA_JWT = prev;
    }
  });
});

describe("InMemoryBytesPinner", () => {
  it("returns deterministic bafy<sha256> URI", async () => {
    const a = new InMemoryBytesPinner();
    const b = new InMemoryBytesPinner();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const ra = await a.pinBytes(bytes, { mimeType: "image/png" });
    const rb = await b.pinBytes(bytes, { mimeType: "image/png" });
    expect(ra.cid).toBe(rb.cid);
    expect(ra.cid).toBe(`bafy${sha256(bytes)}`);
    expect(ra.uri.startsWith("ipfs://")).toBe(true);
    expect(a.pinned).toHaveLength(1);
  });
});

describe("selectIpfsPinner", () => {
  it("uses inmemory when requested", () => {
    expect(selectIpfsPinner({ IPFS_PINNER: "inmemory" }).kind).toBe(
      "inmemory",
    );
  });

  it("auto-picks web3.storage when token present", () => {
    expect(
      selectIpfsPinner({ WEB3_STORAGE_TOKEN: "t" }, { fetch: globalThis.fetch })
        .kind,
    ).toBe("web3.storage");
  });

  it("auto-picks pinata when JWT present", () => {
    expect(
      selectIpfsPinner({ PINATA_JWT: "j" }, { fetch: globalThis.fetch }).kind,
    ).toBe("pinata");
  });

  it("throws ipfs_unconfigured when nothing set", () => {
    expect(() => selectIpfsPinner({})).toThrow(/ipfs_unconfigured/);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 4: handler                                                            */
/* -------------------------------------------------------------------------- */

describe("createImageGenerateHandler", () => {
  function makeReq(input: unknown) {
    return {
      taskId: "t-1",
      bapPubkey: "bap",
      bppPubkey: "bpp",
      networkPubkey: "net",
      action: "image:generate",
      input,
    };
  }
  const ctx = {
    logger: silentLogger,
    agent: { authority: "a", name: "n" },
    now: () => 1000,
  };

  it("success path produces a valid output with sha256 over bytes", async () => {
    const provider = new FakeImageProvider();
    const ipfs = new InMemoryBytesPinner();
    const handler = createImageGenerateHandler({
      provider,
      ipfs,
      now: () => 1234,
      nowMs: () => 0,
    });
    const r = await handler.handleTask(
      makeReq({ prompt: "abc" } satisfies ImageGenerateInput),
      ctx,
    );
    expect(r.status).toBe("success");
    if (r.status !== "success") throw new Error("unreachable");
    const a = r.output.artifact;
    expect(a.mimeType).toBe("image/png");
    expect(a.ipfsUri.startsWith("ipfs://")).toBe(true);
    expect(`ipfs://${a.cid}`).toBe(a.ipfsUri);
    expect(a.prompt).toBe("abc");
    expect(a.producedAtSec).toBe(1234);
    // sha256 must match the pinned bytes.
    expect(a.sha256).toBe(sha256(ipfs.pinned[0]!.bytes));
    expect(r.output.provider).toBe("fake");
  });

  it("oversized prompt → input_invalid", async () => {
    const provider = new FakeImageProvider();
    const ipfs = new InMemoryBytesPinner();
    const handler = createImageGenerateHandler({ provider, ipfs });
    const r = await handler.handleTask(
      makeReq({ prompt: "x".repeat(PROMPT_MAX_CHARS + 1) }),
      ctx,
    );
    expect(r.status).toBe("failure");
    if (r.status !== "failure") throw new Error("unreachable");
    expect(r.reason.startsWith("input_invalid")).toBe(true);
  });

  it("provider failure → provider_error", async () => {
    const provider = {
      kind: "boom",
      generate: async () => {
        throw new Error("provider_error: kaboom");
      },
    };
    const ipfs = new InMemoryBytesPinner();
    const handler = createImageGenerateHandler({ provider, ipfs });
    const r = await handler.handleTask(makeReq({ prompt: "p" }), ctx);
    expect(r.status).toBe("failure");
    if (r.status !== "failure") throw new Error("unreachable");
    expect(r.reason).toBe("provider_error: kaboom");
  });

  it("unexpected provider throw → internal_error", async () => {
    const provider = {
      kind: "boom",
      generate: async () => {
        throw new Error("network down");
      },
    };
    const ipfs = new InMemoryBytesPinner();
    const handler = createImageGenerateHandler({ provider, ipfs });
    const r = await handler.handleTask(makeReq({ prompt: "p" }), ctx);
    expect(r.status).toBe("failure");
    if (r.status !== "failure") throw new Error("unreachable");
    expect(r.reason.startsWith("internal_error")).toBe(true);
  });

  it("ipfs failure → ipfs_error", async () => {
    const provider = new FakeImageProvider();
    const ipfs = {
      kind: "broken",
      pinBytes: async () => {
        throw new Error("ipfs_error: pinner exploded");
      },
    };
    const handler = createImageGenerateHandler({ provider, ipfs });
    const r = await handler.handleTask(makeReq({ prompt: "p" }), ctx);
    expect(r.status).toBe("failure");
    if (r.status !== "failure") throw new Error("unreachable");
    expect(r.reason).toBe("ipfs_error: pinner exploded");
  });
});

/* -------------------------------------------------------------------------- */
/* Step 4: signing chain                                                      */
/* -------------------------------------------------------------------------- */

describe("SigningRuntimeChain", () => {
  it("wraps completeTask with a non-empty signature and pubkey", async () => {
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("seed-1"),
      now: () => 5,
    });
    await chain.completeTask({ taskId: "t", output: { hello: 1 } });
    expect(chain.signedComplete).toHaveLength(1);
    const rec = chain.signedComplete[0]!;
    expect(rec.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.signerPubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.payload.producedAtSec).toBe(5);
    expect(inner.completed).toHaveLength(1);
    const innerOut = inner.completed[0]!.output as Record<string, unknown>;
    expect(innerOut.signature).toBe(rec.signature);
    expect(innerOut.signerPubkey).toBe(rec.signerPubkey);
  });

  it("wraps failTask too", async () => {
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("seed-2"),
      now: () => 9,
    });
    await chain.failTask({ taskId: "t", reason: "nope" });
    expect(chain.signedFail).toHaveLength(1);
    expect(inner.failed).toHaveLength(1);
    expect(inner.failed[0]!.reason).toMatch(/^nope\|sig=[0-9a-f]+\|pk=[0-9a-f]+$/);
  });

  it("delegates to inner chain exactly once per call", async () => {
    let completeCalls = 0;
    let failCalls = 0;
    const inner = {
      completeTask: async () => {
        completeCalls += 1;
      },
      failTask: async () => {
        failCalls += 1;
      },
    };
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("seed-3"),
    });
    await chain.completeTask({ taskId: "a", output: 1 });
    await chain.failTask({ taskId: "b", reason: "x" });
    expect(completeCalls).toBe(1);
    expect(failCalls).toBe(1);
  });

  it("canonicalJson sorts keys deterministically", () => {
    const a = canonicalJson({ b: 1, a: { y: 2, x: 1 } });
    const b = canonicalJson({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 5: end-to-end runBpp                                                  */
/* -------------------------------------------------------------------------- */

describe("runBpp end-to-end", () => {
  it("drives 2 successes (different CIDs) + 1 input_invalid failure", async () => {
    const provider = new FakeImageProvider();
    const ipfs = new InMemoryBytesPinner();
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("e2e"),
      now: () => 7,
    });
    const handler = createImageGenerateHandler({
      provider,
      ipfs,
      now: () => 7,
      nowMs: () => 0,
    });
    const gate = defaultCredentialGate([], {
      loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
      now: () => 0,
    });
    const events = new InMemoryEventSource<unknown>();

    const done = runBpp<unknown, ImageGenerateOutput>(config, handler, {
      eventSource: events,
      chain,
      gate,
      logger: silentLogger,
    });

    const mkEvent = (
      taskId: string,
      input: unknown,
    ): BeckonInitEvent<unknown> => ({
      taskId,
      bapPubkey: "BapPubkey1111111111111111111111111111111111",
      bppPubkey: config.authority,
      networkPubkey: "NetworkPubkey22222222222222222222222222222",
      action: "image:generate",
      input,
      observedAt: 0,
    });

    events.push(mkEvent("ok-1", { prompt: "alpha" }));
    events.push(mkEvent("ok-2", { prompt: "beta" }));
    events.push(
      mkEvent("bad", { prompt: "x".repeat(PROMPT_MAX_CHARS + 1) }),
    );
    events.close();
    await done;

    expect(inner.completed).toHaveLength(2);
    expect(inner.failed).toHaveLength(1);
    expect(inner.failed[0]!.reason).toMatch(/input_invalid/);

    // Each recorded payload carries signature + signerPubkey on its
    // inner-chain projection.
    for (const c of inner.completed) {
      const o = c.output as Record<string, unknown>;
      expect(typeof o.signature).toBe("string");
      expect(typeof o.signerPubkey).toBe("string");
      expect((o.signature as string).length).toBeGreaterThan(0);
    }

    // Two success CIDs differ.
    const out0 = inner.completed[0]!.output as {
      result: ImageGenerateOutput;
    };
    const out1 = inner.completed[1]!.output as {
      result: ImageGenerateOutput;
    };
    expect(out0.result.artifact.cid).not.toEqual(out1.result.artifact.cid);

    expect(chain.signedComplete).toHaveLength(2);
    expect(chain.signedFail).toHaveLength(1);
  });
});
