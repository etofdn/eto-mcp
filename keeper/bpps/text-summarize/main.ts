/**
 * Runnable entrypoint for the `text:summarize` reference BPP (FN-075).
 *
 * Mirrors `keeper/templates/bpp/example/echo-bpp.ts`: registers the
 * AgentCard against a stub registration chain, wires an in-memory
 * event source to a `SigningRuntimeChain` over `InMemoryChain`,
 * builds a credential gate from `config.requiredBapCredentials`, and
 * pumps two synthetic events through `runBpp`.
 *
 * Set `TEXT_SUMMARIZE_FAKE=1` to force the stubbed LLM + fetcher used
 * by this example (the default — there is no production wiring yet).
 *
 * Run:  `bun run keeper/bpps/text-summarize/main.ts`
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
import {
  makeStubSigner,
  SigningRuntimeChain,
} from "./chain-adapter.js";
import { buildHandlerFromPrimitives } from "./handler.js";
import { noopPdfExtractor } from "./fetcher.js";
import type { LlmClient } from "./summarizer.js";
import type { SummarizeInput, SummarizeOutput } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Fake LLM and fake fetch (the only path supported today)                    */
/* -------------------------------------------------------------------------- */

const fakeLlm: LlmClient = {
  async summarize(req) {
    const head = req.text.slice(0, 80).replace(/\s+/g, " ").trim();
    const body =
      req.style === "bullets"
        ? `- ${head}\n- target≈${req.targetLengthWords} words\n- style=bullets`
        : `${head}\n\n(target≈${req.targetLengthWords} words, prose)`;
    return {
      markdown: [
        `# Summary`,
        ``,
        body,
        ``,
        `## Key Facts`,
        `- model=${req.modelId}`,
        `- bytes=${req.text.length}`,
      ].join("\n"),
    };
  },
};

const fakeFetch = async (url: string) => {
  const body = `Fake content fetched from ${url}.\nThis is the body.`;
  const buf = Buffer.from(body, "utf8");
  return {
    ok: true,
    status: 200,
    headers: {
      get: (n: string) => {
        const k = n.toLowerCase();
        if (k === "content-type") return "text/plain; charset=utf-8";
        if (k === "content-length") return String(buf.length);
        return null;
      },
    },
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
      return ab;
    },
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
      pda: "TextSummarizeCardPda",
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
    signer: makeStubSigner(`text-summarize:${config.authority}`),
  });

  const handler = buildHandlerFromPrimitives({
    fetchDeps: { fetch: fakeFetch, pdfExtractor: noopPdfExtractor },
    summarizeDeps: { llm: fakeLlm },
    modelId: config.modelId,
  });

  const gate = defaultCredentialGate(config.requiredBapCredentials, {
    loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
    now: () => Math.floor(Date.now() / 1000),
  });

  const done = runBpp<unknown, SummarizeOutput>(config, handler, {
    eventSource: events,
    chain,
    gate,
    logger: consoleLogger,
  });

  // 3. Push synthetic events.
  events.push(makeEvent("t-text", { source: { kind: "text", text: "hello world" } }));
  events.push(
    makeEvent("t-url", {
      source: { kind: "url", url: "https://example.com/article" },
      style: "bullets",
    }),
  );
  events.close();
  await done;

  // 4. Report.
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
  input: SummarizeInput,
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
  /text-summarize\/main\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  await main();
}
