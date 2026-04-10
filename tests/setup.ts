import type { EtoRpcClient } from "../src/read/rpc-client.js";

// Mock RPC client that returns predictable responses
export function createMockRpc(overrides: Partial<EtoRpcClient> = {}): EtoRpcClient {
  return {
    getHealth: async () => "ok",
    getSlot: async () => 12345,
    getBlockHeight: async () => 12345,
    getBalance: async (_pubkey: string) => ({ value: 1_000_000_000 }),
    getAccountInfo: async (_pubkey: string) => null,
    sendTransaction: async (_serializedTx: string) => "mock-sig-" + Math.random().toString(36).slice(2),
    getTransactionCount: async () => 42,
    faucet: async (_address: string, _amount: number) => "mock-faucet-sig",
    getTransaction: async (_signature: string) => null,
    getBlock: async (_height: number) => null,
    getRecentBlockhash: async () => ({
      blockhash: "mock-blockhash-" + Date.now(),
      lastValidBlockHeight: 99999,
    }),
    getTokenAccountsByOwner: async (_owner: string, _filter?: any) => [],
    getProgramAccounts: async (_programId: string) => [],
    getVoteAccounts: async () => ({ current: [], delinquent: [] }),
    getStakeActivation: async (_pubkey: string) => ({ state: "active", active: 0, inactive: 0 }),
    getSupply: async () => ({ value: { total: 0, circulating: 0, nonCirculating: 0 } }),
    ethChainId: async () => "0x454f",
    ethBlockNumber: async () => "0x3039",
    ethGetBalance: async (_address: string, _block?: string) => "0xde0b6b3a7640000",
    ethGetTransactionCount: async (_address: string, _block?: string) => "0x1",
    ethGetCode: async (_address: string, _block?: string) => "0x",
    ethCall: async (_tx: any, _block?: string) => "0x",
    ethEstimateGas: async (_tx: any) => "0x5208",
    ethSendRawTransaction: async (_signedTx: string) => "0x" + "0".repeat(64),
    ethGetTransactionReceipt: async (_hash: string) => null,
    ethGetTransactionByHash: async (_hash: string) => null,
    ethGetBlockByNumber: async (_height: string, _full: boolean) => null,
    ethGetLogs: async (_filter: any) => [],
    etoGetTransaction: async (_hash: string) => null,
    etoGetBlock: async (_height: number) => null,
    etoGetAccount: async (_address: string) => null,
    etoSearch: async (_query: string) => null,
    etoGetStats: async () => ({}),
    etoGetAccountTransactions: async (_address: string, _limit?: number, _offset?: number) => [],
    etoAddValidator: async (_entry: any) => true,
    etoListValidators: async () => [],
    ...overrides,
  } as unknown as EtoRpcClient;
}

// Reset any global state between tests
export function resetState(): void {
  // Clear any module-level caches or singletons if needed
}
