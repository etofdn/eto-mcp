import type { Signer, SignerFactory } from "./signer-interface.js";

export class PrivySigner implements Signer {
  constructor(private walletId: string, private privyWalletId: string) {}

  async sign(_txBytes: Uint8Array): Promise<Uint8Array> {
    throw new Error("Privy signing not yet implemented. Use local signer for testnet.");
  }

  getPublicKey(): string {
    throw new Error("Privy signer not yet implemented");
  }

  getEvmAddress(): string {
    throw new Error("Privy signer not yet implemented");
  }
}

export class PrivySignerFactory implements SignerFactory {
  async getSigner(_walletId: string): Promise<Signer> {
    throw new Error("Privy signing not yet implemented. Use local signer for testnet.");
  }

  async createWallet(_label: string): Promise<{ walletId: string; svmAddress: string; evmAddress: string }> {
    throw new Error("Privy wallet creation not yet implemented. Use local signer for testnet.");
  }

  async listWallets(): Promise<string[]> {
    throw new Error("Privy wallet listing not yet implemented. Use local signer for testnet.");
  }
}
