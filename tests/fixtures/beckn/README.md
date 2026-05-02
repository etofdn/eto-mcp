# Beckn v2.0 LTS Fixture Envelopes

These JSON fixtures represent canonical Beckn v2.0 LTS request/response envelopes
used by the bridge conformance suite (`tests/bridge-conformance.test.ts`).

## Source

All envelopes are derived from the Beckn v2.0 LTS protocol specification:
- **Reference:** https://developers.becknprotocol.io/docs/protocol-specifications/
- **Project spec:** `spec/BECKN-NATIVE-SPEC.md` (project-local canonical reference)
- **Context fields:** per Beckn §5.2 (Context object) and §5.2.3 (Context propagation)

## Valid Envelopes (forward actions — BAP→BPP)

| File | Action | Description |
|------|--------|-------------|
| `search.json` | `search` | BAP broadcasts a service search (no `bpp_id`/`bpp_uri`) |
| `select.json` | `select` | BAP selects a specific item from a BPP |
| `init.json` | `init` | BAP initiates an order with billing + fulfillment details |
| `confirm.json` | `confirm` | BAP confirms an order with payment |

## Valid Envelopes (callback actions — BPP→BAP)

| File | Action | Description |
|------|--------|-------------|
| `on_search.json` | `on_search` | BPP async catalog callback to BAP |
| `on_select.json` | `on_select` | BPP quote/selection callback to BAP |
| `on_init.json` | `on_init` | BPP draft-order + payment-terms callback to BAP |
| `on_confirm.json` | `on_confirm` | BPP confirmed-order + fulfillment callback to BAP |

## Malformed Envelopes

| File | Fault | Expected Response |
|------|-------|-------------------|
| `malformed-missing-context.json` | No `context` field | `400 BECKN_400` |
| `malformed-bad-action.json` | `context.action` not in enum | `400 BECKN_400` |

## Context Field Requirements (Beckn v2.0 LTS §5.2)

Every valid envelope carries these required context fields:

| Field | Type | Notes |
|-------|------|-------|
| `domain` | string | Network domain (e.g. `"retail"`) |
| `action` | enum | One of the eight supported actions |
| `version` | string | Must be `"2.0.0"` for v2.0 LTS |
| `bap_id` | string | BAP subscriber ID |
| `bap_uri` | string | BAP callback URI |
| `transaction_id` | UUID v4 | Shared across all messages in a transaction |
| `message_id` | UUID v4 | Unique per message |
| `timestamp` | ISO-8601 UTC | Message creation time |
| `ttl` | ISO-8601 duration | Optional; e.g. `"PT30S"` |
| `bpp_id` | string | Required for BPP-targeted actions (select/init/confirm/on_*) |
| `bpp_uri` | string | Required for BPP-targeted actions |

## Context Propagation (§5.2.3)

Callback envelopes (`on_*`) MUST echo the `transaction_id` and `message_id`
from the original forward action. The fixtures in this directory demonstrate
this: each `(search, on_search)` pair shares the same `transaction_id` and
`message_id`.
