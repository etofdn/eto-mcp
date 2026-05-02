/**
 * IPFS pinning surface for the `image:generate` BPP (FN-078).
 *
 * Mirrors the `IpfsPinner` shape used by `eto-mcp/src/issuers/...` but
 * adds a binary-pin method (`pinBytes`) since image artifacts are not
 * JSON. The interface name is intentionally distinct
 * (`BppIpfsPinner`) to avoid colliding with the issuer-side
 * `IpfsPinner.pin(jcsCanonicalJson)` and `IpfsPinner.pinJson(...)`
 * shapes already in tree.
 *
 * Two real adapters are shipped — `Web3StoragePinner` and
 * `PinataPinner` — plus an `InMemoryBytesPinner` for tests. Real CID
 * encoding is delegated to whichever upstream pinner is configured;
 * the in-memory pinner returns a synthetic `bafy<sha256>` placeholder
 * that is documented as test-only (production pinners return real
 * CIDv1 strings).
 */

import { createHash } from "node:crypto";

export interface PinResult {
  readonly uri: string;
  readonly cid: string;
  readonly size: number;
}

export interface PinOpts {
  readonly mimeType: string;
  readonly filename?: string;
}

export interface BppIpfsPinner {
  readonly kind: string;
  pinBytes(bytes: Uint8Array, opts: PinOpts): Promise<PinResult>;
}

export type FetchLike = typeof globalThis.fetch;

export interface PinnerDeps {
  readonly fetch?: FetchLike;
}

/* -------------------------------------------------------------------------- */
/* web3.storage                                                               */
/* -------------------------------------------------------------------------- */

export const WEB3_STORAGE_UPLOAD_URL = "https://api.web3.storage/upload";

interface Web3StorageResponse {
  readonly cid?: string;
}

export class Web3StoragePinner implements BppIpfsPinner {
  public readonly kind = "web3.storage";
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  public constructor(opts: { token?: string } = {}, deps: PinnerDeps = {}) {
    const token = opts.token ?? process.env.WEB3_STORAGE_TOKEN;
    if (!token) throw new Error("ipfs_unconfigured: web3.storage");
    this.token = token;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  public async pinBytes(bytes: Uint8Array, opts: PinOpts): Promise<PinResult> {
    // Wrap bytes in a fresh ArrayBuffer-backed Blob so the fetch BodyInit
    // typings accept it across runtimes (raw Uint8Array isn't a BodyInit).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const body = new Blob([ab], { type: opts.mimeType });
    const resp = await this.fetchImpl(WEB3_STORAGE_UPLOAD_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": opts.mimeType,
      },
      body,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`ipfs_error: web3.storage ${resp.status} ${txt}`);
    }
    const data = (await resp.json()) as Web3StorageResponse;
    if (!data.cid) {
      throw new Error("ipfs_error: web3.storage response missing cid");
    }
    return {
      cid: data.cid,
      uri: `ipfs://${data.cid}`,
      size: bytes.byteLength,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Pinata                                                                     */
/* -------------------------------------------------------------------------- */

export const PINATA_PIN_FILE_URL =
  "https://api.pinata.cloud/pinning/pinFileToIPFS";

interface PinataResponse {
  readonly IpfsHash?: string;
  readonly PinSize?: number;
}

export class PinataPinner implements BppIpfsPinner {
  public readonly kind = "pinata";
  private readonly jwt: string;
  private readonly fetchImpl: FetchLike;

  public constructor(opts: { jwt?: string } = {}, deps: PinnerDeps = {}) {
    const jwt = opts.jwt ?? process.env.PINATA_JWT;
    if (!jwt) throw new Error("ipfs_unconfigured: pinata");
    this.jwt = jwt;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  public async pinBytes(bytes: Uint8Array, opts: PinOpts): Promise<PinResult> {
    const fd = new FormData();
    const filename = opts.filename ?? "artifact.bin";
    // Copy into a fresh ArrayBuffer so the Blob constructor types
    // accept a SharedArrayBuffer-free view across runtimes.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab], { type: opts.mimeType });
    fd.append("file", blob, filename);
    const resp = await this.fetchImpl(PINATA_PIN_FILE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.jwt}` },
      body: fd,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`ipfs_error: pinata ${resp.status} ${txt}`);
    }
    const data = (await resp.json()) as PinataResponse;
    if (!data.IpfsHash) {
      throw new Error("ipfs_error: pinata response missing IpfsHash");
    }
    return {
      cid: data.IpfsHash,
      uri: `ipfs://${data.IpfsHash}`,
      size: data.PinSize ?? bytes.byteLength,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory test pinner                                                      */
/* -------------------------------------------------------------------------- */

export interface InMemoryPinRecord {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
  readonly cid: string;
}

/**
 * Deterministic test pinner: `cid = "bafy" + sha256(bytes).hex`. The
 * `bafy` prefix is purely a convention so the test output looks
 * IPFS-shaped. Production pinners return real CIDv1 strings.
 */
export class InMemoryBytesPinner implements BppIpfsPinner {
  public readonly kind = "inmemory";
  public readonly pinned: InMemoryPinRecord[] = [];

  public async pinBytes(bytes: Uint8Array, opts: PinOpts): Promise<PinResult> {
    const hex = createHash("sha256").update(bytes).digest("hex");
    const cid = `bafy${hex}`;
    const rec: InMemoryPinRecord = {
      bytes: new Uint8Array(bytes),
      mimeType: opts.mimeType,
      ...(opts.filename !== undefined ? { filename: opts.filename } : {}),
      cid,
    };
    this.pinned.push(rec);
    return { uri: `ipfs://${cid}`, cid, size: bytes.byteLength };
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export interface PinnerEnv {
  readonly IPFS_PINNER?: string;
  readonly WEB3_STORAGE_TOKEN?: string;
  readonly PINATA_JWT?: string;
}

/**
 * Pick a real pinner from env. `IPFS_PINNER` overrides the auto-pick:
 *
 *   - `web3.storage`       → `Web3StoragePinner`
 *   - `pinata`             → `PinataPinner`
 *   - `inmemory`           → `InMemoryBytesPinner` (tests/dev only)
 *
 * If unset, web3.storage wins when its token is present, else pinata
 * when its JWT is present. If nothing is configured, throws
 * `ipfs_unconfigured`.
 */
export function selectIpfsPinner(
  env: PinnerEnv = process.env as PinnerEnv,
  deps: PinnerDeps = {},
): BppIpfsPinner {
  const requested = env.IPFS_PINNER;
  if (requested === "inmemory") return new InMemoryBytesPinner();
  const w3 = env.WEB3_STORAGE_TOKEN;
  const pin = env.PINATA_JWT;
  if (requested === "web3.storage") {
    return new Web3StoragePinner(w3 !== undefined ? { token: w3 } : {}, deps);
  }
  if (requested === "pinata") {
    return new PinataPinner(pin !== undefined ? { jwt: pin } : {}, deps);
  }
  if (w3) return new Web3StoragePinner({ token: w3 }, deps);
  if (pin) return new PinataPinner({ jwt: pin }, deps);
  throw new Error("ipfs_unconfigured");
}
