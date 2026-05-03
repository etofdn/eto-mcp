# Singularity SDK — Layer 3 Packaging Specification

> Tracking issue: [etofdn/eto-mcp#11](https://github.com/etofdn/eto-mcp/issues/11)
> Closes / relates to: FN-055.
> Downstream consumers: FN-056 (Python SDK skeleton), FN-057 (record schema typing), FN-058 (identity model), FN-059 (authority inheritance).

This document specifies the **developer-facing surface of the "Singularity
SDK"** — the Layer 3 ergonomic library that wraps ETO MCP's read+write tools so
an LLM coding agent (Claude / Cursor / Codex) can give itself a wallet,
transact, and persist typed records on-chain in a few lines.

This file is **paper only**. No runtime code is shipped by FN-055; the
implementation lives in follow-up tasks.

---

## §1 — Why an SDK

ETO exposes three layers of capability:

| Layer | Surface | Audience | Stability |
|---|---|---|---|
| **L1** — MCP tools | `transfer_native`, `query_memos`, `provision_agent`, etc. (~95 tools) | LLMs over MCP | per-tool, versioned in `src/tools/index.ts` |
| **L2** — Coordination primitives | A2A channels, swarms, MCP-program registry, banking BPPs | Multi-agent systems | scoped per primitive |
| **L3** — Singularity SDK | `singularity.provision`, `agent.pay`, `agent.queryRecords`, `agent.log` | LLM coding agents writing TypeScript / Python | this spec |

Layer 1 is verbose and tool-by-tool. An agent that wants to "spin up a wallet,
fund it, do a paid action, and remember it" must currently chain four to six
MCP calls and reason about idempotency keys, memo encoding, confirmation
timeouts, and recovery via `get_transaction`. Layer 3 collapses that into a
**four-method handle** that an LLM can quote almost verbatim from this spec
into user code.

The four methods are:

1. `singularity.provision(name, opts?)` — create or rehydrate a named agent
   with a wallet on both VMs.
2. `agent.pay(to, amount, opts?)` — confirmed transfer with an optional memo.
3. `agent.queryRecords(filter)` — read typed records previously written by
   this or any other agent.
4. `agent.log({ schema, payload })` — persist a typed record on-chain.

Everything else (chain RPC selection, blockhash refresh, signing, retry,
coalescing) is hidden behind these four methods.

---

## §2 — Design principles

1. **One-call provisioning.** `provision` is the only constructor. It either
   creates a fresh wallet (Ed25519 SVM key + HKDF-derived secp256k1 EVM
   sub-key, mirroring `create_wallet` in `src/tools/wallet.ts`) or rehydrates
   an existing one keyed by `name`. Funding can be requested in the same
   call. Agents that exist after `provision` returns are guaranteed to have a
   wallet on both VMs.

2. **Confirmed-by-default writes.** `pay` and `log` await on-chain confirmation
   before resolving (mirroring `transfer_native`'s 30-second confirm window).
   On timeout they raise a typed error that carries the signature so the
   caller can recover via the same `get_transaction(hash)` recipe documented
   in `src/tools/transfer.ts`.

3. **Memo-as-record convention.** Every write that needs to be recovered later
   leaves a memo via the SPL Memo Program v2. `pay` exposes the memo as an
   opaque string. `log` standardises a JSON envelope on top: the memo is
   `JSON.stringify({ schema, payload })`. This means a single chain index
   (`query_memos`, planned in FN-069) returns both human-readable payment
   notes and structured records in a single feed.

4. **Typed records via JSON memo payloads.** `log<T>` is generic over the
   record type. Schemas follow the
   `eto.singularity.record.<name>.v<n>` naming convention (mirroring
   `docs/schema-registry.md` §2 — `<domain>` is fixed to
   `singularity.record`, `<name>` is the per-record label, `<v>` is a major
   version that bumps on breaking changes). The schema string is **not**
   hashed on-chain — it is a free-form label inside the JSON envelope. The
   schema-hash convention used by `IssueCredential` (FN-057's territory) is
   intentionally distinct.

5. **Zero hidden global state.** There is no module-level "current agent".
   Every method hangs off an explicit `Agent` handle returned by `provision`.
   Two agents in the same process never see each other's wallet, scope, or
   active-wallet sidecar. This mirrors the `runInScope(session.sub, …)`
   isolation already enforced by `src/tools/index.ts:instrumentServer` —
   the SDK is the same isolation boundary lifted up one layer.

---

## §3 — TypeScript API surface

The full type surface that an implementer can paste into a `.d.ts` file. It
targets TypeScript 5.4 ESM (`"type": "module"`, `--module esnext`). No
`namespace` keyword is used because the package is ESM-only.

```ts
/**
 * Singularity SDK — Layer 3 ergonomic surface over the ETO MCP toolset.
 *
 * Every method on this module returns a Promise. There is no synchronous API.
 * All side effects (wallet creation, signing, RPC, on-chain writes) are
 * delegated to the underlying MCP tools listed in each JSDoc.
 */
export interface Singularity {
  /**
   * Create or rehydrate a named agent. Wraps `create_wallet`,
   * `set_active_wallet`, and (when `funding` is set) `transfer_native` and/or
   * `airdrop`. Idempotent: calling twice with the same `name` returns the
   * same `Agent`.
   */
  provision(name: string, opts?: ProvisionOptions): Promise<Agent>;
}

/** Options for {@link Singularity.provision}. Wraps create_wallet + airdrop/transfer_native. */
export interface ProvisionOptions {
  /** Network tag forwarded to `create_wallet`. Default: `"testnet"`. */
  network?: "mainnet" | "testnet" | "devnet";
  /**
   * Optional initial funding for the new wallet. Implemented via `airdrop`
   * on devnet/testnet, or via `transfer_native` from a configured funder
   * wallet on mainnet.
   */
  funding?: {
    /** Amount in SOL as a decimal string, e.g. `"0.5"`. */
    amount: string;
    /** Funder wallet ID. Required on mainnet; ignored when `airdrop` is used. */
    fromWallet?: string;
  };
  /**
   * Optional caller-supplied uniqueness suffix forwarded to the underlying
   * `transfer_native` idempotency key when `funding` is set. Has no effect
   * when `funding` is omitted.
   */
  idempotencyKey?: string;
}

/**
 * A provisioned agent handle. All four user-facing methods hang off this
 * object — the SDK exposes no module-level "current agent".
 */
export interface Agent {
  /** Stable wallet ID (UUID) issued by `create_wallet`. */
  readonly id: string;
  /** Human-readable label passed to `provision`. */
  readonly name: string;
  /** Both addresses derived from the same Ed25519 keypair (see `src/tools/wallet.ts`). */
  readonly wallet: {
    /** Base58 Ed25519 public key. */
    svm: string;
    /** 0x-prefixed keccak256 of the secp256k1 sub-key. */
    evm: string;
  };

  /**
   * Confirmed native transfer with optional memo. Wraps `transfer_native`.
   * Awaits confirmation by default; rejects with a {@link ConfirmationTimeoutError}
   * on the same 30s timeout window as `transfer_native`.
   */
  pay(to: string, amount: string, opts?: PayOptions): Promise<PayResult>;

  /**
   * Read previously-logged records (and optionally raw memos) from chain.
   * Wraps the planned `query_memos` MCP tool (FN-069).
   */
  queryRecords<T = unknown>(filter?: QueryRecordsFilter): Promise<QueryRecordsResult<T>>;

  /**
   * Persist a typed record on-chain by writing a JSON-encoded memo via
   * `transfer_native` to a designated null-recipient (the agent's own SVM
   * address by default). Wraps `transfer_native`; recoverable via
   * `query_memos` (FN-069).
   */
  log<T = unknown>(record: LogRecord<T>, opts?: LogOptions): Promise<LogResult>;
}

/** Options for {@link Agent.pay}. Wraps transfer_native. */
export interface PayOptions {
  /** Free-form memo anchored on-chain via SPL Memo Program v2. */
  memo?: string;
  /** Caller-supplied uniqueness suffix; used to disambiguate parallel transfers. */
  idempotencyKey?: string;
  /** Amount unit. Default: `"sol"`. */
  unit?: "sol" | "lamports";
  /** Override the default confirmation timeout (default: 30_000ms). */
  timeoutMs?: number;
  /** Override the sender wallet (defaults to this agent's wallet). */
  fromWallet?: string;
}

/** Result of {@link Agent.pay}. Mirrors transfer_native's confirmed-path output. */
export interface PayResult {
  /** Base58 transaction signature. */
  signature: string;
  /** Slot the transaction landed in (when reported by RPC). */
  slot?: number;
  /** ISO-8601 confirmation timestamp computed locally on the client. */
  confirmedAt: string;
  /** True iff this signature was returned to another in-flight caller with the same idempotency key. */
  coalesced: boolean;
  /** Resolved SVM recipient (after EVM 0x → SVM normalization, see `src/utils/address.ts`). */
  toSvm: string;
  /** Fee in lamports, when reported by RPC. */
  fee?: number;
}

/** Filter passed to {@link Agent.queryRecords}. Maps onto the planned query_memos tool (FN-069). */
export interface QueryRecordsFilter {
  /** Restrict to memos sent by this SVM/EVM address. */
  sender?: string;
  /** Restrict to memos received by this SVM/EVM address. */
  recipient?: string;
  /**
   * Restrict to records with this exact schema label, e.g.
   * `"eto.singularity.record.payment.v1"`. Memos that fail JSON parsing or
   * lack a `schema` key are excluded when this filter is set.
   */
  schema?: string;
  /** Inclusive lower bound on slot. */
  since?: number;
  /** Inclusive upper bound on slot. */
  until?: number;
  /** Max records to return. SDK clamps to 1000 and pages internally. */
  limit?: number;
  /**
   * When true, also include memos that did not parse as `{ schema, payload }`
   * JSON envelopes. Default: false (typed records only).
   */
  includeRawMemos?: boolean;
}

/** Result of {@link Agent.queryRecords}. Newest record first. */
export interface QueryRecordsResult<T = unknown> {
  /** Decoded records. Sorted by slot descending, then signature descending. */
  records: ReadonlyArray<QueryRecord<T>>;
  /** True iff `limit` was hit and more records may exist. */
  truncated: boolean;
}

/** A single record returned by {@link Agent.queryRecords}. */
export interface QueryRecord<T = unknown> {
  /** Base58 transaction signature. */
  signature: string;
  /** Slot the transaction landed in. */
  slot: number;
  /** Parsed schema label from the JSON envelope. */
  schema: string;
  /** Parsed payload. `unknown` until the caller narrows via the type parameter. */
  payload: T;
  /** Raw memo bytes as UTF-8 string, useful for forensic / non-JSON memos. */
  rawMemo: string;
  /** Sender SVM address. */
  sender: string;
  /** Recipient SVM address. */
  recipient: string;
}

/** Input record for {@link Agent.log}. */
export interface LogRecord<T = unknown> {
  /**
   * Schema label following `eto.singularity.record.<name>.v<n>` (see §2.4 and
   * the naming rules in `docs/schema-registry.md` §2).
   */
  schema: string;
  /** Arbitrary JSON-serializable payload. Bytes count against the SPL memo limit (~566 chars). */
  payload: T;
}

/** Options for {@link Agent.log}. */
export interface LogOptions {
  /**
   * Override the memo recipient. Defaults to the agent's own SVM address
   * (i.e. self-send), so logging does not transfer value to a third party.
   */
  recipient?: string;
  /**
   * Lamports to send alongside the memo. Default: `1n` (1 lamport, the
   * minimum non-zero transfer). Set to `0n` only if the underlying chain
   * accepts zero-value system transfers.
   */
  lamports?: bigint;
  /** Caller-supplied uniqueness suffix forwarded to `transfer_native`. */
  idempotencyKey?: string;
  /** Override the default confirmation timeout (default: 30_000ms). */
  timeoutMs?: number;
}

/** Result of {@link Agent.log}. */
export interface LogResult {
  /** Base58 transaction signature of the memo-bearing transfer. */
  signature: string;
  /** Slot the transaction landed in (when reported by RPC). */
  slot?: number;
  /** Schema label echoed back from the input record (for client-side correlation). */
  schema: string;
}
```

---

## §4 — Method reference

### §4.1 `singularity.provision(name, opts?)`

**Purpose.** Create or rehydrate a named agent with a wallet on both VMs and
optionally fund it.

**Underlying MCP tools.**

- `create_wallet` (existing, `src/tools/wallet.ts`) — fresh provisioning.
- `set_active_wallet` (existing, `src/tools/wallet.ts`) — pin the new wallet
  as active for the current session scope.
- `provision_agent` (planned, **FN-070**) — single-call rehydrate-or-create
  that the SDK delegates to once available; until then the SDK composes
  `list_wallets` + `create_wallet` to achieve the same.
- `airdrop` (existing, `src/tools/devnet.ts`) — funding on dev/testnet.
- `transfer_native` (existing, `src/tools/transfer.ts`) — funding on mainnet.

**Parameters.**

| Name | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Human-readable label. Used both as the wallet's `label` and as the rehydration key. |
| `opts.network` | `"mainnet" \| "testnet" \| "devnet"` | no | Forwarded to `create_wallet`. Default `"testnet"`. |
| `opts.funding.amount` | `string` (SOL) | no | When set, the SDK funds the new wallet. |
| `opts.funding.fromWallet` | `string` | no | Funder wallet ID; required when `network === "mainnet"`. |
| `opts.idempotencyKey` | `string` | no | Forwarded to the funding `transfer_native` call. |

**Return.** A fully-populated `Agent` whose `wallet.svm` and `wallet.evm`
are non-empty.

**Idempotency.** `provision(name)` is idempotent on `name`: a second call with
the same `name` MUST return the same `id` / `wallet`. The funding step is
idempotent on `(fromWallet, toSvm, amount, idempotencyKey)` via
`transfer_native`'s in-flight coalescing.

**Errors.** {@link ProvisionError} on any of: wallet creation failure, name
collision against a different wallet, funder under-balance, funding
confirmation timeout (re-thrown as `ConfirmationTimeoutError`).

---

### §4.2 `agent.pay(to, amount, opts?)`

**Purpose.** Confirmed native SOL transfer with optional memo.

**Underlying MCP tool.** `transfer_native` (existing, `src/tools/transfer.ts`).

**Parameters.**

| Name | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | yes | Recipient in SVM (base58) or EVM (0x) form; normalised to SVM by `resolveAddresses`. |
| `amount` | `string` | yes | Amount as decimal string, in `opts.unit` (default SOL). |
| `opts.memo` | `string` | no | Memo anchored on-chain via SPL Memo Program v2 (cf. `src/tools/transfer.ts`). |
| `opts.idempotencyKey` | `string` | no | Caller-supplied uniqueness suffix; combined with sender/recipient/amount/blockhash/memo to form the in-flight key. |
| `opts.unit` | `"sol" \| "lamports"` | no | Default `"sol"`. |
| `opts.timeoutMs` | `number` | no | Confirmation deadline. Default 30_000ms (matches `transfer_native`). |
| `opts.fromWallet` | `string` | no | Override sender wallet. Defaults to this agent. |

**Return.** {@link PayResult} on confirmation.

**Memo behaviour.** When `opts.memo` is set, the SPL Memo Program v2
instruction is included in the signed transaction (see
`buildTransferTx(..., memo)` in `src/tools/transfer.ts`). The memo therefore
participates in the signature, so two transfers that differ only in memo
produce **distinct** signatures. The memo is recoverable via the planned
`query_memos` MCP tool (FN-069) or via `get_account_transactions`.

**Idempotency.** Mirrors `transfer_native`'s key:
`transfer-{from}-{to}-{lamports}-{blockhash}[-m:{memo}][-i:{idempotencyKey}]`.
Parallel `pay` calls sharing all five components return the same signature
with `coalesced: true`. To force a distinct submission, supply a unique
`opts.idempotencyKey`.

**Errors.** {@link PayError} for outright failure;
{@link ConfirmationTimeoutError} on a 30s timeout — the error carries the
submitted `signature` and instructs the caller to reconcile via
`get_transaction(hash)` per the recovery contract in `src/tools/transfer.ts`.

---

### §4.3 `agent.queryRecords(filter?)`

**Purpose.** Read typed records (and optionally raw memos) previously written
by this or any other agent.

**Underlying MCP tool.** `query_memos` (planned, **FN-069**). Until that
tool merges, the SDK MAY shim by paginating
`get_account_transactions(address)` and decoding memos client-side; the
shape returned by `queryRecords` is stable across both implementations.

**Filter mapping.**

| `QueryRecordsFilter` field | `query_memos` parameter (planned) | Notes |
|---|---|---|
| `sender` | `from` | Address normalised to SVM client-side. |
| `recipient` | `to` | Address normalised to SVM client-side. |
| `schema` | `memo_prefix` | The SDK passes `JSON.stringify({"schema":"<value>"`.slice(0,-1)` (i.e. enough of the JSON prefix to filter cheaply at the indexer). Final filtering is exact-match on the parsed envelope. |
| `since` | `from_slot` | Inclusive. |
| `until` | `to_slot` | Inclusive. |
| `limit` | `limit` | SDK clamps to 1000; iterates with `before_signature` if more are needed. |
| `includeRawMemos` | client-side | Default false — the SDK drops memos that fail `JSON.parse` or lack a `schema` key. |

**JSON-memo decoding rule.**

```
if utf8(memo).startsWith("{") and JSON.parse(utf8(memo)) yields { schema: string, payload: any }
    → typed record (included by default)
else
    → raw memo (included only when filter.includeRawMemos === true)
```

**Errors.** {@link QueryError} on transport / decoding failures. Individual
malformed memos are silently dropped (or surfaced via `includeRawMemos`),
not raised.

---

### §4.4 `agent.log({ schema, payload })`

**Purpose.** Persist a typed record on-chain.

**Underlying MCP tool.** `transfer_native` (existing, `src/tools/transfer.ts`)
with `memo = JSON.stringify({ schema, payload })`. The transfer is sent
**to the agent itself** by default (`opts.recipient` defaults to
`agent.wallet.svm`) so that logging does not move value to a third party.
A configurable null-recipient (e.g. `1nc1nerator11111111111111111111111111111111`)
MAY be supported once an SDK-wide convention is fixed.

**Schema convention.** `schema` MUST follow
`eto.singularity.record.<name>.v<n>` per the rules mirrored from
`docs/schema-registry.md` §2:

- `<name>` is lowercase, dot-separated, and case-sensitive.
- `<v>` is a major version starting at `v1`; breaking payload changes mint a
  new version, never reuse an older one.
- Pre-image bytes are NOT hashed on-chain — the schema string lives inside
  the JSON envelope and is filterable via `query_memos` `memo_prefix`.

**Payload limits.** SPL Memo v2 caps a single memo at ≈566 UTF-8 bytes.
The SDK MUST reject payloads whose serialized envelope exceeds 540 bytes
(leaving 26 bytes of headroom for the JSON wrapper). Larger records are out
of scope for v1 — see §7.

**Idempotency.** Inherits `transfer_native`'s in-flight coalescing on
`(from, to, lamports, blockhash, memo)`. Because the memo includes the full
JSON envelope, two identical `log` calls in flight at the same blockhash
collapse to one signature with `coalesced: true`.

**Errors.** {@link LogError} for payload-too-large, schema-label validation,
or transfer failure; {@link ConfirmationTimeoutError} on a 30s timeout.

---

## §5 — End-to-end example

The shape an LLM coding agent is expected to emit when asked "give yourself a
wallet, pay someone, and remember it":

```ts
// For this snippet to type-check standalone, declare the singleton.
// Real callers `import { singularity } from "@eto/singularity";` once the
// package ships (see §7 open question #1).
declare const singularity: Singularity;

interface PaymentRecord {
  invoiceId: string;
  to: string;
  amountSol: string;
  memo: string;
}

const agent = await singularity.provision("invoice-bot", {
  network: "testnet",
  funding: { amount: "0.5" },
});

const pay = await agent.pay(
  "8vK6NpkqkGnLb6m2bX1tWJyBaP4u2yJrU2pwAcw9PqXk",
  "0.05",
  { memo: "invoice:42" },
);

await agent.log<PaymentRecord>({
  schema: "eto.singularity.record.payment.v1",
  payload: {
    invoiceId: "42",
    to: pay.toSvm,
    amountSol: "0.05",
    memo: "invoice:42",
  },
});

const history = await agent.queryRecords<PaymentRecord>({
  schema: "eto.singularity.record.payment.v1",
  sender: agent.wallet.svm,
  limit: 50,
});

for (const record of history.records) {
  console.log(record.slot, record.payload.invoiceId, record.payload.amountSol);
}
```

---

## §6 — Error model

All SDK errors derive from a single base class so callers can catch
broadly and narrow as needed.

```ts
/** Root of the Singularity SDK error hierarchy. */
export class SingularityError extends Error {
  /** Stable machine-readable code, e.g. `"PROVISION_FAILED"`. */
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SingularityError";
    this.code = code;
  }
}

/** Raised by {@link Singularity.provision}. */
export class ProvisionError extends SingularityError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("PROVISION_FAILED", message, options);
    this.name = "ProvisionError";
  }
}

/** Raised by {@link Agent.pay} (other than confirmation timeout). */
export class PayError extends SingularityError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("PAY_FAILED", message, options);
    this.name = "PayError";
  }
}

/**
 * Raised when a confirmed-by-default write times out before landing.
 * Carries the submitted signature so callers can reconcile via
 * `get_transaction(hash)` per the recovery path documented in
 * `src/tools/transfer.ts`.
 */
export class ConfirmationTimeoutError extends PayError {
  readonly signature: string;
  constructor(signature: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Override the inherited "PAY_FAILED" code with a more specific one.
    (this as { code: string }).code = "CONFIRMATION_TIMEOUT";
    this.name = "ConfirmationTimeoutError";
    this.signature = signature;
  }
}

/** Raised by {@link Agent.queryRecords}. */
export class QueryError extends SingularityError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("QUERY_FAILED", message, options);
    this.name = "QueryError";
  }
}

/** Raised by {@link Agent.log}. */
export class LogError extends SingularityError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("LOG_FAILED", message, options);
    this.name = "LogError";
  }
}
```

Recovery recipe for `ConfirmationTimeoutError` (illustrative):

```
try {
  await agent.pay(to, "0.01", { memo: "rent-may" });
} catch (err) {
  if (err instanceof ConfirmationTimeoutError) {
    // Same recovery path that `transfer_native` documents.
    // Call `get_transaction(hash=err.signature)`; non-null = landed, null = not yet.
  } else {
    throw err;
  }
}
```

---

## §7 — Open questions

| # | Question | Tracked in |
|---|---|---|
| 1 | **Package name.** `@eto/singularity` (org-scoped, parallels `@eto/mcp`) vs `singularity-sdk` (unscoped, easier `npx` UX). Recommendation: `@eto/singularity`. | FN-056 |
| 2 | **Transport.** Direct in-process MCP client (today's stdio path) vs HTTP shim against the SSE gateway in `src/sse-server.ts`. Determines whether the SDK ships a transport or imports one. | FN-056 |
| 3 | **Identity model.** How `Agent.id` relates to ETO's `AgentCard` authority key, DIDs, and the issuer-network gating used by `@eto/mcp/issuers/*`. The SDK MUST NOT pre-empt the canonical identity decision. | FN-058 |
| 4 | **Authority inheritance.** When agent A spawns agent B via `provision`, does B inherit any of A's credentials / capabilities? Default for v1 is **no** (B starts blank). | FN-059 |
| 5 | **Large-record support.** SPL memo's ≈566-byte limit forces JSON envelopes to stay small. Future work: chunked memos with a content-hash header, or off-chain blob + on-chain pointer. | FN-057 |
| 6 | **Schema registry.** Whether `eto.singularity.record.*` labels deserve their own registry document analogous to `docs/schema-registry.md`. | new follow-up (see FN-055 task log) |
| 7 | **Python parity.** Method-for-method Python skeleton with the same four-method surface, including how `LogRecord<T>` translates without TypeScript generics. | FN-056 |
| 8 | **Schema typing.** Branded TS types and JSON-Schema validation for `LogRecord<T>` so callers get compile-time and runtime safety. | FN-057 |

---

## §8 — Non-goals (v1)

- No SDK implementation in this task — see FN-056 (Python skeleton),
  FN-057 (schema typing), FN-058 (identity), FN-059 (authority inheritance).
- No new MCP tools. The spec REFERENCES `query_memos` (FN-069) and
  `provision_agent` (FN-070) but does not depend on their merge.
- No changes to `src/tools/transfer.ts`, `src/tools/wallet.ts`, or any
  runtime code under `src/`.
- No re-spec of credential / `IssueCredential` flows — those live under
  `@eto/mcp/issuers/*` and `docs/schema-registry.md`.
