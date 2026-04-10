import { rpc } from "../read/rpc-client.js";
import { lamportsToSol } from "../utils/units.js";

export interface FeeEstimate {
  totalCost: string;          // "0.001 ETO"
  totalLamports: number;
  breakdown: {
    baseFee: number;          // Transaction base fee
    priorityFee: number;      // Priority fee (congestion)
    rent: number;             // Account creation rent
    computeUnits: number;     // CU consumed
  };
  sufficient: boolean;
  walletBalance: string;
}

/** Fee schedule for common operations (in lamports) */
const FEE_SCHEDULE: Record<string, { baseFee: number; rent: number; computeUnits: number }> = {
  transfer: { baseFee: 5000, rent: 0, computeUnits: 450 },
  token_transfer: { baseFee: 5000, rent: 0, computeUnits: 4000 },
  create_account: { baseFee: 5000, rent: 890880, computeUnits: 1500 },
  create_token: { baseFee: 5000, rent: 1461600, computeUnits: 5000 },
  mint_tokens: { baseFee: 5000, rent: 0, computeUnits: 4500 },
  deploy_evm: { baseFee: 5000, rent: 0, computeUnits: 200000 },
  deploy_wasm: { baseFee: 5000, rent: 0, computeUnits: 200000 },
  deploy_move: { baseFee: 5000, rent: 0, computeUnits: 150000 },
  deploy_svm: { baseFee: 5000, rent: 0, computeUnits: 200000 },
  contract_call: { baseFee: 5000, rent: 0, computeUnits: 50000 },
  stake: { baseFee: 5000, rent: 1392000, computeUnits: 5000 },
  cross_vm_call: { baseFee: 5000, rent: 0, computeUnits: 100000 },
  create_agent: { baseFee: 5000, rent: 3571200, computeUnits: 10000 },
  create_swarm: { baseFee: 5000, rent: 14284800, computeUnits: 15000 },
};

const MINIMUM_PRIORITY_FEE = 1000; // lamports

async function getMedianPriorityFee(): Promise<number> {
  const fees = await rpc.getRecentPrioritizationFees();
  if (!fees || fees.length === 0) return MINIMUM_PRIORITY_FEE;
  const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

export async function estimateFee(operation: string, walletAddress?: string): Promise<FeeEstimate> {
  const schedule = FEE_SCHEDULE[operation] || FEE_SCHEDULE.transfer;

  let dynamicPriorityFee = MINIMUM_PRIORITY_FEE;
  try {
    const median = await getMedianPriorityFee();
    dynamicPriorityFee = Math.max(median, MINIMUM_PRIORITY_FEE);
  } catch {
    // Fall back to static minimum if dynamic fetch fails
  }

  const totalLamports = schedule.baseFee + schedule.rent + dynamicPriorityFee;

  let walletBalance = "unknown";
  let sufficient = true;

  if (walletAddress) {
    try {
      const bal = await rpc.getBalance(walletAddress);
      const balLamports = bal.value;
      walletBalance = lamportsToSol(BigInt(balLamports));
      sufficient = balLamports >= totalLamports;
    } catch {
      // Can't check balance, assume sufficient
    }
  }

  return {
    totalCost: lamportsToSol(BigInt(totalLamports)) + " ETO",
    totalLamports,
    breakdown: {
      baseFee: schedule.baseFee,
      priorityFee: dynamicPriorityFee,
      rent: schedule.rent,
      computeUnits: schedule.computeUnits,
    },
    sufficient,
    walletBalance,
  };
}

/** Get a human-readable fee summary for an operation */
export function formatFeeEstimate(est: FeeEstimate): string {
  const lines = [
    `Estimated cost: ${est.totalCost}`,
    `  Base fee: ${lamportsToSol(BigInt(est.breakdown.baseFee))} ETO (${est.breakdown.baseFee} lamports)`,
  ];
  if (est.breakdown.rent > 0) {
    lines.push(`  Rent: ${lamportsToSol(BigInt(est.breakdown.rent))} ETO (${est.breakdown.rent} lamports)`);
  }
  lines.push(`  Compute: ${est.breakdown.computeUnits} CU`);
  if (!est.sufficient) {
    lines.push(`  Warning: Insufficient balance (wallet: ${est.walletBalance} ETO)`);
  }
  return lines.join("\n");
}

/** List all known operations with their fee estimates */
export function listOperationFees(): string {
  const lines = ["Operation Fee Schedule:", ""];
  for (const [op, schedule] of Object.entries(FEE_SCHEDULE)) {
    const total = schedule.baseFee + schedule.rent;
    lines.push(`  ${op.padEnd(20)} ${lamportsToSol(BigInt(total)).padStart(12)} ETO  (${schedule.computeUnits} CU)`);
  }
  return lines.join("\n");
}
