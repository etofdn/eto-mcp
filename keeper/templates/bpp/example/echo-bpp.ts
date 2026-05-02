/**
 * Worked example: a minimal BPP that echoes its input.
 *
 * Demonstrates all four template extension points:
 *  1. `BppConfig` — name, authority, capability tags.
 *  2. `CapabilityTags` — `util:echo` v1.0.0 with no required credentials.
 *  3. `BppHandler` — returns `{ echoed: req.input.message }`.
 *  4. Credential gate — `defaultCredentialGate([], …)` as a no-op.
 *
 * Pumps two synthetic `BeckonInitEvent`s through `runBpp` and prints
 * the chain-side result. Runs without any RPC connection.
 */

import {
  defaultCredentialGate,
  InMemoryChain,
  InMemoryEventSource,
  InMemoryPinner,
  registerBppAgentCard,
  runBpp,
  type BeckonInitEvent,
  type BppConfig,
  type BppHandler,
  type CapabilityTags,
} from "../index.js";

interface EchoIn {
  readonly message: string;
}
interface EchoOut {
  readonly echoed: string;
}

const tags: CapabilityTags = {
  domain: "util",
  action: "echo",
  version: "1.0.0",
  price: { amount: "0", currency: "ETO" },
  requiredCredentials: [],
  description: "Echo BPP — returns the input message verbatim.",
};

const config: BppConfig = {
  name: "echo-bpp",
  modelId: "claude-haiku-test",
  authority: "EchoBppAuthority1111111111111111111111111111",
  capabilityTags: tags,
  requiredBapCredentials: [],
};

const handler: BppHandler<EchoIn, EchoOut> = {
  async handleTask(req) {
    return { status: "success", output: { echoed: req.input.message } };
  },
};

const consoleLogger = {
  info: (msg: string, fields?: Record<string, unknown>) =>
    console.log(`[info]  ${msg} ${fields ? JSON.stringify(fields) : ""}`),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    console.warn(`[warn]  ${msg} ${fields ? JSON.stringify(fields) : ""}`),
  error: (msg: string, fields?: Record<string, unknown>) =>
    console.error(`[error] ${msg} ${fields ? JSON.stringify(fields) : ""}`),
};

async function main(): Promise<void> {
  // Stub registration against an in-memory chain.
  const regChain = {
    findAgentCardPda: async () => null,
    registerAgent: async () => ({
      pda: "EchoCardPda",
      txSignature: "fake-sig",
    }),
  };
  const reg = await registerBppAgentCard(config, {
    chain: regChain,
    pinner: new InMemoryPinner(),
  });
  console.log(`registered AgentCard pda=${reg.pda} idempotent=${reg.idempotent}`);

  const events = new InMemoryEventSource<EchoIn>();
  const chain = new InMemoryChain();
  const gate = defaultCredentialGate(config.requiredBapCredentials, {
    loadAgentCard: async () => ({ authority: "BAP", credentials: [] }),
    now: () => Math.floor(Date.now() / 1000),
  });

  const done = runBpp<EchoIn, EchoOut>(config, handler, {
    eventSource: events,
    chain,
    gate,
    logger: consoleLogger,
  });

  events.push(makeEvent("t1", "hello"));
  events.push(makeEvent("t2", "world"));
  events.close();
  await done;

  for (const c of chain.completed) {
    console.log(`completed task ${c.taskId} → ${JSON.stringify(c.output)}`);
  }
  for (const f of chain.failed) {
    console.log(`failed task ${f.taskId} reason=${f.reason}`);
  }
}

function makeEvent(taskId: string, message: string): BeckonInitEvent<EchoIn> {
  return {
    taskId,
    bapPubkey: "BapPubkey1111111111111111111111111111111111",
    bppPubkey: config.authority,
    networkPubkey: "NetworkPubkey22222222222222222222222222222",
    action: "util:echo",
    input: { message },
    observedAt: Math.floor(Date.now() / 1000),
  };
}

await main();
