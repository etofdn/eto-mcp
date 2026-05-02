/**
 * Unit tests for the `text:summarize` reference BPP (FN-075).
 *
 * Covers: types/config, fetcher (text/url/pdf paths + size guards +
 * html stripping), summariser, handler wiring, signing chain adapter,
 * and an end-to-end run through `runBpp`.
 */

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
} from "../../keeper/bpps/text-summarize/config.js";
import {
  zSummarizeInput,
  PDF_MAX_BYTES,
  TEXT_MAX_BYTES,
  decodedBase64Bytes,
} from "../../keeper/bpps/text-summarize/types.js";
import {
  fetchSource,
  noopPdfExtractor,
  stripHtml,
  type FetchLike,
  type PdfExtractor,
} from "../../keeper/bpps/text-summarize/fetcher.js";
import {
  summarize,
  sha256Hex,
  type LlmClient,
} from "../../keeper/bpps/text-summarize/summarizer.js";
import {
  createTextSummarizeHandler,
  buildHandlerFromPrimitives,
} from "../../keeper/bpps/text-summarize/handler.js";
import {
  canonicalJson,
  makeStubSigner,
  SigningRuntimeChain,
} from "../../keeper/bpps/text-summarize/chain-adapter.js";
import type { SummarizeInput, SummarizeOutput } from "../../keeper/bpps/text-summarize/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cannedLlm: LlmClient = {
  async summarize(req) {
    return {
      markdown: [
        `# Title for model=${req.modelId}`,
        ``,
        req.style === "bullets" ? `- one\n- two` : `Body prose.`,
        ``,
        `## Key Facts`,
        `- target=${req.targetLengthWords}`,
        `- bytes=${req.text.length}`,
      ].join("\n"),
    };
  },
};

function makeFetchResponse(opts: {
  status?: number;
  body: Buffer | string;
  contentType?: string;
  contentLength?: string | null;
}) {
  const buf = typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : opts.body;
  return {
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    headers: {
      get: (n: string) => {
        const k = n.toLowerCase();
        if (k === "content-type") return opts.contentType ?? "text/plain";
        if (k === "content-length") {
          if (opts.contentLength === null) return null;
          return opts.contentLength ?? String(buf.length);
        }
        return null;
      },
    },
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
      return ab;
    },
  };
}

function makeFetch(map: Record<string, ReturnType<typeof makeFetchResponse>>): FetchLike {
  return async (url: string) => {
    const r = map[url];
    if (!r) throw new Error(`no fixture for ${url}`);
    return r;
  };
}

/* ========================================================================== */
/* Step 1 — types + config                                                    */
/* ========================================================================== */

describe("config + tags", () => {
  it("config passes the template's zBppConfig schema", () => {
    expect(() => zBppConfig.parse(config)).not.toThrow();
  });

  it("tags advertise text:summarize 1.0.0", () => {
    expect(tags.domain).toBe("text");
    expect(tags.action).toBe("summarize");
    expect(tags.version).toBe("1.0.0");
    expect(tags.price).toEqual({ amount: "0.10", currency: "ETO" });
    expect(tags.requiredCredentials).toEqual([]);
    expect(tags.description.length).toBeLessThanOrEqual(512);
  });

  it("buildConfig honours TEXT_SUMMARIZE_AUTHORITY env", () => {
    const prev = process.env.TEXT_SUMMARIZE_AUTHORITY;
    process.env.TEXT_SUMMARIZE_AUTHORITY = "OverrideAuth111111111111111111111111111111";
    try {
      expect(buildConfig().authority).toBe(
        "OverrideAuth111111111111111111111111111111",
      );
    } finally {
      if (prev === undefined) delete process.env.TEXT_SUMMARIZE_AUTHORITY;
      else process.env.TEXT_SUMMARIZE_AUTHORITY = prev;
    }
  });

  it("falls back to dev authority when env is unset", () => {
    const prev = process.env.TEXT_SUMMARIZE_AUTHORITY;
    delete process.env.TEXT_SUMMARIZE_AUTHORITY;
    try {
      expect(buildConfig().authority).toBe(DEV_AUTHORITY_PUBKEY);
    } finally {
      if (prev !== undefined) process.env.TEXT_SUMMARIZE_AUTHORITY = prev;
    }
  });
});

describe("zSummarizeInput", () => {
  it("accepts valid text/url/pdfBase64 inputs", () => {
    expect(
      zSummarizeInput.parse({ source: { kind: "text", text: "hello" } }),
    ).toBeTruthy();
    expect(
      zSummarizeInput.parse({
        source: { kind: "url", url: "https://example.com/" },
        targetLengthWords: 100,
        style: "bullets",
      }),
    ).toBeTruthy();
    expect(
      zSummarizeInput.parse({
        source: { kind: "pdfBase64", data: Buffer.from("hi").toString("base64") },
      }),
    ).toBeTruthy();
  });

  it("rejects malformed url", () => {
    const r = zSummarizeInput.safeParse({ source: { kind: "url", url: "not a url" } });
    expect(r.success).toBe(false);
  });

  it("rejects unknown kind", () => {
    const r = zSummarizeInput.safeParse({
      source: { kind: "video", text: "x" } as never,
    });
    expect(r.success).toBe(false);
  });

  it("rejects oversized text", () => {
    const big = "a".repeat(TEXT_MAX_BYTES + 1);
    const r = zSummarizeInput.safeParse({ source: { kind: "text", text: big } });
    expect(r.success).toBe(false);
  });

  it("rejects oversized pdfBase64 by decoded size", () => {
    // length s.t. decoded > PDF_MAX_BYTES
    const len = Math.ceil(((PDF_MAX_BYTES + 1024) * 4) / 3);
    const r = zSummarizeInput.safeParse({
      source: { kind: "pdfBase64", data: "A".repeat(len) },
    });
    expect(r.success).toBe(false);
  });

  it("rejects targetLengthWords above max", () => {
    const r = zSummarizeInput.safeParse({
      source: { kind: "text", text: "x" },
      targetLengthWords: 9999,
    });
    expect(r.success).toBe(false);
  });
});

describe("decodedBase64Bytes", () => {
  it("matches Buffer.from on representative inputs", () => {
    for (const s of ["", "QQ==", "QUI=", "QUJD", "aGVsbG8gd29ybGQ="]) {
      expect(decodedBase64Bytes(s)).toBe(Buffer.from(s, "base64").length);
    }
  });
});

/* ========================================================================== */
/* Step 2 — fetcher                                                            */
/* ========================================================================== */

describe("fetchSource", () => {
  it("returns text input directly", async () => {
    const r = await fetchSource(
      { kind: "text", text: "hi there" },
      { fetch: makeFetch({}), pdfExtractor: noopPdfExtractor },
    );
    expect(r.text).toBe("hi there");
    expect(r.sourceBytes).toBe(8);
    expect(r.contentType).toBe("text/plain");
  });

  it("decodes pdfBase64 via the injected extractor", async () => {
    const buf = Buffer.from("PDF-1.4 fake", "utf8");
    const extractor: PdfExtractor = async (b) => `extracted:${b.length}`;
    const r = await fetchSource(
      { kind: "pdfBase64", data: buf.toString("base64") },
      { fetch: makeFetch({}), pdfExtractor: extractor },
    );
    expect(r.text).toBe(`extracted:${buf.length}`);
    expect(r.contentType).toBe("application/pdf");
  });

  it("strips html tags and script/style blocks", () => {
    const html =
      "<html><head><style>x{color:red}</style><script>bad()</script></head>" +
      "<body><h1>Title</h1><p>Hello &amp; world</p></body></html>";
    const out = stripHtml(html);
    expect(out).toContain("Title");
    expect(out).toContain("Hello & world");
    expect(out).not.toContain("<");
    expect(out).not.toContain("bad()");
    expect(out).not.toContain("color:red");
  });

  it("fetches a text/plain URL", async () => {
    const fetch = makeFetch({
      "https://x/y": makeFetchResponse({
        body: "remote text",
        contentType: "text/plain; charset=utf-8",
      }),
    });
    const r = await fetchSource(
      { kind: "url", url: "https://x/y" },
      { fetch, pdfExtractor: noopPdfExtractor },
    );
    expect(r.text).toBe("remote text");
    expect(r.contentType).toBe("text/plain");
  });

  it("rejects oversized response by content-length", async () => {
    const fetch = makeFetch({
      "https://x/big": makeFetchResponse({
        body: "small",
        contentLength: String(10 * 1024 * 1024),
      }),
    });
    await expect(
      fetchSource(
        { kind: "url", url: "https://x/big" },
        { fetch, pdfExtractor: noopPdfExtractor },
      ),
    ).rejects.toThrow(/source_too_large/);
  });

  it("rejects oversized response by actual byte count", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    const fetch = makeFetch({
      "https://x/big": makeFetchResponse({
        body: big,
        contentLength: null,
      }),
    });
    await expect(
      fetchSource(
        { kind: "url", url: "https://x/big", maxBytes: 2 * 1024 * 1024 },
        { fetch, pdfExtractor: noopPdfExtractor },
      ),
    ).rejects.toThrow(/source_too_large/);
  });

  it("dispatches application/pdf to pdfExtractor", async () => {
    const fetch = makeFetch({
      "https://x/p": makeFetchResponse({
        body: Buffer.from("%PDF-1.4 fake"),
        contentType: "application/pdf",
      }),
    });
    const extractor: PdfExtractor = async () => "decoded pdf body";
    const r = await fetchSource(
      { kind: "url", url: "https://x/p" },
      { fetch, pdfExtractor: extractor },
    );
    expect(r.text).toBe("decoded pdf body");
    expect(r.contentType).toBe("application/pdf");
  });

  it("surfaces non-200 as fetch_failed: <status>", async () => {
    const fetch = makeFetch({
      "https://x/404": makeFetchResponse({ status: 404, body: "nope" }),
    });
    await expect(
      fetchSource(
        { kind: "url", url: "https://x/404" },
        { fetch, pdfExtractor: noopPdfExtractor },
      ),
    ).rejects.toThrow(/fetch_failed: 404/);
  });

  it("noopPdfExtractor throws pdf_extraction_unavailable", async () => {
    await expect(noopPdfExtractor(new Uint8Array())).rejects.toThrow(
      /pdf_extraction_unavailable/,
    );
  });
});

/* ========================================================================== */
/* Step 3 — summarizer                                                         */
/* ========================================================================== */

describe("summarize", () => {
  it("passes modelId, targetLengthWords, and style to the LLM", async () => {
    const seen: unknown[] = [];
    const llm: LlmClient = {
      async summarize(req) {
        seen.push(req);
        return { markdown: "# x\n\nbody\n\n## Key Facts\n- a" };
      },
    };
    const r = await summarize(
      "the source",
      { modelId: "claude-test", targetLengthWords: 333, style: "bullets" },
      { llm },
    );
    expect(seen[0]).toMatchObject({
      modelId: "claude-test",
      targetLengthWords: 333,
      style: "bullets",
    });
    expect(r.targetLengthWords).toBe(333);
    expect(r.style).toBe("bullets");
    expect(r.sourceSha256).toBe(sha256Hex("the source"));
  });

  it("defaults targetLengthWords=200 and style=prose", async () => {
    const seen: unknown[] = [];
    const llm: LlmClient = {
      async summarize(req) {
        seen.push(req);
        return { markdown: "# t\nbody" };
      },
    };
    await summarize("xyz", { modelId: "m" }, { llm });
    expect(seen[0]).toMatchObject({ targetLengthWords: 200, style: "prose" });
  });

  it("rejects empty/whitespace-only text with empty_source", async () => {
    await expect(summarize("   \n  ", { modelId: "m" }, { llm: cannedLlm })).rejects.toThrow(
      /empty_source/,
    );
  });
});

/* ========================================================================== */
/* Step 4 — handler + signing chain                                            */
/* ========================================================================== */

describe("createTextSummarizeHandler", () => {
  const buildHandler = () =>
    buildHandlerFromPrimitives({
      fetchDeps: { fetch: makeFetch({}), pdfExtractor: noopPdfExtractor },
      summarizeDeps: { llm: cannedLlm },
      modelId: "claude-test",
      now: () => 1700000000,
    });

  it("happy path produces an Artifact whose sha256 binds to content", async () => {
    const handler = buildHandler();
    const r = await handler.handleTask(
      {
        taskId: "t1",
        bapPubkey: "bap",
        bppPubkey: "bpp",
        networkPubkey: "net",
        action: "text:summarize",
        input: { source: { kind: "text", text: "lorem ipsum dolor sit amet" } },
      },
      { logger: silentLogger, agent: { authority: "a", name: "n" }, now: () => 1 },
    );
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    const out = r.output;
    expect(out.artifact.mimeType).toBe("text/markdown");
    expect(out.artifact.sha256).toBe(sha256Hex(out.artifact.content));
    expect(out.artifact.producedAtSec).toBe(1700000000);
    expect(out.modelId).toBe("claude-test");
    expect(out.sourceBytes).toBe(Buffer.byteLength("lorem ipsum dolor sit amet"));
  });

  it("returns failure on schema-invalid input (no throw)", async () => {
    const handler = buildHandler();
    const r = await handler.handleTask(
      {
        taskId: "t2",
        bapPubkey: "bap",
        bppPubkey: "bpp",
        networkPubkey: "net",
        action: "text:summarize",
        input: { source: { kind: "url", url: "not-a-url" } },
      },
      { logger: silentLogger, agent: { authority: "a", name: "n" }, now: () => 1 },
    );
    expect(r.status).toBe("failure");
    if (r.status !== "failure") return;
    expect(r.reason).toMatch(/^input_invalid:/);
  });

  it("oversized text input is rejected with input_invalid", async () => {
    const handler = buildHandler();
    const r = await handler.handleTask(
      {
        taskId: "t3",
        bapPubkey: "bap",
        bppPubkey: "bpp",
        networkPubkey: "net",
        action: "text:summarize",
        input: { source: { kind: "text", text: "a".repeat(TEXT_MAX_BYTES + 1) } },
      },
      { logger: silentLogger, agent: { authority: "a", name: "n" }, now: () => 1 },
    );
    expect(r.status).toBe("failure");
  });

  it("uses createTextSummarizeHandler directly with custom seams", async () => {
    let called = 0;
    const handler = createTextSummarizeHandler({
      fetcher: async (s) => {
        called++;
        if (s.kind !== "text") throw new Error("unexpected");
        return { text: s.text, sourceBytes: s.text.length, contentType: "text/plain" };
      },
      summarizer: async (text, opts) => ({
        markdown: `# h\n\n${text}\n## Key Facts\n- m=${opts.modelId}`,
        sourceSha256: sha256Hex(text),
        targetLengthWords: opts.targetLengthWords ?? 200,
        style: opts.style ?? "prose",
      }),
      modelId: "m",
      now: () => 42,
    });
    const r = await handler.handleTask(
      {
        taskId: "t",
        bapPubkey: "b",
        bppPubkey: "p",
        networkPubkey: "n",
        action: "text:summarize",
        input: { source: { kind: "text", text: "ok" } },
      },
      { logger: silentLogger, agent: { authority: "a", name: "n" }, now: () => 0 },
    );
    expect(called).toBe(1);
    expect(r.status).toBe("success");
  });
});

describe("SigningRuntimeChain", () => {
  it("signs completeTask payloads and forwards to inner chain exactly once", async () => {
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("seed-A"),
      now: () => 1700000001,
    });
    await chain.completeTask({ taskId: "t", output: { hello: "world" } });
    expect(inner.completed.length).toBe(1);
    expect(inner.failed.length).toBe(0);
    expect(chain.signedComplete.length).toBe(1);
    const rec = chain.signedComplete[0]!;
    expect(rec.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.signerPubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.payload).toEqual({
      taskId: "t",
      status: "success",
      output: { hello: "world" },
      producedAtSec: 1700000001,
    });
    // Inner output carries the envelope.
    const innerOut = inner.completed[0]!.output as Record<string, unknown>;
    expect(innerOut.signature).toBe(rec.signature);
    expect(innerOut.signerPubkey).toBe(rec.signerPubkey);
  });

  it("signs failTask payloads and forwards to inner chain exactly once", async () => {
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("seed-B"),
      now: () => 1700000002,
    });
    await chain.failTask({ taskId: "t", reason: "input_too_large" });
    expect(inner.completed.length).toBe(0);
    expect(inner.failed.length).toBe(1);
    expect(chain.signedFail.length).toBe(1);
    const rec = chain.signedFail[0]!;
    expect(rec.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.signerPubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makeStubSigner is deterministic for a given seed", async () => {
    const a = makeStubSigner("seed");
    const b = makeStubSigner("seed");
    const m = new TextEncoder().encode("hi");
    expect(await a(m)).toEqual(await b(m));
  });

  it("canonicalJson sorts keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: [3, 1] })).toBe(
      '{"a":[3,1],"b":{"x":2,"y":1}}',
    );
  });
});

/* ========================================================================== */
/* Step 5 — end-to-end runBpp                                                  */
/* ========================================================================== */

describe("end-to-end runBpp", () => {
  it("processes text + url successes and one oversized failure", async () => {
    const fetch = makeFetch({
      "https://x/article": makeFetchResponse({
        body: "<html><body><p>Hello world</p></body></html>",
        contentType: "text/html",
      }),
    });
    const handler = buildHandlerFromPrimitives({
      fetchDeps: { fetch, pdfExtractor: noopPdfExtractor },
      summarizeDeps: { llm: cannedLlm },
      modelId: "claude-test",
      now: () => 1700000100,
    });
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("e2e"),
      now: () => 1700000200,
    });
    const events = new InMemoryEventSource<unknown>();
    const gate = defaultCredentialGate([], {
      loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
      now: () => 1700000000,
    });
    const done = runBpp<unknown, SummarizeOutput>(config, handler, {
      eventSource: events,
      chain,
      gate,
      logger: silentLogger,
    });

    events.push(makeEvent("e-text", { source: { kind: "text", text: "ok body" } }));
    events.push(makeEvent("e-url", { source: { kind: "url", url: "https://x/article" } }));
    events.push(
      makeEvent("e-bad", {
        source: { kind: "text", text: "a".repeat(TEXT_MAX_BYTES + 1) },
      }),
    );
    events.close();
    await done;

    expect(inner.completed.length).toBe(2);
    expect(inner.failed.length).toBe(1);
    expect(inner.failed[0]!.taskId).toBe("e-bad");
    expect(inner.failed[0]!.reason).toMatch(/^input_invalid:/);
    expect(chain.signedComplete.length).toBe(2);
    expect(chain.signedFail.length).toBe(1);
    for (const rec of [...chain.signedComplete, ...chain.signedFail]) {
      expect(rec.signature.length).toBeGreaterThan(0);
      expect(rec.signerPubkey.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeEvent(taskId: string, input: SummarizeInput): BeckonInitEvent<unknown> {
  return {
    taskId,
    bapPubkey: "BapPubkey1111111111111111111111111111111111",
    bppPubkey: config.authority,
    networkPubkey: "NetworkPubkey22222222222222222222222222222",
    action: "text:summarize",
    input,
    observedAt: 1700000000,
  };
}
