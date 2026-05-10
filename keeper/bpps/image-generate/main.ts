/**
 * Runnable entrypoint for the `image:generate` reference BPP (FN-078).
 *
 * Mirrors `keeper/templates/bpp/example/echo-bpp.ts` and the FN-075
 * `text:summarize` `main.ts`: registers the AgentCard against a stub
 * registration chain, wires an in-memory event source to a
 * `SigningRuntimeChain` over `InMemoryChain`, builds a credential
 * gate from `config.requiredBapCredentials`, and pushes a couple of
 * synthetic events through `runBpp`.
 *
 * `IMAGE_GENERATE_FAKE=1` (or no provider env present) forces the
 * deterministic `FakeImageProvider` + `InMemoryBytesPinner` so the
 * example runs offline. Real provider/pinner wiring is auto-picked
 * from env when keys are present.
 *
 * Run:  `bun run keeper/bpps/image-generate/main.ts`
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
import { createImageGenerateHandler } from "./handler.js";
import {
  FakeImageProvider,
  resolveProviderConfigFromEnv,
  selectProvider,
  type ImageProvider,
} from "./providers/index.js";
import {
  InMemoryBytesPinner,
  selectIpfsPinner,
  type BppIpfsPinner,
} from "./ipfs.js";
import type { ImageGenerateInput, ImageGenerateOutput } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Logger                                                                     */
/* -------------------------------------------------------------------------- */

const consoleLogger: Logger = {
  info: (m, f) => console.log(`[info]  ${m} ${f ? JSON.stringify(f) : ""}`),
  warn: (m, f) => console.warn(`[warn]  ${m} ${f ? JSON.stringify(f) : ""}`),
  error: (m, f) => console.error(`[error] ${m} ${f ? JSON.stringify(f) : ""}`),
};

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

function wireProvider(): ImageProvider {
  if (process.env.IMAGE_GENERATE_FAKE === "1") {
    return new FakeImageProvider();
  }
  const cfg = resolveProviderConfigFromEnv();
  if (!cfg) {
    consoleLogger.warn(
      "no provider env set; falling back to FakeImageProvider",
    );
    return new FakeImageProvider();
  }
  return selectProvider(cfg);
}

function wirePinner(): BppIpfsPinner {
  if (process.env.IMAGE_GENERATE_FAKE === "1") {
    return new InMemoryBytesPinner();
  }
  try {
    return selectIpfsPinner();
  } catch (err) {
    consoleLogger.warn("no IPFS pinner env set; using InMemoryBytesPinner", {
      error: (err as Error).message,
    });
    return new InMemoryBytesPinner();
  }
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

export async function main(): Promise<void> {
  const regChain = {
    findAgentCardPda: async () => null,
    registerAgent: async () => ({
      pda: "ImageGenerateCardPda",
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

  const events = new InMemoryEventSource<unknown>();
  const inner = new InMemoryChain();
  const chain = new SigningRuntimeChain({
    inner,
    signer: makeStubSigner(`image-generate:${config.authority}`),
  });

  const handler = createImageGenerateHandler({
    provider: wireProvider(),
    ipfs: wirePinner(),
  });

  const gate = defaultCredentialGate(config.requiredBapCredentials, {
    loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
    now: () => Math.floor(Date.now() / 1000),
  });

  const done = runBpp<unknown, ImageGenerateOutput>(config, handler, {
    eventSource: events,
    chain,
    gate,
    logger: consoleLogger,
  });

  events.push(
    makeEvent("t-cat", {
      prompt: "a serene tabby cat in a sunlit window",
      width: 512,
      height: 512,
      steps: 4,
    }),
  );
  events.push(
    makeEvent("t-mountain", {
      prompt: "snow-capped mountain at dusk, cinematic",
      width: 1024,
      height: 1024,
      steps: 4,
    }),
  );
  events.close();
  await done;

  for (const c of inner.completed) {
    const out = c.output as { result?: ImageGenerateOutput };
    consoleLogger.info("completed", {
      taskId: c.taskId,
      ipfsUri: out.result?.artifact.ipfsUri,
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
  input: ImageGenerateInput,
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
  /image-generate\/main\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  await main();
}
