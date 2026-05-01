/**
 * Runnable entrypoint for the `web:research` reference BPP (FN-077).
 *
 * Mirrors `keeper/templates/bpp/example/echo-bpp.ts` and
 * `keeper/bpps/text-summarize/main.ts`: registers the AgentCard
 * against a stub registration chain, wires an in-memory event source
 * through `SigningRuntimeChain` over `InMemoryChain`, builds a
 * credential gate from `config.requiredBapCredentials`, and pumps two
 * synthetic events through `runBpp`.
 *
 * Set `WEB_RESEARCH_FAKE=1` (the default in this example) to use the
 * stubbed `FakeSearchProvider` + fake `LlmClient`. There is no
 * production wiring yet — `WEB_RESEARCH_FAKE=0` selects the
 * `HttpSearchProvider` scaffold which throws
 * `search_provider_not_configured` until follow-up tasks land the
 * real adapters.
 *
 * Run: `bun run keeper/bpps/web-research/main.ts`
 */

import {
  defaultCredentialGate,
  InMemoryChain,
  InMemoryEventSource,
  InMemoryPinner,
  registerBppAgentCard,
  runBpp,
  type BeckonInitEvent,
  type Logger,
} from "../../templates/bpp/index.js";
import { config, tags } from "./config.js";
import { makeStubSigner, SigningRuntimeChain } from "./chain-adapter.js";
import { createWebResearchHandler } from "./handler.js";
import {
  FakeSearchProvider,
  HttpSearchProvider,
  defaultFakeCorpus,
  type SearchProvider,
} from "./search-provider.js";
import type {
  LlmClient,
  LlmCompleteRequest,
  LlmCompleteResponse,
} from "./planner.js";
import type { ResearchInput, ResearchOutput } from "./types.js";
import type { FetchedPage } from "./fetcher.js";

/* -------------------------------------------------------------------------- */
/* Fake LLM (the only path supported today)                                   */
/* -------------------------------------------------------------------------- */

const fakeLlm: LlmClient = {
  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    if (req.system.startsWith("You are a research planner")) {
      const userText = req.messages[0]?.content ?? "";
      return {
        text: JSON.stringify({
          subQueries: deriveSubQueries(userText),
          rationale: "fake planner: split into 3 angles",
        }),
      };
    }
    // Synthesizer prompt.
    const userText = req.messages[0]?.content ?? "";
    const queryLine = userText.split("\n").find((l) => l.startsWith("Research query:")) ?? "Research query: ?";
    return {
      text: [
        `# Research notes — ${queryLine.replace("Research query:", "").trim()}`,
        "",
        "## Executive Summary",
        "Synthesised from injected fake sources for the worked example. [1]",
        "",
        "## Findings",
        "1. The fake corpus surfaced relevant material. [1]",
        "",
        "## Citations",
        "[1] (see citation list returned alongside this report)",
      ].join("\n"),
    };
  },
};

function deriveSubQueries(prompt: string): string[] {
  const m = /Research query:\s*(.+)/.exec(prompt);
  const q = (m?.[1] ?? "topic").trim();
  return [q, `${q} overview`, `${q} criticisms`];
}

/* -------------------------------------------------------------------------- */
/* Fake page fetcher                                                          */
/* -------------------------------------------------------------------------- */

const fakePageFetcher = async (url: string): Promise<FetchedPage> => {
  return {
    text: `Fake content fetched from ${url}.`,
    contentType: "text/plain",
    fetchedAtSec: Math.floor(Date.now() / 1000),
    sourceBytes: 64,
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
  // 1. Register AgentCard against a stub registration chain.
  const regChain = {
    findAgentCardPda: async () => null,
    registerAgent: async () => ({
      pda: "WebResearchCardPda",
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

  // 2. Wire the runtime stack.
  const events = new InMemoryEventSource<unknown>();
  const inner = new InMemoryChain();
  const chain = new SigningRuntimeChain({
    inner,
    signer: makeStubSigner(`web-research:${config.authority}`),
  });

  // Select the search provider per env. Default = fake.
  const useFake = (process.env.WEB_RESEARCH_FAKE ?? "1") !== "0";
  const search: SearchProvider = useFake
    ? new FakeSearchProvider({ corpus: defaultFakeCorpus })
    : new HttpSearchProvider({
        // The HttpSearchProvider scaffold throws until follow-up tasks
        // wire a real adapter; cast `globalThis.fetch` to its structural
        // shape just so TS accepts the construction.
        fetch: globalThis.fetch as unknown as ConstructorParameters<
          typeof HttpSearchProvider
        >[0]["fetch"],
      });

  const handler = createWebResearchHandler({
    search,
    fetcher: fakePageFetcher,
    llm: fakeLlm,
    modelId: config.modelId,
  });

  const gate = defaultCredentialGate(config.requiredBapCredentials, {
    loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
    now: () => Math.floor(Date.now() / 1000),
  });

  const done = runBpp<unknown, ResearchOutput>(config, handler, {
    eventSource: events,
    chain,
    gate,
    logger: consoleLogger,
  });

  // 3. Push synthetic events.
  events.push(makeEvent("t-solana", { query: "what is solana", depth: "standard" }));
  events.push(
    makeEvent("t-eddsa", {
      query: "ed25519 vs secp256k1",
      depth: "shallow",
      maxSources: 4,
    }),
  );
  events.close();
  await done;

  // 4. Report.
  for (const c of inner.completed) {
    const out = c.output as { result: ResearchOutput };
    consoleLogger.info("completed", {
      taskId: c.taskId,
      sourceCount: out.result.sourceCount,
      sha256: out.result.artifact.sha256,
    });
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
  input: ResearchInput,
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
  /web-research\/main\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  await main();
}
