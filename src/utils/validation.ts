import { z } from "zod";
import { isValidSvmAddress, isValidEvmAddress } from "./address.js";

export const addressSchema = z.string().refine(
  (addr) => isValidSvmAddress(addr) || isValidEvmAddress(addr),
  "Invalid address: must be base58 (SVM) or 0x-prefixed hex (EVM)"
);

export const amountSchema = z.string().refine((amt) => {
  try {
    const parts = amt.split(".");
    if (parts.length > 2) return false;
    const whole = BigInt(parts[0] || "0");
    if (whole < 0n) return false;
    return true;
  } catch {
    return false;
  }
}, "Amount must be a valid non-negative number");

export const vmSchema = z.enum(["svm", "evm", "wasm", "move", "zk"]);
export const networkSchema = z.enum(["mainnet", "testnet", "devnet"]);

export const walletIdSchema = z.string().min(1, "Wallet ID required");

export const pubkeySchema = z.string().refine(
  (addr) => isValidSvmAddress(addr),
  "Invalid SVM address (base58, 32 bytes)"
);

export const evmAddressSchema = z.string().refine(
  (addr) => isValidEvmAddress(addr),
  "Invalid EVM address (0x + 40 hex chars)"
);

export const base64Schema = z.string().refine((s) => {
  try {
    return Buffer.from(s, "base64").length > 0;
  } catch {
    return false;
  }
}, "Invalid base64 string");

export const hexSchema = z.string().refine(
  (s) => /^(0x)?[0-9a-fA-F]*$/.test(s),
  "Invalid hex string"
);
