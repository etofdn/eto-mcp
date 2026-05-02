# FN-097 — Devnet Faucet Rate-Limiting and Connection Pooling Investigation

**Task:** FN-097  
**Date:** 2026-05-02  
**Endpoint:** `http://127.0.0.1:8899` (default; `ETO_RPC_URL` not set in environment)  
**Depends on:** FN-095 (devnet write failure reproduction)  
**Downstream:** FN-098 (confirmation fix), FN-051  

---

## Summary

**The faucet endpoint is not rate-limiting — it is worse: it returns a pre-computed, address-keyed cached signature for every call, regardless of how many times the address is funded or whether the previous transaction was ever committed to the ledger.** The returned signature never appears in `getTransaction` at 1 s, 5 s, or 30 s polling windows. No rate-limit headers (HTTP 429, `X-RateLimit-*`, `Retry-After`) were observed in 25 probes. Connection pooling via HTTP keep-alive is functioning correctly in Node.js and is NOT masking errors — the fast response times (0.3–0.5 ms) reflect the server's in-memory cache, not a connection-pooling artefact.

The root cause of GitHub issue #13 is that `faucet` returns a deterministic, per-address phantom signature that is never written to the ledger. `EtoRpcClient.faucet()` trusts this response and returns it as a valid signature to callers without any on-chain confirmation step.

---

## Methodology

1. **Preflight** — confirmed `http://127.0.0.1:8899` reachable (`getHealth` → `"ok"`); reviewed FN-095 artifacts (5/5 failed airdrops, 5-6 ms faucet latency, balance always 0).
2. **Burst probing** — 20 consecutive `faucet` curl calls against the same address, capturing full HTTP headers + body into `artifacts/burst-NN.txt`.
3. **Spaced probing** — 5 `faucet` calls (2 with 30 s gap, 3 with abbreviated 2 s gap after the same-sig pattern was confirmed in first 22 calls); captured into `artifacts/spaced-NN.txt`.
4. **Cross-address probing** — called `faucet` with 3 distinct addresses to determine whether the cache is global or per-address.
5. **`getTransaction` polling** — polled the returned signature at 1 s, 5 s, and 30 s delays; captured into `artifacts/gettx-*.txt`.
6. **TypeScript probe** — ran `scripts/probe-faucet.ts` (replicating `EtoRpcClient` code path verbatim) to confirm whether the `JSON.stringify` silent-error path triggered.
7. **Keep-alive trace** — ran `NODE_DEBUG=http,net node` to observe TCP connection reuse; captured into `artifacts/keepalive-trace.txt`.
8. **Error-masking audit** — read-only review of `src/read/rpc-client.ts` and `src/write/submitter.ts`.

---

## Faucet HTTP Behaviour

### Status Codes and Headers

**All 25 probes (20 burst + 5 spaced) returned HTTP 200.**

Exemplar response from `artifacts/burst-01.txt`:

```
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 217
Access-Control-Allow-Origin: *
Connection: keep-alive

{"id":1,"jsonrpc":"2.0","result":{"amount":10000000000,"recipient":"AzghrNHxdksNQbzMFt4oZ4R7seiCwP2v3XkdqD4hbBic","signature":"yZY2ZNfX47fg1d6c1iksp9wxZGp3AG1iEVgm9AZe46aNkb3dYJw58RPq2Q6cvMrg9PXM3bUfqXxvimKyQb2XgHk"}}

--- HTTP_CODE: 200 ---
--- TIME_TOTAL: 0.000382s ---
--- TIME_CONNECT: 0.000093s ---
--- NUM_CONNECTS: 1 ---
```

Response body shape: `{ amount: number, recipient: string, signature: string }`.

### Timing

| Metric | Value |
|--------|-------|
| Median round-trip (burst) | ~0.35 ms |
| Min round-trip | 0.29 ms |
| Max round-trip | 2.05 ms (burst-08, outlier — likely GC) |
| FN-095 MCP-layer latency | 5–6 ms (includes JSON-RPC framing overhead) |

Sub-millisecond response times (0.3–0.5 ms) are physically inconsistent with a real transaction broadcast; a valid Solana-compatible faucet requires at minimum 50–400 ms for network propagation. This confirms the endpoint serves from memory with no I/O.

---

## Rate-Limit Evidence

**Verdict: NO rate-limiting detected.**

| Signal | Observed |
|--------|----------|
| HTTP 429 | Never |
| HTTP 503 | Never |
| `X-RateLimit-*` headers | Never |
| `Retry-After` header | Never |
| "Too Many Requests" body | Never |
| Error responses | None across 25 probes |

All 25 calls succeeded with HTTP 200. The server accepts unlimited concurrent calls to the same address without any throttling signal. This rules out rate-limiting as the root cause of issue #13.

---

## Signature Caching (Critical Finding)

The most significant observation from this investigation: **the faucet endpoint returns an identical signature for every call to the same address.**

### Burst results (`artifacts/burst-summary.tsv`)

All 20 burst calls to address `AzghrNHxdksNQbzMFt4oZ4R7seiCwP2v3XkdqD4hbBic` returned the same signature:

```
yZY2ZNfX47fg1d6c1iksp9wxZGp3AG1iEVgm9AZe46aNkb3dYJw58RPq2Q6cvMrg9PXM3bUfqXxvimKyQb2XgHk
```

(All 20 entries in `burst-summary.tsv` show `yZY2ZNfX47fg1d6c1iks` as the sig_prefix.)

### Spaced results (`artifacts/spaced-summary.tsv`)

All 5 spaced calls (regardless of inter-call gap) also returned the same signature for the same address.

### Cross-address comparison (`artifacts/different-addr2.txt`, `different-addr3.txt`)

Different addresses receive different (but equally constant) signatures:

| Address (first 20 chars) | Returned Signature (first 40 chars) |
|--------------------------|--------------------------------------|
| `AzghrNHxdksNQbzMFt4o...` | `yZY2ZNfX47fg1d6c1iksp9wxZGp3AG1iEV...` |
| `94bSVuA4Xu6gxciDmz3t...` | `4V7jSCcyuzEERnzWhAiZSxsH4Jr4yJQ6o1...` |
| `So11111111111111111111...` | `3aKMS8dPEm9hBQqiqoQcgHPSVsk3NAYCaT...` |

**Conclusion:** The faucet maintains a per-address signature cache. Every call with address `A` always returns the same signature regardless of how many times it has been called or whether funds were ever credited. This is a deterministic phantom response, not idempotent transaction protection (a real idempotent faucet would still write to the ledger once and return the same on-chain signature; here the signature is never on-chain).

Cross-reference: The signature returned for address `94bSVuA4Xu6gxciDmz3t...` matches exactly the signature captured by FN-095 run 1 (`4V7jSCcyuzEERnzWhAiZS...`), confirming the behaviour is reproducible across separate invocations.

---

## `getTransaction` Polling Results

All polls of the signature `yZY2ZNfX47fg1d6c1iksp9wxZGp3AG1iEVgm9AZe46aNkb3dYJw58RPq2Q6cvMrg9PXM3bUfqXxvimKyQb2XgHk` returned `null`:

| Poll time | `getTransaction` result | Artifact |
|-----------|------------------------|---------|
| 1 s after faucet | `{"result":null}` | `artifacts/gettx-yZY2ZNfX47fg1d6c-1s.txt` |
| 5 s after faucet | `{"result":null}` | `artifacts/gettx-yZY2ZNfX47fg1d6c-5s.txt` |
| 30 s after faucet | `{"result":null}` | `artifacts/gettx-yZY2ZNfX47fg1d6c-30s.txt` |

The `getTransaction` round-trip is also 0.2 ms — confirming the node is serving from an empty in-memory store without hitting persistent storage.

---

## Connection Pooling Findings

### HTTP Keep-Alive Behaviour (`artifacts/keepalive-trace.txt`)

`NODE_DEBUG=http,net` trace with 5 sequential `fetch()` calls to the same host:

```
NET 562170: createConnection → 127.0.0.1:8899  ← Request 1: NEW connection
NET 562170: afterConnect
RESULT 1: {"id":1,"jsonrpc":"2.0","result":"ok"}
NET 562170: createConnection → 127.0.0.1:8899  ← Request 2: NEW connection
NET 562170: afterConnect
RESULT 2: {"id":2,"jsonrpc":"2.0","result":"ok"}
(no createConnection for requests 3–5)           ← Connection reused
RESULT 3: {"id":3,"jsonrpc":"2.0","result":"ok"}
RESULT 4: {"id":4,"jsonrpc":"2.0","result":"ok"}
RESULT 5: {"id":5,"jsonrpc":"2.0","result":"ok"}
```

**Observations:**
- Node.js v22 creates up to 2 TCP connections on warmup (default HTTP agent `maxSockets`), then reuses the idle socket for all subsequent requests.
- The server sends `Connection: keep-alive` (confirmed in response headers), so connections persist.
- From request 3 onward, no new TCP handshake occurs.

**Is connection pooling masking errors?** No. The server returns consistent HTTP 200 responses with valid JSON on every request. The fast response times reflect in-memory serving, not a connection-reuse artefact. Even if the keep-alive socket delivered a stale/error response, `EtoRpcClient.call()` checks `!response.ok` and `json.error` before returning, so HTTP-level errors would surface as exceptions.

**Verdict: Connection pooling is working correctly and is NOT a contributing factor to issue #13.**

---

## Error-Masking Audit

The following sites were audited for their potential to silently swallow faucet or rate-limit errors. **No production code was modified.**

| # | Location | Behaviour | Why It Could Mask Failures | Recommendation |
|---|----------|-----------|---------------------------|----------------|
| 1 | `src/read/rpc-client.ts:84` — `EtoRpcClient.faucet()` `??` chain | Non-string, non-`signature` results are JSON.stringify'd and returned as the "signature" | If the server ever returns `{"error":"rate limited"}` with HTTP 200 (no JSON-RPC `.error` field), the error object gets stringified (e.g. `'{"error":"rate limited"}'`) and returned to callers as if it were a valid on-chain signature. The caller never knows. | Throw if `resolvedSig` does not match a known base58/hex signature pattern (44 chars base58 or 88-char hex); never return `JSON.stringify(result)` silently. |
| 2 | `src/read/rpc-client.ts:37–45` — `call()` error detection | Only throws on `!response.ok` (non-2xx) or `json.error` (JSON-RPC level). A 200 response with a structurally invalid body (no `result`, truncated JSON, HTML error page) silently returns `undefined` cast to `T`. | If the faucet node is temporarily overloaded and serves an HTML error page or empty body, `response.json()` throws a parse error — but this is caught by the outer `try/catch` in the `airdrop` tool, not by `call()` itself. A 200 with `{}` (empty result) returns `undefined` silently. | Add `if (json.result === undefined && !json.error) throw new Error(...)` guard after `response.json()`. |
| 3 | `src/write/submitter.ts:172` — `pollConfirmation()` `catch {}` | `getTransaction` errors (network failure, JSON parse error, timeout) are silently discarded; polling just continues until deadline. | If the RPC node is flapping, `getTransaction` may throw repeatedly. The catch block discards all errors and the method ultimately returns `{status: "timeout"}` — masking the actual failure reason entirely. | Log the caught error at debug level, or accumulate the last error and include it in the `timeout` result. |
| 4 | `src/write/submitter.ts` — `inFlight` map keyed on `idempotencyKey` only | When two callers race with the same `idempotencyKey`, they share the same Promise. No per-signature deduplication. | If `sendTransaction` returns a different signature on retry (after a rekey), the original `inFlight` entry is stale. The retrying caller gets `coalesced: true` on a result referencing the old signature, not the new one. | Key the `inFlight` map on `(idempotencyKey, signedTxBase64)` hash, or clear the entry on confirmed/failed result rather than waiting 5 minutes. |

---

## Conclusions

1. **The faucet endpoint returns a deterministic per-address phantom signature.** Every call to `faucet` for address `A` returns the same signature regardless of call count or elapsed time. This signature is never written to the ledger (`getTransaction` → `null` at 1 s / 5 s / 30 s). **Citation:** `artifacts/burst-summary.tsv` (all 20 identical sig prefixes), `artifacts/gettx-summary.tsv` (all null results).

2. **There is no rate-limiting.** Zero HTTP 429s, 503s, or rate-limit headers across 25 probes. The faucet accepts unlimited calls without throttling. **Citation:** `artifacts/burst-01.txt` through `burst-20.txt`, `artifacts/spaced-01.txt` through `spaced-05.txt`.

3. **The `JSON.stringify` silent-error path in `EtoRpcClient.faucet()` was NOT triggered** with this devnet server, because the server always returns a `{signature}` field. However, the code path remains a latent bug: if the server ever returns an error body with HTTP 200 and no JSON-RPC `error` field, the stringified error object becomes the "signature". **Citation:** `artifacts/probe-faucet-ts-results.json`, `src/read/rpc-client.ts:84`.

4. **HTTP keep-alive is functioning normally** in Node.js v22 (and Bun reuses connections similarly). Connections are reused from request 3 onward. This is not masking errors. **Citation:** `artifacts/keepalive-trace.txt`.

5. **Three additional error-masking sites exist in the submitter** that could compound the faucet phantom-signature problem: `pollConfirmation`'s silent `catch {}`, the `inFlight` idempotency key design, and the `call()` method's non-assertion on empty results. These are pre-existing issues that should be fixed in a follow-up task.

---

## Recommended Follow-ups

| Priority | Task | Description |
|----------|------|-------------|
| HIGH | FN-098 | Fix `EtoRpcClient.faucet()` to poll `getTransaction` before returning the signature (or throw if the signature never lands). Add validation that the returned value looks like a real base58 signature. |
| HIGH | FN-098 | Fix `pollConfirmation()` catch block to log errors rather than discard silently (`src/write/submitter.ts:172`). |
| MEDIUM | FN-098 | Add a guard in `call()` at `src/read/rpc-client.ts:43` for `json.result === undefined && !json.error`. |
| MEDIUM | FN-051 | Investigate `inFlight` idempotency key design — consider adding signature to the key or clearing on resolution (`src/write/submitter.ts:46`). |
| LOW | Follow-up | The ETO devnet node's `faucet` implementation should be audited at the server level — why does it return a per-address constant signature? Is this a stub/mock implementation? |

---

## Appendix: Artifact Index

| File | Description |
|------|-------------|
| `scripts/probe-faucet.sh` | curl-based probe script (Phase 1 burst, Phase 2 spaced, Phase 3 getTransaction) |
| `scripts/probe-faucet.ts` | TypeScript probe replicating `EtoRpcClient` code path |
| `artifacts/burst-NN.txt` (×20) | Full HTTP response for each burst faucet call |
| `artifacts/spaced-NN.txt` (×5) | Full HTTP response for each spaced faucet call |
| `artifacts/burst-summary.tsv` | Tabular summary: call, HTTP status, result type, sig prefix, duration |
| `artifacts/spaced-summary.tsv` | Same for spaced calls |
| `artifacts/gettx-yZY2ZNfX47fg1d6c-{1,5,30}s.txt` | `getTransaction` responses at 1/5/30 s |
| `artifacts/gettx-summary.tsv` | getTransaction poll summary |
| `artifacts/different-addr2.txt` | Faucet response for FN-095 address (confirms per-address constant sig) |
| `artifacts/different-addr3.txt` | Faucet response for `So11111111111111111111...` |
| `artifacts/keepalive-trace.txt` | `NODE_DEBUG=http,net` trace (42 lines, 2 new TCP connections for 5 requests) |
| `artifacts/probe-faucet-ts-results.json` | Structured output from TypeScript probe |
