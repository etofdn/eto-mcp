import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { PROGRAM_IDS } from "../config.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";

// ---------------------------------------------------------------------------
// Borsh-style serialization helpers
// ---------------------------------------------------------------------------

function writeU8(buf: number[], v: number): void {
  buf.push(v & 0xff);
}

function writeU32LE(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function writeVec(buf: number[], bytes: Uint8Array): void {
  writeU32LE(buf, bytes.length);
  for (const b of bytes) buf.push(b);
}

function writeBytes(buf: number[], bytes: Uint8Array): void {
  for (const b of bytes) buf.push(b);
}

// ---------------------------------------------------------------------------
// BN254 point encoding helpers
// ---------------------------------------------------------------------------

/** Encode a uint256 decimal or hex string as 32 big-endian bytes */
function encodeUint256(v: unknown, fieldName = "value"): Uint8Array {
  if (typeof v !== "string") {
    throw new Error(`Expected '${fieldName}' to be a decimal or 0x-hex string, got ${v === undefined ? "undefined" : typeof v}`);
  }
  const clean = v.startsWith("0x") ? v.slice(2) : BigInt(v).toString(16);
  const padded = clean.padStart(64, "0");
  return new Uint8Array(Buffer.from(padded, "hex"));
}

/** Encode a G1 point {x, y} as 64 bytes (two uint256 big-endian) */
function encodeG1Point(p: any, name = "point"): Uint8Array {
  if (!p || typeof p !== "object" || typeof p.x !== "string" || typeof p.y !== "string") {
    throw new Error(`Expected '${name}' to be { x: string, y: string }`);
  }
  const out = new Uint8Array(64);
  out.set(encodeUint256(p.x, `${name}.x`), 0);
  out.set(encodeUint256(p.y, `${name}.y`), 32);
  return out;
}

/** Encode a G2 point {x1, x2, y1, y2} as 128 bytes (four uint256 big-endian) */
function encodeG2Point(p: { x1: string; x2: string; y1: string; y2: string }): Uint8Array {
  const out = new Uint8Array(128);
  out.set(encodeUint256(p.x1), 0);
  out.set(encodeUint256(p.x2), 32);
  out.set(encodeUint256(p.y1), 64);
  out.set(encodeUint256(p.y2), 96);
  return out;
}

// ---------------------------------------------------------------------------
// SVM transaction builder for ZK programs
// ---------------------------------------------------------------------------

function buildZkTx(
  caller: Uint8Array,
  programId: Uint8Array,
  instructionData: Uint8Array,
  blockhash: Uint8Array
): Uint8Array {
  // Message header: numSigners=1, numReadonlySigned=0, numReadonlyUnsigned=1
  const header = [1, 0, 1];

  // Account keys: caller (index 0), program (index 1)
  const accountKeys = [caller, programId];

  // Compiled instruction: programIdIndex=1, accounts=[0], data
  const instrBuf: number[] = [];
  writeU8(instrBuf, 1); // programIdIndex
  writeU8(instrBuf, 1); // accounts count
  writeU8(instrBuf, 0); // account index 0 (caller)
  writeVec(instrBuf, instructionData);

  // Build message
  const msgBuf: number[] = [];
  // Header
  for (const h of header) writeU8(msgBuf, h);
  // Account keys count
  writeU8(msgBuf, accountKeys.length);
  for (const key of accountKeys) writeBytes(msgBuf, key);
  // Recent blockhash
  writeBytes(msgBuf, blockhash);
  // Instructions count
  writeU8(msgBuf, 1);
  // Instruction bytes
  for (const b of instrBuf) writeU8(msgBuf, b);

  // Unsigned transaction: 1 empty signature slot (64 zero bytes) + message
  const txBuf: number[] = [];
  writeU8(txBuf, 1); // signature count
  for (let i = 0; i < 64; i++) writeU8(txBuf, 0); // placeholder signature
  for (const b of msgBuf) writeU8(txBuf, b);

  return new Uint8Array(txBuf);
}

import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha256";

function pubkeyBytesFromB58(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length === 32) return decoded;
  const padded = new Uint8Array(32);
  padded.set(decoded, 32 - decoded.length);
  return padded;
}

function blockhashBytesFromB58(b58: string): Uint8Array {
  const decoded = bs58.decode(b58);
  if (decoded.length === 32) return decoded;
  const padded = new Uint8Array(32);
  padded.set(decoded, 32 - decoded.length);
  return padded;
}

export function registerZkTools(server: McpServer): void {
  server.tool(
    "zk_prove",
    "Generate a Groth16 ZK proof on the ETO chain. Proof generation is handled by the on-chain BN254 Groth16 program, so the circuit and proving key never leave the node. Provide the circuit definition, witness (private + public inputs), and proving key — all base64-encoded.",
    {
      circuit: z
        .string()
        .describe("Base64-encoded circuit definition (R1CS or Circom compiled format)"),
      witness: z
        .any()
        .describe("Witness object containing private and public inputs as JSON"),
      proving_key: z
        .string()
        .describe("Base64-encoded Groth16 proving key (zkey file)"),
      from_wallet: z
        .string()
        .optional()
        .describe("Wallet address to sign the transaction. Uses default wallet if omitted."),
    },
    async ({ circuit, witness, proving_key, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "Error: no active wallet. Use set_active_wallet or provide from_wallet." }],
            isError: true,
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const callerB58 = signer.getPublicKey();
        const callerBytes = pubkeyBytesFromB58(callerB58);

        // Decode inputs
        const circuitBytes = new Uint8Array(Buffer.from(circuit, "base64"));
        const witnessBytes = new TextEncoder().encode(JSON.stringify(witness));
        const provingKeyBytes = new Uint8Array(Buffer.from(proving_key, "base64"));

        // Build Borsh-serialized instruction:
        // [0] discriminator for "prove"
        // circuit_hash: sha256 of circuit (32 bytes)
        // witness: length-prefixed bytes
        // proving_key: length-prefixed bytes
        const instrBuf: number[] = [];
        writeU8(instrBuf, 0); // discriminator: prove
        // circuit_hash: sha256 of full circuit bytes (deterministic content hash)
        const circuitHash = sha256(circuitBytes);
        writeBytes(instrBuf, circuitHash);
        writeVec(instrBuf, witnessBytes);
        writeVec(instrBuf, provingKeyBytes);

        const instrData = new Uint8Array(instrBuf);

        const { blockhash } = await blockhashCache.getBlockhash();
        const blockhashBytes = blockhashBytesFromB58(blockhash);

        const txBytes = buildZkTx(callerBytes, PROGRAM_IDS.zkBn254, instrData, blockhashBytes);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          timeoutMs: 30000,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{
              type: "text" as const,
              text: [
                "ZK proof generated.",
                `Signature: ${result.signature}`,
                `Status: ${result.status}`,
                `Circuit size: ${circuit.length} base64 chars`,
                `Proving key size: ${proving_key.length} base64 chars`,
                result.latency_ms ? `Latency: ${result.latency_ms}ms` : "",
              ].filter(Boolean).join("\n"),
            }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{
              type: "text" as const,
              text: `Proof transaction submitted but confirmation timed out.\nSignature: ${result.signature}\nThe transaction may still confirm — check the signature on-chain.`,
            }],
          };
        } else {
          return {
            content: [{
              type: "text" as const,
              text: `ZK prove failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}`,
            }],
            isError: true,
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "zk_verify",
    "Verify a Groth16 BN254 ZK proof on the ETO chain. Accepts the proof, public inputs, and verification key. Returns a boolean result. This is cheaper than full proof generation and can be called from any VM via cross-VM dispatch.",
    {
      proof: z
        .string()
        .describe("Base64-encoded Groth16 proof (output of zk_prove or snarkjs)"),
      public_inputs: z
        .array(z.string())
        .describe("Array of public inputs as decimal strings (field elements)"),
      verification_key: z
        .string()
        .describe("Base64-encoded Groth16 verification key (vkey.json)"),
      from_wallet: z
        .string()
        .optional()
        .describe("Wallet address to sign the transaction. Uses default wallet if omitted."),
    },
    async ({ proof, public_inputs, verification_key, from_wallet }) => {
      try {
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return {
            content: [{ type: "text" as const, text: "Error: no active wallet. Use set_active_wallet or provide from_wallet." }],
            isError: true,
          };
        }

        const factory = getSignerFactory();
        const signer = await factory.getSigner(walletId);
        const callerB58 = signer.getPublicKey();
        const callerBytes = pubkeyBytesFromB58(callerB58);

        const proofBytes = new Uint8Array(Buffer.from(proof, "base64"));
        const vkeyBytes = new Uint8Array(Buffer.from(verification_key, "base64"));

        // Build Borsh-serialized instruction:
        // [1] discriminator for "verify"
        // proof: length-prefixed bytes
        // public_inputs count + each as 32-byte field element
        // verification_key: length-prefixed bytes
        const instrBuf: number[] = [];
        writeU8(instrBuf, 1); // discriminator: verify
        writeVec(instrBuf, proofBytes);
        // public_inputs as field elements (32 bytes each, big-endian uint256)
        writeU32LE(instrBuf, public_inputs.length);
        for (const input of public_inputs) {
          const fieldEl = encodeUint256(input);
          writeBytes(instrBuf, fieldEl);
        }
        writeVec(instrBuf, vkeyBytes);

        const instrData = new Uint8Array(instrBuf);

        const { blockhash } = await blockhashCache.getBlockhash();
        const blockhashBytes = blockhashBytesFromB58(blockhash);

        const txBytes = buildZkTx(callerBytes, PROGRAM_IDS.zkVerify, instrData, blockhashBytes);
        const signedBytes = await signer.sign(txBytes);
        const signedBase64 = Buffer.from(signedBytes).toString("base64");

        const result = await submitter.submitAndConfirm({
          signedTxBase64: signedBase64,
          vm: "svm",
          timeoutMs: 15000,
        });

        if (result.status === "confirmed" || result.status === "finalized") {
          return {
            content: [{
              type: "text" as const,
              text: [
                "ZK proof verified.",
                `Signature: ${result.signature}`,
                `Status: ${result.status}`,
                `Public inputs: ${public_inputs.length}`,
                result.latency_ms ? `Latency: ${result.latency_ms}ms` : "",
              ].filter(Boolean).join("\n"),
            }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [{
              type: "text" as const,
              text: `Verify transaction submitted but confirmation timed out.\nSignature: ${result.signature}\nThe transaction may still confirm — check the signature on-chain.`,
            }],
          };
        } else {
          return {
            content: [{
              type: "text" as const,
              text: `ZK verify failed: ${result.error?.explanation ?? result.error?.raw_message ?? result.status}`,
            }],
            isError: true,
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "zk_bn254_ops",
    "Execute low-level BN254 elliptic curve operations on the ETO chain: point addition (G1+G1), scalar multiplication (G1*scalar), and pairing check (e(G1,G2)). These primitives underpin Groth16, PLONK, and other ZK proof systems. Results are returned as hex-encoded curve points.",
    {
      operation: z
        .enum(["point_add", "scalar_mul", "pairing_check"])
        .describe(
          "BN254 operation: point_add (G1+G1), scalar_mul (G1*scalar), or pairing_check (e(G1,G2))"
        ),
      inputs: z
        .any()
        .describe(
          "Operation inputs as JSON. point_add: {p1:{x,y}, p2:{x,y}}. scalar_mul: {point:{x,y}, scalar}. pairing_check: [{g1:{x,y}, g2:{x1,x2,y1,y2}}]"
        ),
    },
    async ({ operation, inputs }) => {
      try {
        let calldata: Uint8Array;
        let precompileAddr: string;

        if (operation === "point_add") {
          // ecAdd: precompile 0x06, input = G1_1 (64 bytes) + G1_2 (64 bytes) = 128 bytes
          precompileAddr = "0x0000000000000000000000000000000000000006";
          const p1 = encodeG1Point(inputs.p1);
          const p2 = encodeG1Point(inputs.p2);
          calldata = new Uint8Array(128);
          calldata.set(p1, 0);
          calldata.set(p2, 64);
        } else if (operation === "scalar_mul") {
          // ecMul: precompile 0x07, input = G1 (64 bytes) + scalar (32 bytes) = 96 bytes
          precompileAddr = "0x0000000000000000000000000000000000000007";
          const pt = encodeG1Point(inputs.point);
          const scalar = encodeUint256(inputs.scalar);
          calldata = new Uint8Array(96);
          calldata.set(pt, 0);
          calldata.set(scalar, 64);
        } else {
          // pairing_check: precompile 0x08, input = N * (G1 64 bytes + G2 128 bytes) = N * 192 bytes
          precompileAddr = "0x0000000000000000000000000000000000000008";
          const pairs: Array<{ g1: { x: string; y: string }; g2: { x1: string; x2: string; y1: string; y2: string } }> = inputs;
          calldata = new Uint8Array(pairs.length * 192);
          let offset = 0;
          for (const pair of pairs) {
            calldata.set(encodeG1Point(pair.g1), offset);
            calldata.set(encodeG2Point(pair.g2), offset + 64);
            offset += 192;
          }
        }

        const calldataHex = "0x" + Buffer.from(calldata).toString("hex");

        const result = await rpc.ethCall({
          to: precompileAddr,
          data: calldataHex,
        });

        if (!result || result === "0x") {
          return {
            content: [{
              type: "text" as const,
              text: [
                `BN254 ${operation} result: (empty — point at infinity or pairing check = false)`,
                `Precompile: ${precompileAddr}`,
                `Input size: ${calldata.length} bytes`,
              ].join("\n"),
            }],
          };
        }

        const resultHex = result.startsWith("0x") ? result.slice(2) : result;

        if (operation === "pairing_check") {
          // Returns 32 bytes: 0x00...01 = true, 0x00...00 = false
          const valid = BigInt("0x" + resultHex) === 1n;
          return {
            content: [{
              type: "text" as const,
              text: [
                `BN254 pairing check: ${valid ? "VALID (true)" : "INVALID (false)"}`,
                `Precompile: ${precompileAddr}`,
                `Pairs checked: ${(inputs as any[]).length}`,
                `Raw result: 0x${resultHex}`,
              ].join("\n"),
            }],
          };
        }

        // point_add and scalar_mul return a G1 point (64 bytes = x,y)
        if (resultHex.length >= 128) {
          const rx = resultHex.slice(0, 64);
          const ry = resultHex.slice(64, 128);
          return {
            content: [{
              type: "text" as const,
              text: [
                `BN254 ${operation} result:`,
                `  x: 0x${rx}`,
                `  y: 0x${ry}`,
                `Precompile: ${precompileAddr}`,
                `Input size: ${calldata.length} bytes`,
              ].join("\n"),
            }],
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `BN254 ${operation} result: 0x${resultHex}`,
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
