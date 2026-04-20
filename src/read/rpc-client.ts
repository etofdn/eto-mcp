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

  sendTransaction(serializedTx: string): Promise<string> {
    return this.call<string>("sendTransaction", [serializedTx]);
  }

  getTransactionCount(): Promise<number> {
    return this.call<number>("getTransactionCount");
  }

  async faucet(address: string, amount: number): Promise<string> {
    const result: any = await this.call<any>("faucet", [address, amount]);
    return result?.signature ?? result?.txhash ?? result?.tx_hash ?? (typeof result === "string" ? result : JSON.stringify(result));
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

  ethSendRawTransaction(signedTx: string): Promise<string> {
    return this.call<string>("eth_sendRawTransaction", [signedTx]);
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
