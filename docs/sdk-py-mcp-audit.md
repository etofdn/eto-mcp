# Python `mcp` SDK Compatibility Audit

**Audit target:** [`mcp` 1.27.0](https://pypi.org/project/mcp/) (released 2026-04-02)  
**ETO MCP surface:** `src/sse-server.ts`, `src/server.ts`, `src/tools/wallet.ts` (representative)  
**TS SDK:** `@modelcontextprotocol/sdk` (McpServer, SSEServerTransport, mcpAuthRouter)  
**Skeleton spec:** `docs/sdk-py-skeleton-spec.md` does not yet exist; this audit stands alone.  
**Date:** 2026-05-04

---

## Summary Verdict

**GREEN** — the Python `mcp` client is compatible with the ETO MCP SSE surface for immediate adoption.

One **YELLOW** deprecation note (SSE transport lifecycle) and one **YELLOW** server-side cleanup
item (missing `isError` on error returns) are documented below. Neither blocks Python client adoption;
both are server-side improvements, not Python SDK gaps.

---

## Surface Comparison

| Dimension | ETO MCP (TS server) | Python `mcp` 1.27.0 client | Match? |
|---|---|---|---|
| **Transport** | `SSEServerTransport` at `GET /sse`, `POST /message?sessionId=…` (`sse-server.ts:189-228`) | `mcp.client.sse.sse_client` — connects to `/sse`, extracts `sessionId` from endpoint event, POSTs to `/message` | YES |
| **JSON-RPC envelope** | Standard JSON-RPC 2.0 via `@modelcontextprotocol/sdk` | `ClientSession` sends/receives standard JSON-RPC 2.0 frames over the SSE channel | YES |
| **Tool call request** | `tools/call` method, params `{name, arguments}` | `ClientSession.call_tool(name, arguments)` emits identical frame | YES |
| **Tool result shape** | `{content: [{type:"text", text:…}]}` (`wallet.ts:75, 82`) | `CallToolResult` — `content: list[TextContent | ImageContent | …]`, `isError: bool` | YES (see note 1) |
| **Content block types** | `TextContent` (`type:"text"`) | `TextContent`, `ImageContent`, `EmbeddedResource` — same discriminated union | YES |
| **Error propagation** | Error path returns `{content:[{type:"text",text:"Error: …"}]}` with no `isError:true` (`wallet.ts:82-85`) | `CallToolResult.isError` defaults `False`; client reads `.content` regardless | PARTIAL (note 1) |
| **Streaming / progress** | No server-initiated progress tokens on current tools; SSE channel stays open for push | `ClientSession` supports `progress_token` via `report_progress()`; no-op if server omits | YES (no-op compat) |
| **OAuth 2.1 / Bearer auth** | `mcpAuthRouter` issues tokens; `GET /sse` and `POST /message` require `Authorization: Bearer …`; RFC 9728 `/.well-known/oauth-protected-resource` metadata; WWW-Authenticate challenge at `sse-server.ts:78-105` | `OAuthClientProvider` + `TokenStorage` protocol; RFC 9728 discovery; `httpx.Auth` integration on `sse_client(headers=…, auth=…)` | YES |
| **CORS / MCP-Protocol-Version** | Allowed in CORS: `Authorization`, `MCP-Protocol-Version` (`sse-server.ts:35`) | SDK 1.27.0 sends `MCP-Protocol-Version` on negotiation; Python `httpx` client passes custom headers via `headers=` param | YES |
| **Session lifecycle** | Server creates `SSEServerTransport` per connection; session cleaned up on SSE `close` event (`sse-server.ts:197-207`) | `sse_client` context manager — closes cleanly on `__aexit__`; reconnect is caller's responsibility | YES |

---

## Gaps

### Note 1 — Missing `isError` flag on TS error returns (server-side, YELLOW)

**What ETO does:** All tool handlers in `src/tools/` return errors as plain content blocks:

```typescript
// src/tools/wallet.ts:82-85
return { content: [{ type: "text" as const, text: `Error creating wallet: ${err?.message}` }] };
```

No `isError: true` is set. The MCP specification defines `isError` on `CallToolResult` to signal
tool-level failures distinct from successful results.

**Python client behaviour:** `CallToolResult.isError` defaults to `False`. A Python client receives
the error text in `.content[0].text` but cannot distinguish a tool failure from a successful
text-only response without inspecting the text itself.

**Impact:** Transport-level compatibility is unaffected — the wire frame is valid JSON-RPC. However,
a Python consumer that branches on `result.isError` will silently treat TS error returns as successes.

**Severity:** YELLOW — server-side fix (add `isError: true` to error return paths in all tool handlers).
Not a Python SDK gap; Python `mcp` correctly implements the spec field.

### Note 2 — SSE transport deprecation lifecycle (YELLOW, future migration)

The Python SDK README states: _"SSE transport is being superseded by Streamable HTTP transport."_
ETO's `sse-server.ts` uses `SSEServerTransport` exclusively. Both transports remain supported in
`mcp` 1.27.0, so adoption is not blocked today. A future migration to `StreamableHTTPServerTransport`
(TS) and `streamablehttp_client` (Python) should be tracked.

---

## Adoption Recommendation

**Adopt `mcp` 1.27.0 as the Python client transport now.**

Minimal connection pattern:

```python
from mcp.client.sse import sse_client
from mcp.client.session import ClientSession
import httpx

headers = {"Authorization": f"Bearer {token}"}
async with sse_client("https://mcp.entropytoorder.xyz/sse", headers=headers) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        result = await session.call_tool("create_wallet", {"label": "py-test"})
        print(result.content[0].text)
```

For the full OAuth 2.1 flow (discovery → authorize → token → refresh), use `OAuthClientProvider`
with a `TokenStorage` implementation. The ETO server's RFC 9728 metadata at
`/.well-known/oauth-protected-resource` is already compatible with this flow.

**Before relying on `result.isError` in Python consumers:** open a follow-up ticket to add
`isError: true` to all error return paths in `src/tools/` TS handlers.

---

## References

- `src/sse-server.ts:23` — RESOURCE_METADATA_URL (RFC 9728 discovery)
- `src/sse-server.ts:45-50` — `mcpAuthRouter` mount
- `src/sse-server.ts:52-105` — Bearer extraction + WWW-Authenticate challenge
- `src/sse-server.ts:189-228` — SSE handshake + POST /message routing
- `src/server.ts:33-44` — `McpServer` construction
- `src/tools/wallet.ts:62-85` — tool registration envelope + error return shape
- [PyPI mcp 1.27.0](https://pypi.org/project/mcp/)
- [python-sdk README](https://github.com/modelcontextprotocol/python-sdk)
- [python-sdk mcp/client/sse.py](https://github.com/modelcontextprotocol/python-sdk/blob/main/src/mcp/client/sse.py)
