import type { Signer, SignerFactory } from "./signer-interface.js";

const PRIVY_SETUP_INSTRUCTIONS =
  "Privy signer not configured. To enable:\n" +
  "  1. Set PRIVY_APP_ID and PRIVY_APP_SECRET environment variables\n" +
  "  2. See https://docs.privy.io/guide/server/wallets for integration docs\n" +
  "  3. Restart the MCP server";

export class PrivySigner implements Signer {
  constructor(private walletId: string, private privyWalletId: string) {}

  static isConfigured(): boolean {
    return !!(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
  }

  async sign(_txBytes: Uint8Array): Promise<Uint8Array> {
    throw new Error(PRIVY_SETUP_INSTRUCTIONS);
  }

  getPublicKey(): string {
    throw new Error(PRIVY_SETUP_INSTRUCTIONS);
  }

  getEvmAddress(): string {
    throw new Error(PRIVY_SETUP_INSTRUCTIONS);
  }

  async signEvm(_msgHash: Uint8Array): Promise<{ r: Uint8Array; s: Uint8Array; recoveryBit: number }> {
    throw new Error(PRIVY_SETUP_INSTRUCTIONS);
  }

  getEvmSigningAddress(): string {
    throw new Error(PRIVY_SETUP_INSTRUCTIONS);
  }
}

export class PrivySignerFactory implements SignerFactory {
  static isConfigured(): boolean {
    return !!(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
  }

  async getSigner(_walletId: string): Promise<Signer> {
    throw new Error(PRIVY_SETUP_INSTRUCTIONS);
  }

  async createWallet(_label: string): Promise<{ walletId: string; svmAddress: string; evmAddress: string }> {
    throw new Error(PRIVY_SETUP_INSTRUCTIONS);
  }

  async listWallets(): Promise<string[]> {
    throw new Error(PRIVY_SETUP_INSTRUCTIONS);
  }
}
