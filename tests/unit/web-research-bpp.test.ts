/**
 * Unit tests for the `web:research` reference BPP (FN-077).
 *
 * Covers types/config, search-provider seam, page fetcher, planner,
 * synthesiser, handler, signing chain wiring, and an end-to-end run
 * through `runBpp` driven by a fake `LlmClient` + `FakeSearchProvider`.
 */

import { describe, expect, it } from "vitest";
import { zBppConfig, projectCapabilityTags } from "../../keeper/templates/bpp/index.js";
import {
  config,
  tags,
  buildConfig,
  DEV_AUTHORITY_PUBKEY,
} from "../../keeper/bpps/web-research/config.js";
import {
  zResearchInput,
  zResearchOutput,
  MAX_SOURCES_HARD_CAP,
  QUERY_MAX_CHARS,
  DEPTH_PROFILES,
} from "../../keeper/bpps/web-research/types.js";
import {
  FakeSearchProvider,
  HttpSearchProvider,
  defaultFakeCorpus,
  domainMatches,
  filterAndCap,
  hostOf,
  type SearchHit,
} from "../../keeper/bpps/web-research/search-provider.js";
import {
  assertPublicHttpUrl,
  fetchPage,
  type FetchLike,
  type FetchLikeResponse,
} from "../../keeper/bpps/web-research/fetcher.js";

void zResearchOutput;

function makeFetchResponse(opts: {
  status?: number;
  body: Buffer | string;
  contentType?: string;
  contentLength?: string | null;
}): FetchLikeResponse {
  const buf =
    typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : opts.body;
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

function makeFetch(map: Record<string, FetchLikeResponse>): FetchLike {
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

  it("tags advertise web:research 1.0.0", () => {
    expect(tags.domain).toBe("web");
    expect(tags.action).toBe("research");
    expect(tags.version).toBe("1.0.0");
    expect(tags.price).toEqual({ amount: "0.50", currency: "ETO", cents: 50 });
    expect(tags.requiredCredentials).toEqual([]);
    expect(tags.description.length).toBeLessThanOrEqual(512);
  });

  it("projectCapabilityTags surfaces price.cents (ADR-0001)", () => {
    const entry = projectCapabilityTags(tags);
    expect(entry.domain).toBe(tags.domain);
    expect(entry.action).toBe(tags.action);
    expect(entry.price.cents).toBe(tags.price.cents);
    expect(entry.price.cents).toBe(50);
  });

  it("buildConfig honours WEB_RESEARCH_AUTHORITY env", () => {
    const prev = process.env.WEB_RESEARCH_AUTHORITY;
    process.env.WEB_RESEARCH_AUTHORITY = "OverrideAuth111111111111111111111111111111";
    try {
      expect(buildConfig().authority).toBe(
        "OverrideAuth111111111111111111111111111111",
      );
    } finally {
      if (prev === undefined) delete process.env.WEB_RESEARCH_AUTHORITY;
      else process.env.WEB_RESEARCH_AUTHORITY = prev;
    }
  });

  it("falls back to dev authority when env is unset", () => {
    const prev = process.env.WEB_RESEARCH_AUTHORITY;
    delete process.env.WEB_RESEARCH_AUTHORITY;
    try {
      expect(buildConfig().authority).toBe(DEV_AUTHORITY_PUBKEY);
    } finally {
      if (prev !== undefined) process.env.WEB_RESEARCH_AUTHORITY = prev;
    }
  });

  it("DEPTH_PROFILES covers shallow/standard/deep", () => {
    expect(DEPTH_PROFILES.shallow.subQueries).toBe(2);
    expect(DEPTH_PROFILES.standard.subQueries).toBe(3);
    expect(DEPTH_PROFILES.deep.subQueries).toBe(5);
  });
});

describe("zResearchInput", () => {
  it("accepts a minimal valid input", () => {
    expect(zResearchInput.parse({ query: "what is solana" })).toBeTruthy();
  });

  it("accepts shaped input with all knobs", () => {
    expect(
      zResearchInput.parse({
        query: "ed25519 vs secp256k1",
        depth: "deep",
        maxSources: 10,
        recencyDays: 365,
        allowedDomains: ["wikipedia.org", "https://example.com/path"],
        blockedDomains: ["evil.example"],
        targetLengthWords: 1200,
      }),
    ).toBeTruthy();
  });

  it("rejects empty/whitespace query", () => {
    expect(zResearchInput.safeParse({ query: "   " }).success).toBe(false);
    expect(zResearchInput.safeParse({ query: "" }).success).toBe(false);
  });

  it("rejects oversized query", () => {
    const big = "q".repeat(QUERY_MAX_CHARS + 1);
    expect(zResearchInput.safeParse({ query: big }).success).toBe(false);
  });

  it("rejects maxSources above the hard cap", () => {
    const r = zResearchInput.safeParse({
      query: "ok",
      maxSources: MAX_SOURCES_HARD_CAP + 1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown depth", () => {
    const r = zResearchInput.safeParse({ query: "ok", depth: "exhaustive" as never });
    expect(r.success).toBe(false);
  });

  it("rejects malformed domain entries", () => {
    const r = zResearchInput.safeParse({
      query: "ok",
      allowedDomains: ["bad space.com"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative recencyDays", () => {
    expect(
      zResearchInput.safeParse({ query: "ok", recencyDays: -1 }).success,
    ).toBe(false);
  });

  it("rejects targetLengthWords above max", () => {
    expect(
      zResearchInput.safeParse({ query: "ok", targetLengthWords: 99999 }).success,
    ).toBe(false);
  });
});


/* ========================================================================== */
/* Step 2 — search provider + fetcher                                         */
/* ========================================================================== */

describe("domainMatches / hostOf / filterAndCap", () => {
  it("hostOf parses url host", () => {
    expect(hostOf("https://news.example.com/path?x=1")).toBe("news.example.com");
    expect(hostOf("not a url")).toBe("");
  });

  it("domainMatches is suffix-aware", () => {
    expect(domainMatches("example.com", "https://news.example.com/x")).toBe(true);
    expect(domainMatches("example.com", "https://example.com/x")).toBe(true);
    expect(domainMatches("example.com", "https://notexample.com/x")).toBe(false);
    expect(domainMatches("https://example.com/", "https://news.example.com/x")).toBe(
      true,
    );
  });

  it("filterAndCap drops blocked, requires allowed, and respects maxResults", () => {
    const hits: SearchHit[] = [
      { url: "https://a.com/1", title: "a", snippet: "" },
      { url: "https://b.com/1", title: "b", snippet: "" },
      { url: "https://news.a.com/2", title: "a2", snippet: "" },
    ];
    const out = filterAndCap(hits, {
      maxResults: 5,
      allowedDomains: ["a.com"],
      blockedDomains: ["news.a.com"],
    });
    expect(out.map((h) => h.url)).toEqual(["https://a.com/1"]);
  });

  it("filterAndCap honours recencyDays when publishedAtSec is present", () => {
    const now = 1700000000;
    const hits: SearchHit[] = [
      { url: "https://a.com/old", title: "old", snippet: "", publishedAtSec: now - 90 * 86400 },
      { url: "https://a.com/new", title: "new", snippet: "", publishedAtSec: now - 5 * 86400 },
      { url: "https://a.com/undated", title: "u", snippet: "" },
    ];
    const out = filterAndCap(hits, { maxResults: 5, recencyDays: 30, now: () => now });
    expect(out.map((h) => h.url).sort()).toEqual([
      "https://a.com/new",
      "https://a.com/undated",
    ]);
  });
});

describe("FakeSearchProvider", () => {
  const sp = new FakeSearchProvider({ corpus: defaultFakeCorpus, now: () => 1700000000 });

  it("returns deterministic hits for known queries", async () => {
    const hits = await sp.search("what is solana", { maxResults: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.url.startsWith("http"))).toBe(true);
  });

  it("respects maxResults", async () => {
    const hits = await sp.search("solana", { maxResults: 1 });
    expect(hits.length).toBe(1);
  });

  it("filters by allowedDomains", async () => {
    const hits = await sp.search("solana", {
      maxResults: 5,
      allowedDomains: ["wiki.example.org"],
    });
    expect(hits.every((h) => h.url.includes("wiki.example.org"))).toBe(true);
  });

  it("filters by blockedDomains", async () => {
    const hits = await sp.search("solana", {
      maxResults: 5,
      blockedDomains: ["docs.example.com"],
    });
    expect(hits.every((h) => !h.url.includes("docs.example.com"))).toBe(true);
  });

  it("returns empty for unknown queries", async () => {
    const hits = await sp.search("nothing matches", { maxResults: 5 });
    expect(hits).toEqual([]);
  });
});

describe("HttpSearchProvider", () => {
  it("throws search_provider_not_configured until wired", async () => {
    const sp = new HttpSearchProvider({ fetch: (async () => {
      throw new Error("should not be called");
    }) as unknown as FetchLike });
    await expect(sp.search("anything", { maxResults: 1 })).rejects.toThrow(
      /search_provider_not_configured/,
    );
  });
});

describe("assertPublicHttpUrl (SSRF guard)", () => {
  it("accepts public http(s) urls", () => {
    expect(() => assertPublicHttpUrl("https://example.com/x")).not.toThrow();
    expect(() => assertPublicHttpUrl("http://example.com/x")).not.toThrow();
  });

  it("rejects file:// and other schemes", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow(/unsupported_scheme/);
    expect(() => assertPublicHttpUrl("ftp://example.com")).toThrow(/unsupported_scheme/);
  });

  it("rejects localhost / 127.0.0.1 / private ranges", () => {
    expect(() => assertPublicHttpUrl("http://localhost/x")).toThrow(/forbidden_host/);
    expect(() => assertPublicHttpUrl("http://127.0.0.1/x")).toThrow(/forbidden_host/);
    expect(() => assertPublicHttpUrl("http://10.0.0.5/x")).toThrow(/forbidden_host/);
    expect(() => assertPublicHttpUrl("http://192.168.1.1/x")).toThrow(/forbidden_host/);
    expect(() => assertPublicHttpUrl("http://172.20.5.5/x")).toThrow(/forbidden_host/);
    expect(() => assertPublicHttpUrl("http://169.254.1.1/x")).toThrow(/forbidden_host/);
  });

  it("rejects ipv6 link-local", () => {
    expect(() => assertPublicHttpUrl("http://[::1]/x")).toThrow(/forbidden_host/);
    expect(() => assertPublicHttpUrl("http://[fe80::1]/x")).toThrow(/forbidden_host/);
  });
});

describe("fetchPage", () => {
  it("strips html and returns plaintext", async () => {
    const fetch = makeFetch({
      "https://x/y": makeFetchResponse({
        body: "<html><body><p>Hello <b>world</b></p><script>bad()</script></body></html>",
        contentType: "text/html",
      }),
    });
    const r = await fetchPage("https://x/y", { fetch, now: () => 42 });
    expect(r.text).toContain("Hello");
    expect(r.text).toContain("world");
    expect(r.text).not.toContain("<");
    expect(r.text).not.toContain("bad()");
    expect(r.contentType).toBe("text/html");
    expect(r.fetchedAtSec).toBe(42);
    expect(r.fetchError).toBeUndefined();
  });

  it("returns text/plain pass-through", async () => {
    const fetch = makeFetch({
      "https://x/p": makeFetchResponse({ body: "plain body", contentType: "text/plain" }),
    });
    const r = await fetchPage("https://x/p", { fetch });
    expect(r.text).toBe("plain body");
  });

  it("rejects oversized response by content-length with source_too_large", async () => {
    const fetch = makeFetch({
      "https://x/big": makeFetchResponse({
        body: "x",
        contentLength: String(10 * 1024 * 1024),
      }),
    });
    await expect(fetchPage("https://x/big", { fetch })).rejects.toThrow(/source_too_large/);
  });

  it("rejects oversized response by actual byte count", async () => {
    const big = Buffer.alloc(2 * 1024, 0x61);
    const fetch = makeFetch({
      "https://x/big": makeFetchResponse({ body: big, contentLength: null }),
    });
    await expect(
      fetchPage("https://x/big", { fetch, maxBytes: 1024 }),
    ).rejects.toThrow(/source_too_large/);
  });

  it("surfaces non-2xx via fetchError, not throw", async () => {
    const fetch = makeFetch({
      "https://x/404": makeFetchResponse({ status: 404, body: "nope" }),
    });
    const r = await fetchPage("https://x/404", { fetch, now: () => 7 });
    expect(r.fetchError).toBe("fetch_failed:404");
    expect(r.text).toBe("");
    expect(r.fetchedAtSec).toBe(7);
  });

  it("surfaces unsupported content-type via fetchError, not throw", async () => {
    const fetch = makeFetch({
      "https://x/bin": makeFetchResponse({
        body: Buffer.from([0, 1, 2, 3]),
        contentType: "application/octet-stream",
      }),
    });
    const r = await fetchPage("https://x/bin", { fetch });
    expect(r.fetchError).toMatch(/unsupported_content_type/);
    expect(r.text).toBe("");
  });

  it("refuses file:// and private hosts before fetching", async () => {
    const fetch = makeFetch({});
    await expect(fetchPage("file:///etc/passwd", { fetch })).rejects.toThrow(
      /unsupported_scheme/,
    );
    await expect(fetchPage("http://127.0.0.1/x", { fetch })).rejects.toThrow(
      /forbidden_host/,
    );
  });
});

/* ========================================================================== */
/* Step 3 — planner + synthesizer                                              */
/* ========================================================================== */

import {
  planQueries,
  MAX_SUB_QUERIES,
  SUB_QUERY_MAX_CHARS,
  type LlmClient as PlannerLlmClient,
  type LlmCompleteRequest,
} from "../../keeper/bpps/web-research/planner.js";
import {
  synthesize,
  PER_EVIDENCE_CHAR_BUDGET,
  sha256Hex as synSha256,
  type EvidenceItem,
} from "../../keeper/bpps/web-research/synthesizer.js";

function fakePlannerLlm(reply: string | ((req: LlmCompleteRequest) => string)): PlannerLlmClient {
  return {
    async complete(req: LlmCompleteRequest) {
      const text = typeof reply === "function" ? reply(req) : reply;
      return { text };
    },
  };
}

describe("planQueries", () => {
  it("rejects empty/whitespace query with empty_query", async () => {
    await expect(
      planQueries("   ", { depth: "standard", modelId: "m" }, { llm: fakePlannerLlm("{}") }),
    ).rejects.toThrow(/empty_query/);
  });

  it("parses well-formed JSON and dedupes/caps sub-queries", async () => {
    const llm = fakePlannerLlm(
      JSON.stringify({
        subQueries: ["a b c", "  a b c  ", "different angle", "another"],
        rationale: "split by angle",
      }),
    );
    const r = await planQueries("topic", { depth: "standard", modelId: "m" }, { llm });
    expect(r.subQueries).toEqual(["a b c", "different angle", "another"]);
    expect(r.rationale).toBe("split by angle");
  });

  it("strips ```json fences", async () => {
    const llm = fakePlannerLlm("```json\n" + JSON.stringify({
      subQueries: ["q1", "q2", "q3"],
      rationale: "ok",
    }) + "\n```");
    const r = await planQueries("topic", { depth: "shallow", modelId: "m" }, { llm });
    expect(r.subQueries).toEqual(["q1", "q2", "q3"]);
  });

  it("falls back to [query] on malformed JSON", async () => {
    const llm = fakePlannerLlm("this is not json at all");
    const r = await planQueries("the topic", { depth: "standard", modelId: "m" }, { llm });
    expect(r.subQueries).toEqual(["the topic"]);
    expect(r.rationale).toMatch(/falling back/);
  });

  it("falls back to [query] on llm throw", async () => {
    const llm: PlannerLlmClient = {
      async complete() {
        throw new Error("boom");
      },
    };
    const r = await planQueries("the topic", { depth: "standard", modelId: "m" }, { llm });
    expect(r.subQueries).toEqual(["the topic"]);
  });

  it("caps sub-query length at SUB_QUERY_MAX_CHARS", async () => {
    const long = "x".repeat(SUB_QUERY_MAX_CHARS + 50);
    const llm = fakePlannerLlm(JSON.stringify({ subQueries: [long, "ok"], rationale: "" }));
    const r = await planQueries("t", { depth: "standard", modelId: "m" }, { llm });
    expect(r.subQueries[0]!.length).toBe(SUB_QUERY_MAX_CHARS);
  });

  it("caps total sub-queries at MAX_SUB_QUERIES", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `q${i}`);
    const llm = fakePlannerLlm(JSON.stringify({ subQueries: many, rationale: "" }));
    const r = await planQueries("t", { depth: "deep", modelId: "m" }, { llm });
    expect(r.subQueries.length).toBeLessThanOrEqual(MAX_SUB_QUERIES);
  });
});

describe("synthesize", () => {
  const sampleEvidence: EvidenceItem[] = [
    {
      url: "https://a.example/1",
      title: "Source A",
      publisher: "a.example",
      publishedAtSec: 1700000000,
      accessedAtSec: 1700100000,
      text: "Body A explaining the topic.",
    },
    {
      url: "https://b.example/2",
      title: "Source B",
      accessedAtSec: 1700100000,
      text: "Body B with another angle.",
    },
  ];

  it("rejects empty query", async () => {
    await expect(
      synthesize("  ", sampleEvidence, { modelId: "m" }, { llm: fakePlannerLlm("# r") }),
    ).rejects.toThrow(/empty_query/);
  });

  it("rejects empty evidence with no_sources_found", async () => {
    await expect(
      synthesize("q", [], { modelId: "m" }, { llm: fakePlannerLlm("# r") }),
    ).rejects.toThrow(/no_sources_found/);
  });

  it("returns markdown + aligned citations with stable snippetSha256", async () => {
    const llm = fakePlannerLlm("# Report\n\n## Executive Summary\nFoo. [1][2]\n\n## Findings\n1. Bar [1]\n\n## Citations\n[1] A — https://a.example/1\n[2] B — https://b.example/2");
    const r = await synthesize("query", sampleEvidence, { modelId: "m" }, { llm });
    expect(r.markdown).toContain("# Report");
    expect(r.citations).toHaveLength(2);
    expect(r.citations[0]!.url).toBe("https://a.example/1");
    expect(r.citations[0]!.publisher).toBe("a.example");
    expect(r.citations[0]!.snippetSha256).toBe(synSha256("Body A explaining the topic."));
    expect(r.citations[1]!.publisher).toBeUndefined();
  });

  it("truncates oversized evidence extracts to PER_EVIDENCE_CHAR_BUDGET", async () => {
    const big: EvidenceItem = {
      url: "https://big.example/1",
      title: "Big",
      accessedAtSec: 1,
      text: "x".repeat(PER_EVIDENCE_CHAR_BUDGET * 2),
    };
    let received = "";
    const llm: PlannerLlmClient = {
      async complete(req) {
        received = req.messages[0]!.content;
        return { text: "# r\n\n## Executive Summary\nok\n\n## Findings\n1. ok [1]\n\n## Citations\n[1] Big — https://big.example/1" };
      },
    };
    const r = await synthesize("q", [big], { modelId: "m" }, { llm });
    expect(received.length).toBeLessThan(PER_EVIDENCE_CHAR_BUDGET * 2);
    expect(r.citations[0]!.snippetSha256).toBe(
      synSha256("x".repeat(PER_EVIDENCE_CHAR_BUDGET)),
    );
  });

  it("wraps llm errors in synthesis_failed", async () => {
    const llm: PlannerLlmClient = {
      async complete() {
        throw new Error("boom");
      },
    };
    await expect(
      synthesize("q", sampleEvidence, { modelId: "m" }, { llm }),
    ).rejects.toThrow(/synthesis_failed/);
  });

  it("wraps empty llm response in synthesis_failed", async () => {
    const llm = fakePlannerLlm("   ");
    await expect(
      synthesize("q", sampleEvidence, { modelId: "m" }, { llm }),
    ).rejects.toThrow(/synthesis_failed/);
  });
});

/* ========================================================================== */
/* Step 4 — handler + signing chain                                            */
/* ========================================================================== */

import {
  createWebResearchHandler,
  sha256Hex as handlerSha256,
} from "../../keeper/bpps/web-research/handler.js";
import {
  SigningRuntimeChain,
  makeStubSigner,
  canonicalJson,
} from "../../keeper/templates/bpp/index.js";
import { InMemoryChain } from "../../keeper/templates/bpp/index.js";

const cannedReportLlm: PlannerLlmClient = {
  async complete(req: LlmCompleteRequest) {
    if (req.system.startsWith("You are a research planner")) {
      // Derive sub-queries from the user prompt so the fake survives
      // both the "solana" and the "matches-nothing" e2e cases.
      const userText = req.messages[0]?.content ?? "";
      const m = /Research query:\s*(.+)/.exec(userText);
      const q = (m?.[1] ?? "topic").trim();
      return {
        text: JSON.stringify({
          subQueries: [q, `${q} overview`, `${q} background`],
          rationale: "split by angle",
        }),
      };
    }
    // Synthesizer prompt.
    return {
      text: [
        "# Solana research",
        "",
        "## Executive Summary",
        "Solana is fast. [1][2]",
        "",
        "## Findings",
        "1. PoH gives Solana fast finality. [2]",
        "2. Sealevel parallelises tx exec. [1]",
        "",
        "## Citations",
        "[1] Solana Overview — https://docs.example.com/solana/overview",
        "[2] Solana consensus mechanism — https://wiki.example.org/Solana_consensus",
      ].join("\n"),
    };
  },
};

function fakeFetcher(map: Record<string, FetchedPageOrErr>) {
  return async (url: string) => {
    const v = map[url];
    if (v === undefined) throw new Error("not_in_map");
    if (v instanceof Error) throw v;
    return v;
  };
}
type FetchedPageOrErr = import("../../keeper/bpps/web-research/fetcher.js").FetchedPage | Error;

const handlerCtxNow = (): number => 1700000500;

const handlerCtx = {
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  agent: { authority: "a", name: "n" },
  now: handlerCtxNow,
};

describe("createWebResearchHandler", () => {
  it("happy path produces an Artifact whose sha256 binds to content", async () => {
    const sp = new FakeSearchProvider({
      corpus: defaultFakeCorpus,
      now: () => 1700000000,
    });
    const fetcher = fakeFetcher({
      "https://docs.example.com/solana/overview": {
        text: "Solana page body about Sealevel and parallel execution.",
        contentType: "text/plain",
        fetchedAtSec: 1700000400,
        sourceBytes: 100,
      },
      "https://wiki.example.org/Solana_consensus": {
        text: "Tower BFT explanation, layered atop Proof of History.",
        contentType: "text/plain",
        fetchedAtSec: 1700000400,
        sourceBytes: 100,
      },
      "https://blog.example.com/ed25519-vs-secp256k1": {
        text: "irrelevant",
        contentType: "text/plain",
        fetchedAtSec: 1700000400,
        sourceBytes: 9,
      },
    });

    const handler = createWebResearchHandler({
      search: sp,
      fetcher,
      llm: cannedReportLlm,
      modelId: "claude-test",
      now: () => 1700000600,
    });

    const r = await handler.handleTask(
      {
        taskId: "t1",
        bapPubkey: "bap",
        bppPubkey: "bpp",
        networkPubkey: "net",
        action: "web:research",
        input: { query: "what is solana", depth: "standard" },
      },
      handlerCtx,
    );
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    const out = r.output;
    expect(out.artifact.mimeType).toBe("text/markdown");
    expect(out.artifact.sha256).toBe(handlerSha256(out.artifact.content));
    expect(out.artifact.producedAtSec).toBe(1700000600);
    expect(out.modelId).toBe("claude-test");
    expect(out.query).toBe("what is solana");
    expect(out.subQueries.length).toBeGreaterThanOrEqual(3);
    expect(out.citations.length).toBeGreaterThanOrEqual(2);
    expect(out.sourceCount).toBe(out.citations.length);
    expect(zResearchOutput.parse(out)).toBeTruthy();
  });

  it("oversized query returns failure input_too_large", async () => {
    const sp = new FakeSearchProvider({ corpus: [] });
    const handler = createWebResearchHandler({
      search: sp,
      fetcher: async () => ({
        text: "",
        contentType: "text/plain",
        fetchedAtSec: 0,
        sourceBytes: 0,
      }),
      llm: cannedReportLlm,
      modelId: "m",
      now: handlerCtxNow,
    });
    const r = await handler.handleTask(
      {
        taskId: "t",
        bapPubkey: "b",
        bppPubkey: "p",
        networkPubkey: "n",
        action: "web:research",
        input: { query: "q".repeat(QUERY_MAX_CHARS + 1) },
      },
      handlerCtx,
    );
    expect(r.status).toBe("failure");
    if (r.status !== "failure") return;
    expect(r.reason).toBe("input_too_large");
  });

  it("empty query returns failure empty_query", async () => {
    const sp = new FakeSearchProvider({ corpus: [] });
    const handler = createWebResearchHandler({
      search: sp,
      fetcher: async () => ({
        text: "",
        contentType: "text/plain",
        fetchedAtSec: 0,
        sourceBytes: 0,
      }),
      llm: cannedReportLlm,
      modelId: "m",
    });
    const r = await handler.handleTask(
      {
        taskId: "t",
        bapPubkey: "b",
        bppPubkey: "p",
        networkPubkey: "n",
        action: "web:research",
        input: { query: "    " },
      },
      handlerCtx,
    );
    expect(r.status).toBe("failure");
    if (r.status !== "failure") return;
    expect(r.reason).toBe("empty_query");
  });

  it("zero-results path returns failure no_sources_found", async () => {
    const sp = new FakeSearchProvider({ corpus: [] }); // empty corpus
    const handler = createWebResearchHandler({
      search: sp,
      fetcher: async () => ({
        text: "",
        contentType: "text/plain",
        fetchedAtSec: 0,
        sourceBytes: 0,
      }),
      llm: cannedReportLlm,
      modelId: "m",
    });
    const r = await handler.handleTask(
      {
        taskId: "t",
        bapPubkey: "b",
        bppPubkey: "p",
        networkPubkey: "n",
        action: "web:research",
        input: { query: "anything goes" },
      },
      handlerCtx,
    );
    expect(r.status).toBe("failure");
    if (r.status !== "failure") return;
    expect(r.reason).toBe("no_sources_found");
  });

  it("propagates search_provider_not_configured from a real-mode provider", async () => {
    const failingSp: import("../../keeper/bpps/web-research/search-provider.js").SearchProvider = {
      async search() {
        throw new Error("search_provider_not_configured: name=tavily");
      },
    };
    const handler = createWebResearchHandler({
      search: failingSp,
      fetcher: async () => ({
        text: "",
        contentType: "text/plain",
        fetchedAtSec: 0,
        sourceBytes: 0,
      }),
      llm: cannedReportLlm,
      modelId: "m",
    });
    const r = await handler.handleTask(
      {
        taskId: "t",
        bapPubkey: "b",
        bppPubkey: "p",
        networkPubkey: "n",
        action: "web:research",
        input: { query: "hello" },
      },
      handlerCtx,
    );
    expect(r.status).toBe("failure");
    if (r.status !== "failure") return;
    expect(r.reason).toBe("search_provider_not_configured");
  });
});

describe("SigningRuntimeChain (re-exported from text-summarize)", () => {
  it("signs completeTask payloads and forwards to inner chain exactly once", async () => {
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("web-research-A"),
      now: () => 1700000700,
    });
    await chain.completeTask({ taskId: "t", output: { hello: "world" } });
    expect(inner.completed.length).toBe(1);
    expect(inner.failed.length).toBe(0);
    expect(chain.signedComplete.length).toBe(1);
    const rec = chain.signedComplete[0]!;
    expect(rec.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.signerPubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs failTask payloads and forwards to inner chain exactly once", async () => {
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("web-research-B"),
      now: () => 1700000800,
    });
    await chain.failTask({ taskId: "t", reason: "no_sources_found" });
    expect(inner.completed.length).toBe(0);
    expect(inner.failed.length).toBe(1);
    expect(chain.signedFail.length).toBe(1);
  });

  it("canonicalJson sorts keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

/* ========================================================================== */
/* Step 5 — end-to-end runBpp                                                  */
/* ========================================================================== */

import {
  defaultCredentialGate,
  InMemoryEventSource,
  runBpp,
  type BeckonInitEvent,
  type Logger as TplLogger,
} from "../../keeper/templates/bpp/index.js";
import type { ResearchInput, ResearchOutput } from "../../keeper/bpps/web-research/index.js";

const e2eSilentLogger: TplLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("end-to-end runBpp (web:research)", () => {
  it("processes one success and two failures (no_sources_found + input_too_large), all signed", async () => {
    const sp = new FakeSearchProvider({ corpus: defaultFakeCorpus, now: () => 1700000000 });
    const fetcher = async (url: string): Promise<import("../../keeper/bpps/web-research/index.js").FetchedPage> => ({
      text: `Fake content at ${url}.`,
      contentType: "text/plain",
      fetchedAtSec: 1700000400,
      sourceBytes: 32,
    });
    const handler = createWebResearchHandler({
      search: sp,
      fetcher,
      llm: cannedReportLlm,
      modelId: "claude-test",
      now: () => 1700000600,
    });

    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("e2e-web-research"),
      now: () => 1700000700,
    });
    const events = new InMemoryEventSource<unknown>();
    const gate = defaultCredentialGate([], {
      loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
      now: () => 1700000000,
    });
    const done = runBpp<unknown, ResearchOutput>(config, handler, {
      eventSource: events,
      chain,
      gate,
      logger: e2eSilentLogger,
    });

    events.push(makeEvent("e-solana", { query: "what is solana" }));
    events.push(makeEvent("e-empty", { query: "this query matches nothing in fake corpus xyz123" }));
    events.push(
      makeEvent("e-big", { query: "q".repeat(QUERY_MAX_CHARS + 1) }),
    );
    events.close();
    await done;

    expect(inner.completed.length).toBe(1);
    expect(inner.failed.length).toBe(2);
    const failures = inner.failed.map((f) => f.reason);
    expect(failures.some((r) => r.startsWith("no_sources_found"))).toBe(true);
    expect(failures.some((r) => r.startsWith("input_too_large"))).toBe(true);

    expect(chain.signedComplete.length).toBe(1);
    expect(chain.signedFail.length).toBe(2);
    for (const rec of [...chain.signedComplete, ...chain.signedFail]) {
      expect(rec.signature.length).toBeGreaterThan(0);
      expect(rec.signerPubkey.length).toBeGreaterThan(0);
    }

    // Successful payload carries citations and signed envelope.
    const completed = chain.signedComplete[0]!;
    expect(completed.payload.taskId).toBe("e-solana");
    expect(completed.payload.status).toBe("success");
    const out = completed.payload.output as ResearchOutput;
    expect(out.citations.length).toBeGreaterThanOrEqual(2);
    expect(out.sourceCount).toBe(out.citations.length);
  });
});

function makeEvent(taskId: string, input: ResearchInput): BeckonInitEvent<unknown> {
  return {
    taskId,
    bapPubkey: "BapPubkey1111111111111111111111111111111111",
    bppPubkey: config.authority,
    networkPubkey: "NetworkPubkey22222222222222222222222222222",
    action: "web:research",
    input,
    observedAt: 1700000000,
  };
}
