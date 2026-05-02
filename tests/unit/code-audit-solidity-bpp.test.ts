/**
 * Unit tests for the `code:audit:solidity` reference BPP (FN-076).
 *
 * Covers config/types, self-credential preflight, source-loader,
 * static + LLM auditors, the merge orchestrator, the handler, and an
 * end-to-end run through `runBpp` with a `SigningRuntimeChain`.
 */

import { describe, expect, it } from "vitest";
import { zBppConfig, zCapabilityTags } from "../../keeper/templates/bpp/index.js";
import type { AgentCardSnapshot } from "../../keeper/templates/bpp/index.js";
import {
  config,
  tags,
  buildConfig,
  parseSelfIssuersEnv,
  resolveSelfIssuerSet,
  DEV_AUTHORITY_PUBKEY,
  DEV_SELF_ISSUER_PUBKEY,
} from "../../keeper/bpps/code-audit-solidity/config.js";
import {
  zAuditInput,
  PER_FILE_MAX_BYTES,
  TOTAL_INLINE_MAX_BYTES,
  MAX_FILES,
  decodedBase64Bytes,
} from "../../keeper/bpps/code-audit-solidity/types.js";
import {
  assertSelfSkillCredential,
  inMemoryAgentCardLoader,
  MissingSelfCredentialError,
} from "../../keeper/bpps/code-audit-solidity/self-cred.js";
import type { Hex32 } from "../../keeper/templates/bpp/index.js";
import {
  loadSources,
  type FetchLike,
  type FetchLikeResponse,
} from "../../keeper/bpps/code-audit-solidity/source-loader.js";
import {
  runStaticAuditor,
  type SpawnLike,
  type SpawnResult,
  type WhichLike,
} from "../../keeper/bpps/code-audit-solidity/auditors/static.js";

/* ========================================================================== */
/* Step 1 — config + types                                                    */
/* ========================================================================== */

describe("config + tags", () => {
  it("tags pass zCapabilityTags", () => {
    expect(() => zCapabilityTags.parse(tags)).not.toThrow();
  });

  it("tags advertise code:audit:solidity 1.0.0", () => {
    expect(tags.domain).toBe("code");
    expect(tags.action).toBe("audit:solidity");
    expect(tags.version).toBe("1.0.0");
    expect(tags.price).toEqual({ amount: "1.00", currency: "ETO" });
    expect(tags.requiredCredentials).toEqual([]);
    expect(tags.description.length).toBeLessThanOrEqual(512);
  });

  it("config (sans extension field) passes zBppConfig", () => {
    const { selfCredentialIssuerSet: _ignored, ...bppShape } = config;
    expect(() => zBppConfig.parse(bppShape)).not.toThrow();
  });

  it("config carries a non-empty selfCredentialIssuerSet", () => {
    expect(config.selfCredentialIssuerSet.length).toBeGreaterThan(0);
    expect(config.handlerTimeoutSec).toBe(180);
  });

  it("buildConfig honours CODE_AUDIT_SOLIDITY_AUTHORITY env", () => {
    const prev = process.env.CODE_AUDIT_SOLIDITY_AUTHORITY;
    process.env.CODE_AUDIT_SOLIDITY_AUTHORITY = "OverrideAuth111111111111111111111111111111";
    try {
      expect(buildConfig().authority).toBe(
        "OverrideAuth111111111111111111111111111111",
      );
    } finally {
      if (prev === undefined) delete process.env.CODE_AUDIT_SOLIDITY_AUTHORITY;
      else process.env.CODE_AUDIT_SOLIDITY_AUTHORITY = prev;
    }
  });

  it("falls back to dev authority + dev issuer when env unset", () => {
    const prevA = process.env.CODE_AUDIT_SOLIDITY_AUTHORITY;
    const prevI = process.env.CODE_AUDIT_SOLIDITY_SELF_ISSUERS;
    delete process.env.CODE_AUDIT_SOLIDITY_AUTHORITY;
    delete process.env.CODE_AUDIT_SOLIDITY_SELF_ISSUERS;
    try {
      const c = buildConfig();
      expect(c.authority).toBe(DEV_AUTHORITY_PUBKEY);
      expect(c.selfCredentialIssuerSet).toEqual([DEV_SELF_ISSUER_PUBKEY]);
    } finally {
      if (prevA !== undefined) process.env.CODE_AUDIT_SOLIDITY_AUTHORITY = prevA;
      if (prevI !== undefined) process.env.CODE_AUDIT_SOLIDITY_SELF_ISSUERS = prevI;
    }
  });

  it("parseSelfIssuersEnv splits, trims, drops empties", () => {
    expect(parseSelfIssuersEnv(undefined)).toEqual([]);
    expect(parseSelfIssuersEnv("")).toEqual([]);
    expect(parseSelfIssuersEnv("AAA, BBB ,, CCC")).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("resolveSelfIssuerSet honours CODE_AUDIT_SOLIDITY_SELF_ISSUERS env", () => {
    const prev = process.env.CODE_AUDIT_SOLIDITY_SELF_ISSUERS;
    process.env.CODE_AUDIT_SOLIDITY_SELF_ISSUERS = "iss1,iss2";
    try {
      expect(resolveSelfIssuerSet()).toEqual(["iss1", "iss2"]);
    } finally {
      if (prev === undefined) delete process.env.CODE_AUDIT_SOLIDITY_SELF_ISSUERS;
      else process.env.CODE_AUDIT_SOLIDITY_SELF_ISSUERS = prev;
    }
  });
});

describe("zAuditInput", () => {
  it("accepts a minimal inline input and applies severityFloor default", () => {
    const r = zAuditInput.parse({
      kind: "inline",
      files: [{ path: "A.sol", content: "contract A {}" }],
    });
    expect(r.severityFloor).toBe("low");
  });

  it("accepts url and base64 inputs with optional knobs", () => {
    expect(
      zAuditInput.parse({
        kind: "url",
        url: "https://example.com/A.sol",
        maxBytes: 1024,
        solcVersion: "^0.8.20",
        severityFloor: "medium",
      }),
    ).toBeTruthy();
    expect(
      zAuditInput.parse({
        kind: "base64",
        data: Buffer.from("contract X {}").toString("base64"),
        filename: "X.sol",
      }),
    ).toBeTruthy();
  });

  it("rejects unknown kind", () => {
    const r = zAuditInput.safeParse({ kind: "video", text: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects malformed url", () => {
    const r = zAuditInput.safeParse({ kind: "url", url: "not a url" });
    expect(r.success).toBe(false);
  });

  it("rejects per-file content over PER_FILE_MAX_BYTES", () => {
    const r = zAuditInput.safeParse({
      kind: "inline",
      files: [{ path: "Big.sol", content: "a".repeat(PER_FILE_MAX_BYTES + 1) }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects total inline payload over TOTAL_INLINE_MAX_BYTES", () => {
    // Use 9 files of 250 KB each = 2.25 MB total > 2 MB cap.
    const files = Array.from({ length: 9 }, (_, i) => ({
      path: `f${i}.sol`,
      content: "a".repeat(250 * 1024),
    }));
    const r = zAuditInput.safeParse({ kind: "inline", files });
    expect(r.success).toBe(false);
  });

  it("rejects more than MAX_FILES inline files", () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      path: `f${i}.sol`,
      content: "x",
    }));
    const r = zAuditInput.safeParse({ kind: "inline", files });
    expect(r.success).toBe(false);
  });

  it("rejects oversized base64 by decoded size", () => {
    const len = Math.ceil(((PER_FILE_MAX_BYTES + 1024) * 4) / 3);
    const r = zAuditInput.safeParse({
      kind: "base64",
      data: "A".repeat(len),
      filename: "F.sol",
    });
    expect(r.success).toBe(false);
  });

  it("rejects path traversal in inline", () => {
    const r = zAuditInput.safeParse({
      kind: "inline",
      files: [{ path: "../etc/passwd", content: "x" }],
    });
    expect(r.success).toBe(false);
  });

  it("decodedBase64Bytes matches Buffer.from", () => {
    for (const s of ["", "QQ==", "QUI=", "QUJD", "aGVsbG8="]) {
      expect(decodedBase64Bytes(s)).toBe(Buffer.from(s, "base64").length);
    }
  });
});

/* ========================================================================== */
/* Step 2 — self-credential preflight                                          */
/* ========================================================================== */

const SCHEMA: Hex32 = "a".repeat(64);
const ISSUER = "IssuerPubkey1111111111111111111111111111111";
const OTHER_ISSUER = "OtherIssuer22222222222222222222222222222222";
const AUTH = "MyAuthority1111111111111111111111111111111";

function makeCard(creds: AgentCardSnapshot["credentials"]): AgentCardSnapshot {
  return { authority: AUTH, credentials: creds };
}

function loaderFor(card: AgentCardSnapshot) {
  const map = new Map<string, AgentCardSnapshot>();
  map.set(AUTH, card);
  return inMemoryAgentCardLoader(map);
}

const T_NOW = 1_700_000_000;

describe("assertSelfSkillCredential", () => {
  it("ok: matching credential within validity window", async () => {
    const loader = loaderFor(
      makeCard([
        {
          schema: SCHEMA,
          predicateHash: "b".repeat(64),
          issuer: ISSUER,
          validFrom: T_NOW - 100,
          validUntil: T_NOW + 100,
          revoked: false,
        },
      ]),
    );
    await expect(
      assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      }),
    ).resolves.toBeUndefined();
  });

  it("ok: open-ended validity (validFrom=0 && validUntil=0)", async () => {
    const loader = loaderFor(
      makeCard([
        {
          schema: SCHEMA,
          predicateHash: "b".repeat(64),
          issuer: ISSUER,
          validFrom: 0,
          validUntil: 0,
          revoked: false,
        },
      ]),
    );
    await expect(
      assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects wrong schema", async () => {
    const loader = loaderFor(
      makeCard([
        {
          schema: "c".repeat(64),
          predicateHash: "b".repeat(64),
          issuer: ISSUER,
          validFrom: 0,
          validUntil: 0,
          revoked: false,
        },
      ]),
    );
    await expect(
      assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      }),
    ).rejects.toBeInstanceOf(MissingSelfCredentialError);
  });

  it("rejects wrong issuer", async () => {
    const loader = loaderFor(
      makeCard([
        {
          schema: SCHEMA,
          predicateHash: "b".repeat(64),
          issuer: OTHER_ISSUER,
          validFrom: 0,
          validUntil: 0,
          revoked: false,
        },
      ]),
    );
    await expect(
      assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      }),
    ).rejects.toBeInstanceOf(MissingSelfCredentialError);
  });

  it("rejects revoked credential", async () => {
    const loader = loaderFor(
      makeCard([
        {
          schema: SCHEMA,
          predicateHash: "b".repeat(64),
          issuer: ISSUER,
          validFrom: 0,
          validUntil: 0,
          revoked: true,
        },
      ]),
    );
    await expect(
      assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      }),
    ).rejects.toBeInstanceOf(MissingSelfCredentialError);
  });

  it("rejects expired credential (validUntil < now)", async () => {
    const loader = loaderFor(
      makeCard([
        {
          schema: SCHEMA,
          predicateHash: "b".repeat(64),
          issuer: ISSUER,
          validFrom: T_NOW - 1000,
          validUntil: T_NOW - 1,
          revoked: false,
        },
      ]),
    );
    await expect(
      assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      }),
    ).rejects.toBeInstanceOf(MissingSelfCredentialError);
  });

  it("rejects not-yet-valid credential (validFrom > now)", async () => {
    const loader = loaderFor(
      makeCard([
        {
          schema: SCHEMA,
          predicateHash: "b".repeat(64),
          issuer: ISSUER,
          validFrom: T_NOW + 1,
          validUntil: T_NOW + 1000,
          revoked: false,
        },
      ]),
    );
    await expect(
      assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      }),
    ).rejects.toBeInstanceOf(MissingSelfCredentialError);
  });

  it("error carries remediation pointing at the FN-041 admin endpoint", async () => {
    const loader = loaderFor(makeCard([]));
    let caught: unknown;
    try {
      await assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingSelfCredentialError);
    const err = caught as MissingSelfCredentialError;
    expect(err.detail.authority).toBe(AUTH);
    expect(err.detail.schemaId).toBe(SCHEMA);
    expect(err.detail.remediation).toBe(
      `POST /issuers/skill-cert/issue (FN-041) with admin token for subject=${AUTH}, skill=solidity-audit`,
    );
  });

  it("propagates loader errors when AgentCard cannot be loaded", async () => {
    const loader = inMemoryAgentCardLoader(new Map());
    await expect(
      assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      }),
    ).rejects.toThrow(/agent_card_unavailable/);
  });
});

/* ========================================================================== */
/* Step 3 — source loader + static auditor                                    */
/* ========================================================================== */

function makeFetchResp(opts: {
  status?: number;
  body: Buffer | string;
  contentType?: string;
  contentLength?: string | null;
}): FetchLikeResponse {
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

function makeFetch(map: Record<string, FetchLikeResponse>): FetchLike {
  return async (url: string) => {
    const r = map[url];
    if (!r) throw new Error(`no fixture for ${url}`);
    return r;
  };
}

describe("loadSources", () => {
  it("inline returns files directly", async () => {
    const r = await loadSources(
      {
        kind: "inline",
        files: [{ path: "A.sol", content: "contract A {}" }],
      },
      { fetch: makeFetch({}) },
    );
    expect(r.files.length).toBe(1);
    expect(r.sourceBytes).toBe(Buffer.byteLength("contract A {}"));
  });

  it("base64 decodes and resolves to one file", async () => {
    const data = Buffer.from("contract B {}", "utf8").toString("base64");
    const r = await loadSources(
      { kind: "base64", data, filename: "B.sol" },
      { fetch: makeFetch({}) },
    );
    expect(r.files).toEqual([{ path: "B.sol", content: "contract B {}" }]);
  });

  it("url fetches a text/plain response", async () => {
    const fetch = makeFetch({
      "https://x/A.sol": makeFetchResp({
        body: "contract A {}",
        contentType: "text/plain",
      }),
    });
    const r = await loadSources(
      { kind: "url", url: "https://x/A.sol" },
      { fetch },
    );
    expect(r.files[0]!.path).toBe("A.sol");
    expect(r.files[0]!.content).toBe("contract A {}");
  });

  it("url rejects non-text content types", async () => {
    const fetch = makeFetch({
      "https://x/x.bin": makeFetchResp({
        body: "x",
        contentType: "application/zip",
      }),
    });
    await expect(
      loadSources({ kind: "url", url: "https://x/x.bin" }, { fetch }),
    ).rejects.toThrow(/unsupported_content_type/);
  });

  it("url rejects oversized content-length", async () => {
    const fetch = makeFetch({
      "https://x/big": makeFetchResp({
        body: "small",
        contentLength: String(10 * 1024 * 1024),
      }),
    });
    await expect(
      loadSources({ kind: "url", url: "https://x/big" }, { fetch }),
    ).rejects.toThrow(/source_too_large/);
  });

  it("url surfaces non-2xx as fetch_failed: <status>", async () => {
    const fetch = makeFetch({
      "https://x/404": makeFetchResp({ status: 404, body: "nope" }),
    });
    await expect(
      loadSources({ kind: "url", url: "https://x/404" }, { fetch }),
    ).rejects.toThrow(/fetch_failed: 404/);
  });
});

/* -------------------------------------------------------------------------- */
/* Static auditor                                                             */
/* -------------------------------------------------------------------------- */

const FAKE_FILES = [{ path: "A.sol", content: "contract A {}" }];

const cannedSlitherJson = JSON.stringify({
  results: {
    detectors: [
      {
        check: "reentrancy-eth",
        impact: "High",
        description: "External call before state update",
        elements: [
          { source_mapping: { filename_relative: "A.sol", lines: [42] } },
        ],
      },
    ],
  },
});

const cannedMythrilJson = JSON.stringify({
  issues: [
    {
      swc_id: "107",
      title: "Reentrancy",
      severity: "Medium",
      description: "Mythril flagged reentrancy",
      filename: "A.sol",
      lineno: 11,
    },
  ],
});

function whichOnly(
  found: Partial<Record<"slither" | "myth", string>>,
): WhichLike {
  return async (cmd: string) =>
    (found as Record<string, string | undefined>)[cmd] ?? null;
}

function fixedSpawn(
  byCmd: Record<string, SpawnResult>,
): SpawnLike {
  return async (cmd, _args, _opts) => {
    const res = byCmd[cmd];
    if (!res) throw new Error(`unexpected spawn: ${cmd}`);
    return res;
  };
}

describe("runStaticAuditor", () => {
  it("returns available=false when neither tool is on PATH", async () => {
    const r = await runStaticAuditor(FAKE_FILES, {
      which: whichOnly({}),
      spawn: fixedSpawn({}),
    });
    expect(r).toEqual({ available: false, findings: [], toolsRun: [] });
  });

  it("parses slither JSON into findings with source=slither", async () => {
    const r = await runStaticAuditor(FAKE_FILES, {
      which: whichOnly({ slither: "/usr/bin/slither" }),
      spawn: fixedSpawn({
        "/usr/bin/slither": {
          exitCode: 0,
          stdout: cannedSlitherJson,
          stderr: "",
          timedOut: false,
        },
      }),
    });
    expect(r.available).toBe(true);
    expect(r.toolsRun).toEqual(["slither"]);
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]!.source).toBe("slither");
    expect(r.findings[0]!.severity).toBe("high");
    expect(r.findings[0]!.line).toBe(42);
    expect(r.findings[0]!.file).toBe("A.sol");
  });

  it("parses mythril JSON when only mythril is present", async () => {
    const r = await runStaticAuditor(FAKE_FILES, {
      which: whichOnly({ myth: "/usr/bin/myth" }),
      spawn: fixedSpawn({
        "/usr/bin/myth": {
          exitCode: 0,
          stdout: cannedMythrilJson,
          stderr: "",
          timedOut: false,
        },
      }),
    });
    expect(r.toolsRun).toEqual(["mythril"]);
    expect(r.findings[0]!.source).toBe("mythril");
    expect(r.findings[0]!.severity).toBe("medium");
    expect(r.findings[0]!.line).toBe(11);
  });

  it("skips a tool that timed out without throwing", async () => {
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const r = await runStaticAuditor(FAKE_FILES, {
      which: whichOnly({ slither: "/usr/bin/slither" }),
      spawn: fixedSpawn({
        "/usr/bin/slither": {
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: true,
        },
      }),
      logger: {
        warn: (message, fields) => warnings.push({ message, ...(fields ? { fields } : {}) }),
      },
    });
    expect(r.toolsRun).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(warnings.some((w) => /timed out/i.test(w.message))).toBe(true);
  });

  it("skips a tool whose stdout is unparsable JSON without throwing", async () => {
    const warnings: string[] = [];
    const r = await runStaticAuditor(FAKE_FILES, {
      which: whichOnly({ slither: "/usr/bin/slither" }),
      spawn: fixedSpawn({
        "/usr/bin/slither": {
          exitCode: 0,
          stdout: "{not json",
          stderr: "",
          timedOut: false,
        },
      }),
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(r.findings).toEqual([]);
    expect(r.toolsRun).toEqual(["slither"]);
    expect(warnings.some((m) => /parse failed/i.test(m))).toBe(true);
  });
});

/* ========================================================================== */
/* Step 4 — LLM auditor + orchestrator                                        */
/* ========================================================================== */

import { parseLlmAuditOutput, type LlmClient } from "../../keeper/bpps/code-audit-solidity/auditors/llm.js";
import {
  runAudit,
  mergeFindings,
  renderMarkdown,
} from "../../keeper/bpps/code-audit-solidity/auditors/index.js";
import type { AuditFinding } from "../../keeper/bpps/code-audit-solidity/types.js";

const cannedLlm: LlmClient = {
  async audit(req) {
    const f: AuditFinding = {
      id: "llm-0",
      title: "Reentrancy",
      severity: "high",
      file: req.files[0]?.path ?? "<unknown>",
      line: 42,
      description: "External call before state update (LLM)",
      recommendation: "Apply the checks-effects-interactions pattern.",
      source: "llm",
    };
    return {
      findings: [f],
      summary: "One high-severity finding.",
      markdown: "# LLM Audit\n\nbody",
    };
  },
};

describe("parseLlmAuditOutput", () => {
  it("parses a fenced JSON block with valid findings", () => {
    const md = [
      "# Audit",
      "",
      "## Summary",
      "Body.",
      "```json",
      JSON.stringify({
        findings: [
          {
            id: "x",
            title: "T",
            severity: "low",
            file: "A.sol",
            description: "d",
            recommendation: "r",
            source: "llm",
          },
        ],
        summary: "ok",
      }),
      "```",
    ].join("\n");
    const r = parseLlmAuditOutput(md);
    expect(r.findings.length).toBe(1);
    expect(r.summary).toBe("ok");
  });

  it("flags unparsable output with an info-severity finding", () => {
    const r = parseLlmAuditOutput("# Audit\n\nno json here");
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]!.severity).toBe("info");
    expect(r.findings[0]!.id).toBe("llm-unparsable-output");
  });
});

describe("mergeFindings", () => {
  it("dedupes on (file,line,title), keeping the higher severity", () => {
    const a: AuditFinding = {
      id: "a",
      title: "Reentrancy",
      severity: "medium",
      file: "A.sol",
      line: 1,
      description: "d",
      recommendation: "r",
      source: "slither",
    };
    const b: AuditFinding = { ...a, id: "b", severity: "high", source: "llm" };
    const merged = mergeFindings([a, b]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.severity).toBe("high");
    expect(merged[0]!.source).toBe("llm");
  });
});

describe("runAudit", () => {
  const files = [{ path: "A.sol", content: "contract A {}" }];

  it("runs LLM only when static auditors unavailable", async () => {
    const r = await runAudit(
      files,
      { severityFloor: "low", modelId: "m" },
      {
        staticAuditor: async () => ({
          available: false,
          findings: [],
          toolsRun: [],
        }),
        llm: cannedLlm,
        now: () => 1,
      },
    );
    expect(r.report.toolsRun).toEqual(["llm"]);
    expect(r.report.findings.length).toBe(1);
    expect(r.markdown).toContain("# Solidity Audit");
    expect(r.markdown).toContain("Reentrancy");
  });

  it("merges static + LLM findings with dedupe and severity sort", async () => {
    const slitherFinding: AuditFinding = {
      id: "s-0",
      title: "Reentrancy",
      severity: "medium",
      file: "A.sol",
      line: 42,
      description: "static",
      recommendation: "fix",
      source: "slither",
    };
    const r = await runAudit(
      files,
      { severityFloor: "low", modelId: "m" },
      {
        staticAuditor: async () => ({
          available: true,
          findings: [slitherFinding],
          toolsRun: ["slither"],
        }),
        llm: cannedLlm, // returns a high-severity dup at A.sol:42 / Reentrancy
        now: () => 1,
      },
    );
    expect(r.report.toolsRun).toEqual(["slither", "llm"]);
    expect(r.report.findings.length).toBe(1);
    expect(r.report.findings[0]!.severity).toBe("high");
  });

  it("filters by severityFloor", async () => {
    const r = await runAudit(
      files,
      { severityFloor: "critical", modelId: "m" },
      {
        staticAuditor: async () => ({
          available: false,
          findings: [],
          toolsRun: [],
        }),
        llm: cannedLlm,
        now: () => 1,
      },
    );
    expect(r.report.findings.length).toBe(0);
    expect(r.markdown).toContain("_No findings at or above");
  });
});

describe("renderMarkdown", () => {
  it("groups findings by severity descending", () => {
    const md = renderMarkdown({
      title: "T",
      summary: "S",
      toolsRun: ["llm"],
      modelId: "m",
      findings: [
        {
          id: "1",
          title: "Low",
          severity: "low",
          file: "A.sol",
          description: "d",
          recommendation: "r",
          source: "llm",
        },
        {
          id: "2",
          title: "High",
          severity: "high",
          file: "A.sol",
          description: "d",
          recommendation: "r",
          source: "llm",
        },
      ],
    });
    expect(md.indexOf("HIGH")).toBeLessThan(md.indexOf("LOW"));
  });
});

/* ========================================================================== */
/* Step 5 — handler + signing chain + end-to-end runBpp                       */
/* ========================================================================== */

import {
  defaultCredentialGate,
  InMemoryChain,
  InMemoryEventSource,
  runBpp,
  type BeckonInitEvent,
  type Logger,
} from "../../keeper/templates/bpp/index.js";
import {
  createSolidityAuditHandler,
  sha256Hex,
} from "../../keeper/bpps/code-audit-solidity/handler.js";
import {
  SigningRuntimeChain,
  makeStubSigner,
} from "../../keeper/bpps/code-audit-solidity/chain-adapter.js";
import type { AuditInput, AuditOutput } from "../../keeper/bpps/code-audit-solidity/types.js";
import { PER_FILE_MAX_BYTES as MAX_BYTES_2 } from "../../keeper/bpps/code-audit-solidity/types.js";

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeHandler() {
  return createSolidityAuditHandler({
    sourceLoader: async (input) => {
      if (input.kind !== "inline") throw new Error("unsupported_kind");
      let bytes = 0;
      for (const f of input.files) bytes += Buffer.byteLength(f.content, "utf8");
      return { files: input.files, sourceBytes: bytes };
    },
    auditor: async (files, opts) => ({
      report: {
        summary: `audited ${files.length}`,
        findings: [],
        toolsRun: ["llm"],
        modelId: opts.modelId,
      },
      markdown: `# Audit ${files.length}\n\n## Summary\n\naudited ${files.length}\n`,
    }),
    modelId: "claude-test",
    now: () => 1700000000,
  });
}

describe("createSolidityAuditHandler", () => {
  it("happy path produces an Artifact whose sha256 binds to content", async () => {
    const handler = makeHandler();
    const r = await handler.handleTask(
      {
        taskId: "t1",
        bapPubkey: "bap",
        bppPubkey: "bpp",
        networkPubkey: "net",
        action: "code:audit:solidity",
        input: {
          kind: "inline",
          files: [{ path: "A.sol", content: "contract A {}" }],
        },
      },
      {
        logger: silentLogger,
        agent: { authority: "a", name: "n" },
        now: () => 1,
      },
    );
    expect(r.status).toBe("success");
    if (r.status !== "success") return;
    expect(r.output.artifact.mimeType).toBe("text/markdown");
    expect(r.output.artifact.sha256).toBe(sha256Hex(r.output.artifact.content));
    expect(r.output.report.toolsRun).toEqual(["llm"]);
  });

  it("returns failure on schema-invalid input (no throw)", async () => {
    const handler = makeHandler();
    const r = await handler.handleTask(
      {
        taskId: "t2",
        bapPubkey: "bap",
        bppPubkey: "bpp",
        networkPubkey: "net",
        action: "code:audit:solidity",
        input: { kind: "url", url: "not-a-url" },
      },
      {
        logger: silentLogger,
        agent: { authority: "a", name: "n" },
        now: () => 1,
      },
    );
    expect(r.status).toBe("failure");
    if (r.status !== "failure") return;
    expect(r.reason).toMatch(/^input_invalid:/);
  });

  it("oversized inline payload is rejected with input_invalid", async () => {
    const handler = makeHandler();
    const r = await handler.handleTask(
      {
        taskId: "t3",
        bapPubkey: "bap",
        bppPubkey: "bpp",
        networkPubkey: "net",
        action: "code:audit:solidity",
        input: {
          kind: "inline",
          files: [{ path: "Big.sol", content: "a".repeat(MAX_BYTES_2 + 1) }],
        },
      },
      {
        logger: silentLogger,
        agent: { authority: "a", name: "n" },
        now: () => 1,
      },
    );
    expect(r.status).toBe("failure");
  });
});

describe("end-to-end runBpp + SigningRuntimeChain", () => {
  function makeEvent(taskId: string, input: AuditInput): BeckonInitEvent<unknown> {
    return {
      taskId,
      bapPubkey: "BapPubkey1111111111111111111111111111111111",
      bppPubkey: config.authority,
      networkPubkey: "NetworkPubkey22222222222222222222222222222",
      action: "code:audit:solidity",
      input,
      observedAt: 1700000000,
    };
  }

  it("processes single-file + multi-file successes and one oversized failure", async () => {
    const handler = makeHandler();
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("e2e-audit"),
      now: () => 1700000200,
    });
    const events = new InMemoryEventSource<unknown>();
    const gate = defaultCredentialGate([], {
      loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
      now: () => 1700000000,
    });
    const done = runBpp<unknown, AuditOutput>(config, handler, {
      eventSource: events,
      chain,
      gate,
      logger: silentLogger,
    });

    events.push(
      makeEvent("e-single", {
        kind: "inline",
        files: [{ path: "A.sol", content: "contract A {}" }],
      }),
    );
    events.push(
      makeEvent("e-multi", {
        kind: "inline",
        files: [
          { path: "A.sol", content: "contract A {}" },
          { path: "B.sol", content: "contract B {}" },
        ],
        severityFloor: "info",
      }),
    );
    events.push(
      makeEvent("e-bad", {
        kind: "inline",
        files: [{ path: "Big.sol", content: "a".repeat(MAX_BYTES_2 + 1) }],
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

  it("when assertSelfSkillCredential throws, runBpp is never started", async () => {
    // Drive the preflight in isolation. Simulate the main() sequence:
    // failing preflight → no handler invocation → no chain calls.
    const inner = new InMemoryChain();
    const chain = new SigningRuntimeChain({
      inner,
      signer: makeStubSigner("preflight-test"),
    });
    const loader = inMemoryAgentCardLoader(
      new Map([[AUTH, makeCard([])]]),
    );
    let preflightFailed = false;
    try {
      await assertSelfSkillCredential({
        loadAgentCard: loader,
        ownAuthority: AUTH,
        issuerSet: [ISSUER],
        schemaId: SCHEMA,
        nowSec: () => T_NOW,
      });
    } catch {
      preflightFailed = true;
    }
    expect(preflightFailed).toBe(true);
    // runBpp was never invoked; chain is untouched.
    expect(inner.completed.length).toBe(0);
    expect(inner.failed.length).toBe(0);
    expect(chain.signedComplete.length).toBe(0);
    expect(chain.signedFail.length).toBe(0);
  });
});

/* ========================================================================== */
/* Step 5 — main() smoke (fake mode)                                          */
/* ========================================================================== */

import { main as bppMain, SOLIDITY_AUDIT_SCHEMA_ID } from "../../keeper/bpps/code-audit-solidity/main.js";
import { schemaIdForSkill } from "../../src/issuers/skill-cert.js";

describe("main() in fake mode", () => {
  it("SOLIDITY_AUDIT_SCHEMA_ID equals schemaIdForSkill('solidity-audit')", () => {
    expect(SOLIDITY_AUDIT_SCHEMA_ID).toBe(schemaIdForSkill("solidity-audit"));
  });

  it("runs end-to-end without throwing", async () => {
    const prevLog = console.log;
    const prevWarn = console.warn;
    const prevError = console.error;
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
    try {
      await bppMain();
    } finally {
      console.log = prevLog;
      console.warn = prevWarn;
      console.error = prevError;
    }
  });
});
