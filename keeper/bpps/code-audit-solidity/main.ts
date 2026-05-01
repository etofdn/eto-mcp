/**
 * Runnable entrypoint for the `code:audit:solidity` reference BPP
 * (FN-076).
 *
 * Mirrors `bpps/text-summarize/main.ts`: registers the AgentCard,
 * runs the self-skill credential preflight, wires an in-memory event
 * source to a `SigningRuntimeChain` over `InMemoryChain`, builds a
 * credential gate from `config.requiredBapCredentials`, and pumps
 * three synthetic events (one inline single-file, one inline
 * multi-file, one oversized for failure) through `runBpp`.
 *
 * Set `CODE_AUDIT_SOLIDITY_FAKE=1` for example mode (no network, no
 * real slither, fake LLM, seeded AgentCardLoader).
 *
 * Run:  `bun run keeper/bpps/code-audit-solidity/main.ts`
 */

import { schemaIdForSkill } from "../../../src/issuers/skill-cert.js";
import {
  defaultCredentialGate,
  InMemoryChain,
  InMemoryEventSource,
  InMemoryPinner,
  registerBppAgentCard,
  runBpp,
  type AgentCardSnapshot,
  type BeckonInitEvent,
  type Hex32,
  type Logger,
} from "../../templates/bpp/index.js";
import { config, tags } from "./config.js";
import { makeStubSigner, SigningRuntimeChain } from "./chain-adapter.js";
import { createSolidityAuditHandler } from "./handler.js";
import { loadSources } from "./source-loader.js";
import { runAudit } from "./auditors/index.js";
import type { LlmClient } from "./auditors/llm.js";
import type { StaticAuditorResult } from "./auditors/static.js";
import {
  assertSelfSkillCredential,
  inMemoryAgentCardLoader,
} from "./self-cred.js";
import {
  PER_FILE_MAX_BYTES,
  type AuditInput,
  type AuditOutput,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Skill schema (memoised)                                                    */
/* -------------------------------------------------------------------------- */

export const SOLIDITY_AUDIT_SCHEMA_ID: Hex32 = schemaIdForSkill("solidity-audit");

/* -------------------------------------------------------------------------- */
/* Logger                                                                     */
/* -------------------------------------------------------------------------- */

const consoleLogger: Logger = {
  info: (m, f) => console.log(`[info]  ${m} ${f ? JSON.stringify(f) : ""}`),
  warn: (m, f) => console.warn(`[warn]  ${m} ${f ? JSON.stringify(f) : ""}`),
  error: (m, f) => console.error(`[error] ${m} ${f ? JSON.stringify(f) : ""}`),
};

/* -------------------------------------------------------------------------- */
/* Fake LLM + fake static auditor (the only path supported today)             */
/* -------------------------------------------------------------------------- */

const fakeLlm: LlmClient = {
  async audit(req) {
    return {
      findings: [
        {
          id: "llm-fake-0",
          title: "Example LLM finding",
          severity: "low",
          file: req.files[0]?.path ?? "<unknown>",
          line: 1,
          description: "LLM-driven scan flagged an example issue.",
          recommendation: "Review surrounding logic.",
          source: "llm",
        },
      ],
      summary: `Audited ${req.files.length} file(s) at floor=${req.severityFloor}.`,
      markdown: "# (placeholder)",
    };
  },
};

const fakeStaticAuditor = async (): Promise<StaticAuditorResult> => ({
  available: false,
  findings: [],
  toolsRun: [],
});

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

export async function main(): Promise<void> {
  // 1. Register AgentCard against a stub registration chain.
  const regChain = {
    findAgentCardPda: async () => null,
    registerAgent: async () => ({
      pda: "CodeAuditSolidityCardPda",
      txSignature: "fake-sig",
    }),
  };
  const reg = await registerBppAgentCard(config, {
    chain: regChain,
    pinner: new InMemoryPinner(),
  });
  consoleLogger.info("registered AgentCard", {
    pda: reg.pda,
    idempotent: reg.idempotent,
  });

  // 2. Self-credential preflight.
  const issuer = config.selfCredentialIssuerSet[0]!;
  const seededCard: AgentCardSnapshot = {
    authority: config.authority,
    credentials: [
      {
        schema: SOLIDITY_AUDIT_SCHEMA_ID,
        predicateHash: "0".repeat(64),
        issuer,
        validFrom: 0,
        validUntil: 0,
        revoked: false,
      },
    ],
  };
  const ownCardLoader = inMemoryAgentCardLoader(
    new Map([[config.authority, seededCard]]),
  );
  await assertSelfSkillCredential({
    loadAgentCard: ownCardLoader,
    ownAuthority: config.authority,
    issuerSet: config.selfCredentialIssuerSet,
    schemaId: SOLIDITY_AUDIT_SCHEMA_ID,
    nowSec: () => Math.floor(Date.now() / 1000),
  });
  consoleLogger.info("self-skill credential preflight passed");

  // 3. Wire the runtime stack.
  const events = new InMemoryEventSource<unknown>();
  const inner = new InMemoryChain();
  const chain = new SigningRuntimeChain({
    inner,
    signer: makeStubSigner(`code-audit-solidity:${config.authority}`),
  });

  const handler = createSolidityAuditHandler({
    sourceLoader: (src) =>
      loadSources(src, {
        fetch: async () => {
          throw new Error("fetch_failed: example mode");
        },
      }),
    auditor: (files, opts) =>
      runAudit(files, opts, {
        staticAuditor: fakeStaticAuditor,
        llm: fakeLlm,
        now: () => Math.floor(Date.now() / 1000),
      }),
    modelId: config.modelId,
  });

  const gate = defaultCredentialGate(config.requiredBapCredentials, {
    loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
    now: () => Math.floor(Date.now() / 1000),
  });

  const done = runBpp<unknown, AuditOutput>(config, handler, {
    eventSource: events,
    chain,
    gate,
    logger: consoleLogger,
  });

  // 4. Push synthetic events.
  events.push(
    makeEvent("t-inline-1", {
      kind: "inline",
      files: [{ path: "A.sol", content: "contract A { function f() public {} }" }],
    }),
  );
  events.push(
    makeEvent("t-inline-multi", {
      kind: "inline",
      files: [
        { path: "A.sol", content: "contract A {}" },
        { path: "B.sol", content: "contract B {}" },
      ],
      severityFloor: "info",
    }),
  );
  events.push(
    makeEvent("t-bad", {
      kind: "inline",
      files: [{ path: "Big.sol", content: "a".repeat(PER_FILE_MAX_BYTES + 1) }],
    }),
  );
  events.close();
  await done;

  // 5. Report.
  for (const c of inner.completed) {
    consoleLogger.info("completed", { taskId: c.taskId });
  }
  for (const f of inner.failed) {
    consoleLogger.info("failed", { taskId: f.taskId, reason: f.reason });
  }
  consoleLogger.info("signed envelopes", {
    complete: chain.signedComplete.length,
    fail: chain.signedFail.length,
  });
}

function makeEvent(
  taskId: string,
  input: AuditInput,
): BeckonInitEvent<unknown> {
  return {
    taskId,
    bapPubkey: "BapPubkey1111111111111111111111111111111111",
    bppPubkey: config.authority,
    networkPubkey: "NetworkPubkey22222222222222222222222222222",
    action: `${tags.domain}:${tags.action}`,
    input,
    observedAt: Math.floor(Date.now() / 1000),
  };
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /code-audit-solidity\/main\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  await main();
}
