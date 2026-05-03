# Singularity SDK — Python Skeleton Specification (`singularity-sdk-py`)

> Tracking issue: [etofdn/eto-mcp#11](https://github.com/etofdn/eto-mcp/issues/11) (bullet 3/10).
> Closes / relates to: FN-056.
> Canonical source of truth for the API surface this document mirrors:
> [`docs/sdk-api-spec.md`](./sdk-api-spec.md) (FN-055).
> Downstream consumers: FN-057 (record schema typing), FN-058 (identity model),
> FN-059 (authority inheritance), FN-069 (`query_memos` MCP tool),
> FN-070 (`provision_agent` MCP tool).

This document specifies a **paper-only skeleton** for the future
`singularity-sdk-py` Python package. It is a faithful behavioral mirror of the
Layer 3 TypeScript SDK defined in FN-055. **No implementation, no
`pyproject.toml`, no source files** are produced by FN-056 — only this spec
and the type stubs embedded in it.

If FN-055's `docs/sdk-api-spec.md` ever drifts, **that document remains
authoritative**: surface drift is fixed by re-opening FN-055, never by editing
this Python mirror.

---

## §1 — Why a Python SDK

ETO's Layer 1 MCP surface is verbose (≈95 tools in `src/tools/index.ts`), and
the Layer 3 TypeScript ergonomic wrapper from FN-055 collapses common
"provision a wallet, pay, log a record, query history" flows into four
methods: `provision`, `pay`, `log`, `queryRecords`.

A Python mirror is needed because:

1. **MCP-using LLM agents are Python-first.** Claude Code, Cursor, and most
   custom agent frameworks (LangGraph, LlamaIndex, Smol-Agents, CrewAI) have
   Python as their primary or canonical binding. Forcing those agents through
   the TypeScript SDK requires shelling out to Node, which breaks single-process
   debugging, single-process tracing, and single-process credential handling.
2. **Data-science / ML environments are Python-first.** Notebook-driven
   experimentation (Jupyter, Colab, Modal, Replit) overwhelmingly favors
   Python. An agent that wants to back-test a payment policy or replay record
   history wants pandas / polars next to the SDK call.
3. **Behavioral parity, not innovation.** The Python SDK is a thin behavioral
   mirror. Method names map TS camelCase → Python snake_case; semantics are
   identical; the error hierarchy is isomorphic. The Python package adds **no
   new capabilities** beyond what FN-055 specifies.

Per FN-055 §7 open question #7, this Python parity track is the dedicated
follow-up where method-for-method correspondence is worked out — including
how `LogRecord<T>` translates without TypeScript generics (answer: PEP 695 /
`typing.Generic[T]`, see §5).

---

## §2 — Non-goals

This spec is **planning-only**. The following are explicitly out of scope and
must not be inferred or pre-empted from this document:

1. **No implementation.** No `singularity-sdk-py/` directory, no
   `pyproject.toml`, no `src/singularity_sdk/*.py` files, no tests. The actual
   package lands in a follow-up implementation task.
2. **No transport choice locked in.** Whether the Python SDK uses the
   official [`mcp`](https://pypi.org/project/mcp/) Python client, a raw HTTP
   shim against `src/sse-server.ts`, or both, is **explicitly deferred** to
   §8. Implementers MUST treat the choice as open until the implementation
   task picks one.
3. **No async-vs-sync decision binding.** The signatures in §5 are written
   `async def …` because that is the lowest-friction match to the underlying
   awaitable MCP transports. Whether the package ships sync wrappers, an
   async-only API, or dual-API is recorded in §8 as an open question. The
   sync-wrapper *naming pattern* (`pay_sync`, `query_records_sync`, …) is
   reserved here so a later decision does not invalidate this document.
4. **No new MCP tool dependencies.** This spec inherits FN-055's references
   to `query_memos` (FN-069) and `provision_agent` (FN-070) but introduces
   none of its own.
5. **No identity / authority decisions.** Identity model integration
   (FN-058) and authority inheritance (FN-059) are explicit §8 open questions.
6. **No schema-validation engine choice.** Whether `LogRecord[T]` validation
   is enforced via pydantic v2, generated JSON Schemas, attrs, or msgspec is
   deferred to FN-057 / §8.

---

## §3 — Package layout

Proposed source-tree layout for the future `singularity-sdk-py` package. This
is the layout the implementation task will materialize; FN-056 produces
**none** of these files.

```
singularity-sdk-py/
  pyproject.toml
  README.md
  src/singularity_sdk/
    __init__.py          # re-exports SingularityAgent, errors, provision()
    agent.py             # SingularityAgent class
    provision.py         # module-level provision() factory
    records.py           # LogRecord, QueryRecordsFilter dataclasses
    errors.py            # SingularityError hierarchy
    transport.py         # MCP client adapter (interface only in this spec)
    _types.py            # TypedDicts / dataclasses mirroring TS interfaces
  tests/
    test_agent.py
    test_provision.py
    test_records.py
```

Notes on the layout:

- **Distribution name vs import name diverge**: PyPI distribution is
  `singularity-sdk` (hyphenated, per PyPI/PEP 503 convention); Python import
  is `singularity_sdk` (underscored, PEP 8 module names).
- **`src/` layout** is mandatory. It prevents accidental import-from-cwd and
  is the modern norm enforced by `hatchling` and `setuptools-scm`.
- **`transport.py` is interface-only in this spec.** The implementation
  picks between `mcp` Python client and HTTP shim per §8 open question.
- **`_types.py` is private** (leading underscore) — only `agent.py`,
  `records.py`, and `provision.py` import from it. Public re-exports flow
  through `__init__.py`.

---

## §4 — PyPI packaging plan

| Concern | Decision |
|---|---|
| **Distribution name** | `singularity-sdk` (PyPI), import name `singularity_sdk`. |
| **Build backend** | [`hatchling`](https://hatch.pypa.io/) (PEP 517, PEP 621). Reasoning: src-layout out of the box, no `setup.py`, fast wheels, well-supported in modern CI. |
| **Layout** | `src/` layout (see §3). |
| **Minimum Python** | 3.10 — for structural pattern matching (`match`), PEP 604 union syntax (`X | Y`), `ParamSpec` from `typing`, and dataclass `kw_only=True`. |
| **Versioning** | SemVer. Initial release `0.1.0a0`. `__version__` in `singularity_sdk/__init__.py` tracks the FN-055 spec version it mirrors (e.g. `__spec_version__ = "FN-055/v1"`). |
| **Runtime deps (named, NOT pinned)** | Either `mcp` (official Python client) **or** `httpx` (HTTP shim transport) — see §8 open question on transport. `pydantic >= 2` for dataclass-style typed records and runtime validation of incoming `RecordEntry`s. No version pins beyond the major-version floor. |
| **Dev deps** | `pytest`, `pytest-asyncio`, `mypy`, `ruff`. (No formatters listed beyond `ruff format`.) |
| **Trove classifiers** | `Development Status :: 3 - Alpha`, `Intended Audience :: Developers`, `License :: OSI Approved :: MIT License`, `Programming Language :: Python :: 3`, `Programming Language :: Python :: 3.10`, `Programming Language :: Python :: 3.11`, `Programming Language :: Python :: 3.12`, `Topic :: Software Development :: Libraries :: Python Modules`, `Typing :: Typed`. |
| **License** | `MIT`, matching the parent `eto-mcp` repo. A `py.typed` marker ships with the package (PEP 561). |
| **Publish flow** | GitHub Actions workflow at `.github/workflows/publish-sdk-py.yml` triggered on tags matching `singularity-sdk-py-v*`. Uses **PyPI Trusted Publishing (OIDC)** — no long-lived `PYPI_API_TOKEN` secret. The workflow runs `hatch build` and `pypa/gh-action-pypi-publish@release/v1`. |

A `py.typed` marker file makes the type stubs in §5 available to downstream
`mypy` users without a separate `types-singularity-sdk` stub package.

---

## §5 — Python API surface

The full public surface as Python type stubs. Bodies are `...` because this
is a planning spec, not an implementation. The block below is intended to be
machine-checkable via `python3 -m py_compile`.

```python
"""Singularity SDK — Python skeleton (FN-056).

Mirror of docs/sdk-api-spec.md (FN-055). Bodies are intentionally `...`;
this module is a planning artifact, not a runtime package.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Generic, Literal, TypedDict, TypeVar

T = TypeVar("T")


# ---------------------------------------------------------------------------
# §5.1 — TypedDicts and dataclasses (mirror TS interfaces)
# ---------------------------------------------------------------------------


class WalletAddresses(TypedDict):
    """Both addresses derived from one Ed25519 keypair (src/tools/wallet.ts)."""

    svm: str  # base58 Ed25519 public key
    evm: str  # 0x-prefixed keccak256 of the secp256k1 sub-key


class FundingOptions(TypedDict, total=False):
    """Optional initial funding for a freshly provisioned wallet."""

    amount: str  # SOL as decimal string, e.g. "0.5"
    from_wallet: str  # funder wallet ID; required on mainnet


class ProvisionOptions(TypedDict, total=False):
    """Options for `provision()`. Wraps create_wallet + airdrop/transfer_native."""

    network: Literal["mainnet", "testnet", "devnet"]
    funding: FundingOptions
    idempotency_key: str


class PayOptions(TypedDict, total=False):
    """Options for `SingularityAgent.pay()`. Wraps transfer_native (src/tools/transfer.ts)."""

    memo: str
    idempotency_key: str
    unit: Literal["sol", "lamports"]
    timeout_ms: int
    from_wallet: str


@dataclass(frozen=True, kw_only=True)
class PayResult:
    """Result of `SingularityAgent.pay()`. Mirrors transfer_native confirmed-path output."""

    signature: str  # base58
    confirmed_at: str  # ISO-8601
    coalesced: bool
    to_svm: str
    slot: int | None = None
    fee: int | None = None  # lamports


@dataclass(frozen=True, kw_only=True)
class QueryRecordsFilter:
    """Filter for `SingularityAgent.query_records()`. Maps onto query_memos (FN-069)."""

    sender: str | None = None
    recipient: str | None = None
    schema: str | None = None
    since: int | None = None  # inclusive lower-bound slot
    until: int | None = None  # inclusive upper-bound slot
    limit: int | None = None  # SDK clamps to 1000
    include_raw_memos: bool = False


@dataclass(frozen=True, kw_only=True)
class RecordEntry(Generic[T]):
    """A single record returned by `query_records`. Newest-first ordering at the result level."""

    signature: str
    slot: int
    schema: str
    payload: T
    raw_memo: str
    sender: str
    recipient: str


@dataclass(frozen=True, kw_only=True)
class QueryRecordsResult(Generic[T]):
    """Result of `query_records`. Sorted slot-desc, signature-desc."""

    records: tuple[RecordEntry[T], ...]
    truncated: bool


@dataclass(frozen=True, kw_only=True)
class LogRecord(Generic[T]):
    """Input record for `SingularityAgent.log()`. Generic over payload type T."""

    schema: str  # eto.singularity.record.<name>.v<n>
    payload: T


class LogOptions(TypedDict, total=False):
    """Options for `SingularityAgent.log()`. Wraps transfer_native."""

    recipient: str  # defaults to agent.wallet["svm"] (self-send)
    lamports: int  # default 1
    idempotency_key: str
    timeout_ms: int


@dataclass(frozen=True, kw_only=True)
class LogResult:
    """Result of `SingularityAgent.log()`."""

    signature: str
    schema: str
    slot: int | None = None


# ---------------------------------------------------------------------------
# §5.2 — SingularityAgent class
# ---------------------------------------------------------------------------


class SingularityAgent:
    """A provisioned agent handle. All methods are awaitable.

    Mirrors the FN-055 `Agent` interface. There is no module-level "current
    agent"; every method hangs off an explicit handle returned by
    `provision()`.
    """

    id: str  # stable wallet UUID
    name: str  # human-readable label
    wallet: WalletAddresses

    async def pay(
        self,
        recipient: str,
        amount: str,
        *,
        memo: str | None = None,
        idempotency_key: str | None = None,
        unit: Literal["sol", "lamports"] = "sol",
        timeout_ms: int = 30_000,
        from_wallet: str | None = None,
    ) -> PayResult:
        """Wraps transfer_native (src/tools/transfer.ts)."""
        ...

    async def query_records(
        self,
        filter: QueryRecordsFilter | None = None,
    ) -> QueryRecordsResult[object]:
        """Wraps query_memos (planned, FN-069)."""
        ...

    async def log(
        self,
        record: LogRecord[T],
        *,
        recipient: str | None = None,
        lamports: int = 1,
        idempotency_key: str | None = None,
        timeout_ms: int = 30_000,
    ) -> LogResult:
        """Wraps transfer_native with a JSON memo envelope (src/tools/transfer.ts)."""
        ...


# ---------------------------------------------------------------------------
# §5.3 — Module-level provision() factory
# ---------------------------------------------------------------------------


async def provision(
    name: str,
    *,
    funding: FundingOptions | None = None,
    network: Literal["mainnet", "testnet", "devnet"] = "testnet",
    idempotency_key: str | None = None,
) -> SingularityAgent:
    """Wraps create_wallet + set_active_wallet + (optionally) airdrop / transfer_native.

    Idempotent on `name`: a second call with the same name returns the same
    `SingularityAgent` (same `id`, same `wallet`). See FN-055 §4.1.
    """
    ...
```

### §5.4 — Sync-wrapper note

Each `async` method has a planned **sync sibling** following the naming
pattern `<method>_sync` (e.g. `pay_sync`, `query_records_sync`, `log_sync`,
and module-level `provision_sync`). The sync wrappers MUST be a thin
`asyncio.run` shell over the async API; no separate code path. Whether the
sync wrappers actually ship in v0.1 is recorded as an §8 open question — the
naming pattern is reserved here so a later "yes" does not retro-break user
code.

### §5.5 — TS ↔ Python mapping table

Every TS method/field from `docs/sdk-api-spec.md` §3 next to its Python
equivalent. Field names that are already snake_case (or do not exist in TS)
are listed once.

| TypeScript (FN-055 §3)                | Python (FN-056 §5)                       |
|---------------------------------------|------------------------------------------|
| `Singularity.provision`               | module-level `provision`                 |
| `Agent`                               | `SingularityAgent`                       |
| `Agent.id`                            | `SingularityAgent.id`                    |
| `Agent.name`                          | `SingularityAgent.name`                  |
| `Agent.wallet`                        | `SingularityAgent.wallet`                |
| `Agent.wallet.svm` / `.evm`           | `wallet["svm"]` / `wallet["evm"]`        |
| `Agent.pay`                           | `SingularityAgent.pay`                   |
| `Agent.queryRecords`                  | `SingularityAgent.query_records`         |
| `Agent.log`                           | `SingularityAgent.log`                   |
| `ProvisionOptions.network`            | `ProvisionOptions["network"]`            |
| `ProvisionOptions.funding`            | `ProvisionOptions["funding"]`            |
| `ProvisionOptions.funding.amount`     | `FundingOptions["amount"]`               |
| `ProvisionOptions.funding.fromWallet` | `FundingOptions["from_wallet"]`          |
| `ProvisionOptions.idempotencyKey`     | `ProvisionOptions["idempotency_key"]`    |
| `PayOptions.memo`                     | `PayOptions["memo"]`                     |
| `PayOptions.idempotencyKey`           | `PayOptions["idempotency_key"]`          |
| `PayOptions.unit`                     | `PayOptions["unit"]`                     |
| `PayOptions.timeoutMs`                | `PayOptions["timeout_ms"]`               |
| `PayOptions.fromWallet`               | `PayOptions["from_wallet"]`              |
| `PayResult.signature`                 | `PayResult.signature`                    |
| `PayResult.slot`                      | `PayResult.slot`                         |
| `PayResult.confirmedAt`               | `PayResult.confirmed_at`                 |
| `PayResult.coalesced`                 | `PayResult.coalesced`                    |
| `PayResult.toSvm`                     | `PayResult.to_svm`                       |
| `PayResult.fee`                       | `PayResult.fee`                          |
| `QueryRecordsFilter.sender`           | `QueryRecordsFilter.sender`              |
| `QueryRecordsFilter.recipient`        | `QueryRecordsFilter.recipient`           |
| `QueryRecordsFilter.schema`           | `QueryRecordsFilter.schema`              |
| `QueryRecordsFilter.since`            | `QueryRecordsFilter.since`               |
| `QueryRecordsFilter.until`            | `QueryRecordsFilter.until`               |
| `QueryRecordsFilter.limit`            | `QueryRecordsFilter.limit`               |
| `QueryRecordsFilter.includeRawMemos`  | `QueryRecordsFilter.include_raw_memos`   |
| `QueryRecordsResult.records`          | `QueryRecordsResult.records`             |
| `QueryRecordsResult.truncated`        | `QueryRecordsResult.truncated`           |
| `QueryRecord<T>`                      | `RecordEntry[T]`                         |
| `QueryRecord.rawMemo`                 | `RecordEntry.raw_memo`                   |
| `LogRecord<T>.schema`/`.payload`      | `LogRecord[T].schema` / `.payload`       |
| `LogOptions.recipient`                | `LogOptions["recipient"]`                |
| `LogOptions.lamports`                 | `LogOptions["lamports"]`                 |
| `LogOptions.idempotencyKey`           | `LogOptions["idempotency_key"]`          |
| `LogOptions.timeoutMs`                | `LogOptions["timeout_ms"]`               |
| `LogResult.signature` / `.slot` / `.schema` | identical names                    |

---

## §6 — Error model

The Python error hierarchy is **isomorphic** to FN-055 §6: one base class,
one error per method, plus a confirmation-timeout subclass that carries the
signature for the standard `get_transaction(hash)` recovery.

```python
"""Singularity SDK error hierarchy (FN-056 §6). Mirrors FN-055 §6."""

from __future__ import annotations


class SingularityError(Exception):
    """Root of the Singularity SDK error hierarchy."""

    code: str = "SINGULARITY_ERROR"

    def __init__(self, message: str, *, cause: BaseException | None = None) -> None:
        super().__init__(message)
        if cause is not None:
            self.__cause__ = cause


class ProvisionError(SingularityError):
    """Raised by `provision()`."""

    code = "PROVISION_FAILED"


class PayError(SingularityError):
    """Raised by `SingularityAgent.pay()` (other than confirmation timeout)."""

    code = "PAY_FAILED"


class ConfirmationTimeoutError(PayError):
    """Raised when a confirmed-by-default write times out before landing.

    Carries the submitted `signature` so the caller can reconcile via
    `get_transaction(hash=signature)` per the recovery contract documented
    in `src/tools/transfer.ts`.
    """

    code = "CONFIRMATION_TIMEOUT"

    def __init__(
        self,
        signature: str,
        message: str,
        *,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message, cause=cause)
        self.signature = signature


class QueryError(SingularityError):
    """Raised by `SingularityAgent.query_records()`."""

    code = "QUERY_FAILED"


class LogError(SingularityError):
    """Raised by `SingularityAgent.log()`."""

    code = "LOG_FAILED"
```

### §6.1 — Behavioral parity matrix

All cells read **identical** in v0.1. Any future divergence is escalated as a
new §8 open question and tracked in a follow-up FN ticket; it is **not**
silently absorbed.

| Method            | TypeScript behavior (FN-055)                                                                 | Python behavior (FN-056)                                                                  | Divergence |
|-------------------|----------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|------------|
| `provision`       | One-call create-or-rehydrate; idempotent on `name`; optional funding; default `testnet`.     | Same.                                                                                     | identical  |
| `pay`             | Confirmed-by-default; 30s timeout; memo via SPL Memo v2; in-flight coalescing; SVM/EVM input. | Same.                                                                                     | identical  |
| `query_records`   | Filter on sender/recipient/schema/slot range; default-drops non-JSON memos; clamps to 1000.  | Same. Field names snake_cased.                                                            | identical  |
| `log`             | JSON-envelope memo `{schema,payload}`; default recipient = self; ≤540-byte payload limit.    | Same.                                                                                     | identical  |
| Error hierarchy   | `SingularityError` → {`ProvisionError`, `PayError` → `ConfirmationTimeoutError`, `QueryError`, `LogError`}. | Identical class graph; `ConfirmationTimeoutError.signature` carries the signature.  | identical  |
| Idempotency keys  | Caller-supplied `idempotencyKey`; combined with sender/recipient/amount/blockhash/memo.       | `idempotency_key` (snake_case); same combination rule.                                    | identical  |
| Confirmation      | 30_000 ms default; override via `timeoutMs`.                                                  | 30_000 ms default; override via `timeout_ms`.                                             | identical  |
| Address handling  | SVM (base58) and EVM (0x) accepted; normalised to SVM via `resolveAddresses`.                | Same.                                                                                     | identical  |

---

## §7 — End-to-end example

The shape a Claude / Cursor / LangGraph Python agent is expected to emit when
asked *"give yourself a wallet, pay someone, remember it, then read history
back"*:

```python
import asyncio
from singularity_sdk import (
    LogRecord,
    QueryRecordsFilter,
    provision,
)


async def main() -> None:
    agent = await provision(
        "invoice-bot",
        network="testnet",
        funding={"amount": "0.5"},
    )

    pay = await agent.pay(
        "8vK6NpkqkGnLb6m2bX1tWJyBaP4u2yJrU2pwAcw9PqXk",
        "0.05",
        memo="invoice:42",
    )

    await agent.log(
        LogRecord(
            schema="eto.singularity.record.payment.v1",
            payload={
                "invoice_id": "42",
                "to": pay.to_svm,
                "amount_sol": "0.05",
                "memo": "invoice:42",
            },
        ),
    )

    history = await agent.query_records(
        QueryRecordsFilter(
            schema="eto.singularity.record.payment.v1",
            sender=agent.wallet["svm"],
            limit=50,
        ),
    )

    for record in history.records:
        print(record.slot, record.payload)


if __name__ == "__main__":
    asyncio.run(main())
```

---

## §8 — Open questions

| # | Question | Tracked in |
|---|---|---|
| 1 | **Transport.** Use the official [`mcp`](https://pypi.org/project/mcp/) Python client (matches the canonical MCP stdio path), a raw HTTP shim against `src/sse-server.ts`, or both behind a `Transport` ABC? Determines `pyproject.toml` runtime deps and whether the SDK can run in environments without Node. | FN-056 (this spec) |
| 2 | **Sync vs async API.** Async-only (matches `mcp` Python client) vs dual sync+async via `_sync` siblings (broader notebook ergonomics). The §5.4 naming pattern is reserved either way. | FN-056 (this spec) |
| 3 | **Identity model.** How `SingularityAgent.id` relates to ETO's `AgentCard` authority key, DIDs, and the issuer-network gating used by `@eto/mcp/issuers/*`. The Python SDK MUST NOT pre-empt the canonical decision. | FN-058 |
| 4 | **Authority inheritance.** When agent A spawns agent B via `provision`, does B inherit any of A's credentials / capabilities? Default for v0.1 is **no** (B starts blank), matching FN-055. | FN-059 |
| 5 | **Schema typing layer for `LogRecord[T]` payload validation.** Generated pydantic models from a shared JSON-Schema bundle vs hand-maintained `BaseModel` classes vs `TypedDict` only. | FN-057 |
| 6 | **JSON-Schema vendoring.** Should the package vendor TS-generated JSON Schemas (built from the FN-055 / FN-057 surface) for runtime validation, or hand-maintain pydantic models in Python? Vendoring keeps Python honest at the cost of a build-time dependency on the TS package. | FN-057 |
| 7 | **`mcp` Python client compatibility audit.** Confirm that the official Python MCP client supports the same tool-call envelope, error propagation, and streaming semantics that `src/sse-server.ts` and the `mcp` TS server emit; surface gaps before transport selection. | FN-038 (created from this task via `fn_task_create`) |
| 8 | **Large-record support.** SPL memo's ≈566-byte limit forces small JSON envelopes. Future work: chunked memos with a content-hash header, or off-chain blob + on-chain pointer. Inherited from FN-055 §7. | FN-057 |

---

## §9 — Non-goals (recap)

This spec produces no runtime artifacts. The following are explicitly **not**
delivered by FN-056 and MUST be done in follow-up tasks:

- The `singularity-sdk-py/` source tree.
- `pyproject.toml`, `__init__.py`, or any `.py` source file.
- A published `singularity-sdk` PyPI release.
- Any change to `docs/sdk-api-spec.md` (FN-055's deliverable). Surface drift
  is corrected by re-opening FN-055.
- Any change to `src/`, `tests/`, or `docs/schema-registry.md`.
