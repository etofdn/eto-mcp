import bs58 from "bs58";
import { rpc } from "./rpc-client.js";

export interface TokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  createdAt?: string;
}

// In-memory registry — populated by create_token and manual registration
const metadataRegistry = new Map<string, TokenMetadata>();

// Well-known tokens (pre-populated)
metadataRegistry.set("native", {
  mint: "native",
  name: "ETO",
  symbol: "ETO",
  decimals: 9,
  supply: 0n,
  mintAuthority: null,
  freezeAuthority: null,
});

export function registerTokenMetadata(metadata: TokenMetadata): void {
  metadataRegistry.set(metadata.mint, metadata);
}

export async function getTokenMetadata(mint: string): Promise<TokenMetadata | null> {
  // Check registry first
  const cached = metadataRegistry.get(mint);
  if (cached) return cached;

  // Try to parse from on-chain data
  try {
    const accountInfo = await rpc.getAccountInfo(mint);
    if (!accountInfo) return null;

    const data = accountInfo?.value?.data ?? accountInfo?.data;
    if (!data) return null;

    // Decode raw bytes from the account data field
    let bytes: Uint8Array;
    if (typeof data === "string") {
      bytes = new Uint8Array(Buffer.from(data, "base64"));
    } else if (Array.isArray(data)) {
      bytes = new Uint8Array(Buffer.from(data[0], data[1]));
    } else {
      return null;
    }

    // SPL Mint layout (82 bytes minimum):
    //   [0]      : mint_authority option tag (0 = None, 1 = Some)
    //   [1..33]  : mint_authority pubkey (32 bytes, only if tag == 1)
    //   [36..44] : supply (u64 LE) — offset 36 = 4 (option header) + 32 (authority)
    //   [44]     : decimals (u8)
    //   [45]     : is_initialized (u8)
    //   [46]     : freeze_authority option tag
    //   [47..79] : freeze_authority pubkey (32 bytes, only if tag == 1)
    if (bytes.length < 82) return null;

    const hasMintAuth = bytes[0] === 1;
    const mintAuthority = hasMintAuth ? encodePubkey(bytes.slice(1, 33)) : null;

    const supplyOffset = 36;
    const supply = readU64LE(bytes, supplyOffset);
    const decimals = bytes[supplyOffset + 8];
    const isInitialized = bytes[supplyOffset + 9];

    if (!isInitialized) return null;

    const hasFreezeAuth = bytes[supplyOffset + 10] === 1;
    const freezeAuthority = hasFreezeAuth
      ? encodePubkey(bytes.slice(supplyOffset + 11, supplyOffset + 43))
      : null;

    // Generate a name from the mint address (no on-chain metadata program yet)
    const shortMint = mint.slice(0, 6);
    const metadata: TokenMetadata = {
      mint,
      name: `Token ${shortMint}`,
      symbol: shortMint.toUpperCase(),
      decimals,
      supply,
      mintAuthority,
      freezeAuthority,
    };

    // Cache it
    metadataRegistry.set(mint, metadata);
    return metadata;
  } catch {
    return null;
  }
}

export function listKnownTokens(): TokenMetadata[] {
  return Array.from(metadataRegistry.values());
}

function encodePubkey(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}
