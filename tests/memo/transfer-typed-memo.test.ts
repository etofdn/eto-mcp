import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all wiring before importing the module under test so the registered
// tool handlers pick up our stubs. Each mocked module exposes the minimum
// surface registerTransferTools touches.

const buildTransferTx = vi.fn(
  (_from: string, _to: string, _lamports: bigint, _bh: string, _memo?: string) =>
    new Uint8Array([1, 2, 3]),
);

const sign = vi.fn(async (_: Uint8Array) => new Uint8Array([4, 5, 6]));
const getSigner = vi.fn(async (_id: string) => ({
  sign,
  getPublicKey: () => "FromPubKey11111111111111111111111111111111",
}));

const submit = vi.fn(async (_args: unknown) => ({
  status: "confirmed" as const,
  signature: "sig-123",
  fee: 5000,
  latency_ms: 10,
  coalesced: false,
}));

vi.mock("../../src/wasm/index.js", () => ({
  buildTransferTx: (...args: any[]) => buildTransferTx(...(args as Parameters<typeof buildTransferTx>)),
}));

vi.mock("../../src/signing/index.js", () => ({
  getSignerFactory: () => ({ getSigner: (id: string) => getSigner(id) }),
}));

vi.mock("../../src/tools/wallet.js", () => ({
  getActiveWalletId: () => "wallet-1",
}));

vi.mock("../../src/write/blockhash-cache.js", () => ({
  blockhashCache: {
    getBlockhash: async () => ({ blockhash: "BlockHash1111111111111111111111111111111" }),
    refresh: async () => ({ blockhash: "BlockHash" + Math.random().toString(36).slice(2, 10) }),
  },
}));

vi.mock("../../src/write/submitter.js", () => ({
  submitter: {
    submitAndConfirm: (args: unknown) => submit(args),
  },
}));

vi.mock("../../src/utils/address.js", () => ({
  resolveAddresses: (addr: string) => ({ svm: addr, evm: "0x" + addr.slice(0, 40) }),
}));

vi.mock("../../src/utils/units.js", () => ({
  solToLamports: (s: string) => BigInt(Math.floor(Number(s) * 1e9)),
  lamportsToSol: (l: bigint) => (Number(l) / 1e9).toString(),
}));

import { registerTransferTools } from "../../src/tools/transfer.js";

interface ToolHandlerEntry {
  schema: Record<string, unknown>;
  handler: (args: any) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function makeServer() {
  const tools = new Map<string, ToolHandlerEntry>();
  return {
    tool(
      name: string,
      _desc: string,
      schema: Record<string, unknown>,
      handler: ToolHandlerEntry["handler"],
    ) {
      tools.set(name, { schema, handler });
    },
    invoke(name: string, args: any) {
      const entry = tools.get(name);
      if (!entry) throw new Error(`tool ${name} not registered`);
      return entry.handler(args);
    },
  };
}

beforeEach(() => {
  buildTransferTx.mockClear();
  sign.mockClear();
  submit.mockClear();
  getSigner.mockClear();
});

describe("transfer_native typed_memo", () => {
  it("encodes typed_memo and forwards the envelope to buildTransferTx", async () => {
    const server = makeServer();
    registerTransferTools(server as any);

    const result = await server.invoke("transfer_native", {
      to: "Recipient1111111111111111111111111111111111",
      amount: "0.001",
      typed_memo: {
        type: "payment",
        payload: { purpose: "service", invoice_id: "inv-001" },
      },
    });

    expect(result.content[0].text).toMatch(/Transfer successful/);
    expect(buildTransferTx).toHaveBeenCalledTimes(1);
    const memoArg = buildTransferTx.mock.calls[0]![4];
    expect(typeof memoArg).toBe("string");
    const env = JSON.parse(memoArg as string);
    expect(env.schema).toBe("eto.memo.payment.v1");
    expect(env.payload).toEqual({ purpose: "service", invoice_id: "inv-001" });
  });

  it("rejects when both memo and typed_memo are provided", async () => {
    const server = makeServer();
    registerTransferTools(server as any);

    const result = await server.invoke("transfer_native", {
      to: "Recipient1111111111111111111111111111111111",
      amount: "0.001",
      memo: "free-form",
      typed_memo: {
        type: "payment",
        payload: { purpose: "service", invoice_id: "inv-001" },
      },
    });

    expect(result.content[0].text).toMatch(/Provide either `memo` or `typed_memo`/);
    expect(submit).not.toHaveBeenCalled();
    expect(buildTransferTx).not.toHaveBeenCalled();
  });

  it("returns an encode error when typed_memo.payload is invalid", async () => {
    const server = makeServer();
    registerTransferTools(server as any);

    const result = await server.invoke("transfer_native", {
      to: "Recipient1111111111111111111111111111111111",
      amount: "0.001",
      typed_memo: {
        type: "payment",
        payload: { purpose: "not-an-enum" }, // missing invoice_id, bad enum
      },
    });

    expect(result.content[0].text).toMatch(/Error encoding typed_memo/);
    expect(submit).not.toHaveBeenCalled();
    expect(buildTransferTx).not.toHaveBeenCalled();
  });
});

describe("batch_transfer typed_memo", () => {
  it("encodes per-entry typed_memo via encodeMemo", async () => {
    const server = makeServer();
    registerTransferTools(server as any);

    const result = await server.invoke("batch_transfer", {
      transfers: [
        {
          to: "Recipient1111111111111111111111111111111111",
          amount: "0.001",
          typed_memo: {
            type: "coordination_log",
            payload: { event: "task_offered", task_id: "t-1", actor: "did:eto:a" },
          },
        },
      ],
    });

    expect(result.content[0].text).toMatch(/1 succeeded/);
    expect(buildTransferTx).toHaveBeenCalledTimes(1);
    const memo = buildTransferTx.mock.calls[0]![4];
    const env = JSON.parse(memo as string);
    expect(env.type).toBe("coordination_log");
  });

  it("fails just the offending entry on conflicting memo + typed_memo", async () => {
    const server = makeServer();
    registerTransferTools(server as any);

    const result = await server.invoke("batch_transfer", {
      transfers: [
        {
          to: "Recipient1111111111111111111111111111111111",
          amount: "0.001",
          memo: "freeform",
          typed_memo: { type: "payment", payload: { purpose: "service", invoice_id: "i" } },
        },
        {
          to: "Recipient2222222222222222222222222222222222",
          amount: "0.001",
          typed_memo: { type: "payment", payload: { purpose: "tip", invoice_id: "i2" } },
        },
      ],
    });

    expect(result.content[0].text).toMatch(/1 succeeded, 1 failed/);
    expect(buildTransferTx).toHaveBeenCalledTimes(1);
  });
});
