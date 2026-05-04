import { describe, test, expect, vi } from "vitest";
import bs58 from "bs58";

// src/config.ts has pre-existing duplicate top-level exports that esbuild
// refuses to parse; mock it so we can import the agent tools module just for
// its `parseAgentState` export. (Same pattern used in a2a-tools.test.ts.)
vi.mock("../../src/config.js", () => ({
  PROGRAM_IDS: {
    mcp: new Uint8Array(32),
    agent: new Uint8Array(32),
    swarm: new Uint8Array(32),
    a2a: new Uint8Array(32),
    zkBn254: new Uint8Array(32),
    zkVerify: new Uint8Array(32),
  },
  ISSUER_URL: "http://localhost:0",
  config: {},
}));

const { parseAgentState } = await import("../../src/tools/agent.js");

// -----------------------------------------------------------------------------
// Synthetic AgentState buffer builder. Mirrors the on-chain Borsh layout so
// these tests don't depend on the Rust toolchain. See the wire-format comment
// at the top of src/tools/agent.ts for the canonical layout.
// -----------------------------------------------------------------------------

interface HumanAuthorityFixture {
  authStrategy: string;
  sub: string;
  boundAtSlot: bigint;
}

interface AgentStateFixture {
  authority?: Buffer;       // 32 bytes; defaults to deterministic filler
  name?: string;
  modelId?: string;
  metadataUri?: string;
  reputation?: bigint;
  statusByte?: number;
  // Trailer control:
  //   "omit"       → no trailer bytes (legacy v0 on the wire)
  //   number       → emit that exact byte as schema_version, then maybe a body
  schemaVersion?: 0 | 1 | number | "omit";
  // Used when schemaVersion === 1: emit Option<HumanAuthority>.
  //   undefined / null → option tag 0x00, no body
  //   object           → option tag 0x01 + HumanAuthority body
  humanAuthority?: HumanAuthorityFixture | null;
  // Test-only override: when schemaVersion === 1 and `truncatedBinding` is set,
  // append `truncatedBinding` raw bytes after the 0x01 option tag instead of a
  // proper HumanAuthority body. Used for the truncated-trailer case.
  truncatedBinding?: Buffer;
}

function writeU32LE(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function writeU64LE(out: number[], v: bigint): void {
  const lo = Number(v & 0xffffffffn);
  const hi = Number((v >> 32n) & 0xffffffffn);
  writeU32LE(out, lo);
  writeU32LE(out, hi);
}

function writeBorshString(out: number[], s: string): void {
  const enc = Buffer.from(s, "utf8");
  writeU32LE(out, enc.length);
  for (const b of enc) out.push(b);
}

function buildAgentStateBuffer(fix: AgentStateFixture = {}): Buffer {
  const out: number[] = [];
  // discriminator
  for (let i = 0; i < 8; i++) out.push(0);
  // authority (32 bytes)
  const authority = fix.authority ?? Buffer.alloc(32, 0x11);
  if (authority.length !== 32) throw new Error("authority must be 32 bytes");
  for (const b of authority) out.push(b);
  // strings
  writeBorshString(out, fix.name ?? "agent-fixture");
  writeBorshString(out, fix.modelId ?? "claude-opus-4-6");
  writeBorshString(out, fix.metadataUri ?? "ipfs://meta");
  // reputation (u64) and status (u8)
  writeU64LE(out, fix.reputation ?? 42n);
  out.push(fix.statusByte ?? 0);

  // Trailer
  const sv = fix.schemaVersion ?? "omit";
  if (sv === "omit") {
    // no bytes — legacy v0 buffer
  } else if (sv === 1) {
    out.push(0x01);
    if (fix.truncatedBinding !== undefined) {
      // option tag = Some, then raw truncated bytes
      out.push(0x01);
      for (const b of fix.truncatedBinding) out.push(b);
    } else if (fix.humanAuthority) {
      // option tag = Some + body
      out.push(0x01);
      writeBorshString(out, fix.humanAuthority.authStrategy);
      writeBorshString(out, fix.humanAuthority.sub);
      writeU64LE(out, fix.humanAuthority.boundAtSlot);
    } else {
      // option tag = None
      out.push(0x00);
    }
  } else {
    // schema_version === 0 (malformed) or >= 2 (unknown future) — single byte, no body.
    out.push(sv & 0xff);
  }

  return Buffer.from(out);
}

describe("parseAgentState", () => {
  test("legacy v0 fallback (no trailer) returns schemaVersion=0 and humanAuthority=null", () => {
    const buf = buildAgentStateBuffer({ schemaVersion: "omit" });
    const result = parseAgentState(buf);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(0);
    expect(result!.humanAuthority).toBeNull();
    expect(result!.name).toBe("agent-fixture");
    expect(result!.modelId).toBe("claude-opus-4-6");
    expect(result!.metadataUri).toBe("ipfs://meta");
    expect(result!.reputation).toBe(42n);
    expect(result!.statusByte).toBe(0);
  });

  test("v1 trailer with binding round-trips authStrategy, sub, and boundAtSlot", () => {
    const buf = buildAgentStateBuffer({
      schemaVersion: 1,
      humanAuthority: {
        authStrategy: "siwe",
        sub: "0xabc...def",
        boundAtSlot: 12345678n,
      },
    });
    const result = parseAgentState(buf);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(1);
    expect(result!.humanAuthority).not.toBeNull();
    expect(result!.humanAuthority!.authStrategy).toBe("siwe");
    expect(result!.humanAuthority!.sub).toBe("0xabc...def");
    expect(result!.humanAuthority!.boundAtSlot).toBe(12345678n);
  });

  test("v1 trailer with null binding (option tag 0x00, no body) returns humanAuthority=null", () => {
    const buf = buildAgentStateBuffer({
      schemaVersion: 1,
      humanAuthority: null,
    });
    const result = parseAgentState(buf);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(1);
    expect(result!.humanAuthority).toBeNull();
  });

  test("unknown future schema version (>= 2) is refused with null", () => {
    const buf = buildAgentStateBuffer({ schemaVersion: 2 });
    expect(parseAgentState(buf)).toBeNull();

    const bufHigh = buildAgentStateBuffer({ schemaVersion: 99 });
    expect(parseAgentState(bufHigh)).toBeNull();
  });

  test("schema_version === 0 with explicit trailer byte is malformed → null", () => {
    // Distinct from the legacy fallthrough case: the buffer here has a 0x00
    // trailer byte where v0 should have ended at EOF.
    const buf = buildAgentStateBuffer({ schemaVersion: 0 });
    expect(parseAgentState(buf)).toBeNull();
  });

  test("unknown authStrategy string passes through (no allowlist in decoder)", () => {
    const buf = buildAgentStateBuffer({
      schemaVersion: 1,
      humanAuthority: {
        authStrategy: "future-strategy-name",
        sub: "user-1",
        boundAtSlot: 1n,
      },
    });
    const result = parseAgentState(buf);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(1);
    expect(result!.humanAuthority?.authStrategy).toBe("future-strategy-name");
  });

  test("truncated v1 trailer body returns null via the existing try/catch", () => {
    // Option tag 0x01 (Some) followed by a length prefix claiming 100 bytes
    // but only 4 bytes of payload — readString should walk off the end.
    const truncated = Buffer.from([
      100, 0, 0, 0, // u32-LE length = 100
      0x61, 0x62, 0x63, 0x64, // "abcd" — far short of 100
    ]);
    const buf = buildAgentStateBuffer({
      schemaVersion: 1,
      truncatedBinding: truncated,
    });
    expect(parseAgentState(buf)).toBeNull();
  });

  test("v0 fields are preserved when v1 trailer is present (sanity guard)", () => {
    const authority = Buffer.alloc(32, 0xab);
    const expectedAuthorityB58 = bs58.encode(authority);
    const buf = buildAgentStateBuffer({
      authority,
      name: "preserved-name",
      modelId: "model-x",
      metadataUri: "ipfs://preserved",
      reputation: 9001n,
      statusByte: 1,
      schemaVersion: 1,
      humanAuthority: {
        authStrategy: "siwe",
        sub: "0xfeedface",
        boundAtSlot: 7n,
      },
    });
    const result = parseAgentState(buf);
    expect(result).not.toBeNull();
    expect(result!.authority).toBe(expectedAuthorityB58);
    expect(result!.name).toBe("preserved-name");
    expect(result!.modelId).toBe("model-x");
    expect(result!.metadataUri).toBe("ipfs://preserved");
    expect(result!.reputation).toBe(9001n);
    expect(result!.statusByte).toBe(1);
    expect(result!.schemaVersion).toBe(1);
    expect(result!.humanAuthority?.authStrategy).toBe("siwe");
    expect(result!.humanAuthority?.sub).toBe("0xfeedface");
    expect(result!.humanAuthority?.boundAtSlot).toBe(7n);
  });
});
