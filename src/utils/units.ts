import type { TokenAmount } from "../models/index.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;

export function lamportsToSol(lamports: bigint | number): string {
  const l = BigInt(lamports);
  const whole = l / LAMPORTS_PER_SOL;
  const frac = l % LAMPORTS_PER_SOL;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

export function solToLamports(sol: string): bigint {
  const parts = sol.split(".");
  const whole = BigInt(parts[0] || "0") * LAMPORTS_PER_SOL;
  if (!parts[1]) return whole;
  const fracStr = parts[1].padEnd(9, "0").slice(0, 9);
  return whole + BigInt(fracStr);
}

export function toTokenAmount(
  raw: bigint | number,
  decimals: number,
  symbol?: string
): TokenAmount {
  const rawBig = BigInt(raw);
  const divisor = 10n ** BigInt(decimals);
  const whole = rawBig / divisor;
  const frac = rawBig % divisor;
  let human: string;
  if (frac === 0n) {
    human = whole.toString();
  } else {
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    human = `${whole}.${fracStr}`;
  }
  return { raw: rawBig.toString(), human, decimals, symbol };
}

export function fromHumanAmount(human: string, decimals: number): bigint {
  const parts = human.split(".");
  const whole = BigInt(parts[0] || "0") * 10n ** BigInt(decimals);
  if (!parts[1]) return whole;
  const fracStr = parts[1].padEnd(decimals, "0").slice(0, decimals);
  return whole + BigInt(fracStr);
}
