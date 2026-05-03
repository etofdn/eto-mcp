import { describe, test, expect, beforeEach, vi } from "vitest";

// FN-065: pin the wiring contract so transfer_native / batch_transfer always
// pass the user-supplied `memo` as the 5th positional argument to
// buildTransferTx. The actual on-chain Memo Program v2 instruction is built
// inside buildTransferTx (FN-064 / tests/unit/wasm.test.ts); here we only
// guard the wiring at the MCP-tool boundary.

vi.mock("../../src/wasm/index.js", () => ({
  buildTransferTx: vi.fn(() => new Uint8Array([1, 2, 3, 4])),
}));

vi.mock("../../src/signing/index.js", () => ({
  getSignerFactory: vi.fn(() => ({
    getSigner: vi.fn(async () => ({
      getPublicKey: () => "FromPubkey1111111111111111111111111111111111",
      sign: vi.fn(async (bytes: Uint8Array) => bytes),
    })),
  })),
}));

vi.mock("../../src/tools/wallet.js", () => ({
  getActiveWalletId: vi.fn(() => "active-wallet-id"),
}));

vi.mock("../../src/write/blockhash-cache.js", () => {
  let counter = 0;
  return {
    blockhashCache: {
      getBlockhash: vi.fn(async () => ({ blockhash: "blockhash-static", lastValidBlockHeight: 1 })),
      // batch_transfer uses refresh() and requires a *different* blockhash each
      // iteration so identical transfers don't collapse to one signature.
      refresh: vi.fn(async () => ({ blockhash: `blockhash-${counter++}`, lastValidBlockHeight: 1 })),
    },
  };
});

vi.mock("../../src/write/submitter.js", () => ({
  submitter: {
    submitAndConfirm: vi.fn(async () => ({
      status: "confirmed",
      signature: "mock-sig",
      coalesced: false,
      latency_ms: 5,
      fee: 5000,
    })),
  },
}));

vi.mock("../../src/utils/address.js", () => ({
  resolveAddresses: vi.fn((addr: string) => ({ svm: addr, evm: "0x" + "0".repeat(40) })),
}));

// Keep utils/units real — small, deterministic, no I/O.

import { registerTransferTools } from "../../src/tools/transfer.js";
import { buildTransferTx } from "../../src/wasm/index.js";
import { submitter } from "../../src/write/submitter.js";

type ToolHandler = (args: any) => Promise<any>;

function makeFakeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  return { server: server as any, handlers };
}

describe("FN-065 — transfer.ts memo wiring", () => {
  let handlers: Map<string, ToolHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    const fake = makeFakeServer();
    handlers = fake.handlers;
    registerTransferTools(fake.server);
  });

  test("transfer_native forwards memo as the 5th arg to buildTransferTx", async () => {
    const handler = handlers.get("transfer_native")!;
    expect(handler).toBeDefined();

    const result = await handler({
      to: "Recipient11111111111111111111111111111111111",
      amount: "0.1",
      memo: "test",
    });

    // Sanity: handler completed without throwing into the error branch.
    expect(result.content[0].text).toMatch(/Transfer successful/);

    expect(buildTransferTx).toHaveBeenCalledTimes(1);
    const call = (buildTransferTx as any).mock.calls[0];
    expect(call.length).toBe(5);
    expect(call[4]).toBe("test");
  });

  test("transfer_native with no memo passes undefined as the 5th arg", async () => {
    const handler = handlers.get("transfer_native")!;
    await handler({
      to: "Recipient11111111111111111111111111111111111",
      amount: "0.1",
    });

    expect(buildTransferTx).toHaveBeenCalledTimes(1);
    const call = (buildTransferTx as any).mock.calls[0];
    // Either undefined or absent — both indicate the SPL Memo Program ix is skipped.
    expect(call[4]).toBeUndefined();
  });

  test("batch_transfer forwards each per-iteration memo to buildTransferTx", async () => {
    const handler = handlers.get("batch_transfer")!;
    const res = await handler({
      transfers: [
        { to: "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", amount: "0.1", memo: "a" },
        { to: "Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", amount: "0.2", memo: "b" },
        { to: "Ccccccccccccccccccccccccccccccccccccccccccc", amount: "0.3" },
      ],
    });

    expect(res.content[0].text).toMatch(/Summary: 3 succeeded/);
    expect(buildTransferTx).toHaveBeenCalledTimes(3);
    const calls = (buildTransferTx as any).mock.calls;
    expect(calls[0][4]).toBe("a");
    expect(calls[1][4]).toBe("b");
    expect(calls[2][4]).toBeUndefined();
  });

  test("transfer_native idempotencyKey differs for distinct memos (memoSuffix guard)", async () => {
    const handler = handlers.get("transfer_native")!;

    await handler({
      to: "Recipient11111111111111111111111111111111111",
      amount: "0.1",
      memo: "alpha",
    });
    await handler({
      to: "Recipient11111111111111111111111111111111111",
      amount: "0.1",
      memo: "beta",
    });

    const calls = (submitter.submitAndConfirm as any).mock.calls;
    expect(calls.length).toBe(2);
    const key1 = calls[0][0].idempotencyKey;
    const key2 = calls[1][0].idempotencyKey;
    expect(key1).not.toBe(key2);
    expect(key1).toContain("-m:alpha");
    expect(key2).toContain("-m:beta");
  });
});
