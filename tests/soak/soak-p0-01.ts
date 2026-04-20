#!/usr/bin/env bun
/**
 * Soak test for MCP-P0-01:
 * "100 restarts of the SSE server, same thirdweb address re-auths every time,
 *  wallets survive every restart, active wallet survives every restart,
 *  zero 'Wallet not found' errors."
 *
 * Each iteration:
 *   1. Spawn `bun run src/sse-server.ts` on PORT=8081.
 *   2. Wait for /health to 200 (<=15s).
 *   3. SIWE auth via thirdweb /auth/login + /auth/verify using a fixed private key.
 *   4. Open GET /sse, parse `sessionId` from the first `event: endpoint` frame,
 *      hold the stream open.
 *   5. Drive MCP tool calls on POST /message?sessionId=... with Bearer token.
 *      - Iteration 0: tools/list (smoke), list_wallets, create_wallet, set_active_wallet
 *      - Iterations 1..99: session_info (fallback list_wallets) and assert survival.
 *   6. Close SSE, SIGTERM the child, SIGKILL after 3s if still alive.
 *   7. Record row { iter, boot_ms, wallet_present, active_match, errors[] }.
 *
 * After the loop, write tests/soak/soak-report.{json,md} and exit 0 iff
 * wallet_losses === 0 && active_losses === 0 && errors_total === 0.
 *
 * Run:
 *   export THIRDWEB_CLIENT_ID=...
 *   export THIRDWEB_SECRET_KEY=...
 *   export ETO_WALLET_PASSPHRASE=...
 *   export SOAK_PRIVKEY=0x<64-hex>
 *   bun run tests/soak/soak-p0-01.ts --yes
 */

import { spawn, type Subprocess } from "bun";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// ---------- thirdweb imports (version ^5) ----------
// Uses the published subpath exports: `thirdweb/wallets` + `thirdweb/auth`.
import { privateKeyToAccount } from "thirdweb/wallets";
import { createThirdwebClient } from "thirdweb";
import { signLoginPayload } from "thirdweb/auth";

// ---------- Config ----------
const PORT = 8081;
const BASE = `http://localhost:${PORT}`;
const ITERATIONS = 100;
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const SIGKILL_GRACE_MS = 3_000;
const CHAIN_ID = 1;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT_JSON = join(ROOT, "tests", "soak", "soak-report.json");
const REPORT_MD = join(ROOT, "tests", "soak", "soak-report.md");

// ---------- Required env ----------
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[soak] Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

const THIRDWEB_CLIENT_ID = requireEnv("THIRDWEB_CLIENT_ID");
const THIRDWEB_SECRET_KEY = requireEnv("THIRDWEB_SECRET_KEY");
const ETO_WALLET_PASSPHRASE = requireEnv("ETO_WALLET_PASSPHRASE");
const SOAK_PRIVKEY_RAW = requireEnv("SOAK_PRIVKEY");
const SOAK_PRIVKEY = SOAK_PRIVKEY_RAW.startsWith("0x")
  ? SOAK_PRIVKEY_RAW
  : (`0x${SOAK_PRIVKEY_RAW}` as `0x${string}`);

// ---------- Confirmation gate ----------
async function confirmOrDie() {
  const yes = process.argv.includes("--yes") || process.argv.includes("-y");
  if (yes) return;
  console.error(
    "[soak] This harness wipes ~/.eto/wallets/<address>.enc and .active for the soak address.",
  );
  console.error("[soak] Re-run with --yes to proceed, or Ctrl-C to abort.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer: string = await new Promise((resolve) =>
    rl.question("[soak] Type 'yes' to continue: ", (a) => {
      rl.close();
      resolve(a);
    }),
  );
  if (answer.trim().toLowerCase() !== "yes") {
    console.error("[soak] Aborted.");
    process.exit(1);
  }
}

// ---------- Wallet-file cleanup for soak address ----------
async function wipeSoakWalletFiles(address: string) {
  const lower = address.toLowerCase();
  const dir = join(homedir(), ".eto", "wallets");
  // TODO: The persisted wallet filename is `<session.sub>.enc`. For SIWE-based
  // thirdweb auth `sub` is typically the lowercased address, but this is an
  // assumption — verify against the concurrent auth implementation. If `sub`
  // differs, update this path or call session_info after first auth to learn
  // the real `scope` and remove that file instead.
  const candidates = [
    join(dir, `${lower}.enc`),
    join(dir, `${lower}.active`),
    join(dir, `${address}.enc`),
    join(dir, `${address}.active`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        await rm(p, { force: true });
        console.error(`[soak] removed ${p}`);
      } catch (err) {
        console.error(`[soak] could not remove ${p}:`, err);
      }
    }
  }
}

// ---------- Child-process lifecycle ----------
type Child = {
  proc: Subprocess;
  stderrDrain: Promise<void>;
};

function spawnServer(): Child {
  const proc = spawn({
    cmd: ["bun", "run", "src/sse-server.ts"],
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_DEV_BYPASS: "false",
      THIRDWEB_CLIENT_ID,
      THIRDWEB_SECRET_KEY,
      ETO_WALLET_PASSPHRASE,
      PORT: String(PORT),
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Drain stderr so the pipe doesn't fill and block the child.
  const stderrDrain = (async () => {
    const r = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done } = await r.read();
        if (done) break;
      }
    } catch {
      // child was killed; ignore
    }
  })();

  // Drain stdout too.
  (async () => {
    const r = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done } = await r.read();
        if (done) break;
      }
    } catch {
      /* ignore */
    }
  })();

  return { proc, stderrDrain };
}

async function killServer(child: Child) {
  try {
    child.proc.kill(15); // SIGTERM
  } catch {
    /* already dead */
  }
  const timer = setTimeout(() => {
    try {
      child.proc.kill(9);
    } catch {
      /* ignore */
    }
  }, SIGKILL_GRACE_MS);
  try {
    await child.proc.exited;
  } catch {
    /* ignore */
  }
  clearTimeout(timer);
  try {
    await child.stderrDrain;
  } catch {
    /* ignore */
  }
}

async function waitForHealth(deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        await r.text(); // drain
        return true;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((res) => setTimeout(res, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

// ---------- Auth flow ----------
async function login(address: string): Promise<any> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, chainId: CHAIN_ID }),
  });
  if (!res.ok) {
    throw new Error(`/auth/login ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  // Defensive unwrap: server may return {payload:{...}} or the bare payload.
  return body.payload ?? body;
}

async function verifyLogin(
  payload: any,
  signature: string,
): Promise<{ token: string; exp?: number }> {
  const res = await fetch(`${BASE}/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, signature, strategy: "siwe" }),
  });
  if (!res.ok) {
    throw new Error(`/auth/verify ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const token = body.token ?? body.jwt ?? body.access_token;
  if (!token) throw new Error(`/auth/verify missing token in ${JSON.stringify(body)}`);
  return { token, exp: body.exp };
}

// ---------- SSE stream: hold open + parse endpoint sessionId ----------
type SseHandle = {
  sessionId: string;
  close: () => void;
  done: Promise<void>;
};

async function openSse(token: string): Promise<SseHandle> {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/sse`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    },
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`/sse ${res.status}: ${res.ok ? "no body" : await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sessionId: string | null = null;

  // Parse SSE frames until we see `event: endpoint\ndata: /message?sessionId=...`.
  // Per MCP SSE transport the endpoint event is the first frame sent.
  const waitForEndpoint = (async () => {
    while (sessionId === null) {
      const { value, done } = await reader.read();
      if (done) throw new Error("/sse closed before endpoint frame");
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = frame.split("\n");
        let event: string | null = null;
        let data: string | null = null;
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            data = (data ? data + "\n" : "") + line.slice(5).trim();
          }
        }
        if (event === "endpoint" && data) {
          // data looks like `/message?sessionId=<uuid>`
          const m = data.match(/sessionId=([^&\s]+)/);
          if (m) {
            sessionId = m[1]!;
            break;
          }
        }
      }
    }
  })();

  await waitForEndpoint;

  // Keep draining the stream in the background so the server keeps the session alive.
  const done = (async () => {
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* aborted */
    }
  })();

  return {
    sessionId: sessionId!,
    close: () => {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    },
    done,
  };
}

// ---------- JSON-RPC over /message ----------
let rpcId = 0;

async function rpc(
  sessionId: string,
  token: string,
  method: string,
  params: any,
): Promise<any> {
  const id = ++rpcId;
  const res = await fetch(`${BASE}/message?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) {
    throw new Error(`rpc ${method} http ${res.status}: ${await res.text()}`);
  }
  // Note: SSEServerTransport.handlePostMessage returns 202 Accepted; the actual
  // JSON-RPC response is pushed over the SSE stream. For a soak harness we
  // accept the 202 as success for notifications/tools-list, and for tool calls
  // we rely on the SSE response stream. But to keep this harness simple and
  // synchronous we parse whatever the POST returns if it's JSON, and otherwise
  // treat a 2xx as enqueue-success and poll via a second call.
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return await res.json();
  }
  await res.text();
  return { accepted: true };
}

/**
 * Issue a `tools/call` whose JSON-RPC response arrives over the SSE stream.
 * We re-read the stream for the matching id; see sseCollector below.
 */

// A helper: because the MCP SSE transport pushes responses back over the SSE
// channel (not the POST reply), we install a parallel reader on the SSE body
// that routes frames keyed by JSON-RPC id.
type SseRpcBus = {
  waitFor: (id: number, timeoutMs?: number) => Promise<any>;
  close: () => void;
};

async function openSseWithBus(token: string): Promise<{
  sessionId: string;
  bus: SseRpcBus;
  handleClose: () => void;
  done: Promise<void>;
}> {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/sse`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`/sse ${res.status}: ${res.ok ? "no body" : await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const pending = new Map<number, (payload: any) => void>();
  let sessionId: string | null = null;
  let sessionIdResolve!: (s: string) => void;
  const sessionIdP = new Promise<string>((r) => (sessionIdResolve = r));

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = frame.split("\n");
          let event: string | null = null;
          let data: string | null = null;
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) {
              data = (data ? data + "\n" : "") + line.slice(5).trim();
            }
          }
          if (!data) continue;
          if (event === "endpoint") {
            const m = data.match(/sessionId=([^&\s]+)/);
            if (m && !sessionId) {
              sessionId = m[1]!;
              sessionIdResolve(sessionId);
            }
          } else {
            // Assume JSON-RPC response frame (event: message or no event).
            try {
              const obj = JSON.parse(data);
              if (typeof obj.id === "number" && pending.has(obj.id)) {
                const cb = pending.get(obj.id)!;
                pending.delete(obj.id);
                cb(obj);
              }
            } catch {
              /* non-JSON frame, ignore */
            }
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  const sid = await Promise.race([
    sessionIdP,
    new Promise<string>((_, rej) =>
      setTimeout(() => rej(new Error("sse: endpoint frame timeout")), 10_000),
    ),
  ]);

  const bus: SseRpcBus = {
    waitFor(id: number, timeoutMs = 15_000): Promise<any> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`rpc id=${id} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });
    },
    close() {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    },
  };

  return {
    sessionId: sid,
    bus,
    handleClose: () => ctrl.abort(),
    done: pump,
  };
}

async function callRpc(
  sessionId: string,
  token: string,
  bus: SseRpcBus,
  method: string,
  params: any,
): Promise<any> {
  const id = ++rpcId;
  const waiter = bus.waitFor(id);
  const res = await fetch(`${BASE}/message?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`rpc ${method} http ${res.status}: ${await res.text()}`);
  }
  await res.text();
  const reply = await waiter;
  if (reply.error) {
    throw new Error(`rpc ${method} error: ${JSON.stringify(reply.error)}`);
  }
  return reply.result;
}

async function callTool(
  sessionId: string,
  token: string,
  bus: SseRpcBus,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const result = await callRpc(sessionId, token, bus, "tools/call", {
    name,
    arguments: args,
  });
  // Double-unwrap: result.content[0].text is a JSON string for most tools.
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------- Iteration body ----------
type IterRow = {
  iter: number;
  boot_ms: number | null;
  wallet_present: boolean;
  active_match: boolean;
  errors: string[];
};

function percentile(xs: number[], p: number): number | null {
  const clean = xs.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const rank = Math.min(clean.length - 1, Math.floor((p / 100) * clean.length));
  return clean[rank]!;
}

async function runOnce(
  iter: number,
  address: string,
  signMessage: (msg: string) => Promise<`0x${string}`>,
  state: { walletId: string | null },
): Promise<IterRow> {
  const row: IterRow = {
    iter,
    boot_ms: null,
    wallet_present: false,
    active_match: false,
    errors: [],
  };

  const bootStart = Date.now();
  const child = spawnServer();
  let sseHandle: { bus: SseRpcBus; handleClose: () => void; done: Promise<void> } | null =
    null;

  try {
    const healthy = await waitForHealth(HEALTH_TIMEOUT_MS);
    row.boot_ms = Date.now() - bootStart;
    if (!healthy) {
      row.errors.push("health check did not succeed within timeout");
      return row;
    }

    // Auth
    const payload = await login(address);
    const signedObj = await signLoginPayload({
      payload,
      account: {
        address: address as `0x${string}`,
        signMessage: async ({ message }: { message: string | { raw: string } }) => {
          const m = typeof message === "string" ? message : message.raw;
          return await signMessage(m);
        },
      } as any,
    });
    const { token } = await verifyLogin(signedObj.payload, signedObj.signature);

    // Open SSE and get sessionId
    const opened = await openSseWithBus(token);
    sseHandle = { bus: opened.bus, handleClose: opened.handleClose, done: opened.done };
    const sessionId = opened.sessionId;

    // MCP initialize (required by MCP protocol before tool calls)
    await callRpc(sessionId, token, opened.bus, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "eto-soak", version: "0.0.1" },
    }).catch((e) => {
      // Not all servers require it; soft-fail.
      row.errors.push(`initialize soft-fail: ${String(e?.message ?? e)}`);
    });

    if (iter === 0) {
      await callRpc(sessionId, token, opened.bus, "tools/list", {}).catch((e) => {
        row.errors.push(`tools/list: ${String(e?.message ?? e)}`);
      });
      const created = await callTool(sessionId, token, opened.bus, "create_wallet", {
        label: "soak",
      });
      const walletId: string | undefined =
        created?.wallet_id ?? created?.id ?? created?.walletId;
      if (!walletId) {
        row.errors.push(`create_wallet no id: ${JSON.stringify(created)}`);
      } else {
        state.walletId = walletId;
        await callTool(sessionId, token, opened.bus, "set_active_wallet", {
          wallet_id: walletId,
        }).catch((e) => row.errors.push(`set_active_wallet: ${String(e?.message ?? e)}`));
      }
    }

    // Assert survival. Prefer session_info; fall back to list_wallets.
    let info: any = null;
    try {
      info = await callTool(sessionId, token, opened.bus, "session_info", {});
    } catch (e) {
      row.errors.push(`session_info: ${String((e as any)?.message ?? e)}`);
    }

    const wantedId = state.walletId;
    if (info && Array.isArray(info.wallets)) {
      if (wantedId) {
        row.wallet_present = info.wallets.some((w: any) => w.id === wantedId);
        row.active_match = info.active_wallet_id === wantedId;
      } else {
        // First iteration before walletId was set (shouldn't happen on iter>0).
        row.wallet_present = info.wallets.length > 0;
        row.active_match = Boolean(info.active_wallet_id);
      }
    } else {
      // Fallback path
      try {
        const list = await callTool(sessionId, token, opened.bus, "list_wallets", {});
        const arr = Array.isArray(list)
          ? list
          : Array.isArray(list?.wallets)
          ? list.wallets
          : [];
        if (wantedId) {
          row.wallet_present = arr.some((w: any) => (w.id ?? w.wallet_id) === wantedId);
        } else {
          row.wallet_present = arr.length > 0;
        }
        // Without session_info we can't verify active_wallet; mark false.
        row.active_match = false;
        row.errors.push("active_wallet assertion skipped: session_info unavailable");
      } catch (e) {
        row.errors.push(`list_wallets fallback: ${String((e as any)?.message ?? e)}`);
      }
    }

    // Check for literal 'Wallet not found' anywhere we collected
    if (info && JSON.stringify(info).includes("Wallet not found")) {
      row.errors.push("Wallet not found in session_info response");
    }
  } catch (e: any) {
    row.errors.push(`iter ${iter}: ${String(e?.message ?? e)}`);
  } finally {
    if (sseHandle) {
      try {
        sseHandle.handleClose();
      } catch {
        /* ignore */
      }
      try {
        await Promise.race([
          sseHandle.done,
          new Promise((r) => setTimeout(r, 500)),
        ]);
      } catch {
        /* ignore */
      }
    }
    await killServer(child);
  }

  return row;
}

// ---------- Main ----------
async function main() {
  await confirmOrDie();

  // Build a thirdweb client (client id only, read-only for client-side sigs).
  // We still declare it because future helpers may require it; unused for signLoginPayload.
  createThirdwebClient({ clientId: THIRDWEB_CLIENT_ID });

  // Derive address + signer from SOAK_PRIVKEY.
  const account = privateKeyToAccount({
    client: createThirdwebClient({ clientId: THIRDWEB_CLIENT_ID }),
    privateKey: SOAK_PRIVKEY as `0x${string}`,
  });
  const address = account.address;
  const signMessage = async (message: string): Promise<`0x${string}`> => {
    return (await account.signMessage({ message })) as `0x${string}`;
  };

  console.error(`[soak] address=${address}`);
  await wipeSoakWalletFiles(address);

  await mkdir(dirname(REPORT_JSON), { recursive: true });

  const rows: IterRow[] = [];
  const state = { walletId: null as string | null };

  for (let i = 0; i < ITERATIONS; i++) {
    const row = await runOnce(i, address, signMessage, state);
    rows.push(row);
    console.error(
      `[soak] iter=${i} boot_ms=${row.boot_ms} wallet=${row.wallet_present} active=${row.active_match} errs=${row.errors.length}`,
    );
  }

  const wallet_losses = rows.filter((r) => r.iter > 0 && !r.wallet_present).length;
  const active_losses = rows.filter((r) => r.iter > 0 && !r.active_match).length;
  const errors_total = rows.reduce((acc, r) => acc + r.errors.length, 0);
  const boots = rows.map((r) => r.boot_ms).filter((x): x is number => typeof x === "number");

  const summary = {
    iterations: ITERATIONS,
    address,
    wallet_losses,
    active_losses,
    errors_total,
    p50_boot_ms: percentile(boots, 50),
    p95_boot_ms: percentile(boots, 95),
    started_wallet_id: state.walletId,
    rows,
  };

  await writeFile(REPORT_JSON, JSON.stringify(summary, null, 2), "utf8");

  const md = [
    "# Soak report: MCP-P0-01",
    "",
    `- address: \`${address}\``,
    `- iterations: ${ITERATIONS}`,
    `- wallet_losses: ${wallet_losses}`,
    `- active_losses: ${active_losses}`,
    `- errors_total: ${errors_total}`,
    `- p50_boot_ms: ${summary.p50_boot_ms ?? "n/a"}`,
    `- p95_boot_ms: ${summary.p95_boot_ms ?? "n/a"}`,
    `- started_wallet_id: ${state.walletId ?? "n/a"}`,
    "",
    "## First 10 iterations",
    "",
    "| iter | boot_ms | wallet_present | active_match | errors |",
    "|-----:|--------:|:--------------:|:------------:|-------:|",
    ...rows.slice(0, 10).map(
      (r) =>
        `| ${r.iter} | ${r.boot_ms ?? ""} | ${r.wallet_present} | ${r.active_match} | ${r.errors.length} |`,
    ),
    "",
    "## Failures (all)",
    "",
    ...rows
      .filter((r) => r.errors.length > 0 || !r.wallet_present || (r.iter > 0 && !r.active_match))
      .map((r) => `- iter ${r.iter}: ${r.errors.join(" | ") || "(no explicit error)"}`),
  ].join("\n");

  await writeFile(REPORT_MD, md, "utf8");

  const pass = wallet_losses === 0 && active_losses === 0 && errors_total === 0;
  console.error(
    `[soak] done. pass=${pass} wallet_losses=${wallet_losses} active_losses=${active_losses} errors_total=${errors_total}`,
  );
  console.error(`[soak] report: ${REPORT_JSON}`);
  console.error(`[soak] report: ${REPORT_MD}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[soak] fatal:", err);
  process.exit(1);
});
