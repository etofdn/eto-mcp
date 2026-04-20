#!/usr/bin/env bun
/**
 * ETO Mesh Validator — Cross-Chain State Attestation
 *
 * A single process that participates in both ETO and Ethereum,
 * observes state on both chains, and produces signed attestations
 * that can be verified on either side.
 *
 * This IS the validator mesh. No bridge. No oracle. Just a validator
 * that sees both chains and attests to what it saw.
 *
 * Usage:
 *   bun run mesh/validator.ts
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import bs58 from "bs58";
import { appendFileSync, mkdirSync } from "fs";

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ─── Config ───
const ETO_RPC = process.env.ETO_RPC_URL || "http://localhost:8899";
const ETH_RPC = process.env.ETH_RPC_URL || "http://localhost:8545";
const SOL_RPC = process.env.SOL_RPC_URL || "http://localhost:8901";
const POLL_MS = parseInt(process.env.MESH_POLL_MS || "2000");
const LOG_DIR = "/tmp/eto-mesh-logs";
mkdirSync(LOG_DIR, { recursive: true });

// ─── Validator Identity ───
// In production, this comes from a secure key store
// For testnet, generate a deterministic key from a seed
const VALIDATOR_SEED = sha256(new TextEncoder().encode("eto-mesh-validator-testnet-v1"));
const VALIDATOR_PUBKEY = ed.getPublicKey(VALIDATOR_SEED);
const VALIDATOR_ADDRESS = bs58.encode(VALIDATOR_PUBKEY);

// ─── Types ───
interface ChainState {
  chainId: string;
  blockHeight: number;
  blockHash: string;
  stateRoot: string;
  timestamp: number;
}

interface Attestation {
  id: string;
  type: "state" | "transfer" | "balance" | "event";
  sourceChain: string;
  destChain: string;
  sourceBlock: number;
  data: Record<string, any>;
  validator: string;
  signature: string;
  timestamp: number;
}

interface CrossChainTransfer {
  id: string;
  from: { chain: string; address: string; amount: bigint };
  to: { chain: string; address: string };
  status: "pending" | "attested" | "settled" | "failed";
  attestation?: Attestation;
}

// ─── RPC Helpers ───
async function etoRpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(ETO_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(`ETO RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function ethRpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(ETH_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(`ETH RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function solRpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(SOL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(`SOL RPC ${method}: ${json.error.message}`);
  return json.result;
}

// ─── State Readers ───
async function getEtoState(): Promise<ChainState> {
  const height = await etoRpc("getBlockHeight");
  const blockhash = await etoRpc("getRecentBlockhash");
  return {
    chainId: "eto-testnet",
    blockHeight: height,
    blockHash: blockhash?.value?.blockhash || "unknown",
    stateRoot: "0x" + Buffer.from(sha256(new TextEncoder().encode(`eto:${height}`))).toString("hex").slice(0, 16),
    timestamp: Date.now(),
  };
}

async function getEthState(): Promise<ChainState> {
  const blockNum = await ethRpc("eth_blockNumber");
  const block = await ethRpc("eth_getBlockByNumber", [blockNum, false]);
  return {
    chainId: "eth-devnet",
    blockHeight: parseInt(blockNum, 16),
    blockHash: block?.hash || "0x0",
    stateRoot: block?.stateRoot || "0x0",
    timestamp: Date.now(),
  };
}

async function getEthBalance(address: string): Promise<bigint> {
  const hex = await ethRpc("eth_getBalance", [address, "latest"]);
  return BigInt(hex);
}

async function getEtoBalance(address: string): Promise<number> {
  const result = await etoRpc("getBalance", [address]);
  return result?.value ?? result ?? 0;
}

// ─── Attestation Engine ───
async function signAttestation(data: Record<string, any>): Promise<string> {
  const msg = new TextEncoder().encode(JSON.stringify(data));
  const sig = await ed.sign(sha256(msg), VALIDATOR_SEED);
  return Buffer.from(sig).toString("hex");
}

function verifyAttestation(attestation: Attestation): boolean {
  const { signature, validator, ...data } = attestation;
  const msg = new TextEncoder().encode(JSON.stringify(data));
  const sigBytes = Buffer.from(signature, "hex");
  const pubkey = bs58.decode(validator);
  try {
    return ed.verify(sigBytes, sha256(msg), pubkey);
  } catch {
    return false;
  }
}

async function createStateAttestation(
  sourceState: ChainState,
  destChain: string,
): Promise<Attestation> {
  const id = Buffer.from(sha256(new TextEncoder().encode(
    `${sourceState.chainId}:${sourceState.blockHeight}:${Date.now()}`
  ))).toString("hex").slice(0, 16);

  const attestationData = {
    id,
    type: "state" as const,
    sourceChain: sourceState.chainId,
    destChain,
    sourceBlock: sourceState.blockHeight,
    data: {
      blockHash: sourceState.blockHash,
      stateRoot: sourceState.stateRoot,
      blockHeight: sourceState.blockHeight,
    },
    validator: VALIDATOR_ADDRESS,
    timestamp: Date.now(),
  };

  const signature = await signAttestation(attestationData);
  return { ...attestationData, signature };
}

async function createBalanceAttestation(
  chain: string,
  address: string,
  balance: bigint | number,
  blockHeight: number,
): Promise<Attestation> {
  const id = Buffer.from(sha256(new TextEncoder().encode(
    `balance:${chain}:${address}:${blockHeight}`
  ))).toString("hex").slice(0, 16);

  const attestationData = {
    id,
    type: "balance" as const,
    sourceChain: chain,
    destChain: chain === "eto-testnet" ? "eth-devnet" : "eto-testnet",
    sourceBlock: blockHeight,
    data: {
      address,
      balance: balance.toString(),
      verified: true,
    },
    validator: VALIDATOR_ADDRESS,
    timestamp: Date.now(),
  };

  const signature = await signAttestation(attestationData);
  return { ...attestationData, signature };
}

// ─── Attestation Store ───
const attestations: Attestation[] = [];
const pendingTransfers: CrossChainTransfer[] = [];

function storeAttestation(att: Attestation): void {
  attestations.push(att);
  const line = JSON.stringify(att) + "\n";
  appendFileSync(`${LOG_DIR}/attestations.jsonl`, line);
}

// ─── Cross-Chain Transfer Handler ───
async function handleCrossChainTransfer(transfer: CrossChainTransfer): Promise<void> {
  log("info", `Processing transfer: ${transfer.from.chain} → ${transfer.to.chain} | ${transfer.from.amount} wei`);

  // 1. Verify source balance
  let sourceBalance: bigint;
  let sourceBlock: number;

  if (transfer.from.chain === "eth-devnet") {
    sourceBalance = await getEthBalance(transfer.from.address);
    const blockNum = await ethRpc("eth_blockNumber");
    sourceBlock = parseInt(blockNum, 16);
  } else {
    const bal = await getEtoBalance(transfer.from.address);
    sourceBalance = BigInt(bal);
    sourceBlock = await etoRpc("getBlockHeight");
  }

  if (sourceBalance < transfer.from.amount) {
    transfer.status = "failed";
    log("error", `Insufficient balance: has ${sourceBalance}, needs ${transfer.from.amount}`);
    return;
  }

  // 2. Create balance attestation (proves source has the funds)
  const balanceAtt = await createBalanceAttestation(
    transfer.from.chain,
    transfer.from.address,
    sourceBalance,
    sourceBlock,
  );
  storeAttestation(balanceAtt);

  // 3. Create transfer attestation
  const transferAtt = await createStateAttestation(
    transfer.from.chain === "eth-devnet" ? await getEthState() : await getEtoState(),
    transfer.to.chain,
  );
  storeAttestation(transferAtt);

  // 4. Credit on destination chain
  if (transfer.to.chain === "eto-testnet") {
    // Credit on ETO via faucet (in production: mint verified-asset).
    // Pass the amount as a hex string so bigint precision is preserved
    // for wei-denominated values above 2**53 − 1.
    try {
      const amountHex = "0x" + transfer.from.amount.toString(16);
      await etoRpc("faucet", [transfer.to.address, amountHex]);
      transfer.status = "settled";
      log("info", `Settled on ETO: ${transfer.to.address} credited ${transfer.from.amount} lamports`);
    } catch (e: any) {
      transfer.status = "failed";
      log("error", `ETO credit failed: ${e.message}`);
    }
  } else {
    // Credit on Ethereum via Anvil's eth_sendTransaction (devnet only).
    try {
      const accounts = await ethRpc("eth_accounts");
      if (!Array.isArray(accounts) || accounts.length === 0) {
        transfer.status = "failed";
        log("error", "ETH credit failed: eth_accounts returned an empty list");
        return;
      }
      await ethRpc("eth_sendTransaction", [{
        from: accounts[0], // Anvil's funded account
        to: transfer.to.address,
        value: "0x" + transfer.from.amount.toString(16),
      }]);
      transfer.status = "settled";
      log("info", `Settled on ETH: ${transfer.to.address} credited ${transfer.from.amount} wei`);
    } catch (e: any) {
      transfer.status = "failed";
      log("error", `ETH credit failed: ${e.message}`);
    }
  }

  transfer.attestation = transferAtt;
}

// ─── HTTP API for MCP integration ───
// Mutating endpoints (/transfer, /attest, /attest-balance) are gated behind
// a shared-secret bearer token and a simple in-memory rate limit. This keeps
// unauthenticated callers off the Anvil signer and the ETO faucet even when
// the validator is reachable on an open port. Set MESH_AUTH_TOKEN at launch;
// a blank token disables auth (explicit dev opt-in).
const MESH_AUTH_TOKEN = process.env.MESH_AUTH_TOKEN || "";
const MESH_BIND_HOST = process.env.MESH_BIND_HOST || "127.0.0.1";
const MESH_RATE_LIMIT_PER_MIN = parseInt(process.env.MESH_RATE_LIMIT_PER_MIN || "30");

const MUTATING_PATHS = new Set(["/transfer", "/attest", "/attest-balance"]);
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function checkAuth(req: Request): Response | null {
  if (!MESH_AUTH_TOKEN) return null; // dev: explicitly disabled
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (token !== MESH_AUTH_TOKEN) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function checkRateLimit(req: Request): Response | null {
  const key = req.headers.get("x-forwarded-for") || "local";
  const now = Date.now();
  const bucket = rateBuckets.get(key) ?? { count: 0, windowStart: now };
  if (now - bucket.windowStart > 60_000) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count++;
  rateBuckets.set(key, bucket);
  if (bucket.count > MESH_RATE_LIMIT_PER_MIN) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  return null;
}

async function startApi(): Promise<void> {
  const server = Bun.serve({
    port: 9200,
    hostname: MESH_BIND_HOST,
    async fetch(req) {
      const url = new URL(req.url);

      // Gate mutating endpoints before any work happens.
      if (MUTATING_PATHS.has(url.pathname) && req.method === "POST") {
        const authErr = checkAuth(req);
        if (authErr) return authErr;
        const rateErr = checkRateLimit(req);
        if (rateErr) return rateErr;
      }

      // Health
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", validator: VALIDATOR_ADDRESS, chains: ["eto-testnet", "eth-devnet"] });
      }

      // Get both chain states
      if (url.pathname === "/state") {
        const [eto, eth] = await Promise.all([getEtoState(), getEthState()]);
        return Response.json({ eto, eth, validator: VALIDATOR_ADDRESS });
      }

      // Create attestation for a specific chain
      if (url.pathname === "/attest" && req.method === "POST") {
        const body = await req.json() as any;
        const chain = body.chain || "eto-testnet";
        const state = chain === "eth-devnet" ? await getEthState() : await getEtoState();
        const destChain = chain === "eth-devnet" ? "eto-testnet" : "eth-devnet";
        const att = await createStateAttestation(state, destChain);
        storeAttestation(att);
        return Response.json(att);
      }

      // Verify an attestation
      if (url.pathname === "/verify" && req.method === "POST") {
        const att = await req.json() as Attestation;
        const valid = verifyAttestation(att);
        return Response.json({ valid, validator: att.validator });
      }

      // Attest a balance
      if (url.pathname === "/attest-balance" && req.method === "POST") {
        const body = await req.json() as any;
        const chain = body.chain || "eth-devnet";
        const address = body.address;
        let balance: bigint;
        let blockHeight: number;

        if (chain === "eth-devnet") {
          balance = await getEthBalance(address);
          blockHeight = parseInt(await ethRpc("eth_blockNumber"), 16);
        } else {
          balance = BigInt(await getEtoBalance(address));
          blockHeight = await etoRpc("getBlockHeight");
        }

        const att = await createBalanceAttestation(chain, address, balance, blockHeight);
        storeAttestation(att);
        return Response.json({ attestation: att, balance: balance.toString() });
      }

      // Initiate cross-chain transfer
      if (url.pathname === "/transfer" && req.method === "POST") {
        const body = await req.json() as any;
        const transfer: CrossChainTransfer = {
          id: crypto.randomUUID(),
          from: { chain: body.from_chain, address: body.from_address, amount: BigInt(body.amount) },
          to: { chain: body.to_chain, address: body.to_address },
          status: "pending",
        };
        pendingTransfers.push(transfer);
        await handleCrossChainTransfer(transfer);
        return Response.json({
          id: transfer.id,
          status: transfer.status,
          attestation: transfer.attestation,
        });
      }

      // List attestations
      if (url.pathname === "/attestations") {
        const limit = parseInt(url.searchParams.get("limit") || "50");
        return Response.json(attestations.slice(-limit));
      }

      // List transfers
      if (url.pathname === "/transfers") {
        return Response.json(pendingTransfers.map(t => ({
          ...t,
          from: { ...t.from, amount: t.from.amount.toString() },
        })));
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  log("info", `Mesh validator API on http://localhost:${server.port}`);
}

// ─── Main Loop ───
function log(level: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [mesh] ${msg}`;
  appendFileSync(`${LOG_DIR}/mesh.log`, line + "\n");
  console.error(line);
}

async function main(): Promise<void> {
  console.error(`
═══════════════════════════════════════════════
  ETO Mesh Validator — Cross-Chain Attestation
═══════════════════════════════════════════════

  Validator: ${VALIDATOR_ADDRESS}
  ETO RPC:   ${ETO_RPC}
  ETH RPC:   ${ETH_RPC}
  Poll:      ${POLL_MS}ms
  API:       http://localhost:9200
  Logs:      ${LOG_DIR}/
`);

  // Verify both chains are reachable
  try {
    const etoHealth = await etoRpc("getHealth");
    log("info", `ETO chain: ${etoHealth}`);
  } catch (e: any) {
    log("error", `ETO unreachable: ${e.message}`);
    process.exit(1);
  }

  try {
    const ethBlock = await ethRpc("eth_blockNumber");
    log("info", `ETH chain: block ${parseInt(ethBlock, 16)}`);
  } catch (e: any) {
    log("error", `ETH unreachable: ${e.message}`);
    process.exit(1);
  }

  // Start API
  await startApi();

  // Main attestation loop — continuously attest to both chains' state
  let tick = 0;
  while (true) {
    tick++;
    try {
      const [etoState, ethState] = await Promise.all([getEtoState(), getEthState()]);

      // Attest ETO state (for ETH consumption)
      const etoAtt = await createStateAttestation(etoState, "eth-devnet");
      storeAttestation(etoAtt);

      // Attest ETH state (for ETO consumption)
      const ethAtt = await createStateAttestation(ethState, "eto-testnet");
      storeAttestation(ethAtt);

      if (tick % 5 === 0) {
        log("info", `Tick ${tick} | ETO block=${etoState.blockHeight} | ETH block=${ethState.blockHeight} | Attestations=${attestations.length}`);
      }
    } catch (e: any) {
      log("error", `Tick ${tick} error: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
