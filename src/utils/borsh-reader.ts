// Minimal Borsh-compatible reader for parsing on-chain account data.
// Matches the layout produced by `borsh::to_vec(...)` in the Rust runtime
// (LE integers, Vec/String prefixed by u32 LE length, fixed-size arrays raw).
import bs58 from "bs58";

export class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  pos(): number {
    return this.offset;
  }

  remaining(): number {
    return this.buf.length - this.offset;
  }

  skip(n: number): void {
    this.offset += n;
  }

  readU8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  readU32(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readU64(): bigint {
    const lo = this.buf.readUInt32LE(this.offset);
    const hi = this.buf.readUInt32LE(this.offset + 4);
    this.offset += 8;
    return BigInt(hi) * 0x100000000n + BigInt(lo);
  }

  readBytes(n: number): Buffer {
    const b = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }

  readString(): string {
    const n = this.readU32();
    return this.readBytes(n).toString("utf8");
  }

  readPubkey(): string {
    return bs58.encode(this.readBytes(32));
  }

  readVecU8(): Buffer {
    const n = this.readU32();
    return this.readBytes(n);
  }

  readOption<T>(reader: (r: BorshReader) => T): T | null {
    const tag = this.readU8();
    return tag === 0 ? null : reader(this);
  }
}

/**
 * Decode an account.data field that may be base64 string, base58 string,
 * `[base64Str, "base64"]` tuple, or a Buffer/Uint8Array. Returns Buffer or null.
 */
export function decodeAccountData(data: any): Buffer | null {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") {
    // SVM RPC default is base58 for getAccountInfo without encoding param,
    // but our calls usually return base64. Try base64 first, base58 fallback.
    try {
      return Buffer.from(data, "base64");
    } catch {
      try {
        return Buffer.from(bs58.decode(data));
      } catch {
        return null;
      }
    }
  }
  if (Array.isArray(data)) {
    const [str, enc] = data;
    if (typeof str === "string") {
      const e = (enc as string) || "base64";
      if (e === "base64") return Buffer.from(str, "base64");
      if (e === "base58") return Buffer.from(bs58.decode(str));
      if (e === "hex") return Buffer.from(str, "hex");
    }
  }
  return null;
}
