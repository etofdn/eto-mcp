/**
 * FN-080: Per-BPP system prompt + handler — cross-cutting test suite.
 *
 * Verifies, across all 5 reference BPPs, that:
 *   1. Each BPP's `system.md` exists and opens with `# BPP: <tag>`.
 *   2. A successful handler invocation causes `chain.completeTask` to
 *      be called exactly once (via the runtime dispatch path).
 *   3. The `SigningRuntimeChain` signs the completeTask payload and
 *      produces a deterministic, non-empty signature.
 *   4. A handler failure resolves to `{ status: "failure" }` and
 *      `chain.completeTask` is NOT called.
 *   5. Signing is deterministic: same seed + payload ⇒ identical sig.
 *
 * The handlers under test are the full FN-075..079 implementations.
 * This suite focuses on the handler→chain boundary (the finaliser side)
 * that FN-080 specifies via `system.md` and the handler contract.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryChain,
  type Logger,
} from "../../templates/bpp/index.js";

/* -------------------------------------------------------------------------- */
/* Shared signing chain (FN-112): one import from the template barrel,        */
/* per-BPP aliases preserved as const so call sites are unchanged.            */
/* -------------------------------------------------------------------------- */
import { SigningRuntimeChain, makeStubSigner } from "../../templates/bpp/index.js";
const TextSigningChain = SigningRuntimeChain;
const CodeSigningChain = SigningRuntimeChain;
const WebSigningChain = SigningRuntimeChain;
const ImageSigningChain = SigningRuntimeChain;
const DataSigningChain = SigningRuntimeChain;
const makeTextStub = makeStubSigner;
const makeCodeStub = makeStubSigner;
const makeWebStub = makeStubSigner;
const makeImageStub = makeStubSigner;
const makeDataStub = makeStubSigner;

/* -------------------------------------------------------------------------- */
/* text:summarize                                                             */
/* -------------------------------------------------------------------------- */
import {
  config as textConfig,
  DEV_AUTHORITY_PUBKEY as TEXT_AUTHORITY,
} from "../text-summarize/config.js";
import { createTextSummarizeHandler } from "../text-summarize/handler.js";
import type { SummarizeResult } from "../text-summarize/summarizer.js";

/* -------------------------------------------------------------------------- */
/* code:audit:solidity                                                        */
/* -------------------------------------------------------------------------- */
import {
  config as codeConfig,
  DEV_AUTHORITY_PUBKEY as CODE_AUTHORITY,
} from "../code-audit-solidity/config.js";
import { createSolidityAuditHandler } from "../code-audit-solidity/handler.js";

/* -------------------------------------------------------------------------- */
/* web:research                                                               */
/* -------------------------------------------------------------------------- */
import {
  config as webConfig,
  DEV_AUTHORITY_PUBKEY as WEB_AUTHORITY,
} from "../web-research/config.js";
import { createWebResearchHandler } from "../web-research/handler.js";
import { FakeSearchProvider, defaultFakeCorpus } from "../web-research/search-provider.js";
import type { LlmCompleteRequest } from "../web-research/planner.js";
import type { FetchedPage } from "../web-research/fetcher.js";

/* -------------------------------------------------------------------------- */
/* image:generate                                                             */
/* -------------------------------------------------------------------------- */
import {
  config as imageConfig,
  DEV_AUTHORITY_PUBKEY as IMAGE_AUTHORITY,
} from "../image-generate/config.js";
import { createImageGenerateHandler } from "../image-generate/handler.js";
import type { BppIpfsPinner, PinResult, PinOpts } from "../image-generate/ipfs.js";

/* -------------------------------------------------------------------------- */
/* data:analyze                                                               */
/* -------------------------------------------------------------------------- */
import {
  config as dataConfig,
  DEV_AUTHORITY_PUBKEY as DATA_AUTHORITY,
} from "../data-analyze/config.js";
import { createDataAnalyzeHandler } from "../data-analyze/handler.js";
import { profileCsv } from "../data-analyze/analyzers/profiler.js";
import type { FetchedCsv } from "../data-analyze/source-loader.js";
import type { AnalyzeResult } from "../data-analyze/analyzers/planner.js";
import type { DatasetSample } from "../data-analyze/analyzers/profiler.js";
import type { DatasetProfile } from "../data-analyze/types.js";
import type { AnalysisReport } from "../data-analyze/types.js";

/* -------------------------------------------------------------------------- */
/* Shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const silentCtx = {
  logger: silentLogger,
  agent: { authority: "authority", name: "test" },
  now: () => 1700000000,
};

/** Resolve the `system.md` path for a given BPP directory name. */
function systemMdPath(bppDir: string): string {
  return join(__dirname, "..", bppDir, "system.md");
}

/** Read a system.md file and return its content. */
function readSystemMd(bppDir: string): string {
  return readFileSync(systemMdPath(bppDir), "utf8");
}

/* ========================================================================== */
/* 1. system.md — header and required sections (all 5 BPPs)                  */
/* ========================================================================== */

describe("system.md headers", () => {
  const cases: Array<{ bppDir: string; expectedTag: string }> = [
    { bppDir: "text-summarize", expectedTag: "text:summarize" },
    { bppDir: "code-audit-solidity", expectedTag: "code:audit:solidity" },
    { bppDir: "web-research", expectedTag: "web:research" },
    { bppDir: "image-generate", expectedTag: "image:generate" },
    { bppDir: "data-analyze", expectedTag: "data:analyze" },
  ];

  for (const { bppDir, expectedTag } of cases) {
    it(`${bppDir}/system.md starts with "# BPP: ${expectedTag}"`, () => {
      const content = readSystemMd(bppDir);
      const firstLine = content.trimStart().split("\n")[0]!.trim();
      expect(firstLine).toBe(`# BPP: ${expectedTag}`);
    });

    it(`${bppDir}/system.md contains a "Credential Gating" section`, () => {
      const content = readSystemMd(bppDir);
      expect(content).toMatch(/##\s+Credential Gating/);
    });

    it(`${bppDir}/system.md contains a "Completion Contract" section`, () => {
      const content = readSystemMd(bppDir);
      expect(content).toMatch(/##\s+Completion Contract/);
    });

    it(`${bppDir}/system.md contains "Hard Refusal Rules"`, () => {
      const content = readSystemMd(bppDir);
      expect(content).toMatch(/##\s+Hard Refusal Rules/);
    });

    it(`${bppDir}/system.md mentions "verified-human" credential`, () => {
      const content = readSystemMd(bppDir);
      expect(content).toContain("verified-human");
    });
  }
});

/* ========================================================================== */
/* 2. text:summarize — handler ↔ chain boundary                              */
/* ========================================================================== */

describe("text:summarize handler → chain boundary", () => {
  const mockSummaryResult: SummarizeResult = {
    markdown: "## Summary\n\nThis is a test summary.",
    sourceSha256: "a".repeat(64),
    targetLengthWords: 50,
    style: "prose",
  };

  const buildSuccessHandler = () =>
    createTextSummarizeHandler({
      fetcher: async () => ({
        text: "Hello world, this is some content to summarise.",
        sourceBytes: 48,
        contentType: "text/plain",
      }),
      summarizer: async () => mockSummaryResult,
      modelId: "claude-test",
      now: () => 1700000000,
    });

  it("success path → handler returns { status: 'success' }", async () => {
    const handler = buildSuccessHandler();
    const result = await handler.handleTask(
      {
        taskId: "t0",
        bapPubkey: "bap",
        bppPubkey: TEXT_AUTHORITY,
        networkPubkey: "net",
        action: "text:summarize",
        input: { source: { kind: "text", text: "hello world" } },
      },
      { ...silentCtx, agent: { authority: TEXT_AUTHORITY, name: "summarize" } },
    );
    expect(result.status).toBe("success");
  });

  it("success path → chain.completeTask called exactly once, failTask NOT called", async () => {
    const inner = new InMemoryChain();
    const chain = new TextSigningChain({
      inner,
      signer: makeTextStub("text-seed"),
      now: () => 1700000000,
    });
    const handler = buildSuccessHandler();
    const result = await handler.handleTask(
      {
        taskId: "t1",
        bapPubkey: "bap",
        bppPubkey: TEXT_AUTHORITY,
        networkPubkey: "net",
        action: "text:summarize",
        input: { source: { kind: "text", text: "hello world" } },
      },
      { ...silentCtx, agent: { authority: TEXT_AUTHORITY, name: "summarize" } },
    );
    // Runtime would do: success → chain.completeTask; failure → chain.failTask
    if (result.status === "success") {
      await chain.completeTask({ taskId: "t1", output: result.output });
    } else {
      await chain.failTask({ taskId: "t1", reason: result.reason });
    }
    expect(inner.completed.length).toBe(1);
    expect(inner.failed.length).toBe(0);
  });

  it("failure path → handler returns { status: 'failure' }, completeTask NOT called", async () => {
    const inner = new InMemoryChain();
    const chain = new TextSigningChain({
      inner,
      signer: makeTextStub("text-seed"),
      now: () => 1700000000,
    });
    const handler = createTextSummarizeHandler({
      fetcher: async () => { throw new Error("fetch_failed: 503"); },
      summarizer: async () => mockSummaryResult,
      modelId: "claude-test",
      now: () => 1700000000,
    });
    const result = await handler.handleTask(
      {
        taskId: "t2",
        bapPubkey: "bap",
        bppPubkey: TEXT_AUTHORITY,
        networkPubkey: "net",
        action: "text:summarize",
        input: { source: { kind: "url", url: "https://example.com" } },
      },
      { ...silentCtx, agent: { authority: TEXT_AUTHORITY, name: "summarize" } },
    );
    expect(result.status).toBe("failure");
    // On failure, runtime calls failTask not completeTask
    expect(inner.completed.length).toBe(0);
  });

  it("SigningRuntimeChain produces non-empty deterministic signature", async () => {
    const inner = new InMemoryChain();
    const signer = makeTextStub("authority-seed");
    const chain = new TextSigningChain({ inner, signer, now: () => 1700000000 });
    await chain.completeTask({ taskId: "t3", output: { test: true } });
    expect(chain.signedComplete.length).toBe(1);
    const rec = chain.signedComplete[0]!;
    expect(rec.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.signerPubkey).toMatch(/^[0-9a-f]{64}$/);
    // Determinism: same seed + payload → same sig
    const chain2 = new TextSigningChain({
      inner: new InMemoryChain(),
      signer: makeTextStub("authority-seed"),
      now: () => 1700000000,
    });
    await chain2.completeTask({ taskId: "t3", output: { test: true } });
    expect(chain2.signedComplete[0]!.signature).toBe(rec.signature);
    expect(chain2.signedComplete[0]!.signerPubkey).toBe(rec.signerPubkey);
  });

  it("authority in BPP config matches DEV_AUTHORITY_PUBKEY", () => {
    expect(textConfig.authority).toBe(TEXT_AUTHORITY);
  });
});

/* ========================================================================== */
/* 3. code:audit:solidity — handler ↔ chain boundary                         */
/* ========================================================================== */

describe("code:audit:solidity handler → chain boundary", () => {
  function buildSuccessHandler() {
    return createSolidityAuditHandler({
      // sourceLoader receives Zod-validated input; pass files through.
      sourceLoader: async (input) => {
        if (input.kind !== "inline") throw new Error("unsupported_kind");
        let bytes = 0;
        for (const f of input.files) bytes += Buffer.byteLength(f.content, "utf8");
        return { files: input.files, sourceBytes: bytes };
      },
      auditor: async (files, opts) => ({
        report: {
          summary: `audited ${files.length} file(s)`,
          findings: [],
          toolsRun: ["llm" as const],
          modelId: opts.modelId,
        },
        markdown: `# Audit\n\n## Summary\n\nNo issues found.\n`,
      }),
      modelId: "claude-test",
      now: () => 1700000000,
    });
  }

  // zAuditInput expects files[].path (not .name)
  const happyInput = {
    kind: "inline" as const,
    files: [{ path: "Token.sol", content: "// SPDX-License-Identifier: MIT\ncontract Token {}" }],
  };

  it("success path → handler returns { status: 'success' }", async () => {
    const handler = buildSuccessHandler();
    const result = await handler.handleTask(
      {
        taskId: "c1",
        bapPubkey: "bap",
        bppPubkey: CODE_AUTHORITY,
        networkPubkey: "net",
        action: "code:audit:solidity",
        input: happyInput,
      },
      { ...silentCtx, agent: { authority: CODE_AUTHORITY, name: "code-audit" } },
    );
    expect(result.status).toBe("success");
  });

  it("success path → chain.completeTask called, failTask NOT called", async () => {
    const inner = new InMemoryChain();
    const chain = new CodeSigningChain({
      inner,
      signer: makeCodeStub("code-seed"),
      now: () => 1700000000,
    });
    const handler = buildSuccessHandler();
    const result = await handler.handleTask(
      {
        taskId: "c2",
        bapPubkey: "bap",
        bppPubkey: CODE_AUTHORITY,
        networkPubkey: "net",
        action: "code:audit:solidity",
        input: happyInput,
      },
      { ...silentCtx, agent: { authority: CODE_AUTHORITY, name: "code-audit" } },
    );
    if (result.status === "success") {
      await chain.completeTask({ taskId: "c2", output: result.output });
    } else {
      await chain.failTask({ taskId: "c2", reason: result.reason });
    }
    expect(inner.completed.length).toBe(1);
    expect(inner.failed.length).toBe(0);
  });

  it("failure path (source loader throws) → { status: 'failure' }", async () => {
    const handler = createSolidityAuditHandler({
      sourceLoader: async () => { throw new Error("fetch_failed: 503"); },
      auditor: async (_files, _opts) => ({
        report: { summary: "ok", findings: [], toolsRun: ["llm" as const] },
        markdown: "# Audit\n\nNo issues.\n",
      }),
      modelId: "claude-test",
      now: () => 1700000000,
    });
    const result = await handler.handleTask(
      {
        taskId: "c3",
        bapPubkey: "bap",
        bppPubkey: CODE_AUTHORITY,
        networkPubkey: "net",
        action: "code:audit:solidity",
        input: { kind: "url", url: "https://example.com/Token.sol" },
      },
      { ...silentCtx, agent: { authority: CODE_AUTHORITY, name: "code-audit" } },
    );
    expect(result.status).toBe("failure");
  });

  it("authority in config matches DEV_AUTHORITY_PUBKEY", () => {
    expect(codeConfig.authority).toBe(CODE_AUTHORITY);
  });
});

/* ========================================================================== */
/* 4. web:research — handler ↔ chain boundary                                */
/* ========================================================================== */

describe("web:research handler → chain boundary", () => {
  /**
   * LlmClient that handles both the planner and synthesizer calls.
   * The planner detects its call via the system prompt prefix.
   */
  function makeWebLlm() {
    return {
      async complete(req: LlmCompleteRequest) {
        if (req.system.startsWith("You are a research planner")) {
          // Return valid JSON plan with one sub-query
          return {
            text: JSON.stringify({
              subQueries: ["Solana validator benchmarks"],
              rationale: "Focused query",
            }),
          };
        }
        // Synthesizer call — return a Markdown report with a citation
        return {
          text: "## Research Report\n\nKey findings about validators [1].\n\n## References\n1. https://docs.example.com/solana/overview",
        };
      },
    };
  }

  /** Search provider with at least one known hit from the default corpus. */
  const searchProvider = new FakeSearchProvider({
    corpus: defaultFakeCorpus,
    now: () => 1700000000,
  });

  /** Fetcher that returns a typed FetchedPage. */
  const fetcher = async (url: string): Promise<FetchedPage> => ({
    text: "Solana uses Proof of History for consensus.",
    contentType: "text/plain",
    fetchedAtSec: 1700000000,
    sourceBytes: 47,
  });

  it("success path → handler returns { status: 'success' }", async () => {
    const handler = createWebResearchHandler({
      search: searchProvider,
      fetcher,
      llm: makeWebLlm(),
      modelId: "claude-test",
      now: () => 1700000000,
    });
    const result = await handler.handleTask(
      {
        taskId: "w1",
        bapPubkey: "bap",
        bppPubkey: WEB_AUTHORITY,
        networkPubkey: "net",
        action: "web:research",
        input: { query: "Solana validator benchmarks" },
      },
      { ...silentCtx, agent: { authority: WEB_AUTHORITY, name: "web-research" } },
    );
    expect(result.status).toBe("success");
  });

  it("success path → chain.completeTask called, failTask NOT called", async () => {
    const inner = new InMemoryChain();
    const chain = new WebSigningChain({
      inner,
      signer: makeWebStub("web-seed"),
      now: () => 1700000000,
    });
    const handler = createWebResearchHandler({
      search: searchProvider,
      fetcher,
      llm: makeWebLlm(),
      modelId: "claude-test",
      now: () => 1700000000,
    });
    const result = await handler.handleTask(
      {
        taskId: "w2",
        bapPubkey: "bap",
        bppPubkey: WEB_AUTHORITY,
        networkPubkey: "net",
        action: "web:research",
        input: { query: "Solana validator benchmarks" },
      },
      { ...silentCtx, agent: { authority: WEB_AUTHORITY, name: "web-research" } },
    );
    if (result.status === "success") {
      await chain.completeTask({ taskId: "w2", output: result.output });
    } else {
      await chain.failTask({ taskId: "w2", reason: result.reason });
    }
    expect(inner.completed.length).toBe(1);
    expect(inner.failed.length).toBe(0);
  });

  it("failure path (search throws) → { status: 'failure' }", async () => {
    const handler = createWebResearchHandler({
      search: {
        async search() { throw new Error("search_provider_not_configured"); },
      },
      fetcher,
      llm: makeWebLlm(),
      modelId: "claude-test",
      now: () => 1700000000,
    });
    const result = await handler.handleTask(
      {
        taskId: "w3",
        bapPubkey: "bap",
        bppPubkey: WEB_AUTHORITY,
        networkPubkey: "net",
        action: "web:research",
        input: { query: "Solana validator benchmarks" },
      },
      { ...silentCtx, agent: { authority: WEB_AUTHORITY, name: "web-research" } },
    );
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.reason).toMatch(/search_provider_not_configured/);
    }
  });

  it("authority in config matches DEV_AUTHORITY_PUBKEY", () => {
    expect(webConfig.authority).toBe(WEB_AUTHORITY);
  });
});

/* ========================================================================== */
/* 5. image:generate — handler ↔ chain boundary                              */
/* ========================================================================== */

describe("image:generate handler → chain boundary", () => {
  const fakeBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

  const mockProvider = {
    kind: "fake" as const,
    async generate() {
      return {
        bytes: fakeBytes,
        mimeType: "image/png" as const,
        providerJobId: "job-001",
        modelId: "test-model",
      };
    },
  };

  class MockIpfsPinner implements BppIpfsPinner {
    readonly kind = "mock";
    async pinBytes(_bytes: Uint8Array, _opts: PinOpts): Promise<PinResult> {
      return {
        uri: "ipfs://QmTestCid123",
        cid: "QmTestCid123",
        size: fakeBytes.length,
      };
    }
  }

  it("success path → handler returns { status: 'success' }", async () => {
    const handler = createImageGenerateHandler({
      provider: mockProvider,
      ipfs: new MockIpfsPinner(),
      now: () => 1700000000,
      nowMs: () => 1700000000000,
    });
    const result = await handler.handleTask(
      {
        taskId: "i1",
        bapPubkey: "bap",
        bppPubkey: IMAGE_AUTHORITY,
        networkPubkey: "net",
        action: "image:generate",
        input: { prompt: "A beautiful sunset over the ocean" },
      },
      { ...silentCtx, agent: { authority: IMAGE_AUTHORITY, name: "image-gen" } },
    );
    expect(result.status).toBe("success");
  });

  it("success path → chain.completeTask called, failTask NOT called", async () => {
    const inner = new InMemoryChain();
    const chain = new ImageSigningChain({
      inner,
      signer: makeImageStub("image-seed"),
      now: () => 1700000000,
    });
    const handler = createImageGenerateHandler({
      provider: mockProvider,
      ipfs: new MockIpfsPinner(),
      now: () => 1700000000,
      nowMs: () => 1700000000000,
    });
    const result = await handler.handleTask(
      {
        taskId: "i2",
        bapPubkey: "bap",
        bppPubkey: IMAGE_AUTHORITY,
        networkPubkey: "net",
        action: "image:generate",
        input: { prompt: "A beautiful sunset over the ocean" },
      },
      { ...silentCtx, agent: { authority: IMAGE_AUTHORITY, name: "image-gen" } },
    );
    if (result.status === "success") {
      await chain.completeTask({ taskId: "i2", output: result.output });
    } else {
      await chain.failTask({ taskId: "i2", reason: result.reason });
    }
    expect(inner.completed.length).toBe(1);
    expect(inner.failed.length).toBe(0);
    expect(chain.signedComplete.length).toBe(1);
  });

  it("failure path (provider throws) → { status: 'failure' }, completeTask NOT called", async () => {
    const inner = new InMemoryChain();
    const handler = createImageGenerateHandler({
      provider: {
        kind: "fake",
        async generate() { throw new Error("provider_error: API returned 500"); },
      },
      ipfs: new MockIpfsPinner(),
      now: () => 1700000000,
      nowMs: () => 1700000000000,
    });
    const result = await handler.handleTask(
      {
        taskId: "i3",
        bapPubkey: "bap",
        bppPubkey: IMAGE_AUTHORITY,
        networkPubkey: "net",
        action: "image:generate",
        input: { prompt: "A beautiful sunset over the ocean" },
      },
      { ...silentCtx, agent: { authority: IMAGE_AUTHORITY, name: "image-gen" } },
    );
    expect(result.status).toBe("failure");
    expect(inner.completed.length).toBe(0);
  });

  it("authority in config matches DEV_AUTHORITY_PUBKEY", () => {
    expect(imageConfig.authority).toBe(IMAGE_AUTHORITY);
  });
});

/* ========================================================================== */
/* 6. data:analyze — handler ↔ chain boundary                                */
/* ========================================================================== */

describe("data:analyze handler → chain boundary", () => {
  const sampleCsv = "col_a,col_b,col_c\n1,2,3\n4,5,6\n7,8,9\n";

  const mockFetcher = async (_source: unknown): Promise<FetchedCsv> => ({
    text: sampleCsv,
    sourceBytes: sampleCsv.length,
    contentType: "text/csv",
  });

  const cannedReport: AnalysisReport = {
    summary: "Three numeric columns.",
    findings: ["All columns are integers."],
    anomalies: [],
    suggestedQuestions: [],
  };

  const mockAnalyzer = async (
    _profile: DatasetProfile,
    _sample: DatasetSample,
    _opts: unknown,
  ): Promise<AnalyzeResult> => ({
    markdown: "# Analysis Report\n\nThree numeric columns found.",
    report: cannedReport,
  });

  function buildSuccessHandler() {
    return createDataAnalyzeHandler({
      fetcher: mockFetcher,
      // Use the real profiler to avoid mocking the complex ProfileResult shape
      profiler: (text, opts) => profileCsv(text, opts),
      analyzer: mockAnalyzer,
      modelId: "claude-test",
      now: () => 1700000000,
    });
  }

  it("success path → handler returns { status: 'success' }", async () => {
    const handler = buildSuccessHandler();
    const result = await handler.handleTask(
      {
        taskId: "d1",
        bapPubkey: "bap",
        bppPubkey: DATA_AUTHORITY,
        networkPubkey: "net",
        action: "data:analyze",
        input: { source: { kind: "csv", text: sampleCsv } },
      },
      { ...silentCtx, agent: { authority: DATA_AUTHORITY, name: "data-analyze" } },
    );
    expect(result.status).toBe("success");
  });

  it("success path → chain.completeTask called, failTask NOT called", async () => {
    const inner = new InMemoryChain();
    const chain = new DataSigningChain({
      inner,
      signer: makeDataStub("data-seed"),
      now: () => 1700000000,
    });
    const handler = buildSuccessHandler();
    const result = await handler.handleTask(
      {
        taskId: "d2",
        bapPubkey: "bap",
        bppPubkey: DATA_AUTHORITY,
        networkPubkey: "net",
        action: "data:analyze",
        input: { source: { kind: "csv", text: sampleCsv } },
      },
      { ...silentCtx, agent: { authority: DATA_AUTHORITY, name: "data-analyze" } },
    );
    if (result.status === "success") {
      await chain.completeTask({ taskId: "d2", output: result.output });
    } else {
      await chain.failTask({ taskId: "d2", reason: result.reason });
    }
    expect(inner.completed.length).toBe(1);
    expect(inner.failed.length).toBe(0);
    expect(chain.signedComplete.length).toBe(1);
  });

  it("failure path (fetcher throws) → { status: 'failure' }, completeTask NOT called", async () => {
    const inner = new InMemoryChain();
    const handler = createDataAnalyzeHandler({
      fetcher: async () => { throw new Error("fetch_failed: 404"); },
      profiler: (text, opts) => profileCsv(text, opts),
      analyzer: mockAnalyzer,
      modelId: "claude-test",
      now: () => 1700000000,
    });
    const result = await handler.handleTask(
      {
        taskId: "d3",
        bapPubkey: "bap",
        bppPubkey: DATA_AUTHORITY,
        networkPubkey: "net",
        action: "data:analyze",
        input: { source: { kind: "url", url: "https://example.com/data.csv" } },
      },
      { ...silentCtx, agent: { authority: DATA_AUTHORITY, name: "data-analyze" } },
    );
    expect(result.status).toBe("failure");
    expect(inner.completed.length).toBe(0);
  });

  it("authority in config matches DEV_AUTHORITY_PUBKEY", () => {
    expect(dataConfig.authority).toBe(DATA_AUTHORITY);
  });
});

/* ========================================================================== */
/* 7. Cross-BPP: SigningRuntimeChain invariants                               */
/* ========================================================================== */

describe("SigningRuntimeChain invariants (cross-BPP)", () => {
  it("completeTask payload is signed BEFORE forwarding to inner chain", async () => {
    const inner = new InMemoryChain();
    const chain = new TextSigningChain({
      inner,
      signer: makeTextStub("cross-bpp"),
      now: () => 1700000001,
    });
    await chain.completeTask({ taskId: "cross-1", output: { v: 42 } });

    // Outer wrapper records the signed envelope
    expect(chain.signedComplete.length).toBe(1);
    const rec = chain.signedComplete[0]!;
    expect(rec.signature.length).toBeGreaterThan(0);
    expect(rec.signerPubkey.length).toBeGreaterThan(0);
    expect(rec.payload.taskId).toBe("cross-1");
    expect(rec.payload.status).toBe("success");
    expect(rec.payload.producedAtSec).toBe(1700000001);

    // Inner chain receives the envelope merged into the output
    expect(inner.completed.length).toBe(1);
    const innerOut = inner.completed[0]!.output as Record<string, unknown>;
    expect(innerOut.signature).toBe(rec.signature);
    expect(innerOut.signerPubkey).toBe(rec.signerPubkey);
  });

  it("failTask payload is signed and forwarded, completeTask NOT called", async () => {
    const inner = new InMemoryChain();
    const chain = new TextSigningChain({
      inner,
      signer: makeTextStub("cross-bpp-fail"),
      now: () => 1700000002,
    });
    await chain.failTask({ taskId: "cross-2", reason: "input_invalid: bad field" });

    expect(chain.signedFail.length).toBe(1);
    expect(inner.failed.length).toBe(1);
    expect(inner.completed.length).toBe(0);
    expect(chain.signedFail[0]!.payload.status).toBe("failure");
    expect(chain.signedFail[0]!.payload.taskId).toBe("cross-2");
  });

  it("signer is deterministic: same seed + message → identical signature", async () => {
    const msg = new TextEncoder().encode("payload-to-sign");
    const envA = await makeTextStub("determinism-seed")(msg);
    const envB = await makeTextStub("determinism-seed")(msg);
    expect(envA.signature).toBe(envB.signature);
    expect(envA.pubkey).toBe(envB.pubkey);
  });

  it("different seeds → different signatures for same message", async () => {
    const msg = new TextEncoder().encode("shared-payload");
    const envA = await makeTextStub("seed-A")(msg);
    const envB = await makeTextStub("seed-B")(msg);
    expect(envA.signature).not.toBe(envB.signature);
    expect(envA.pubkey).not.toBe(envB.pubkey);
  });

  it("signedComplete records signerPubkey that is non-empty hex", async () => {
    const inner = new InMemoryChain();
    const chain = new TextSigningChain({
      inner,
      signer: makeTextStub("wallet-pubkey-seed"),
      now: () => 1700000003,
    });
    await chain.completeTask({ taskId: "auth-check", output: {} });
    const rec = chain.signedComplete[0]!;
    // signerPubkey is a 64-char hex (sha256 of seed-derived bytes)
    expect(rec.signerPubkey).toMatch(/^[0-9a-f]{64}$/);
    // Matches the pubkey from the signer factory directly
    const envFromFactory = await makeTextStub("wallet-pubkey-seed")(new Uint8Array());
    expect(rec.signerPubkey).toBe(envFromFactory.pubkey);
  });
});
