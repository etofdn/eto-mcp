/**
 * Synthetic `BeckonInitEvent` fixtures for the BPP e2e test suite (FN-082).
 *
 * One realistic Init event per reference BPP. Inputs conform to each
 * BPP's Zod schema so stub handlers can parse them cleanly and produce
 * `{ status: "success" }` results in the round-trip harness.
 */

import type { BeckonInitEvent } from "../../../keeper/templates/bpp/types.js";
import { BAP_WITH_CRED_PUBKEY } from "./agent-cards.js";

/** Capability tag strings identifying the five reference BPPs. */
export type BppCapabilityTag =
  | "text:summarize"
  | "code:audit:solidity"
  | "web:research"
  | "image:generate"
  | "data:analyze";

export const BPP_NAMES = [
  "text-summarize",
  "code-audit-solidity",
  "web-research",
  "image-generate",
  "data-analyze",
] as const;

export type BppName = (typeof BPP_NAMES)[number];

// Fixed pubkeys used across all events — only the `action` and `input` differ.
const BPP_PUBKEY = "BppAgentCardPubkey111111111111111111111111111";
const NETWORK_PUBKEY = "NetworkPubkey1111111111111111111111111111111";
const NOW_SEC = 1_750_000_000; // deterministic; does not need to be wall-clock

function makeEvent<T>(
  taskId: string,
  action: BppCapabilityTag,
  input: T,
): BeckonInitEvent<T> {
  return {
    taskId,
    bapPubkey: BAP_WITH_CRED_PUBKEY,
    bppPubkey: BPP_PUBKEY,
    networkPubkey: NETWORK_PUBKEY,
    action,
    input,
    observedAt: NOW_SEC,
  };
}

/** One synthetic Init event per BPP, keyed by BppName. */
export const INIT_EVENTS = {
  "text-summarize": makeEvent("task-text-001", "text:summarize", {
    source: {
      kind: "text" as const,
      text: "TypeScript is a superset of JavaScript that adds static type checking.",
    },
    targetLengthWords: 50,
    style: "prose" as const,
  }),

  "code-audit-solidity": makeEvent(
    "task-code-001",
    "code:audit:solidity",
    {
      kind: "inline" as const,
      files: [
        {
          path: "Token.sol",
          content: [
            "// SPDX-License-Identifier: MIT",
            "pragma solidity ^0.8.20;",
            "contract Token {",
            "  mapping(address => uint256) public balances;",
            "  function mint(address to, uint256 amt) external { balances[to] += amt; }",
            "}",
          ].join("\n"),
        },
      ],
      severityFloor: "low" as const,
    },
  ),

  "web-research": makeEvent("task-web-001", "web:research", {
    query: "What are the main benefits of Solana over Ethereum for DeFi?",
    depth: "shallow" as const,
    maxSources: 3,
  }),

  "image-generate": makeEvent("task-img-001", "image:generate", {
    prompt: "A futuristic city skyline at sunset with flying vehicles",
    width: 512,
    height: 512,
    steps: 20,
  }),

  "data-analyze": makeEvent("task-data-001", "data:analyze", {
    source: {
      kind: "csv" as const,
      text: [
        "name,age,score",
        "Alice,30,95",
        "Bob,25,87",
        "Carol,35,92",
        "Dave,28,78",
      ].join("\n"),
    },
    hasHeader: true,
    question: "Who has the highest score?",
  }),
} satisfies Record<BppName, BeckonInitEvent<unknown>>;
