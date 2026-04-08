/**
 * ETO MCP Server — End-to-End QA Test
 *
 * Tests the MCP tool handlers directly against a live local testnet.
 * Run: bun run test-qa.ts
 * Requires: testnet running on localhost:8899
 */

import { rpc } from "./src/read/rpc-client.js";
import { localSignerFactory } from "./src/signing/local-signer.js";
import { blockhashCache } from "./src/write/blockhash-cache.js";
import { submitter } from "./src/write/submitter.js";
import { buildTransferTx } from "./src/wasm/index.js";
import { lamportsToSol, solToLamports } from "./src/utils/units.js";
import { resolveAddresses, isValidSvmAddress, isValidEvmAddress } from "./src/utils/address.js";
import bs58 from "bs58";

let passed = 0;
let failed = 0;

function ok(name: string, detail?: string) {
  passed++;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, err: any) {
  failed++;
  console.log(`  ✗ ${name} — ${err?.message || err}`);
}

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log("  ETO MCP Server — QA Test Suite");
  console.log("  Testnet: http://localhost:8899");
  console.log("══════════════════════════════════════\n");

  // ─── 1. RPC Health ───
  console.log("[1] RPC Connection");
  try {
    const health = await rpc.getHealth();
    ok("getHealth", health);
  } catch (e) { fail("getHealth", e); }

  try {
    const height = await rpc.getBlockHeight();
    ok("getBlockHeight", `height=${height}`);
  } catch (e) { fail("getBlockHeight", e); }

  try {
    const slot = await rpc.getSlot();
    ok("getSlot", `slot=${slot}`);
  } catch (e) { fail("getSlot", e); }

  // ─── 2. Wallet Creation ───
  console.log("\n[2] Wallet Management");
  let walletId: string;
  let svmAddress: string;
  let evmAddress: string;
  try {
    const w = await localSignerFactory.createWallet("QA-Test-Wallet");
    walletId = w.walletId;
    svmAddress = w.svmAddress;
    evmAddress = w.evmAddress;
    ok("createWallet", `id=${walletId.slice(0, 8)}... svm=${svmAddress.slice(0, 8)}... evm=${evmAddress.slice(0, 10)}...`);
  } catch (e) { fail("createWallet", e); return; }

  try {
    const wallets = await localSignerFactory.listWallets();
    ok("listWallets", `count=${wallets.length}`);
  } catch (e) { fail("listWallets", e); }

  // ─── 3. Address Resolution ───
  console.log("\n[3] Address Utils");
  try {
    const addrs = resolveAddresses(svmAddress);
    ok("resolveAddresses (SVM→EVM)", `evm=${addrs.evm.slice(0, 10)}...`);
  } catch (e) { fail("resolveAddresses", e); }

  try {
    ok("isValidSvmAddress", `${isValidSvmAddress(svmAddress)}`);
    ok("isValidEvmAddress", `${isValidEvmAddress(evmAddress)}`);
  } catch (e) { fail("addressValidation", e); }

  // ─── 4. Faucet (Airdrop) ───
  console.log("\n[4] Faucet / Airdrop");
  try {
    const result = await rpc.faucet(svmAddress, 10_000_000_000); // 10 ETO in lamports
    ok("faucet", `10 ETO airdropped`);
  } catch (e) { fail("faucet", e); }

  // Wait for faucet tx to confirm (blocks certify every ~2-3s)
  await sleep(5000);

  // ─── 5. Balance Check ───
  console.log("\n[5] Balance Queries");
  try {
    const bal = await rpc.getBalance(svmAddress);
    const solBal = lamportsToSol(BigInt(bal.value));
    ok("getBalance (SVM)", `${solBal} ETO (${bal.value} lamports)`);
  } catch (e) { fail("getBalance", e); }

  try {
    const ethBal = await rpc.ethGetBalance(evmAddress);
    ok("ethGetBalance (EVM)", `${ethBal}`);
  } catch (e) { fail("ethGetBalance", e); }

  // ─── 6. Account Info ───
  console.log("\n[6] Account Info");
  try {
    const info = await rpc.getAccountInfo(svmAddress);
    ok("getAccountInfo", `lamports=${info?.lamports ?? info?.value?.lamports ?? "?"}`);
  } catch (e) { fail("getAccountInfo", e); }

  // ─── 7. Transaction Building + Signing + Submission ───
  console.log("\n[7] Transfer (Build → Sign → Submit)");

  // Create a second wallet to transfer to
  let wallet2Svm: string;
  try {
    const w2 = await localSignerFactory.createWallet("QA-Recipient");
    wallet2Svm = w2.svmAddress;
    ok("createRecipientWallet", `${wallet2Svm.slice(0, 8)}...`);
  } catch (e) { fail("createRecipientWallet", e); return; }

  try {
    // Get blockhash
    const { blockhash } = await blockhashCache.getBlockhash();
    ok("getBlockhash", blockhash.slice(0, 12) + "...");

    // Build transfer tx (1 ETO = 1_000_000_000 lamports)
    const lamports = 1_000_000_000n;
    const txBytes = buildTransferTx(svmAddress, wallet2Svm, lamports, blockhash);
    ok("buildTransferTx", `${txBytes.length} bytes`);

    // Sign
    const signer = await localSignerFactory.getSigner(walletId);
    const signedTx = await signer.sign(txBytes);
    ok("signTransaction", `${signedTx.length} bytes`);

    // Submit
    const txBase64 = Buffer.from(signedTx).toString("base64");
    const result = await submitter.submitAndConfirm({
      signedTxBase64: txBase64,
      vm: "svm",
      timeoutMs: 10000,
    });

    if (result.status === "confirmed" || result.status === "finalized") {
      ok("submitAndConfirm", `status=${result.status} sig=${result.signature.slice(0, 12)}... latency=${result.latency_ms}ms`);
    } else {
      fail("submitAndConfirm", `status=${result.status} sig=${result.signature?.slice(0, 12) || "none"} error=${result.error?.raw_message || "unknown"}`);
    }
  } catch (e) { fail("transfer flow", e); }

  // Wait for confirmation
  await sleep(2000);

  // ─── 8. Verify Transfer ───
  console.log("\n[8] Verify Transfer");
  try {
    const bal2 = await rpc.getBalance(wallet2Svm);
    const received = lamportsToSol(BigInt(bal2.value));
    if (bal2.value > 0) {
      ok("recipientBalance", `${received} ETO received`);
    } else {
      fail("recipientBalance", "recipient has 0 balance");
    }
  } catch (e) { fail("recipientBalance", e); }

  // ─── 9. Ethereum-Compatible RPC ───
  console.log("\n[9] Ethereum RPC Compatibility");
  try {
    const chainId = await rpc.ethChainId();
    ok("eth_chainId", chainId);
  } catch (e) { fail("eth_chainId", e); }

  try {
    const blockNum = await rpc.ethBlockNumber();
    ok("eth_blockNumber", blockNum);
  } catch (e) { fail("eth_blockNumber", e); }

  // ─── 10. Block Queries ───
  console.log("\n[10] Block Queries");
  try {
    const height = await rpc.getBlockHeight();
    const block = await rpc.getBlock(Math.max(1, height - 1));
    ok("getBlock", `height=${height - 1} txs=${block?.transactions?.length ?? block?.tx_count ?? "?"}`);
  } catch (e) { fail("getBlock", e); }

  // ─── 11. Transaction Count ───
  console.log("\n[11] Transaction Count");
  try {
    const count = await rpc.getTransactionCount();
    ok("getTransactionCount", `${count}`);
  } catch (e) { fail("getTransactionCount", e); }

  // ─── Summary ───
  console.log("\n══════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
