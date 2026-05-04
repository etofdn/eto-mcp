/**
 * Unit tests for the `data:analyze` reference BPP (FN-079).
 *
 * Covers: types/config, fetcher (csv/csvBase64/url paths + size guards),
 * profiler (RFC 4180 parser, delimiter auto-detect, type inference,
 * stats, anomaly flags, sampling), analyzer (LLM seam + markdown
 * rendering), handler wiring, signing chain re-export, and an end-to-
 * end run through `runBpp`.
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
} from "../../keeper/bpps/data-analyze/config.js";
import {
  zAnalyzeInput,
  decodedBase64Bytes,
  TEXT_MAX_BYTES,
  CSV_BASE64_MAX_BYTES,
  MAX_MAX_ROWS,
  type AnalysisReport,
} from "../../keeper/bpps/data-analyze/types.js";
import {
  fetchCsv,
  type FetchLike,
} from "../../keeper/bpps/data-analyze/fetcher.js";
import {
  parseCsv,
  detectDelimiter,
  profileCsv,
} from "../../keeper/bpps/data-analyze/profiler.js";
import {
  analyze,
  sha256Hex,
  type LlmClient,
} from "../../keeper/bpps/data-analyze/analyzer.js";
import {
  buildHandlerFromPrimitives,
  createDataAnalyzeHandler,
} from "../../keeper/bpps/data-analyze/handler.js";
import {
  canonicalJson,
  makeStubSigner,
  SigningRuntimeChain,
} from "../../keeper/templates/bpp/index.js";
import type {
  AnalyzeInput,
  AnalyzeOutput,
} from "../../keeper/bpps/data-analyze/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cannedReport: AnalysisReport = {
  summary: "A small dataset.",
  findings: ["Column `a` is integer.", "Column `c` looks numeric."],
  anomalies: [],
  suggestedQuestions: ["What is the mean of `c`?"],
};

const cannedLlm: LlmClient = {
  async analyze(req) {
    return {
      ...cannedReport,
      summary: `Profiled ${req.profile.rowCount}×${req.profile.columnCount} on ${req.modelId}.`,
      ...(req.question !== undefined ? { answer: `Re: ${req.question}` } : {}),
    };
  },
};

function makeFetchResponse(opts: {
  status?: number;
  body: Buffer | string;
  contentType?: string;
  contentLength?: string | null;
}) {
  const buf =
    typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : opts.body;
  return {
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    headers: {
      get: (n: string) => {
        const k = n.toLowerCase();
        if (k === "content-type") return opts.contentType ?? "text/csv";
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

function makeFetch(
  map: Record<string, ReturnType<typeof makeFetchResponse>>,
): FetchLike {
  return async (url: string) => {
    const r = map[url];
    if (!r) throw new Error(`no fixture for ${url}`);
    return r;
  };
}

/** Deterministic LCG-based rng for sample tests. */
function makeRng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/* ========================================================================== */
/* Step 1 — types + config                                                    */
/* ========================================================================== */

describe("config + tags", () => {
  it("config passes the template's zBppConfig schema", () => {
    expect(() => zBppConfig.parse(config)).not.toThrow();
  });

  it("tags advertise data:analyze 1.0.0", () => {
    expect(tags.domain).toBe("data");
    expect(tags.action).toBe("analyze");
    expect(tags.version).toBe("1.0.0");
    expect(tags.price).toEqual({ amount: "0.25", currency: "ETO" });
    expect(tags.requiredCredentials).toEqual([]);
    expect(tags.description.length).toBeLessThanOrEqual(512);
  });

  it("buildConfig honours DATA_ANALYZE_AUTHORITY env", () => {
    const prev = process.env.DATA_ANALYZE_AUTHORITY;
    process.env.DATA_ANALYZE_AUTHORITY =
      "OverrideAuth111111111111111111111111111111";
    try {
      expect(buildConfig().authority).toBe(
        "OverrideAuth111111111111111111111111111111",
      );
    } finally {
      if (prev !== undefined) process.env.DATA_ANALYZE_AUTHORITY = prev;
      else delete process.env.DATA_ANALYZE_AUTHORITY;
    }
  });

  it("falls back to DEV_AUTHORITY_PUBKEY without env", () => {
    const prev = process.env.DATA_ANALYZE_AUTHORITY;
    delete process.env.DATA_ANALYZE_AUTHORITY;
    try {
      expect(buildConfig().authority).toBe(DEV_AUTHORITY_PUBKEY);
    } finally {
      if (prev !== undefined) process.env.DATA_ANALYZE_AUTHORITY = prev;
    }
  });
});

describe("zAnalyzeInput", () => {
  it("accepts a minimal csv source", () => {
    const r = zAnalyzeInput.safeParse({ source: { kind: "csv", text: "a\n1\n" } });
    expect(r.success).toBe(true);
  });

  it("rejects oversized inline csv text", () => {
    const big = "x".repeat(TEXT_MAX_BYTES + 1);
    const r = zAnalyzeInput.safeParse({ source: { kind: "csv", text: big } });
    expect(r.success).toBe(false);
  });

  it("rejects oversized csvBase64 (decoded)", () => {
    // Construct a base64 string whose decoded size exceeds the cap.
    const oversize = CSV_BASE64_MAX_BYTES + 1024;
    const fakeB64 = "A".repeat(Math.ceil((oversize * 4) / 3));
    const r = zAnalyzeInput.safeParse({
      source: { kind: "csvBase64", data: fakeB64 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects malformed url", () => {
    const r = zAnalyzeInput.safeParse({
      source: { kind: "url", url: "not-a-url" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown kind", () => {
    const r = zAnalyzeInput.safeParse({
      source: { kind: "json", text: "{}" } as unknown as AnalyzeInput["source"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects maxRows above hard cap", () => {
    const r = zAnalyzeInput.safeParse({
      source: { kind: "csv", text: "a\n1\n" },
      maxRows: MAX_MAX_ROWS + 1,
    });
    expect(r.success).toBe(false);
  });

  it("decodedBase64Bytes computes length without decoding", () => {
    expect(decodedBase64Bytes("aGVsbG8=")).toBe(5);
    expect(decodedBase64Bytes("")).toBe(0);
    expect(decodedBase64Bytes("aGk=")).toBe(2);
  });
});

/* ========================================================================== */
/* Step 2 — fetcher / parser                                                  */
/* ========================================================================== */

describe("fetchCsv", () => {
  const noFetch: FetchLike = async () => {
    throw new Error("should not be called");
  };

  it("passes inline csv through", async () => {
    const r = await fetchCsv(
      { kind: "csv", text: "a,b\n1,2\n" },
      { fetch: noFetch },
    );
    expect(r.text).toBe("a,b\n1,2\n");
    expect(r.sourceBytes).toBe(8);
  });

  it("decodes csvBase64", async () => {
    const data = Buffer.from("a,b\n1,2\n", "utf8").toString("base64");
    const r = await fetchCsv(
      { kind: "csvBase64", data },
      { fetch: noFetch },
    );
    expect(r.text).toBe("a,b\n1,2\n");
    expect(r.sourceBytes).toBe(8);
  });

  it("rejects invalid base64", async () => {
    await expect(
      fetchCsv(
        { kind: "csvBase64", data: "###not-base-64###" },
        { fetch: noFetch },
      ),
    ).rejects.toThrow(/input_too_large/);
  });

  it("rejects non-utf8 csvBase64 input", async () => {
    // Bytes 0xFF 0xFE are invalid utf-8.
    const data = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64");
    await expect(
      fetchCsv({ kind: "csvBase64", data }, { fetch: noFetch }),
    ).rejects.toThrow("encoding_unsupported");
  });

  it("fetches a url with text/csv content-type", async () => {
    const fetch = makeFetch({
      "https://x/y.csv": makeFetchResponse({
        body: "a,b\n1,2\n",
        contentType: "text/csv; charset=utf-8",
      }),
    });
    const r = await fetchCsv(
      { kind: "url", url: "https://x/y.csv" },
      { fetch },
    );
    expect(r.text).toBe("a,b\n1,2\n");
    expect(r.contentType).toBe("text/csv");
  });

  it("fetches a tsv via text/tab-separated-values", async () => {
    const fetch = makeFetch({
      "https://x/y.tsv": makeFetchResponse({
        body: "a\tb\n1\t2\n",
        contentType: "text/tab-separated-values",
      }),
    });
    const r = await fetchCsv(
      { kind: "url", url: "https://x/y.tsv" },
      { fetch },
    );
    expect(r.contentType).toBe("text/tab-separated-values");
  });

  it("rejects oversized url response (declared)", async () => {
    const fetch = makeFetch({
      "https://x/big.csv": makeFetchResponse({
        body: "a,b\n",
        contentLength: String(50 * 1024 * 1024),
      }),
    });
    await expect(
      fetchCsv({ kind: "url", url: "https://x/big.csv" }, { fetch }),
    ).rejects.toThrow("source_too_large");
  });

  it("rejects oversized url response (actual body > maxBytes)", async () => {
    const fetch = makeFetch({
      "https://x/big.csv": makeFetchResponse({
        body: "a".repeat(2048),
        contentLength: null,
      }),
    });
    await expect(
      fetchCsv(
        { kind: "url", url: "https://x/big.csv", maxBytes: 1024 },
        { fetch },
      ),
    ).rejects.toThrow("source_too_large");
  });

  it("converts non-2xx status to fetch_failed", async () => {
    const fetch = makeFetch({
      "https://x/oops.csv": makeFetchResponse({
        status: 503,
        body: "",
      }),
    });
    await expect(
      fetchCsv({ kind: "url", url: "https://x/oops.csv" }, { fetch }),
    ).rejects.toThrow("fetch_failed: 503");
  });

  it("rejects unsupported content types", async () => {
    const fetch = makeFetch({
      "https://x/file.bin": makeFetchResponse({
        body: "stuff",
        contentType: "application/binary-blob",
      }),
    });
    await expect(
      fetchCsv({ kind: "url", url: "https://x/file.bin" }, { fetch }),
    ).rejects.toThrow("unsupported_content_type");
  });

  it("rejects non-utf8 url body", async () => {
    const fetch = makeFetch({
      "https://x/bin.csv": makeFetchResponse({
        body: Buffer.from([0xff, 0xfe, 0xfd]),
        contentType: "text/csv",
      }),
    });
    await expect(
      fetchCsv({ kind: "url", url: "https://x/bin.csv" }, { fetch }),
    ).rejects.toThrow("encoding_unsupported");
  });
});

/* ========================================================================== */
/* Step 3 — profiler                                                          */
/* ========================================================================== */

describe("parseCsv (RFC 4180)", () => {
  it("parses standard CSV", () => {
    expect(parseCsv("a,b,c\n1,2,3\n4,5,6\n", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    expect(parseCsv(`a,b\n"x,y","z"\n`, ",")).toEqual([
      ["a", "b"],
      ["x,y", "z"],
    ]);
  });

  it("handles escaped quotes", () => {
    expect(parseCsv(`a\n"He said ""hi"""\n`, ",")).toEqual([
      ["a"],
      [`He said "hi"`],
    ]);
  });

  it("handles embedded newlines in quoted fields", () => {
    expect(parseCsv(`a,b\n"line1\nline2",c\n`, ",")).toEqual([
      ["a", "b"],
      ["line1\nline2", "c"],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses TSV with tab delimiter", () => {
    expect(parseCsv("a\tb\n1\t2\n", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("detectDelimiter", () => {
  it("picks tab when most-frequent", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
  });
  it("picks semicolon when most-frequent", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
  });
  it("falls back to comma", () => {
    expect(detectDelimiter("a,b\n1,2\n")).toBe(",");
  });
  it("ignores delimiters inside quoted fields", () => {
    // Many tabs inside quotes; outside there is one comma per row.
    const s = `"x\t\t\t",1\n"y\t\t\t",2\n`;
    expect(detectDelimiter(s)).toBe(",");
  });
});

describe("profileCsv", () => {
  it("infers types across mixed columns", () => {
    const text = [
      "flag,age,score,date,name",
      "true,30,95.5,2024-01-01,Alice",
      "false,42,80.0,2024-02-01,Bob",
      "true,29,88.2,2024-03-01,Carol",
    ].join("\n");
    const r = profileCsv(text, {
      delimiter: "auto",
      hasHeader: true,
      maxRows: 100,
    });
    expect(r.profile.rowCount).toBe(3);
    expect(r.profile.columnCount).toBe(5);
    const byName = Object.fromEntries(
      r.profile.columns.map((c) => [c.name, c]),
    );
    expect(byName.flag!.inferredType).toBe("boolean");
    expect(byName.age!.inferredType).toBe("integer");
    expect(byName.score!.inferredType).toBe("number");
    expect(byName.date!.inferredType).toBe("date");
    expect(byName.name!.inferredType).toBe("string");
  });

  it("computes numeric stats", () => {
    const text = "x\n1\n2\n3\n4\n5\n";
    const r = profileCsv(text, {
      delimiter: "auto",
      hasHeader: true,
      maxRows: 100,
    });
    const x = r.profile.columns[0]!;
    expect(x.min).toBe(1);
    expect(x.max).toBe(5);
    expect(x.mean).toBe(3);
    expect(x.stddev).toBeCloseTo(Math.sqrt(2.5), 6);
  });

  it("respects hasHeader: false", () => {
    const r = profileCsv("1,2\n3,4\n", {
      delimiter: ",",
      hasHeader: false,
      maxRows: 100,
    });
    expect(r.profile.rowCount).toBe(2);
    expect(r.profile.columns[0]!.name).toBe("col_1");
  });

  it("counts nulls (empty-string default)", () => {
    const text = "a,b\n1,\n,2\n3,4\n";
    const r = profileCsv(text, {
      delimiter: ",",
      hasHeader: true,
      maxRows: 100,
    });
    expect(r.profile.columns[0]!.nullCount).toBe(1);
    expect(r.profile.columns[1]!.nullCount).toBe(1);
  });

  it("flips truncated when maxRows is exceeded", () => {
    const rows = Array.from({ length: 50 }, (_, i) => `${i}`).join("\n");
    const r = profileCsv("x\n" + rows + "\n", {
      delimiter: ",",
      hasHeader: true,
      maxRows: 10,
    });
    expect(r.truncated).toBe(true);
    expect(r.profile.truncated).toBe(true);
    expect(r.profile.rowCount).toBe(10);
  });

  it("flags high null rate", () => {
    // 8/10 nulls in column b
    const lines = ["a,b"];
    for (let i = 0; i < 8; i++) lines.push(`${i},`);
    lines.push("8,1");
    lines.push("9,2");
    const r = profileCsv(lines.join("\n") + "\n", {
      delimiter: ",",
      hasHeader: true,
      maxRows: 100,
    });
    expect(r.columnFlags[1]!.highNullRate).toBe(true);
  });

  it("flags constant column", () => {
    const r = profileCsv("a\nx\nx\nx\n", {
      delimiter: ",",
      hasHeader: true,
      maxRows: 100,
    });
    expect(r.columnFlags[0]!.constant).toBe(true);
  });

  it("flags monotonic numeric column", () => {
    const r = profileCsv("a\n1\n2\n3\n4\n5\n", {
      delimiter: ",",
      hasHeader: true,
      maxRows: 100,
    });
    expect(r.columnFlags[0]!.monotonic).toBe(true);
  });

  it("samples deterministically with injected rng", () => {
    const rows = Array.from({ length: 50 }, (_, i) => `${i}`).join("\n");
    const r1 = profileCsv("x\n" + rows + "\n", {
      delimiter: ",",
      hasHeader: true,
      maxRows: 100,
    }, { rng: makeRng(42) });
    const r2 = profileCsv("x\n" + rows + "\n", {
      delimiter: ",",
      hasHeader: true,
      maxRows: 100,
    }, { rng: makeRng(42) });
    expect(r1.sample.random).toEqual(r2.sample.random);
    expect(r1.sample.head.length).toBeGreaterThan(0);
  });
});

/* ========================================================================== */
/* Step 4 — analyzer                                                          */
/* ========================================================================== */

describe("analyze", () => {
  const fakeProfile = {
    rowCount: 3,
    columnCount: 1,
    columns: [
      {
        name: "x",
        inferredType: "integer" as const,
        nonNullCount: 3,
        nullCount: 0,
        distinctCount: 3,
        min: 1,
        max: 3,
      },
    ],
    delimiter: "," as const,
    encoding: "utf-8" as const,
    truncated: false,
  };
  const fakeSample = {
    columns: ["x"],
    head: [["1"], ["2"], ["3"]],
    random: [],
  };

  it("forwards modelId and question to the LLM", async () => {
    let captured: { modelId?: string; question?: string } = {};
    const llm: LlmClient = {
      async analyze(req) {
        captured = { modelId: req.modelId, question: req.question };
        return cannedReport;
      },
    };
    await analyze(fakeProfile, fakeSample, {
      modelId: "claude-test",
      question: "Why?",
    }, { llm });
    expect(captured.modelId).toBe("claude-test");
    expect(captured.question).toBe("Why?");
  });

  it("renders markdown with all sections", async () => {
    const r = await analyze(fakeProfile, fakeSample, {
      modelId: "m",
      question: "q?",
    }, { llm: cannedLlm });
    expect(r.markdown).toContain("# Data Analysis Report");
    expect(r.markdown).toContain("## Summary");
    expect(r.markdown).toContain("## Findings");
    expect(r.markdown).toContain("## Anomalies");
    expect(r.markdown).toContain("## Suggested Questions");
    expect(r.markdown).toContain("## Answer");
  });

  it("rejects empty datasets", async () => {
    const empty = { ...fakeProfile, columns: [], columnCount: 0, rowCount: 0 };
    await expect(
      analyze(empty, fakeSample, { modelId: "m" }, { llm: cannedLlm }),
    ).rejects.toThrow("empty_dataset");
  });

  it("surfaces llm_invalid_response for malformed LLM output", async () => {
    const badLlm: LlmClient = {
      async analyze() {
        // Missing required fields.
        return { summary: "x" } as unknown as AnalysisReport;
      },
    };
    await expect(
      analyze(fakeProfile, fakeSample, { modelId: "m" }, { llm: badLlm }),
    ).rejects.toThrow("llm_invalid_response");
  });

  it("merges profiler-flagged anomalies into the report", async () => {
    const flags = [
      {
        highNullRate: false,
        allDistinct: false,
        monotonic: true,
        constant: false,
        outlierHeavy: false,
      },
    ];
    const r = await analyze(fakeProfile, fakeSample, {
      modelId: "m",
      columnFlags: flags,
    }, { llm: cannedLlm });
    expect(
      r.report.anomalies.some((a) => a.includes("monotonic")),
    ).toBe(true);
  });
});

/* ========================================================================== */
/* Step 4b — signing chain (re-export from text-summarize)                    */
/* ========================================================================== */

describe("SigningRuntimeChain", () => {
  it("signs completeTask payloads", async () => {
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("test-seed"),
      now: () => 1234,
    });
    await chain.completeTask({ taskId: "t1", output: { hi: 1 } });
    expect(chain.signedComplete).toHaveLength(1);
    const sc = chain.signedComplete[0]!;
    expect(sc.signature).toMatch(/^[0-9a-f]+$/);
    expect(sc.signerPubkey).toMatch(/^[0-9a-f]+$/);
    expect(sc.payload.producedAtSec).toBe(1234);
    expect(inner.completed).toHaveLength(1);
  });

  it("signs failTask payloads", async () => {
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("test-seed"),
      now: () => 1,
    });
    await chain.failTask({ taskId: "t2", reason: "boom" });
    expect(chain.signedFail).toHaveLength(1);
    expect(chain.signedFail[0]!.signature).toMatch(/^[0-9a-f]+$/);
    expect(inner.failed).toHaveLength(1);
  });

  it("canonicalJson sorts keys", () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });
});

/* ========================================================================== */
/* Step 5 — handler                                                           */
/* ========================================================================== */

describe("createDataAnalyzeHandler", () => {
  const goodFetched = {
    text: "a,b\n1,2\n3,4\n",
    sourceBytes: 12,
    contentType: "text/csv",
  };

  function makeHandler(overrides: Partial<{
    fetcher: (s: AnalyzeInput["source"]) => Promise<typeof goodFetched>;
    analyzer: typeof cannedLlm["analyze"];
  }> = {}) {
    return createDataAnalyzeHandler({
      fetcher: overrides.fetcher ?? (async () => goodFetched),
      profiler: (text, opts) => profileCsv(text, opts, { rng: makeRng(7) }),
      analyzer: async (profile, sample, opts) => {
        const report = overrides.analyzer
          ? await overrides.analyzer({
              profile,
              sample,
              modelId: opts.modelId,
              ...(opts.question !== undefined ? { question: opts.question } : {}),
            })
          : cannedReport;
        return {
          markdown: `# Data Analysis Report\n## Summary\n${report.summary}\n`,
          report,
        };
      },
      modelId: "test-model",
      now: () => 9999,
    });
  }

  it("returns success on valid input", async () => {
    const h = makeHandler();
    const res = await h.handleTask(
      {
        taskId: "t",
        bapPubkey: "BAP",
        bppPubkey: "BPP",
        networkPubkey: "NET",
        action: "data:analyze",
        input: { source: { kind: "csv", text: "a,b\n1,2\n" } },
      },
      { logger: silentLogger, agent: { authority: "BPP", name: "n" }, now: () => 0 },
    );
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.output.modelId).toBe("test-model");
      expect(res.output.artifact.producedAtSec).toBe(9999);
      expect(res.output.artifact.sha256).toBe(sha256Hex(res.output.artifact.content));
    }
  });

  it("returns failure on schema invalidation", async () => {
    const h = makeHandler();
    const res = await h.handleTask(
      {
        taskId: "t",
        bapPubkey: "BAP",
        bppPubkey: "BPP",
        networkPubkey: "NET",
        action: "data:analyze",
        input: { source: { kind: "json", text: "{}" } },
      },
      { logger: silentLogger, agent: { authority: "BPP", name: "n" }, now: () => 0 },
    );
    expect(res.status).toBe("failure");
    if (res.status === "failure") {
      expect(res.reason.startsWith("input_invalid")).toBe(true);
    }
  });

  it("returns failure on fetcher throw with stable code passthrough", async () => {
    const h = makeHandler({
      fetcher: async () => {
        throw new Error("source_too_large");
      },
    });
    const res = await h.handleTask(
      {
        taskId: "t",
        bapPubkey: "BAP",
        bppPubkey: "BPP",
        networkPubkey: "NET",
        action: "data:analyze",
        input: { source: { kind: "csv", text: "a\n1\n" } },
      },
      { logger: silentLogger, agent: { authority: "BPP", name: "n" }, now: () => 0 },
    );
    expect(res.status).toBe("failure");
    if (res.status === "failure") {
      expect(res.reason).toBe("source_too_large");
    }
  });

  it("returns failure on empty dataset", async () => {
    const h = makeHandler({
      fetcher: async () => ({
        text: "",
        sourceBytes: 0,
        contentType: "text/csv",
      }),
    });
    const res = await h.handleTask(
      {
        taskId: "t",
        bapPubkey: "BAP",
        bppPubkey: "BPP",
        networkPubkey: "NET",
        action: "data:analyze",
        input: { source: { kind: "csv", text: "a\n1\n" } },
      },
      { logger: silentLogger, agent: { authority: "BPP", name: "n" }, now: () => 0 },
    );
    expect(res.status).toBe("failure");
    if (res.status === "failure") {
      expect(res.reason).toBe("empty_dataset");
    }
  });
});

/* ========================================================================== */
/* Step 5b — end-to-end runBpp                                                */
/* ========================================================================== */

describe("runBpp end-to-end", () => {
  it("drives 2 success + 1 failure with signed envelopes", async () => {
    const fetch = makeFetch({
      "https://example.com/data.csv": makeFetchResponse({
        body: "x,y\n1,2\n3,4\n5,6\n",
        contentType: "text/csv",
      }),
    });

    const handler = buildHandlerFromPrimitives({
      fetchDeps: { fetch },
      analyzeDeps: { llm: cannedLlm },
      modelId: "test-model",
      now: () => 1700_000_000,
    });

    const events = new InMemoryEventSource<unknown>();
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("test"),
      now: () => 1700_000_000,
    });
    const gate = defaultCredentialGate([], {
      loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
      now: () => 0,
    });

    const done = runBpp<unknown, AnalyzeOutput>(config, handler, {
      eventSource: events,
      chain,
      gate,
      logger: silentLogger,
    });

    const mk = (
      taskId: string,
      input: AnalyzeInput,
    ): BeckonInitEvent<unknown> => ({
      taskId,
      bapPubkey: "BAP",
      bppPubkey: config.authority,
      networkPubkey: "NET",
      action: "data:analyze",
      input,
      observedAt: 0,
    });

    events.push(
      mk("ok-csv", {
        source: { kind: "csv", text: "a,b\n1,2\n3,4\n" },
      }),
    );
    events.push(
      mk("ok-url", {
        source: { kind: "url", url: "https://example.com/data.csv" },
      }),
    );
    events.push(
      mk("fail-too-large", {
        source: { kind: "csv", text: "a\n" + "x".repeat(TEXT_MAX_BYTES + 1) },
      }),
    );
    events.close();
    await done;

    expect(inner.completed).toHaveLength(2);
    expect(inner.failed).toHaveLength(1);
    expect(chain.signedComplete).toHaveLength(2);
    expect(chain.signedFail).toHaveLength(1);

    for (const sc of chain.signedComplete) {
      expect(sc.signature.length).toBeGreaterThan(0);
      expect(sc.signerPubkey.length).toBeGreaterThan(0);
    }
    for (const sf of chain.signedFail) {
      expect(sf.signature.length).toBeGreaterThan(0);
    }

    // The failure reason must be one of the stable codes (or wrapped).
    const failReason = inner.failed[0]!.reason;
    expect(
      /input_invalid|source_too_large|input_too_large|handler_internal_error/.test(
        failReason,
      ),
    ).toBe(true);

    // sha256 binding: completed payload's nested artifact sha matches its content.
    for (const c of inner.completed) {
      const out = (c.output as { result: AnalyzeOutput }).result;
      expect(out.artifact.sha256).toBe(sha256Hex(out.artifact.content));
    }
  });
});
