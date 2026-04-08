import { localSignerFactory } from "./local-signer.js";
import { frostSignerFactory } from "./frost-signer.js";
import type { SignerFactory } from "./signer-interface.js";

export function getSignerFactory(): SignerFactory {
  // If FROST signing service is configured, use it
  if (process.env.SIGNING_SERVICE_URL) {
    return frostSignerFactory;
  }
  // Default: local signer for dev/testnet
  return localSignerFactory;
}

export { localSignerFactory } from "./local-signer.js";
export { frostSignerFactory } from "./frost-signer.js";
export type { Signer, SignerFactory } from "./signer-interface.js";
