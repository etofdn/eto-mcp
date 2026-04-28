export type VmType = "svm" | "evm" | "wasm" | "move" | "zk";
export type Network = "mainnet" | "testnet" | "devnet";
export type SvmAddress = string; // base58 Ed25519 pubkey (32 bytes)
export type EvmAddress = string; // 0x-prefixed hex (20 bytes)
export type UniversalAddress = string; // either format

export interface TokenAmount {
  raw: string;
  human: string;
  decimals: number;
  symbol?: string;
}

export interface Wallet {
  id: string;
  label: string;
  svm_address: SvmAddress;
  evm_address: EvmAddress;
  key_type: "ed25519" | "secp256k1" | "hd";
  hd_path?: string;
  network: Network;
  created_at: string;
  is_active: boolean;
  custody: "local" | "privy" | "frost";
}

export interface WalletWithBalance extends Wallet {
  balance: TokenAmount;
  token_count: number;
}

export interface AccountInfo {
  address: UniversalAddress;
  svm_address: SvmAddress;
  evm_address: EvmAddress;
  balance: TokenAmount;
  owner: string;
  executable: boolean;
  data_size: number;
  rent_epoch: number;
  vm_type: VmType;
  is_token_account: boolean;
  token_info?: {
    mint: string;
    owner: string;
    amount: TokenAmount;
    decimals: number;
    frozen: boolean;
  };
  is_contract: boolean;
  contract_info?: {
    vm: VmType;
    bytecode_size: number;
    is_upgradeable: boolean;
  };
}

export interface UnifiedReceipt {
  hash: string;
  vm: VmType;
  block_height: number;
  timestamp: number;
  success: boolean;
  from: UniversalAddress;
  to: UniversalAddress | null;
  value: TokenAmount;
  gas_used: number;
  fee: TokenAmount;
  program: string;
  instruction_type: string;
  logs: string[];
  error?: TransactionError;
  state_changes: StateChange[];
  evm_receipt?: {
    contract_address?: EvmAddress;
    logs: EvmLog[];
    status: number;
  };
}

export interface TransactionError {
  code: string;
  raw_message: string;
  explanation: string;
  recovery_hints: string[];
  retryable: boolean;
}

export interface StateChange {
  address: UniversalAddress;
  field: "balance" | "data" | "owner" | "executable" | "storage";
  before: string;
  after: string;
  description: string;
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  log_index: number;
}

export interface BlockInfo {
  height: number;
  hash: string;
  parent_hash: string;
  timestamp: number;
  tx_count: number;
  successful: number;
  failed: number;
  state_root: string;
  vm_breakdown: VmBreakdown;
  gas_used: number;
  transactions?: string[];
}

export interface VmBreakdown {
  svm: number;
  evm: number;
  wasm: number;
  move: number;
  zk: number;
}

export interface ChainStats {
  block_height: number;
  tps_current: number;
  tps_peak: number;
  total_transactions: number;
  active_validators: number;
  epoch: number;
  epoch_progress: number;
  vm_breakdown_24h: VmBreakdown;
  uptime: string;
}

export interface TokenHolding {
  mint: string;
  symbol: string;
  name: string;
  balance: TokenAmount;
  vm_origin: VmType;
  frozen: boolean;
}

export interface StakePosition {
  stake_account: SvmAddress;
  validator: SvmAddress;
  amount: TokenAmount;
  status: "activating" | "active" | "deactivating" | "inactive";
  activation_epoch: number;
  deactivation_epoch?: number;
  rewards_earned: TokenAmount;
}

export interface ValidatorInfo {
  vote_account: SvmAddress;
  identity: SvmAddress;
  commission: number;
  activated_stake: TokenAmount;
  last_vote: number;
  uptime: string;
  apy_estimate: number;
}

export interface UniversalTokenHeader {
  version: number;
  vm_origin: VmType;
  mint: Uint8Array;
  owner: Uint8Array;
  amount: bigint;
  decimals: number;
  frozen: boolean;
}

export interface SimulationResult {
  success: boolean;
  state_changes: StateChange[];
  token_movements: TokenMovement[];
  gas_used: number;
  fee: number;
  logs: string[];
  error?: string;
  summary: string;
}

export interface TokenMovement {
  token: string;
  from: string;
  to: string;
  amount: string;
  decimals: number;
  human_amount: string;
}

export interface TransactionResult {
  status: "confirmed" | "finalized" | "failed" | "timeout" | "expired";
  signature: string;
  block_height?: number;
  block_hash?: string;
  timestamp?: number;
  gas_used?: number;
  fee?: number;
  receipt?: UnifiedReceipt;
  error?: TransactionError;
  retries: number;
  latency_ms: number;
  // True when this result was returned to a caller whose idempotency key
  // matched an already-in-flight submission. Lets callers detect parallel
  // coalescing instead of silently sharing a signature with another caller.
  coalesced?: boolean;
}
