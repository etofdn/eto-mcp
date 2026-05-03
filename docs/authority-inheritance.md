# Authority Inheritance for Mutually-Trusted Agents

> **Status:** Specification (FN-059). No runtime tool behavior changes ship with
> this document. The TypeScript predicate at
> [`src/models/authority-inheritance.ts`](../src/models/authority-inheritance.ts)
> is the typed reference implementation; rollout follow-ups (filed at the end
> of this doc) will wire it into `create_a2a_channel`, `join_swarm`, and the
> on-chain `AgentState` layout.
>
> **Upstream:** GitHub issue
> [etofdn/etofdn-mcp#11](https://github.com/etofdn/etofdn-mcp/issues/11).
> **Related:** [`docs/agent-identity-model.md`](./agent-identity-model.md)
> (FN-058), FN-054 (A2A milestone), FN-060 (Layer-2 coordination API),
> FN-061 (model attestation).

---

## §1 — Overview & motivation

Issue #11 frames the problem succinctly:

> *"Two agents that share the same verified `human_authority` should
> automatically be mutually trusted to coordinate (open A2A channels, join
> swarms, exchange messages) without an explicit per-pair allowlist."*

Today, ETO's A2A layer authorizes coordination implicitly: any wallet may
call `create_a2a_channel` pointing at any `agent_account`, and `join_swarm`
gates membership only on the swarm's policy (`open` / `invite-only` /
`stake-required`). That posture is permissive enough to ship — but it is the
wrong default for a multi-agent fleet:

- **Per-pair allowlists do not scale.** A single human running *N* agents on
  *M* surfaces (laptop IDE, hosted runner, CI worker, mobile companion) needs
  *N × M* coordination relationships. Maintaining an explicit allowlist for
  every pair is `O(N²)` busywork that breaks on every key rotation.
- **The natural primitive is the human, not the wallet.** Wallet anchors
  rotate; sessions expire; model providers change. The one stable identity
  axis across all of these is the human attested by the auth backend
  (FN-058 §2.1's `human_authority`). Two agents under the same
  `human_authority` are, in user-mental-model terms, *the same principal* —
  there is no meaningful trust gap to bridge.
- **Per-pair allowlists conflate identity with authorization.** Capabilities
  (`a2a:write`, `transfer:write`, …) already gate *what* an agent may do.
  Identity should answer *who is asking*. Authority inheritance lets the
  identity layer answer "yes, this is the same human" without touching
  capability scoping.

Authority inheritance therefore says: **if two agents share the same verified
`human_authority`, they MAY coordinate freely, subject only to each side's
own `capabilities[]` list**. The capability check remains untouched (per
[`docs/agent-identity-model.md` §3.1](./agent-identity-model.md#31--worked-example)
— *"inheritance attributes intent, it does not lend caps"*).

---

## §2 — Inheritance rule (formal)

> **Rule.** Agent *A* MAY coordinate with Agent *B* iff:
>
> 1. `A.human_authority` is **verified** (see §2.1), AND
> 2. `B.human_authority` is **verified**, AND
> 3. `A.human_authority ≡ B.human_authority` (see §2.2).
>
> When the rule holds, A and B are *mutually trusted at the identity layer*.
> Capability gating still applies on each side independently.

### §2.1 — What "verified" means

FN-058 (`docs/agent-identity-model.md` §2.1) classifies `human_authority` by
its `kind`:

| `kind` | Source | Verified for inheritance? |
|---|---|---|
| `"thirdweb"` | siwe / inapp_email / inapp_oauth — real human-attested | **Yes** |
| `"dev"` | dev-bypass; never a real human | No |
| `"stdio"` | `__stdio__` scope; local-trust only | No |
| `"unknown"` | fallback when nothing is known | No |

Equivalently: *verified* means `human_authority.kind === "thirdweb"` AND
`human_authority.auth_strategy` is one of `"siwe" | "inapp_email" |
"inapp_oauth"` (i.e. is present and non-`"dev"`).

This matches FN-058 §3.2's exclusion list — `__stdio__` and `__dev__` MUST
NOT inherit even on a `sub` collision.

> **Why not key on `attestation_status`?** `attestation_status` is the
> discriminator for `model_attestation`, NOT for `human_authority`. FN-058
> deliberately did not give `HumanAuthority` a `verified` flag because the
> verification fact is fully determined by `kind` + `auth_strategy`. This
> spec preserves that invariant.

### §2.2 — What `≡` means

`A.human_authority ≡ B.human_authority` iff **both** of:

1. `A.human_authority.auth_strategy === B.human_authority.auth_strategy`
   (and both are present), AND
2. `A.human_authority.sub === B.human_authority.sub`.

Bare `sub` equality is **insufficient**: two different auth strategies could
plausibly mint identical `sub` values. For example, `inapp_email` keys on a
provider-internal user ID; `siwe` keys on a 0x-hex wallet address. Nothing in
the protocol guarantees these namespaces are disjoint, so we treat the pair
`(auth_strategy, sub)` as the canonical principal key.

**Note on `kind` vs `auth_strategy`.** `kind` is a coarser bucket
(`"thirdweb"` collapses three strategies). For inheritance we require the
*finer* match — two thirdweb-kind authorities with differing strategies
(e.g. `siwe` vs `inapp_oauth`) are NOT considered the same principal even if
`sub` matches, because the underlying credential ceremony is different.

### §2.3 — Decision table

| Self verified? | Other verified? | Strategies match? | `sub` matches? | Inherit? | Reason code |
|---|---|---|---|---|---|
| no  | *   | *   | *   | no  | `unverified_self` |
| yes | no  | *   | *   | no  | `unverified_other` |
| yes | yes | no  | *   | no  | `different_strategy` |
| yes | yes | yes | no  | no  | `different_sub` |
| yes | yes | yes | yes | **yes** | `allowed` |
| (either side missing `human_authority` field entirely) | | | | no | `missing_human_authority` |

The reason codes correspond 1:1 to the `canInheritTrust(...)` return values
in [`src/models/authority-inheritance.ts`](../src/models/authority-inheritance.ts).

---

## §3 — Trust degradation rules

### §3.1 — Unverified `human_authority`

If either side's `human_authority` fails the verified test in §2.1 (e.g.
`kind === "stdio"`, `kind === "dev"`, `kind === "unknown"`, or
`auth_strategy` is missing):

- The pair MUST NOT inherit trust.
- Authorization falls back to whatever per-tool mechanism existed before this
  spec: today, `create_a2a_channel` is implicitly open to any active wallet,
  and `join_swarm` enforces the swarm's `open` / `invite-only` /
  `stake-required` policy. Authority inheritance is purely *additive* — it
  bypasses those checks when it applies, and is silent when it does not.

### §3.2 — Model attestation is irrelevant

`model_attestation.attestation_status` is **not** consulted by inheritance.
Per FN-058 §3, *"two agents inherit authority across model providers,
because the human is the same human."* A `verified` Claude-on-laptop and a
`self_declared` GPT-on-runner under the same thirdweb SIWE `sub` MAY
coordinate — model identity is downstream of human identity.

### §3.3 — Session scope boundaries

Inheritance is **identity-level, not session-level**. A stale or expired
`session_scope` on the *receiving* side does not block inheritance from a
peer whose underlying `human_authority` is still verifiable, *provided the
receiver's own session is still valid for the capability it would exercise
in response*. Concretely:

- An expired `session_scope.expires_at_iso` invalidates the local agent's
  ability to act (capability gate fails), but it does not retroactively
  poison the inheritance relationship for messages that arrived earlier.
- When evaluating an inbound coordination request, the receiver checks
  inheritance against *its own current* `AgentIdentity`, not against a
  cached one.

### §3.4 — Identity-level only, never capability-level

Authority inheritance does NOT lend capabilities. If agent A has
`a2a:write + transfer:write` and agent B has only `a2a:read`, B receiving an
inherited request from A does NOT gain `transfer:write`. B can still only do
what B's own `session_scope.capabilities` permit. (This is FN-058 §3.1
verbatim and is restated here so downstream implementers do not get clever.)

---

## §4 — On-chain `AgentState` data model change

The current `AgentState` Borsh layout (see `src/tools/agent.ts` lines 12–42
and `runtime/src/programs/agent.rs`) is:

```
discriminator : [u8; 8]
authority     : Pubkey (32)
name          : String       // borsh: u32 LE length + UTF-8 bytes
model_id      : String
metadata_uri  : String
reputation    : u64
status        : u8           // 0=active, 1=paused, 2=deactivated
```

To carry `human_authority` on-chain, this spec adds **two** fields, appended
after `status`, gated by an explicit version byte:

```
schema_version  : u8                         // 0 = legacy, 1 = with human_authority
human_authority : Option<HumanAuthorityRecord>  // borsh Option = u8 tag (0|1) + value
```

with:

```rust
struct HumanAuthorityRecord {
    auth_strategy : String,   // "siwe" | "inapp_email" | "inapp_oauth" | "dev"
    sub           : String,   // matches AgentIdentity.human_authority.sub
    bound_at_slot : u64,      // slot at which this binding was written
}
```

Borsh field order is fixed: `auth_strategy`, then `sub`, then `bound_at_slot`.
String length prefixes are u32 LE per Borsh. `bound_at_slot` is a Solana
slot number captured by the runtime during the registration tx.

### §4.1 — Decoder rules

`parseAgentState` in `src/tools/agent.ts` will be amended (in the rollout
follow-up) so that, after reading `status`:

1. If the buffer has no remaining bytes, treat as `schema_version = 0` and
   `human_authority = None`. **Legacy accounts continue to parse cleanly.**
2. Otherwise read `schema_version: u8`.
3. If `schema_version >= 1`, read `human_authority: Option<HumanAuthorityRecord>`
   using `BorshReader.readU8()` for the option tag and (when tag = 1) the
   three fields above.
4. Unknown `schema_version` values higher than the decoder knows about MUST
   cause `parseAgentState` to surface a recognizable error
   (`"unsupported AgentState schema_version"`), not silently truncate.

The existing `BorshReader` API
([`src/utils/borsh-reader.ts`](../src/utils/borsh-reader.ts)) already exposes
`readU8`, `readU64`, `readString`, and length-prefixed primitives — no new
Borsh helpers are required.

### §4.2 — Backwards compatibility

- Accounts created before the schema change have **zero trailing bytes**
  past `status`. `parseAgentState` MUST treat them as `human_authority =
  None`.
- The inheritance predicate treats `human_authority = None` as
  `missing_human_authority` (not "unverified") so that legacy accounts never
  participate in inheritance silently.
- New accounts created after the schema change MUST be written with
  `schema_version = 1` and the `Option` populated according to whether the
  registration request carried a verified `SessionClaims`.

### §4.3 — Population path

`human_authority` is written **once, by the runtime, during agent
registration**:

- The MCP gateway forwards the caller's verified `SessionClaims` (already
  available at the request handler — see `src/gateway/session.ts`) into the
  `RegisterAgent` instruction's data payload.
- The on-chain `RegisterAgent` handler stamps the value into the
  `AgentState` PDA along with the current `Clock.slot` as `bound_at_slot`.
- Forging is prevented because:
  1. Only the on-chain `authority` signer can land a `RegisterAgent` tx
     against the PDA, AND
  2. The gateway is the only path that can attach a verified `SessionClaims`
     payload, AND
  3. The runtime trusts `SessionClaims` only when supplied via the gateway's
     authenticated channel; direct RPC tx submission with an unverified
     authority claim is rejected.

A future `BindAgentAuthority` instruction (separate task) will let the
authority of a legacy account opt-in to the binding without re-registering.

---

## §5 — Authorization-check logic (pseudo-code)

> **This section is normative for the rollout follow-ups, not for FN-059.**
> FN-059 itself does not modify the tool implementations.

The check is the same for both tools and is expressed in terms of the
predicate exported by `src/models/authority-inheritance.ts`:

```ts
import { sharesHumanAuthority, canInheritTrust }
  from "../models/authority-inheritance.js";
import { buildInterimAgentIdentity }
  from "../models/agent-identity.js";
```

### §5.1 — `create_a2a_channel(agent_account)`

```ts
// Sketch — to be implemented by the rollout follow-up.
const state = await fetchAgentState(agent_account);
if (!state) return error("agent_account not found");

if (state.schema_version >= 1 && state.human_authority !== null) {
  const selfIdentity = buildInterimAgentIdentity(currentSessionInfo());
  const otherIdentity: AgentIdentity = agentIdentityFromAgentState(state);

  if (sharesHumanAuthority(selfIdentity, otherIdentity)) {
    // Fast-path: same human authority, allow regardless of any other
    // (future) per-pair allowlist.
    return registerCard({ /* … */ });
  }

  const decision = canInheritTrust(selfIdentity, otherIdentity);
  if (!decision.allowed) {
    // Today: implicit-allow fallback (current behavior).
    // Future: explicit-deny when an allowlist mechanism exists.
    return registerCard({ /* … */ });
  }
}

// Legacy account or no human_authority bound → existing implicit behavior.
return registerCard({ /* … */ });
```

### §5.2 — `join_swarm(swarm_id)`

```ts
// Sketch — to be implemented by the rollout follow-up.
const swarm = await fetchSwarmState(swarm_id);
const selfIdentity = buildInterimAgentIdentity(currentSessionInfo());

let inheritedFastPath = false;
for (const memberAccount of swarm.members) {
  const memberState = await fetchAgentState(memberAccount);
  if (!memberState || memberState.schema_version < 1
      || memberState.human_authority === null) continue;
  const memberIdentity = agentIdentityFromAgentState(memberState);
  if (sharesHumanAuthority(selfIdentity, memberIdentity)) {
    inheritedFastPath = true;
    break;
  }
}

if (inheritedFastPath) {
  // Bypass invitation/stake gates: the swarm contains another agent under
  // the same human_authority, so the swarm is effectively a private
  // workspace for that principal.
  return submitJoinSwarm({ stake_amount: "0", invitation: "" });
}

// Fall through to the existing policy check (open/invite-only/stake-required).
return submitJoinSwarm({ stake_amount, invitation });
```

`agentIdentityFromAgentState(state)` is a small helper (to be added in the
on-chain rollout task) that lifts `state.human_authority` into a partial
`AgentIdentity` whose `model_attestation`, `environment`, and
`session_scope` fields are filled with `absent` / synthetic stubs — only
`human_authority` is consulted by `sharesHumanAuthority`.

---

## §6 — Threat model

| # | Threat | Mitigation |
|---|---|---|
| T1 | **Forged `human_authority` claim by a malicious gateway operator.** A compromised gateway could mint `SessionClaims` with arbitrary `(auth_strategy, sub)` and use them to register an agent that inherits trust from an unrelated principal. | The gateway is in the trust base for *all* MCP authorization today; this spec does not widen that surface. Compromise of the gateway HMAC key was already a fleet-fatal event before this spec. **Non-mitigation:** until on-chain attestation transport (FN-061) lands, the runtime cannot independently verify `SessionClaims`. |
| T2 | **Replay across `auth_strategy` migrations.** A user migrates from `dev` to `siwe`. An old agent registered with `auth_strategy: "dev"` collides on `sub` with a new `siwe`-anchored agent. | The §2.2 strategy-must-match rule rejects this: `("dev", "0xAlice") ≢ ("siwe", "0xAlice")`. Additionally, §2.1 excludes `"dev"` from the verified set entirely, so `"dev"`-anchored agents never inherit at all. |
| T3 | **Stale `bound_at_slot` after credential rotation.** A user revokes a thirdweb session and reauthenticates; an agent registered before revocation still carries the old `(auth_strategy, sub)`. | Inheritance keys on `(auth_strategy, sub)`, not on session lifetime. If `sub` is stable across the rotation (it usually is — `sub` is a long-lived account ID), inheritance survives, which is the desired outcome. If `sub` rotates, the old binding becomes a dangling identity that no longer matches any live session — cannot inherit because no live peer will produce the same `sub`. The `bound_at_slot` field is recorded for forensic / audit use; it is not consulted by the predicate. |
| T4 | **Cross-tenant leak when `sub` collides across strategies.** Two distinct humans happen to share a `sub` value (e.g. one's email-hash equals another's wallet address by coincidence). | The §2.2 rule requires `auth_strategy` to match, which makes accidental cross-strategy collision non-exploitable. Same-strategy collisions are the auth provider's responsibility (thirdweb's `sub` namespaces are documented as collision-free within a single `auth_strategy`). |
| T5 | **Discoverability leak.** Anyone who reads on-chain state can enumerate which agents share a `human_authority`. | **Explicit non-mitigation.** `AgentState` is a public PDA; placing `human_authority` on-chain means the binding is public. Users who require unlinkability between their agents MUST register them under separate `human_authority` principals (e.g. distinct thirdweb accounts). FN-061 may revisit this with off-chain attestation transport. |
| T6 | **Schema downgrade attack.** An attacker writes `schema_version = 0` to an account that previously had `schema_version = 1`, hoping decoders will treat it as legacy and skip inheritance. | The `RegisterAgent` instruction is the only writer; once `schema_version = 1` is stamped, the runtime MUST refuse to write `0` over it. (Specified here; enforced by the on-chain rollout task.) |

---

## §7 — Rollout plan

This spec is delivered as a planning artifact. Three follow-up tasks are
filed via `fn_task_create` to land the on-chain change and the two tool
hookups. Each depends on FN-059 (this task). Their IDs are recorded below
when filed:

1. **On-chain `AgentState` Borsh extension.** Extend the `AgentState`
   layout with `schema_version: u8` + `human_authority:
   Option<HumanAuthorityRecord>`, update `RegisterAgent` to populate it from
   verified `SessionClaims`, and update `parseAgentState` in
   `src/tools/agent.ts` to decode the new fields per §4.1. Includes the
   `BindAgentAuthority` opt-in instruction for legacy accounts.
   - **Filed as:** _to be recorded after `fn_task_create`_

2. **`create_a2a_channel` authorization fast-path.** Wire
   `sharesHumanAuthority` into the `create_a2a_channel` handler in
   `src/tools/a2a.ts` per §5.1. Must not regress the legacy / no-binding
   path.
   - **Filed as:** _to be recorded after `fn_task_create`_

3. **`join_swarm` authorization fast-path.** Wire `sharesHumanAuthority`
   into the `join_swarm` handler in `src/tools/swarm.ts` per §5.2. Iterates
   members; bypasses invitation/stake gates only when at least one member
   shares the caller's `human_authority`.
   - **Filed as:** _to be recorded after `fn_task_create`_

---

## §8 — Non-goals

The following are explicitly **out of scope** for this spec:

- **Revocation.** A way for a human to invalidate a previously-bound
  `human_authority` on an agent without burning the agent account. Belongs
  to a future `RevokeAgentAuthority` design.
- **Delegation across `human_authority` boundaries.** "User A authorizes
  user B's agent to act on A's behalf." This is a *capability*-layer
  concept, not an identity-layer one, and lives outside this spec
  (FN-058 §8 lists it as a non-goal too).
- **Group-of-humans authority.** A team / multisig authority that multiple
  humans share. Could be modeled as a synthetic `auth_strategy` in a future
  spec.
- **On-chain attestation transport for `model_attestation`.** Tracked by
  FN-061; orthogonal to authority inheritance.
- **Implementation of the on-chain Borsh change** — specified here, landed
  by rollout task #1.
- **Implementation of the tool-handler checks** — specified here, landed
  by rollout tasks #2 and #3.
- **Cryptographic proof of `human_authority` to a remote peer over A2A.**
  This spec assumes both peers query the same on-chain `AgentState` to
  discover `human_authority`. Peer-to-peer attestation transport is an
  FN-060 concern.

---

## §9 — Open questions

| # | Question | Resolved by |
|---|---|---|
| Q1 | Should `auth_strategy = "dev"` ever inherit on a developer's local cluster (i.e. "trust dev within dev")? Today the answer is no; revisit if dev-mode ergonomics suffer. | Rollout task #2 / #3 |
| Q2 | When a swarm has hundreds of members, the §5.2 per-member iteration is O(N) RPC reads. Is a swarm-level cached "authorities present" index warranted? | Rollout task #3 |
| Q3 | Should `BindAgentAuthority` allow rebinding (changing `human_authority` after first bind), or is the binding append-only-with-revocation? | Rollout task #1 (and a future revocation spec) |
| Q4 | Is `bound_at_slot` enough for forensic auditing, or do we also need an event log entry on each binding? | Rollout task #1 |
| Q5 | When `human_authority.kind === "stdio"`, FN-058 §3.2 says "local trust only" but does not forbid two stdio agents on the same host from inheriting. Do we surface that as a separate `local_inherit` predicate, or keep stdio strictly non-inheriting? | Future task (TBD) |

---

## §10 — Cross-references

- [`docs/agent-identity-model.md`](./agent-identity-model.md) — FN-058,
  authoritative `AgentIdentity` and `HumanAuthority` shapes; this spec
  imports those types verbatim.
- [`src/models/agent-identity.ts`](../src/models/agent-identity.ts) —
  TypeScript surface for `AgentIdentity` / `HumanAuthority`.
- [`src/models/authority-inheritance.ts`](../src/models/authority-inheritance.ts) —
  reference predicate (`sharesHumanAuthority`, `canInheritTrust`).
- [`src/tools/agent.ts`](../src/tools/agent.ts) — current `parseAgentState`
  and Borsh layout (target of rollout task #1).
- [`src/tools/a2a.ts`](../src/tools/a2a.ts) — `create_a2a_channel`
  registration (target of rollout task #2).
- [`src/tools/swarm.ts`](../src/tools/swarm.ts) — `join_swarm` handler
  (target of rollout task #3).
- [`src/utils/borsh-reader.ts`](../src/utils/borsh-reader.ts) — Borsh
  decoding helpers used by §4.1.
- GitHub issue [#11](https://github.com/etofdn/etofdn-mcp/issues/11) —
  upstream framing.
- FN-054 — A2A milestone parent.
- FN-060 — Layer-2 coordination API (consumes this rule transitively).
- FN-061 — model attestation (orthogonal but referenced in §3.2).
