/**
 * Runnable entrypoint for the bank-as-BPP keeper module
 * (FN-096 / T-3.9.1.2).
 *
 * Mirrors `keeper/bpps/text-summarize/main.ts`:
 *   1. Registers the bank AgentCard against a stub registration chain.
 *   2. Publishes the multi-capability `BankCatalog` as a signed
 *      `CatalogCommitPayload` via `InMemoryCatalogCommitRecorder`.
 *   3. Wires `InMemoryEventSource` + `SigningRuntimeChain(InMemoryChain)`,
 *      runs `runBpp` with the umbrella config.
 *   4. Pushes one `BeckonInitEvent` per capability (five total) and
 *      asserts each is recorded as `failed` with a reason starting
 *      `not_implemented:`.
 *   5. Logs a summary including `catalogHash`, `commitSignature`,
 *      `networkIdHex`, and the count of registered capabilities (5).
 *
 * Run:  `bun run keeper/bpps/bank/main.ts`
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
import { config, catalog } from "./config.js";
import { BANK_CAPABILITY_KEYS } from "./catalog.js";
import { makeStubSigner, SigningRuntimeChain } from "./chain-adapter.js";
import { createBankHandler } from "./handler.js";
import {
  InMemoryCatalogCommitRecorder,
  publishBankCatalog,
} from "./catalog-publisher.js";

/* -------------------------------------------------------------------------- */
/* Logger                                                                     */
/* -------------------------------------------------------------------------- */

const consoleLogger: Logger = {
  info: (m, f) => console.log(`[info]  ${m}${f ? " " + JSON.stringify(f) : ""}`),
  warn: (m, f) => console.warn(`[warn]  ${m}${f ? " " + JSON.stringify(f) : ""}`),
  error: (m, f) =>
    console.error(`[error] ${m}${f ? " " + JSON.stringify(f) : ""}`),
};

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

export async function main(): Promise<void> {
  // 1. Register AgentCard against a stub registration chain.
  const regChain = {
    findAgentCardPda: async () => null,
    registerAgent: async () => ({
      pda: "BankBppAgentCardPda111111111111111111111111",
      txSignature: "fake-reg-sig",
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

  // 2. Publish CatalogCommit (in-memory recorder, stub signer).
  const signer = makeStubSigner(`bank-bpp:${config.authority}`);
  const recorder = new InMemoryCatalogCommitRecorder();
  const published = await publishBankCatalog({
    catalog,
    networkPubkey: "BankNetworkPubkey111111111111111111111111111",
    recorder,
    signer,
  });
  consoleLogger.info("CatalogCommit published", {
    catalogHash: published.commitHash,
    signature: published.signature.slice(0, 16) + "…",
    capabilities: catalog.capabilities.length,
    networkIdHex: catalog.networkIdHex.slice(0, 16) + "…",
  });

  // 3. Wire the runtime stack.
  const events = new InMemoryEventSource<unknown>();
  const inner = new InMemoryChain();
  const chain = new SigningRuntimeChain({
    inner,
    signer,
  });
  const handler = createBankHandler({
    now: () => Math.floor(Date.now() / 1000),
  });
  const gate = defaultCredentialGate(config.requiredBapCredentials, {
    loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
    now: () => Math.floor(Date.now() / 1000),
  });

  const done = runBpp(config, handler, {
    eventSource: events,
    chain,
    gate,
    logger: consoleLogger,
  });

  // 4. Push one BeckonInitEvent per bank capability (five total).
  for (const key of BANK_CAPABILITY_KEYS) {
    events.push(makeEvent(key));
  }
  events.close();
  await done;

  // 5. Assert all five events are recorded as failed with not_implemented.
  const failed = inner.failed;
  const notImplCount = failed.filter((f) =>
    f.reason.includes("not_implemented:"),
  ).length;
  if (notImplCount !== BANK_CAPABILITY_KEYS.length) {
    const details = failed.map((f) => `${f.taskId}: ${f.reason}`).join(", ");
    throw new Error(
      `Expected all ${BANK_CAPABILITY_KEYS.length} capabilities to return ` +
        `not_implemented, but got ${notImplCount}. Details: ${details}`,
    );
  }

  // 6. Log summary.
  consoleLogger.info("bank BPP smoke check complete", {
    catalogHash: published.commitHash,
    commitSignature: published.signature.slice(0, 16) + "…",
    networkIdHex: catalog.networkIdHex,
    registeredCapabilities: catalog.capabilities.length,
    failedEvents: failed.length,
    allNotImplemented: notImplCount === BANK_CAPABILITY_KEYS.length,
  });

  for (const f of failed) {
    consoleLogger.info("failed (not_implemented)", {
      taskId: f.taskId,
      reason: f.reason,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeEvent(action: string): BeckonInitEvent<unknown> {
  return {
    taskId: `bank-smoke-${action}`,
    bapPubkey: "BapPubkey1111111111111111111111111111111111",
    bppPubkey: config.authority,
    networkPubkey: "BankNetworkPubkey111111111111111111111111111",
    action,
    input: {},
    observedAt: Math.floor(Date.now() / 1000),
  };
}

/* -------------------------------------------------------------------------- */
/* Self-execution guard (mirrors text-summarize/main.ts pattern)              */
/* -------------------------------------------------------------------------- */

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /bank\/main\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  await main();
}
