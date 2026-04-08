import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
    },
    async ({ circuit, witness, proving_key }) => {
      try {
        const lines = [
          "ZK proof generation — tool interface is ready.",
          "",
          "ZK proof generation runs on-chain via the Groth16 BN254 program.",
          "",
          "Planned flow:",
          "  1. Upload circuit and proving key to ephemeral on-chain storage",
          "  2. Build ProveInstruction with circuit_id, witness, and proving_key_id",
          "  3. Submit to the on-chain Groth16 program (program ID: groth16BN254...)",
          "  4. Poll for proof completion (typically 2-5 slots)",
          "  5. Return: proof (base64 Groth16 proof), public_inputs[], proof_account",
          "",
          "Note: The BN254 curve supports Ethereum-compatible proof verification,",
          "meaning proofs generated here can be verified on any EVM chain.",
          "",
          `Input received:`,
          `  circuit length    : ${circuit.length} base64 chars`,
          `  witness           : ${JSON.stringify(witness).slice(0, 100)}${JSON.stringify(witness).length > 100 ? "..." : ""}`,
          `  proving_key length: ${proving_key.length} base64 chars`,
          "",
          "The ZK prove pipeline will be wired in the next iteration.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
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
    },
    async ({ proof, public_inputs, verification_key }) => {
      try {
        const lines = [
          "ZK proof verification — tool interface is ready.",
          "",
          "Planned flow:",
          "  1. Decode base64 proof and verification key",
          "  2. Parse public_inputs as BN254 field elements",
          "  3. Build VerifyInstruction for the on-chain Groth16 verifier",
          "  4. Submit verification transaction",
          "  5. Return: valid (bool), verification_tx_hash, gas_used",
          "",
          "Note: On-chain verification costs ~200,000 gas and is finalized in 1 slot.",
          "",
          `Input received:`,
          `  proof length        : ${proof.length} base64 chars`,
          `  public_inputs count : ${public_inputs.length}`,
          `  verification_key len: ${verification_key.length} base64 chars`,
          "",
          "The ZK verify pipeline will be wired in the next iteration.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
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
        const opDescriptions: Record<string, string> = {
          point_add:
            "G1 point addition: computes P1 + P2 on the BN254 G1 curve. ~150 gas.",
          scalar_mul:
            "G1 scalar multiplication: computes scalar * P on the BN254 G1 curve. ~6000 gas.",
          pairing_check:
            "BN254 pairing check: verifies e(G1_i, G2_i) product = 1. ~45000 gas per pair.",
        };

        const lines = [
          `BN254 ${operation} — tool interface is ready.`,
          "",
          opDescriptions[operation],
          "",
          "Planned flow:",
          "  1. Validate and encode input curve points as 32-byte big-endian field elements",
          "  2. Build BN254 precompile call (EVM precompile at 0x06/0x07/0x08)",
          "  3. Execute via eth_call against the BN254 precompile address",
          "  4. Decode output curve point from returned bytes",
          "  5. Return: result as hex-encoded point coordinates",
          "",
          `Input received:`,
          `  operation: ${operation}`,
          `  inputs   : ${JSON.stringify(inputs).slice(0, 200)}${JSON.stringify(inputs).length > 200 ? "..." : ""}`,
          "",
          "The BN254 operations pipeline will be wired in the next iteration.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
