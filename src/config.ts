export const config = {
  port: parseInt(process.env.PORT || "3000"),
  etoRpcUrl: process.env.ETO_RPC_URL || "http://localhost:8899",
  network: (process.env.NETWORK || "testnet") as "mainnet" | "testnet" | "devnet",
  logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
  corsOrigins: process.env.CORS_ORIGINS || "*",

  chain: {
    id: 17743, // 0x454F
    idHex: "0x454f",
    nativeDecimals: 9,
    nativeSymbol: "ETO",
  },

  rpc: {
    cacheBalanceTtlMs: 2000,
    cacheBlockHeightTtlMs: 1000,
    cacheStatsTtlMs: 5000,
    cacheAccountTtlMs: 5000,
  },

  tx: {
    blockhashRefreshMs: 20_000,
    blockhashValidityMs: 60_000,
    defaultTimeoutMs: 30_000,
    maxRetries: 3,
    confirmationPollMs: 400,
  },

  auth: {
    sessionTtlSeconds: 300, // 5 min
    refreshTtlSeconds: 86400, // 24h
    devBypass: process.env.AUTH_DEV_BYPASS === "true",
  },

  rateLimits: {
    readPerMinute: 100,
    writePerMinute: 20,
    deployPerMinute: 5,
  },

  subscriptions: {
    pollIntervalMs: 2000,
    maxPerUser: 50,
    notificationBufferSize: 100,
  },
} as const;

export const PROGRAM_IDS = {
  system: new Uint8Array(32).fill(0),
  evm: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0xEE; return b; })(),
  wasm: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x03; return b; })(),
  move: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x02; return b; })(),
  zkVerify: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x04; return b; })(),
  zkBn254: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x05; return b; })(),
  universalToken: (() => { const b = new Uint8Array(32).fill(0xFF); b[31] = 0x06; return b; })(),
  // SPL Token program ID (Solana-compatible)
  token: Uint8Array.from([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
    28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
  ]),
  // Associated Token Account program
  ata: Uint8Array.from([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131,
    11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
  ]),
  stake: (() => {
    // "Stake11111111111111111111111111111111111111" base58 decoded
    const b = new Uint8Array(32).fill(0);
    b[0] = 0x06; b[1] = 0xa1; b[2] = 0xd8; b[3] = 0x17;
    b[4] = 0x91; b[5] = 0x37; b[6] = 0x54; b[7] = 0x2a;
    return b;
  })(),
  vote: (() => {
    const b = new Uint8Array(32).fill(0);
    b[0] = 0x07; b[1] = 0x61; b[2] = 0x48; b[3] = 0x17;
    return b;
  })(),
  agent: (() => {
    const b = new Uint8Array(32);
    b[0] = 0xA6; b[1] = 0xE7; b[2] = 0x01; b[30] = 0xAE; b[31] = 0x01;
    return b;
  })(),
  mcp: (() => {
    const b = new Uint8Array(32);
    b[0] = 0xBC; b[1] = 0xD0; b[2] = 0x01; b[30] = 0xBC; b[31] = 0x01;
    return b;
  })(),
  a2a: (() => {
    const b = new Uint8Array(32);
    b[0] = 0xA2; b[1] = 0xA0; b[2] = 0x01; b[30] = 0xA2; b[31] = 0x01;
    return b;
  })(),
  swarm: (() => {
    const b = new Uint8Array(32);
    b[0] = 0x5A; b[1] = 0xAF; b[2] = 0x01; b[30] = 0x5A; b[31] = 0x01;
    return b;
  })(),
} as const;
