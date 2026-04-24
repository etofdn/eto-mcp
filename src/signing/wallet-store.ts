import { scrypt } from "@noble/hashes/scrypt";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { mkdir, readFile, rename, writeFile, stat } from "fs/promises";

const WALLET_DIR = process.env.ETO_WALLET_DIR || join(homedir(), ".eto", "wallets");
const LEGACY_WALLET_PATH = join(homedir(), ".eto", "wallets.enc");

export interface WalletData {
  label: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

// File format: salt(32) + nonce(12) + tag(16) + ciphertext
const SALT_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export class WalletStore {
  private key: Uint8Array | null = null;
  private _passphrase: string | null = null;
  private _cachedKey: { salt: Uint8Array; key: Uint8Array; N: number } | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly scope: string;

  constructor(scope: string = "__default__") {
    this.scope = scope;
    const passphrase = process.env.ETO_WALLET_PASSPHRASE;
    if (passphrase) {
      // We defer key derivation to load/save so we can use the stored salt
      // Mark as configured with a sentinel; actual key derived per operation
      this._passphrase = passphrase;
    }
  }

  isConfigured(): boolean {
    return this._passphrase !== null;
  }

  private walletPath(): string {
    return join(WALLET_DIR, `${this.scope}.enc`);
  }

  /** Plaintext sidecar file storing only the active wallet id (no key material). */
  static activeWalletPath(scope: string): string {
    return join(WALLET_DIR, `${scope}.active`);
  }

  async readActive(): Promise<string | null> {
    try {
      const raw = (await readFile(WalletStore.activeWalletPath(this.scope), "utf8")).trim();
      return raw.length > 0 ? raw : null;
    } catch {
      return null;
    }
  }

  async writeActive(walletId: string | null): Promise<void> {
    const path = WalletStore.activeWalletPath(this.scope);
    await mkdir(WALLET_DIR, { recursive: true });
    if (walletId === null || walletId === "") {
      await writeFile(path, "", { mode: 0o600 });
      return;
    }
    const tmp = path + ".tmp";
    await writeFile(tmp, walletId, { mode: 0o600 });
    await rename(tmp, path);
  }

  beginLoad(onLoaded: (wallets: Map<string, WalletData>) => void): void {
    this.loadPromise = this.load().then(onLoaded).catch(err => {
      console.error("[eto-mcp] Failed to load persisted wallets:", err);
    });
  }

  async ensureLoaded(): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise;
    }
  }

  // OWASP Password Storage Cheat Sheet (2025) minimum for scrypt: N=2^17, r=8, p=1.
  // Legacy files produced before 2026-04 used N=2^12 — we try the current
  // parameters first and fall back to the legacy params on decrypt failure so
  // existing deployments transparently migrate (re-saved on the next save()).
  private static readonly SCRYPT_N_CURRENT = 2 ** 17;
  private static readonly SCRYPT_N_LEGACY = 2 ** 12;

  private deriveKey(salt: Uint8Array, N: number = WalletStore.SCRYPT_N_CURRENT): Uint8Array {
    // Cache derived key per session so scrypt only runs once per passphrase+salt+N.
    // Length check is required — without it a cached salt that's a prefix of
    // `salt` (or vice-versa) compares equal under .every and silently returns
    // the wrong cached key.
    if (
      this._cachedKey
      && this._cachedKey.N === N
      && this._cachedKey.salt.length === salt.length
      && this._cachedKey.salt.every((v, i) => v === salt[i])
    ) {
      return this._cachedKey.key;
    }
    const key = scrypt(this._passphrase!, salt, { N, r: 8, p: 1, dkLen: 32 });
    this._cachedKey = { salt: new Uint8Array(salt), key, N };
    return key;
  }

  async save(wallets: Map<string, WalletData>): Promise<void> {
    if (!this._passphrase) return;

    // Serialize wallet map to JSON-safe structure
    const plain: Record<string, { label: string; privateKey: string; publicKey: string }> = {};
    for (const [id, w] of wallets) {
      plain[id] = {
        label: w.label,
        privateKey: Buffer.from(w.privateKey).toString("hex"),
        publicKey: Buffer.from(w.publicKey).toString("hex"),
      };
    }
    const plaintext = Buffer.from(JSON.stringify(plain), "utf8");

    const salt = randomBytes(SALT_LEN);
    const nonce = randomBytes(NONCE_LEN);
    const key = this.deriveKey(salt);

    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload = Buffer.concat([salt, nonce, tag, ciphertext]);

    // Atomic write: write to tmp, then rename
    await mkdir(WALLET_DIR, { recursive: true });
    const walletPath = this.walletPath();
    const tmp = walletPath + ".tmp";
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, walletPath);
  }

  async load(): Promise<Map<string, WalletData>> {
    const wallets = new Map<string, WalletData>();
    if (!this._passphrase) return wallets;

    // One-shot migration of the legacy single-file store into the __stdio__ scope.
    // If we're loading __stdio__ and the new file does NOT exist, but the legacy
    // file does, decrypt from legacy → save under the new scope → rename legacy
    // to ".migrated" so it never re-runs. Idempotent.
    if (this.scope === "__stdio__") {
      await this.migrateLegacyIfNeeded();
    }

    let payload: Buffer;
    try {
      payload = await readFile(this.walletPath());
    } catch {
      // File doesn't exist yet — return empty map
      return wallets;
    }

    if (payload.length < SALT_LEN + NONCE_LEN + TAG_LEN) {
      console.error("[eto-mcp] Wallet file too short, ignoring");
      return wallets;
    }

    return this.decryptPayload(payload) ?? wallets;
  }

  private decryptPayload(payload: Buffer): Map<string, WalletData> | null {
    const salt = payload.subarray(0, SALT_LEN);
    const nonce = payload.subarray(SALT_LEN, SALT_LEN + NONCE_LEN);
    const tag = payload.subarray(SALT_LEN + NONCE_LEN, SALT_LEN + NONCE_LEN + TAG_LEN);
    const ciphertext = payload.subarray(SALT_LEN + NONCE_LEN + TAG_LEN);

    // Try current params first, then legacy (N=2^12) for files produced by
    // older versions. On legacy success we log once so the operator knows the
    // next save() will upgrade the file in place.
    for (const N of [WalletStore.SCRYPT_N_CURRENT, WalletStore.SCRYPT_N_LEGACY]) {
      const key = this.deriveKey(salt, N);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const plain = JSON.parse(plaintext.toString("utf8")) as Record<
          string,
          { label: string; privateKey: string; publicKey: string }
        >;
        const wallets = new Map<string, WalletData>();
        for (const [id, w] of Object.entries(plain)) {
          wallets.set(id, {
            label: w.label,
            privateKey: Uint8Array.from(Buffer.from(w.privateKey, "hex")),
            publicKey: Uint8Array.from(Buffer.from(w.publicKey, "hex")),
          });
        }
        if (N === WalletStore.SCRYPT_N_LEGACY) {
          console.error(
            `[eto-mcp] Loaded wallets from legacy (N=2^12) scrypt params; next save() will re-encrypt under N=2^17`,
          );
        }
        return wallets;
      } catch {
        // try next N
      }
    }
    console.error("[eto-mcp] Failed to decrypt wallet file — wrong passphrase or corrupted data");
    return null;
  }

  private async migrateLegacyIfNeeded(): Promise<void> {
    // Only run if legacy file exists and new scoped file does not.
    const newPath = this.walletPath();
    let newExists = false;
    try {
      await stat(newPath);
      newExists = true;
    } catch {
      // not there — proceed
    }
    if (newExists) return;

    let legacyBuf: Buffer;
    try {
      legacyBuf = await readFile(LEGACY_WALLET_PATH);
    } catch {
      return; // nothing to migrate
    }

    if (legacyBuf.length < SALT_LEN + NONCE_LEN + TAG_LEN) return;

    const decrypted = this.decryptPayload(legacyBuf);
    if (!decrypted) return;

    await this.save(decrypted);
    try {
      await rename(LEGACY_WALLET_PATH, LEGACY_WALLET_PATH + ".migrated");
    } catch (e) {
      console.error("[eto-mcp] Migrated legacy wallets but could not rename legacy file:", e);
    }
    console.error("[eto-mcp] Migrated legacy wallets.enc into scoped store (__stdio__).");
  }
}
