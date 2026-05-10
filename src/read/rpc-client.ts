import { config } from "../config.js";
import { log } from "../utils/logger.js";

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * FN-197: validate that a string looks like a real on-chain transaction
 * signature before letting it leave the RPC client. `faucet` is SVM-only,
 * so we accept base58 only with the strict bounds called out in the
 * FN-097 error-masking audit: 43–88 chars from the base58 alphabet
 * (Solana mainnet sigs decode to 64 bytes → 87–88 base58 chars; 43 is
 * the lower bound for short test payloads). Hex responses are themselves
 * a smell — they indicate the node is running a non-SVM mock — so they
 * are rejected. This closes the JSON.stringify-of-an-error-object
 * masking case identified by FN-097.
 *
 * FN-089: also applied to `sendTransaction` and `ethSendRawTransaction`
 * results so misbehaving devnet nodes can't propagate a garbage string
 * into `pollConfirmation` and produce a spurious timeout.
 */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;
/** EVM tx hash: 0x followed by exactly 64 hex chars (32 bytes). */
const HEX_SIG_RE = /^0x[0-9a-fA-F]{64}$/;

function isValidSignature(s: string): boolean {
  if (typeof s !== "string") return false;
  if (s.length === 0) return false;
  return BASE58_RE.test(s);
}

/** FN-089: validate an EVM tx hash returned by eth_sendRawTransaction. */
function isValidEvmTxHash(s: string): boolean {
  if (typeof s !== "string") return false;
  return HEX_SIG_RE.test(s);
}

export class EtoRpcClient {
  private endpoint: string;
  private counter = 0;

  constructor(endpoint?: string) {
    this.endpoint = endpoint ?? config.etoRpcUrl;
  }

  private async call<T>(method: string, params: any[] = []): Promise<T> {
    const id = ++this.counter;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const start = performance.now();

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const ms = (performance.now() - start).toFixed(1);
    log("debug", "rpc", `${method} ${ms}ms`, { id });

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }

    const json = (await response.json()) as JsonRpcResponse<T>;

    if (json.error) {
      throw new Error(
        `JSON-RPC error ${json.error.code}: ${json.error.message}`
      );
    }

    // FN-198: a malformed response with neither a `result` nor `error`
    // field used to slip through as `undefined` and surface downstream
    // as a phantom value (e.g. `JSON.stringify(undefined)` → `undefined`).
    // Reject explicitly so the caller learns the node is misbehaving.
    if (json.result === undefined) {
      throw new Error(
        `JSON-RPC response for ${method} has neither result nor error field`,
      );
    }

    return json.result as T;
  }

  // Solana-Compatible Methods

  getHealth(): Promise<string> {
    return this.call<string>("getHealth");
  }

  getSlot(): Promise<number> {
    return this.call<number>("getSlot");
  }

  getBlockHeight(): Promise<number> {
    return this.call<number>("getBlockHeight");
  }

  getBalance(pubkey: string): Promise<{ value: number }> {
    return this.call<{ value: number }>("getBalance", [pubkey]);
  }

  getAccountInfo(pubkey: string): Promise<any> {
    return this.call<any>("getAccountInfo", [pubkey]);
  }

  async sendTransaction(serializedTx: string): Promise<string> {
    const sig = await this.call<string>("sendTransaction", [serializedTx]);
    // FN-089: validate the returned value is a real base58 signature so that
    // a misbehaving devnet node can't inject a garbage string into
    // pollConfirmation and produce a spurious "not found" / timeout.
    if (!isValidSignature(sig)) {
      throw new Error(
        `sendTransaction returned non-signature response (got ${typeof sig}: ${JSON.stringify(sig).slice(0, 200)})`,
      );
    }
    return sig;
  }

  getTransactionCount(): Promise<number> {
    return this.call<number>("getTransactionCount");
  }

  async faucet(address: string, amount: number): Promise<string> {
    const result: any = await this.call<any>("faucet", [address, amount]);
    const candidate =
      result?.signature ?? result?.txhash ?? result?.tx_hash ??
      (typeof result === "string" ? result : null);
    // FN-197 / FN-198: never fall back to JSON.stringify(result) — that
    // turned a rate-limit error or a phantom-faucet payload into a
    // string callers treated as a real signature. Validate, or throw.
    // The chain-side mock-faucet replacement is tracked as FN-196.
    if (!candidate || !isValidSignature(candidate)) {
      throw new Error(
        `faucet returned non-signature response (got ${typeof result}: ${JSON.stringify(
          result,
        ).slice(0, 200)}). The local node may be running a mock faucet; see FN-196.`,
      );
    }
    return candidate;
  }

  getTransaction(signature: string): Promise<any> {
    return this.call<any>("getTransaction", [signature]);
  }

  getBlock(height: number): Promise<any> {
    return this.call<any>("getBlock", [height]);
  }

  async getRecentBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const result = await this.call<any>("getRecentBlockhash");
    const bh = result?.value?.blockhash ?? result?.blockhash ?? result;
    const height = result?.value?.lastValidBlockHeight ?? result?.context?.slot ?? 0;
    return { blockhash: bh, lastValidBlockHeight: height };
  }

  async getTokenAccountsByOwner(owner: string, filter?: { mint: string } | { programId: string }): Promise<any[]> {
    const params = filter
      ? [owner, filter]
      : [owner, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }];
    const result: any = await this.call<any>("getTokenAccountsByOwner", params);
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.value)) return result.value;
    return [];
  }

  getProgramAccounts(programId: string): Promise<any[]> {
    return this.call<any[]>("getProgramAccounts", [programId]);
  }

  getVoteAccounts(): Promise<any> {
    return this.call<any>("getVoteAccounts");
  }

  getStakeActivation(pubkey: string): Promise<any> {
    return this.call<any>("getStakeActivation", [pubkey]);
  }

  getSupply(): Promise<any> {
    return this.call<any>("getSupply");
  }

  // Ethereum-Compatible Methods

  ethChainId(): Promise<string> {
    return this.call<string>("eth_chainId");
  }

  ethBlockNumber(): Promise<string> {
    return this.call<string>("eth_blockNumber");
  }

  ethGetBalance(address: string, block?: string): Promise<string> {
    return this.call<string>("eth_getBalance", [address, block ?? "latest"]);
  }

  ethGetTransactionCount(address: string, block?: string): Promise<string> {
    return this.call<string>("eth_getTransactionCount", [
      address,
      block ?? "latest",
    ]);
  }

  ethGetCode(address: string, block?: string): Promise<string> {
    return this.call<string>("eth_getCode", [address, block ?? "latest"]);
  }

  ethCall(
    tx: { from?: string; to: string; data: string; value?: string },
    block?: string
  ): Promise<string> {
    return this.call<string>("eth_call", [tx, block ?? "latest"]);
  }

  ethEstimateGas(tx: {
    from?: string;
    to: string;
    data?: string;
    value?: string;
  }): Promise<string> {
    return this.call<string>("eth_estimateGas", [tx]);
  }

  async ethSendRawTransaction(signedTx: string): Promise<string> {
    const hash = await this.call<string>("eth_sendRawTransaction", [signedTx]);
    // FN-089: validate the returned value is a real EVM tx hash (0x + 64 hex
    // chars) so a misbehaving node can't propagate a garbage string into callers.
    if (!isValidEvmTxHash(hash)) {
      throw new Error(
        `eth_sendRawTransaction returned non-hash response (got ${typeof hash}: ${JSON.stringify(hash).slice(0, 200)})`,
      );
    }
    return hash;
  }

  ethGetTransactionReceipt(hash: string): Promise<any> {
    return this.call<any>("eth_getTransactionReceipt", [hash]);
  }

  ethGetTransactionByHash(hash: string): Promise<any> {
    return this.call<any>("eth_getTransactionByHash", [hash]);
  }

  ethGetBlockByNumber(height: string, full: boolean): Promise<any> {
    return this.call<any>("eth_getBlockByNumber", [height, full]);
  }

  ethGetLogs(filter: {
    address?: string;
    topics?: string[];
    fromBlock?: string;
    toBlock?: string;
  }): Promise<any[]> {
    return this.call<any[]>("eth_getLogs", [filter]);
  }

  // ETO Unified Methods

  etoGetTransaction(hash: string): Promise<any> {
    return this.call<any>("eto_getTransaction", [hash]);
  }

  etoGetBlock(height: number): Promise<any> {
    return this.call<any>("eto_getBlock", [height]);
  }

  etoGetAccount(address: string): Promise<any> {
    return this.call<any>("eto_getAccount", [address]);
  }

  etoSearch(query: string): Promise<any> {
    return this.call<any>("eto_search", [query]);
  }

  etoGetStats(): Promise<any> {
    return this.call<any>("eto_getStats");
  }

  etoGetAccountTransactions(
    address: string,
    limit?: number,
    offset?: number
  ): Promise<any[]> {
    return this.call<any[]>("eto_getAccountTransactions", [
      address,
      limit ?? 20,
      offset ?? 0,
    ]);
  }

  // Validator Methods

  etoAddValidator(entry: any): Promise<boolean> {
    return this.call<boolean>("eto_addValidator", [entry]);
  }

  etoListValidators(): Promise<any[]> {
    return this.call<any[]>("eto_listValidators");
  }

  getRecentPrioritizationFees(addresses?: string[]): Promise<Array<{ slot: number; prioritizationFee: number }>> {
    const params: any[] = addresses && addresses.length > 0 ? [addresses] : [];
    return this.call<Array<{ slot: number; prioritizationFee: number }>>("getRecentPrioritizationFees", params);
  }
}

export const rpc = new EtoRpcClient();
