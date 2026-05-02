/**
 * FN-012 — Integration test: cast_call vs read_contract return compatible data
 *
 * Asserts that ABI-decoding the raw hex returned by `read_contract` (which
 * comes from eth_call) yields the same logical value that Foundry's
 * `cast call` returns in its human-readable decoded form.
 *
 * Strategy
 * --------
 * Both tools ultimately query the same on-chain state. In production:
 *   - read_contract   → eth_call RPC → raw ABI-encoded hex
 *   - cast_call       → cast call    → ABI-decoded human-readable output
 *
 * In this test we use a shared "contract state" fixture (the canonical hex
 * encoding of a known value) and assert that:
 *   - read_contract echoes the exact raw hex (no mutation)
 *   - ABI-decoding that hex produces a value equal to what cast_call returns
 *
 * Coverage
 * --------
 *   • uint256: totalSupply() returns 1_000_000 (18-decimal token)
 *   • address: owner() returns a known EVM address (EIP-55 checksum round-trip)
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { EventEmitter } from "node:events";
import { keccak_256 } from "@noble/hashes/sha3";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by vitest before any imports of the real modules
// ---------------------------------------------------------------------------

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/read/rpc-client.js", () => ({
  rpc: {
    ethCall: vi.fn(),
  },
}));

// Import mocked dependencies AFTER vi.mock declarations
import { execFile } from "child_process";
import { rpc } from "../../src/read/rpc-client.js";

// Import tool registrars AFTER mocks are in place
import { registerContractTools } from "../../src/tools/contract.js";
import { registerFoundryTools } from "../../src/tools/foundry.js";

// ---------------------------------------------------------------------------
// Minimal McpServer shim — captures tool handlers without the full SDK
// ---------------------------------------------------------------------------

type ToolHandler = (
  args: Record<string, unknown>
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

class MockMcpServer {
  private handlers = new Map<string, ToolHandler>();

  /** Matches the McpServer.tool() signature used in the real tool registrars. */
  tool(
    name: string,
    _desc: string,
    _schema: unknown,
    handler: ToolHandler
  ): void {
    this.handlers.set(name, handler);
  }

  call(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const h = this.handlers.get(name);
    if (!h) throw new Error(`Tool not registered: ${name}`);
    return h(args);
  }
}

// ---------------------------------------------------------------------------
// ABI decode helpers (mirrors the encoding done by contract.ts internally)
// ---------------------------------------------------------------------------

/** Decode a single-slot ABI uint256 from a raw 32-byte hex result. */
function abiDecodeUint256(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // ABI uint256 occupies the last 32 bytes (64 hex chars); take the whole slot.
  const slot = clean.slice(-64).padStart(64, "0");
  return BigInt("0x" + slot);
}

/** Decode a single-slot ABI address (right-aligned in 32 bytes) from raw hex. */
function abiDecodeAddress(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Address occupies the last 20 bytes (40 hex chars) of the 32-byte slot.
  const addrHex = clean.slice(-40);
  return "0x" + addrHex.toLowerCase();
}

/** Apply EIP-55 checksum to a lowercase 0x-prefixed address. */
function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(lower));
  const hashHex = Buffer.from(hash).toString("hex");
  const checksummed = lower
    .split("")
    .map((char, i) => (parseInt(hashHex[i], 16) >= 8 ? char.toUpperCase() : char))
    .join("");
  return "0x" + checksummed;
}

// ---------------------------------------------------------------------------
// Shared contract state fixtures
// ---------------------------------------------------------------------------

// uint256 fixture: 1_000_000 (typical ERC-20 totalSupply with 0 decimals)
const UINT256_VALUE = 1_000_000n;
const UINT256_HEX =
  "0x" + UINT256_VALUE.toString(16).padStart(64, "0");
// = 0x00000000000000000000000000000000000000000000000000000000000f4240

// address fixture (Ethereum Foundation donation address — public)
const ADDRESS_LOWER = "0xde0b6b3a7640000000000000000000000000000f"; // fake but valid 20-byte
const ADDRESS_CHECKSUMMED = toChecksumAddress(ADDRESS_LOWER);
const ADDRESS_HEX =
  "0x" + "000000000000000000000000" + ADDRESS_LOWER.slice(2).padStart(40, "0");

// Shared fake contract address
const CONTRACT_ADDR = "0xabcdef1234567890abcdef1234567890abcdef12";

// ---------------------------------------------------------------------------
// Helpers to mock execFile (cast call → decoded output)
// ---------------------------------------------------------------------------

function mockCastCallReturns(decoded: string): void {
  (execFile as ReturnType<typeof vi.fn>).mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      cb(null, decoded + "\n", "");
      return {} as EventEmitter;
    }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cast_call vs read_contract — ABI type compatibility", () => {
  let server: MockMcpServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new MockMcpServer();
    registerContractTools(server as unknown as Parameters<typeof registerContractTools>[0]);
    registerFoundryTools(server as unknown as Parameters<typeof registerFoundryTools>[0]);
  });

  // ── uint256 ──────────────────────────────────────────────────────────────

  describe("uint256 (totalSupply)", () => {
    const METHOD_SIG = "totalSupply()";

    test("read_contract returns the raw ABI-encoded hex", async () => {
      (rpc.ethCall as ReturnType<typeof vi.fn>).mockResolvedValue(UINT256_HEX);

      const result = await server.call("read_contract", {
        contract: CONTRACT_ADDR,
        method: METHOD_SIG,
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      // The tool output contains "Result: <hex>"
      expect(text).toContain(`Result: ${UINT256_HEX}`);
    });

    test("cast_call returns the ABI-decoded decimal string", async () => {
      mockCastCallReturns(UINT256_VALUE.toString());

      const result = await server.call("cast_call", {
        to: CONTRACT_ADDR,
        sig: METHOD_SIG,
        args: [],
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain(UINT256_VALUE.toString());
    });

    test("ABI-decoding read_contract hex matches cast_call decoded value", async () => {
      // Simulate read_contract
      (rpc.ethCall as ReturnType<typeof vi.fn>).mockResolvedValue(UINT256_HEX);
      const readResult = await server.call("read_contract", {
        contract: CONTRACT_ADDR,
        method: METHOD_SIG,
      });
      const readText = readResult.content[0].text;
      const hexMatch = readText.match(/Result:\s*(0x[0-9a-fA-F]+)/);
      expect(hexMatch).not.toBeNull();
      const rawHex = hexMatch![1];

      // Simulate cast_call
      mockCastCallReturns(UINT256_VALUE.toString());
      const castResult = await server.call("cast_call", {
        to: CONTRACT_ADDR,
        sig: METHOD_SIG,
        args: [],
      });
      const castText = castResult.content[0].text;
      // cast output: "Call result:\n<value>"
      const castValueMatch = castText.match(/Call result:\n([\s\S]+)/);
      expect(castValueMatch).not.toBeNull();
      const castValue = castValueMatch![1].trim();

      // ABI-decode the raw hex and compare
      const decoded = abiDecodeUint256(rawHex);
      expect(decoded.toString()).toBe(castValue);
    });
  });

  // ── address ──────────────────────────────────────────────────────────────

  describe("address (owner)", () => {
    const METHOD_SIG = "owner()";

    test("read_contract returns the raw ABI-encoded hex for address", async () => {
      (rpc.ethCall as ReturnType<typeof vi.fn>).mockResolvedValue(ADDRESS_HEX);

      const result = await server.call("read_contract", {
        contract: CONTRACT_ADDR,
        method: METHOD_SIG,
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain(`Result: ${ADDRESS_HEX}`);
    });

    test("cast_call returns the EIP-55 checksummed address", async () => {
      mockCastCallReturns(ADDRESS_CHECKSUMMED);

      const result = await server.call("cast_call", {
        to: CONTRACT_ADDR,
        sig: METHOD_SIG,
        args: [],
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain(ADDRESS_CHECKSUMMED);
    });

    test("ABI-decoding read_contract hex matches cast_call decoded address (case-insensitive)", async () => {
      // Simulate read_contract
      (rpc.ethCall as ReturnType<typeof vi.fn>).mockResolvedValue(ADDRESS_HEX);
      const readResult = await server.call("read_contract", {
        contract: CONTRACT_ADDR,
        method: METHOD_SIG,
      });
      const readText = readResult.content[0].text;
      const hexMatch = readText.match(/Result:\s*(0x[0-9a-fA-F]+)/);
      expect(hexMatch).not.toBeNull();
      const rawHex = hexMatch![1];

      // Simulate cast_call
      mockCastCallReturns(ADDRESS_CHECKSUMMED);
      const castResult = await server.call("cast_call", {
        to: CONTRACT_ADDR,
        sig: METHOD_SIG,
        args: [],
      });
      const castText = castResult.content[0].text;
      const castValueMatch = castText.match(/Call result:\n([\s\S]+)/);
      expect(castValueMatch).not.toBeNull();
      const castValue = castValueMatch![1].trim();

      // ABI-decode the raw hex (address: last 20 bytes)
      const decoded = abiDecodeAddress(rawHex);
      // Compare case-insensitively: cast returns checksummed, we decode to lower
      expect(decoded).toBe(castValue.toLowerCase());
    });

    test("applying EIP-55 checksum to ABI-decoded address matches cast_call output exactly", async () => {
      // Simulate read_contract
      (rpc.ethCall as ReturnType<typeof vi.fn>).mockResolvedValue(ADDRESS_HEX);
      const readResult = await server.call("read_contract", {
        contract: CONTRACT_ADDR,
        method: METHOD_SIG,
      });
      const rawHex = readResult.content[0].text.match(/Result:\s*(0x[0-9a-fA-F]+)/)![1];

      // Simulate cast_call
      mockCastCallReturns(ADDRESS_CHECKSUMMED);
      const castResult = await server.call("cast_call", {
        to: CONTRACT_ADDR,
        sig: METHOD_SIG,
        args: [],
      });
      const castValue = castResult.content[0].text
        .match(/Call result:\n([\s\S]+)/)![1]
        .trim();

      // ABI-decode → apply EIP-55 → should exactly match cast's checksummed output
      const decodedLower = abiDecodeAddress(rawHex);
      const decodedChecksummed = toChecksumAddress(decodedLower);
      expect(decodedChecksummed).toBe(castValue);
    });
  });

  // ── same RPC call, both tools ─────────────────────────────────────────────

  describe("same underlying eth_call state — cross-tool consistency", () => {
    test("uint256: both tools reflect the same contract value", async () => {
      // Shared contract state: storageValue() returns 42
      const STORAGE_VALUE = 42n;
      const storageHex = "0x" + STORAGE_VALUE.toString(16).padStart(64, "0");

      // read_contract side
      (rpc.ethCall as ReturnType<typeof vi.fn>).mockResolvedValue(storageHex);
      const readResult = await server.call("read_contract", {
        contract: CONTRACT_ADDR,
        method: "storageValue()",
      });
      const rawHex = readResult.content[0].text.match(/Result:\s*(0x[0-9a-fA-F]+)/)![1];
      const decodedFromHex = abiDecodeUint256(rawHex);

      // cast_call side (returns decoded decimal — what cast would output for the same state)
      mockCastCallReturns(STORAGE_VALUE.toString());
      const castResult = await server.call("cast_call", {
        to: CONTRACT_ADDR,
        sig: "storageValue()",
        args: [],
      });
      const castValue = castResult.content[0].text
        .match(/Call result:\n([\s\S]+)/)![1]
        .trim();

      // Both should agree on the value
      expect(decodedFromHex).toBe(STORAGE_VALUE);
      expect(castValue).toBe(STORAGE_VALUE.toString());
      expect(decodedFromHex.toString()).toBe(castValue);
    });
  });
});
