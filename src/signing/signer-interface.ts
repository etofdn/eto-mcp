export interface Signer {
  /** Sign a transaction (raw bytes) and return signed bytes */
  sign(txBytes: Uint8Array): Promise<Uint8Array>;
  /** Get the public key (base58 SVM address) */
  getPublicKey(): string;
  /** Get the EVM address derived from this key */
  getEvmAddress(): string;
}

export interface SignerFactory {
  /** Create or retrieve a signer for the given wallet ID */
  getSigner(walletId: string): Promise<Signer>;
  /** Create a new keypair and return its wallet ID + addresses */
  createWallet(label: string): Promise<{ walletId: string; svmAddress: string; evmAddress: string }>;
  /** List all wallet IDs */
  listWallets(): Promise<string[]>;
}
