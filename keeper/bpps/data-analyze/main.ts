/**
 * Runnable entrypoint for the `data:analyze` reference BPP (FN-079).
 *
 * Mirrors `keeper/bpps/text-summarize/main.ts`: registers the
 * AgentCard against a stub registration chain, wires an in-memory
 * event source to a `SigningRuntimeChain` over `InMemoryChain`,
 * builds a credential gate from `config.requiredBapCredentials`, and
 * pumps three synthetic events through `runBpp` (one inline `csv`,
 * one `url`, one oversized failure case).
 *
 * Set `DATA_ANALYZE_FAKE=1` to force the stubbed LLM + fetcher used
 * by this example (the default — there is no production wiring yet).
 *
 * Run: `bun run keeper/bpps/data-analyze/main.ts`
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
import {
  makeStubSigner,
  SigningRuntimeChain,
} from "./chain-adapter.js";
import { buildHandlerFromPrimitives } from "./handler.js";
import type { LlmClient } from "./analyzers/planner.js";
import type { AnalyzeInput, AnalyzeOutput, AnalysisReport } from "./types.js";
import {
  assertSelfSkillCredential,
  inMemoryAgentCardLoader,
} from "./self-cred.js";

/* -------------------------------------------------------------------------- */
/* Skill schema (memoised)                                                    */
/* -------------------------------------------------------------------------- */

export const DATA_ANALYZE_SCHEMA_ID: Hex32 = schemaIdForSkill("data-analyze");

/* -------------------------------------------------------------------------- */
/* Fake LLM and fake fetch                                                    */
/* -------------------------------------------------------------------------- */

const fakeLlm: LlmClient = {
  async analyze(req): Promise<AnalysisReport> {
    const cols = req.profile.columns.map((c) => c.name).join(", ");
    return {
      summary: `Profiled ${req.profile.rowCount} rows × ${req.profile.columnCount} columns.`,
      findings: [
        `Columns: ${cols}.`,
        `First inferred type: ${req.profile.columns[0]?.inferredType ?? "?"}.`,
      ],
      anomalies: [],
      suggestedQuestions: ["What is the trend over time?"],
      ...(req.question !== undefined
        ? { answer: `Re: "${req.question}" — see findings.` }
        : {}),
    };
  },
};

const fakeFetch = async (url: string) => {
  const body = "name,age,score\nAlice,30,95.5\nBob,42,80.0\nCarol,29,88.2\n";
  const buf = Buffer.from(body, "utf8");
  return {
    ok: true,
    status: 200,
    headers: {
      get: (n: string) => {
        const k = n.toLowerCase();
        if (k === "content-type") return "text/csv; charset=utf-8";
        if (k === "content-length") return String(buf.length);
        return null;
      },
    },
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
      return ab;
    },
    _url: url,
  };
};

/* -------------------------------------------------------------------------- */
/* Logger                                                                     */
/* -------------------------------------------------------------------------- */

const consoleLogger: Logger = {
  info: (m, f) => console.log(`[info]  ${m} ${f ? JSON.stringify(f) : ""}`),
  warn: (m, f) => console.warn(`[warn]  ${m} ${f ? JSON.stringify(f) : ""}`),
  error: (m, f) => console.error(`[error] ${m} ${f ? JSON.stringify(f) : ""}`),
};

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

export async function main(): Promise<void> {
  // 1. Register AgentCard.
  const regChain = {
    findAgentCardPda: async () => null,
    registerAgent: async () => ({
      pda: "DataAnalyzeCardPda",
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
  const devIssuer = "SkillCertIssuerDevPubkey1111111111111111111";
  const issuerSet = (process.env.DATA_ANALYZE_SELF_ISSUERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const resolvedIssuers = issuerSet.length > 0 ? issuerSet : [devIssuer];
  const seededCard: AgentCardSnapshot = {
    authority: config.authority,
    credentials: [
      {
        schema: DATA_ANALYZE_SCHEMA_ID,
        predicateHash: "0".repeat(64),
        issuer: resolvedIssuers[0]!,
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
    issuerSet: resolvedIssuers,
    schemaId: DATA_ANALYZE_SCHEMA_ID,
    nowSec: () => Math.floor(Date.now() / 1000),
  });
  consoleLogger.info("self-skill credential preflight passed");

  // 3. Wire the runtime stack.
  const events = new InMemoryEventSource<unknown>();
  const inner = new InMemoryChain();
  const chain = new SigningRuntimeChain({
    inner,
    signer: makeStubSigner(`data-analyze:${config.authority}`),
  });

  const handler = buildHandlerFromPrimitives({
    fetchDeps: { fetch: fakeFetch },
    analyzeDeps: { llm: fakeLlm },
    modelId: config.modelId,
  });

  const gate = defaultCredentialGate(config.requiredBapCredentials, {
    loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
    now: () => Math.floor(Date.now() / 1000),
  });

  const done = runBpp<unknown, AnalyzeOutput>(config, handler, {
    eventSource: events,
    chain,
    gate,
    logger: consoleLogger,
  });

  // 4. Push synthetic events.
  events.push(
    makeEvent("t-csv", {
      source: {
        kind: "csv",
        text: "a,b,c\n1,2,3\n4,5,6\n7,8,9\n",
      },
      question: "Are columns related?",
    }),
  );
  events.push(
    makeEvent("t-url", {
      source: { kind: "url", url: "https://example.com/data.csv" },
    }),
  );
  // Oversized inline csv → schema rejects → failTask.
  events.push(
    makeEvent("t-too-large", {
      source: { kind: "csv", text: "a\n" + "x".repeat(9 * 1024 * 1024) },
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
  input: AnalyzeInput,
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
  /data-analyze\/main\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  await main();
}
