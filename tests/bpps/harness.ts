/**
 * Round-trip harness for the BPP e2e test suite (FN-082).
 *
 * `roundTripBpp(opts)` wires a single BPP through:
 *   1. A per-BPP stub `BppHandler` (no real LLM/API calls)
 *   2. A `defaultCredentialGate` wrapped with a `vi.fn()` spy
 *   3. An `InMemoryChain` to record completions/failures
 *   4. An `InMemoryEventSource` with a single synthetic Init event
 *   5. `runBpp(config, handler, deps)` — the same function the BPP
 *      process calls in production
 *
 * The harness returns when `runBpp` resolves (i.e. the event source is
 * closed). Tests assert on `chain.completed`, `chain.failed`, and the
 * `gateSpy` call record.
 *
 * Real-testnet mode (`ETO_E2E=1`) is gated via a branch at the bottom
 * of this file. It is intentionally a no-op in CI unless the operator
 * has already started `eto-mcp/mesh/start.sh` and set the env var.
 *
 * NOTE: `registerBppAgentCard` is intentionally skipped here. Registration
 * is FN-073's concern and tested by `tests/unit/bpp-template.test.ts`.
 * The harness passes a pre-built `BppConfig` directly to `runBpp`.
 */

import { vi } from "vitest";
import {
  defaultCredentialGate,
  InMemoryChain,
  InMemoryEventSource,
  runBpp,
  type BppConfig,
  type BppHandler,
  type CredentialGate,
  type Logger,
} from "../../keeper/templates/bpp/index.js";
import type { AgentCardSnapshot } from "../../keeper/templates/bpp/types.js";
import { FAKE_ISSUER, VERIFIED_HUMAN_SCHEMA_HASH_HEX } from "./fixtures/credentials.js";
import { INIT_EVENTS, type BppName } from "./fixtures/intents.js";

/* -------------------------------------------------------------------------- */
/* Silent logger for the harness                                              */
/* -------------------------------------------------------------------------- */

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/* -------------------------------------------------------------------------- */
/* Per-BPP stub handlers (DI factory pattern — no vi.mock needed)            */
/* -------------------------------------------------------------------------- */

/**
 * Build a stub `BppHandler` for the named BPP.
 *
 * Each stub uses the BPP's own factory function with deterministic
 * dependencies so the full input validation pipeline runs (Zod parse,
 * error-code mapping) but no real LLM / API call is made.
 *
 * The stub handlers return a minimal but structurally-valid output that
 * satisfies the handler's own `TaskResult<TOutput>` type contract.
 */
async function buildStubHandler(bppName: BppName): Promise<BppHandler> {
  switch (bppName) {
    case "text-summarize": {
      const { createTextSummarizeHandler } = await import(
        "../../keeper/bpps/text-summarize/handler.js"
      );
      return createTextSummarizeHandler({
        fetcher: async (_src) => ({
          text: "TypeScript is a superset of JavaScript.",
          sourceBytes: 40,
          contentType: "text/plain",
        }),
        summarizer: async (_text, _opts) => ({
          markdown: "## Summary\n\nTypeScript adds static types to JavaScript.",
          sourceSha256: "a".repeat(64),
          targetLengthWords: 50,
          style: "prose" as const,
        }),
        modelId: "stub",
      });
    }

    case "code-audit-solidity": {
      const { createSolidityAuditHandler } = await import(
        "../../keeper/bpps/code-audit-solidity/handler.js"
      );
      return createSolidityAuditHandler({
        sourceLoader: async (_src) => ({
          files: [
            {
              path: "Token.sol",
              content:
                "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Token {}",
            },
          ],
          sourceBytes: 75,
        }),
        auditor: async (_files, _opts) => ({
          markdown:
            "## Audit Report\n\nNo critical vulnerabilities found in stub mode.",
          report: {
            summary: "Stub audit: no issues",
            findings: [],
            toolsRun: ["llm" as const],
          },
        }),
        modelId: "stub",
      });
    }

    case "web-research": {
      const { createWebResearchHandler } = await import(
        "../../keeper/bpps/web-research/handler.js"
      );
      const stubLlm = {
        complete: async (
          _req: unknown,
        ): Promise<{ readonly text: string }> => ({
          // Return valid planner JSON so planQueries doesn't fall back.
          // The same client is reused by the synthesizer; it returns markdown then.
          text: JSON.stringify({
            subQueries: ["Solana DeFi advantages over Ethereum"],
            rationale: "stub single query",
          }),
        }),
      };
      return createWebResearchHandler({
        search: {
          search: async (_query, _opts) => [
            {
              url: "https://example.com/solana-defi",
              title: "Solana DeFi Guide",
              snippet: "Solana is fast.",
            },
          ],
        },
        fetcher: async (_url) => ({
          text: "Solana offers fast transaction throughput beneficial for DeFi.",
          contentType: "text/plain",
          fetchedAtSec: 1_750_000_000,
          sourceBytes: 60,
        }),
        llm: stubLlm,
        modelId: "stub",
      });
    }

    case "image-generate": {
      const { createImageGenerateHandler } = await import(
        "../../keeper/bpps/image-generate/handler.js"
      );
      const { InMemoryBytesPinner } = await import(
        "../../keeper/bpps/image-generate/ipfs.js"
      );
      const stubProvider = {
        kind: "stub",
        generate: async (
          _req: unknown,
        ): Promise<{
          bytes: Uint8Array;
          mimeType: "image/png";
          modelId: string;
          providerJobId: string;
        }> => ({
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mimeType: "image/png" as const,
          modelId: "stub",
          providerJobId: "stub-job-1",
        }),
      };
      return createImageGenerateHandler({
        provider: stubProvider,
        ipfs: new InMemoryBytesPinner(),
        now: () => 1_750_000_000,
        nowMs: () => 1_750_000_000_000,
      });
    }

    case "data-analyze": {
      const { createDataAnalyzeHandler } = await import(
        "../../keeper/bpps/data-analyze/handler.js"
      );
      return createDataAnalyzeHandler({
        fetcher: async (_src) => ({
          text: "name,age,score\nAlice,30,95\nBob,25,87",
          sourceBytes: 36,
          contentType: "text/csv",
        }),
        profiler: (_text, _opts) => ({
          profile: {
            columnCount: 3,
            rowCount: 2,
            sizeBytes: 36,
            delimiter: "," as const,
            columns: [
              {
                name: "name",
                inferredType: "string" as const,
                nullRate: 0,
                distinctCount: 2,
                min: undefined,
                max: undefined,
                mean: undefined,
                stddev: undefined,
                topValues: undefined,
              },
              {
                name: "age",
                inferredType: "integer" as const,
                nullRate: 0,
                distinctCount: 2,
                min: 25,
                max: 30,
                mean: 27.5,
                stddev: 3.5,
                topValues: undefined,
              },
              {
                name: "score",
                inferredType: "integer" as const,
                nullRate: 0,
                distinctCount: 2,
                min: 87,
                max: 95,
                mean: 91,
                stddev: 5.66,
                topValues: undefined,
              },
            ],
          },
          sample: {
            columns: ["name", "age", "score"],
            head: [
              ["Alice", "30", "95"],
              ["Bob", "25", "87"],
            ],
            random: [],
          },
          truncated: false,
          columnFlags: [
            {
              highNullRate: false,
              allDistinct: true,
              monotonic: false,
              constant: false,
              outlierHeavy: false,
            },
            {
              highNullRate: false,
              allDistinct: true,
              monotonic: false,
              constant: false,
              outlierHeavy: false,
            },
            {
              highNullRate: false,
              allDistinct: true,
              monotonic: false,
              constant: false,
              outlierHeavy: false,
            },
          ],
        }),
        analyzer: async (_profile, _sample, _opts) => ({
          markdown:
            "## Analysis\n\nAlice has the highest score at 95.",
          report: {
            summary: "Small dataset with 3 columns. Alice scores highest.",
            findings: ["Alice (score=95) has the maximum value in `score`."],
            anomalies: [],
            suggestedQuestions: ["What is the average score?"],
          },
        }),
        modelId: "stub",
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* BPP configs with overridden requiredBapCredentials                        */
/* -------------------------------------------------------------------------- */

/**
 * The per-BPP production configs have `requiredBapCredentials: []`
 * (FN-081 not yet shipped). The harness overrides them with the
 * verified-human requirement so gating tests are meaningful.
 *
 * This is the exact `RequiredCredential` the harness's `CredentialGate`
 * checks, and the exact one present in `bapCardWithVerifiedHuman`.
 */
const VERIFIED_HUMAN_REQ = {
  schema: VERIFIED_HUMAN_SCHEMA_HASH_HEX,
  issuerSet: [FAKE_ISSUER],
  mustBeActive: true,
} as const;

async function buildBppConfig(bppName: BppName): Promise<BppConfig> {
  switch (bppName) {
    case "text-summarize": {
      const { config } = await import(
        "../../keeper/bpps/text-summarize/config.js"
      );
      return { ...config, requiredBapCredentials: [VERIFIED_HUMAN_REQ] };
    }
    case "code-audit-solidity": {
      const { config } = await import(
        "../../keeper/bpps/code-audit-solidity/config.js"
      );
      return { ...config, requiredBapCredentials: [VERIFIED_HUMAN_REQ] };
    }
    case "web-research": {
      const { config } = await import(
        "../../keeper/bpps/web-research/config.js"
      );
      return { ...config, requiredBapCredentials: [VERIFIED_HUMAN_REQ] };
    }
    case "image-generate": {
      const { config } = await import(
        "../../keeper/bpps/image-generate/config.js"
      );
      return { ...config, requiredBapCredentials: [VERIFIED_HUMAN_REQ] };
    }
    case "data-analyze": {
      const { config } = await import(
        "../../keeper/bpps/data-analyze/config.js"
      );
      return { ...config, requiredBapCredentials: [VERIFIED_HUMAN_REQ] };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* roundTripBpp                                                               */
/* -------------------------------------------------------------------------- */

export interface RoundTripBppOpts {
  readonly bppName: BppName;
  readonly bapCard: AgentCardSnapshot;
  readonly chain?: InMemoryChain;
}

export interface RoundTripBppResult {
  readonly chain: InMemoryChain;
  /** vi.fn() wrapping the real CredentialGate — records every invocation. */
  readonly gateSpy: ReturnType<typeof vi.fn>;
}

/**
 * Drive one BPP round-trip through `runBpp` in in-memory mode.
 *
 * 1. Builds a stub handler (factory DI, no real APIs).
 * 2. Constructs a BppConfig with `requiredBapCredentials = [verified-human]`.
 * 3. Creates a credential gate and wraps it in a vi.fn() spy.
 * 4. Pushes the per-BPP synthetic Init event and closes the source.
 * 5. Awaits `runBpp` (resolves when the source is exhausted).
 * 6. Returns the InMemoryChain and gateSpy for assertion.
 *
 * When `ETO_E2E=1` and the RPC is reachable additional on-chain
 * assertions fire inside `runBpp` via the testnet chain adapter.
 * See TODO(FN-073) comment at the bottom of this file.
 */
export async function roundTripBpp(
  opts: RoundTripBppOpts,
): Promise<RoundTripBppResult> {
  const { bppName, bapCard } = opts;
  const chain = opts.chain ?? new InMemoryChain();

  const [handler, config] = await Promise.all([
    buildStubHandler(bppName),
    buildBppConfig(bppName),
  ]);

  const eventSource = new InMemoryEventSource();

  // Build the real gate (passes through to actual credential checking).
  const realGate: CredentialGate = defaultCredentialGate(
    config.requiredBapCredentials,
    {
      loadAgentCard: async (_pubkey) => bapCard,
      now: () => 1_750_000_000,
    },
  );
  // Spy wraps the gate so tests can assert on call args while the gate
  // still runs its actual logic.
  const gateSpy = vi.fn(realGate);

  const runBppPromise = runBpp(config, handler, {
    eventSource,
    chain,
    gate: gateSpy as CredentialGate,
    logger: silentLogger,
    now: () => 1_750_000_000,
  });

  // Push the per-BPP init event and close the source so runBpp exits.
  const initEvent = INIT_EVENTS[bppName];
  eventSource.push(initEvent);
  eventSource.close();

  await runBppPromise;

  // TODO(FN-073): when ETO_E2E=1 and a real chain adapter is available,
  // add the on-chain assertion branch here — fetch the CompleteTask tx
  // and verify the 5-account ordering (auth, task, escrow,
  // receiver_wallet, receiver_card) per FN-080's buildCompleteTaskTx.
  if (process.env["ETO_E2E"] === "1") {
    // Real testnet assertions are not yet implemented because FN-073/FN-080
    // chain primitives don't yet support real RPC submission.
    // TODO(FN-073): wire RealChain adapter once the SVM tx submitter lands.
    console.log(
      `[ETO_E2E] Round-trip for ${bppName} complete (on-chain assertion pending FN-073).`,
    );
  }

  return { chain, gateSpy };
}
