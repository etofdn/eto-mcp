import type { Signer, SignerFactory } from "./signer-interface.js";
import bs58 from "bs58";

const SIGNING_SERVICE_URL = process.env.SIGNING_SERVICE_URL || "http://127.0.0.1:9100";

interface DkgResponse {
  key_id: string;
  public_key: string;      // base58
  public_key_hex: string;
  shares: { share_index: number; share_hex: string }[];
}

interface SignResponse {
  signature: string;        // hex
  public_key: string;       // base58
  key_id: string;
}

async function signingServiceCall<T>(method: string, path: string, body?: any): Promise<T> {
  const response = await fetch(`${SIGNING_SERVICE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Signing service error (${response.status}): ${err}`);
  }
  return response.json() as Promise<T>;
}

export class FrostSigner implements Signer {
  constructor(
    private keyId: string,
    private publicKeyBase58: string,
    private shareIndices: [number, number] = [1, 2],
  ) {}

  async sign(txBytes: Uint8Array): Promise<Uint8Array> {
    // Parse the message bytes from the Borsh-serialized transaction
    const sigCount = new DataView(txBytes.buffer, txBytes.byteOffset, 4).getUint32(0, true);
    const messageOffset = 4 + sigCount * 64;
    const messageBytes = txBytes.slice(messageOffset);

    // Call signing service
    const response = await signingServiceCall<SignResponse>("POST", "/sign", {
      key_id: this.keyId,
      message_hex: Buffer.from(messageBytes).toString("hex"),
      share_indices: this.shareIndices,
    });

    // Parse signature (64 bytes hex)
    const sigBytes = Buffer.from(response.signature, "hex");

    // Replace first signature slot in the transaction
    const result = new Uint8Array(txBytes);
    result.set(new Uint8Array(sigBytes), 4);
    return result;
  }

  getPublicKey(): string {
    return this.publicKeyBase58;
  }

  getEvmAddress(): string {
    const pubkeyBytes = bs58.decode(this.publicKeyBase58);
    const last20 = pubkeyBytes.slice(12);
    return "0x" + Buffer.from(last20).toString("hex");
  }

  async signEvm(_msgHash: Uint8Array): Promise<{ r: Uint8Array; s: Uint8Array; recoveryBit: number }> {
    throw new Error("EVM signing not supported for FrostSigner");
  }

  getEvmSigningAddress(): string {
    throw new Error("EVM signing not supported for FrostSigner");
  }
}

// In-memory mapping of walletId → keyId + publicKey
const frostWallets = new Map<string, { keyId: string; publicKey: string; label: string }>();

export class FrostSignerFactory implements SignerFactory {
  async createWallet(label: string): Promise<{ walletId: string; svmAddress: string; evmAddress: string }> {
    // Call DKG endpoint on signing service
    const dkg = await signingServiceCall<DkgResponse>("POST", "/dkg");

    const walletId = crypto.randomUUID();
    frostWallets.set(walletId, {
      keyId: dkg.key_id,
      publicKey: dkg.public_key,
      label,
    });

    const signer = new FrostSigner(dkg.key_id, dkg.public_key);
    return {
      walletId,
      svmAddress: dkg.public_key,
      evmAddress: signer.getEvmAddress(),
    };
  }

  async getSigner(walletId: string): Promise<Signer> {
    const entry = frostWallets.get(walletId);
    if (!entry) throw new Error(`FROST wallet not found: ${walletId}`);
    return new FrostSigner(entry.keyId, entry.publicKey);
  }

  async listWallets(): Promise<string[]> {
    return Array.from(frostWallets.keys());
  }
}

export const frostSignerFactory = new FrostSignerFactory();
