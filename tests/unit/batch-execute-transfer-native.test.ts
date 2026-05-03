import { describe, test, expect, vi, beforeEach } from "vitest";

// Mocks must be hoisted via vi.mock before importing the SUT.
vi.mock("../../src/wasm/index.js", () => ({
  buildTransferTx: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock("../../src/signing/index.js", () => {
  const signer = {
    getPublicKey: vi.fn(() => "FROM_SVM_PUBKEY"),
    sign: vi.fn(async (_bytes: Uint8Array) => new Uint8Array([9, 9, 9])),
  };
  return {
    getSignerFactory: vi.fn(() => ({
      getSigner: vi.fn(async (_id: string) => signer),
    })),
  };
});

vi.mock("../../src/write/blockhash-cache.js", () => ({
  blockhashCache: {
    getBlockhash: vi.fn(async () => ({ blockhash: "BLOCKHASH_XYZ" })),
    refresh: vi.fn(async () => ({ blockhash: "BLOCKHASH_XYZ" })),
  },
}));

vi.mock("../../src/write/submitter.js", () => ({
  submitter: {
    submitAndConfirm: vi.fn(async (_args: any) => ({
      status: "confirmed",
      signature: "SIG_OK",
      coalesced: false,
    })),
  },
}));

vi.mock("../../src/tools/wallet.js", () => ({
  getActiveWalletId: vi.fn(() => "WALLET_ACTIVE"),
}));

vi.mock("../../src/utils/address.js", () => ({
  resolveAddresses: vi.fn((addr: string) => ({ svm: addr, evm: "0x" + addr })),
}));

vi.mock("../../src/read/rpc-client.js", () => ({
  rpc: {
    faucet: vi.fn(async (_addr: string, _lamports: number) => "AIRDROP_SIG"),
    getBalance: vi.fn(async () => ({ value: "0" })),
    getBlockHeight: vi.fn(async () => 0),
    getHealth: vi.fn(async () => "ok"),
    etoGetAccount: vi.fn(async () => null),
    etoGetTransaction: vi.fn(async () => null),
    etoGetBlock: vi.fn(async () => null),
    etoGetStats: vi.fn(async () => null),
    etoGetAccountTransactions: vi.fn(async () => []),
  },
}));

// Import after mocks.
import { registerBatchTools } from "../../src/tools/batch.js";
import { buildTransferTx } from "../../src/wasm/index.js";
import { submitter } from "../../src/write/submitter.js";
import { rpc } from "../../src/read/rpc-client.js";

type Handler = (args: any) => Promise<any>;

function captureHandlers(): { handlers: Map<string, Handler>; server: any } {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, _schema: any, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  return { handlers, server };
}

function getBatchExecute() {
  const { handlers, server } = captureHandlers();
  registerBatchTools(server as any);
  const handler = handlers.get("batch_execute");
  if (!handler) throw new Error("batch_execute not registered");
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default success implementation after clearAllMocks resets it.
  (submitter.submitAndConfirm as any).mockImplementation(async () => ({
    status: "confirmed",
    signature: "SIG_OK",
    coalesced: false,
  }));
  (rpc.faucet as any).mockImplementation(async () => "AIRDROP_SIG");
});

describe("batch_execute - transfer_native dispatch", () => {
  test("Test 1: single transfer_native passes memo and idempotency key correctly", async () => {
    const batchExecute = getBatchExecute();
    const result = await batchExecute({
      operations: [
        {
          tool: "transfer_native",
          params: { to: "TO_SVM_ADDR", amount: "1.5", memo: "hello" },
        },
      ],
      atomic: true,
    });

    const text = result.content[0].text as string;
    expect(text).toContain("1 succeeded, 0 failed, 0 skipped");

    // 5th positional argument must be the memo
    expect(buildTransferTx).toHaveBeenCalledTimes(1);
    const call = (buildTransferTx as any).mock.calls[0];
    expect(call[4]).toBe("hello");

    // submitter received idempotency key with -m:hello
    expect(submitter.submitAndConfirm).toHaveBeenCalledTimes(1);
    const submitArgs = (submitter.submitAndConfirm as any).mock.calls[0][0];
    expect(submitArgs.idempotencyKey).toContain("-m:hello");
    expect(submitArgs.vm).toBe("svm");
  });

  test("Test 2: mixed batch [airdrop, transfer_native] with atomic=true succeeds for both", async () => {
    const batchExecute = getBatchExecute();
    const result = await batchExecute({
      operations: [
        { tool: "airdrop", params: { address: "TO_SVM_ADDR", amount: "1" } },
        { tool: "transfer_native", params: { to: "TO_SVM_ADDR", amount: "0.25" } },
      ],
      atomic: true,
    });

    const text = result.content[0].text as string;
    expect(text).toContain("2 succeeded, 0 failed");
    expect(text).not.toContain("not directly supported");
    expect(rpc.faucet).toHaveBeenCalledTimes(1);
    expect(submitter.submitAndConfirm).toHaveBeenCalledTimes(1);
  });

  test("Test 3: airdrop-only batch unchanged — invokes faucet twice", async () => {
    const batchExecute = getBatchExecute();
    const result = await batchExecute({
      operations: [
        { tool: "airdrop", params: { address: "ADDR_A", amount: "1" } },
        { tool: "airdrop", params: { address: "ADDR_B", amount: "2" } },
      ],
      atomic: true,
    });

    const text = result.content[0].text as string;
    expect(text).toContain("2 succeeded, 0 failed");
    expect(rpc.faucet).toHaveBeenCalledTimes(2);
  });

  test("Test 4: failed submitter result records ERROR and skips later ops under atomic=true", async () => {
    (submitter.submitAndConfirm as any).mockImplementationOnce(async () => ({
      status: "failed",
      signature: "",
      error: { explanation: "simulated failure", raw_message: "raw" },
    }));

    const batchExecute = getBatchExecute();
    const result = await batchExecute({
      operations: [
        { tool: "transfer_native", params: { to: "TO_SVM_ADDR", amount: "1" } },
        { tool: "airdrop", params: { address: "TO_SVM_ADDR", amount: "1" } },
      ],
      atomic: true,
    });

    const text = result.content[0].text as string;
    expect(text).toMatch(/\[1\] ERROR\s+tool=transfer_native/);
    expect(text).toContain("simulated failure");
    expect(text).toMatch(/\[2\] SKIPPED\s+tool=airdrop/);
    expect(text).toContain("1 failed");
    expect(rpc.faucet).not.toHaveBeenCalled();
  });
});
