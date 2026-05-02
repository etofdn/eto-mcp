/**
 * AgentCard registration for BPPs (FN-073, T-2.7.1.1, Step 2).
 *
 * Builds the Borsh-encoded `RegisterAgent` instruction expected by the
 * on-chain ETO program (discriminator = 0, three length-prefixed strings:
 * `name`, `model_id`, `metadata_uri`). The instruction shape is held
 * stable here so the five reference BPPs (FN-075–079) and the bank BPP
 * (FN-096) all submit byte-identical bytes against the eventual
 * `eto-mcp/src/tools/agent.ts` builder.
 *
 * NOTE on size limits
 * -------------------
 * The on-chain `RegisterAgent` Rust struct that ratifies these limits is
 * not yet in the tree (the broader Keeper SDK lands in a parallel task).
 * We therefore document the limits the template enforces — derived from
 * the `AgentCard.name` / `metadata_uri` field budgets implied by Solana
 * account-size conventions and the existing FN-019 layout — and gate
 * them in a single `REGISTER_AGENT_*` constant block. If the Rust struct
 * lands with different limits, raise the constants here in lockstep
 * (see TODO at the bottom of the file).
 */

import { z } from "zod";
import {
  zCapabilityTags,
  type AgentConfig,
  type BppConfig,
  type CapabilityTags,
  type Pubkey,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Borsh discriminator for the `RegisterAgent` instruction. */
export const REGISTER_AGENT_DISCRIMINATOR = 0;

/**
 * Maximum byte length of the `name` field. 64 bytes matches the
 * documented `AgentCard.name` cap used by `eto-mcp/src/issuers/skill-cert`
 * and the placeholder size budget in this codebase. TODO(FN-074):
 * verify against the `RegisterAgent` Rust struct once it lands.
 */
export const REGISTER_AGENT_NAME_MAX = 64;

/**
 * Maximum byte length of `metadata_uri`. 256 is the working budget for
 * AgentCard metadata pointers; capability-tag JSON exceeding this is
 * pinned via `MetadataPinner`. TODO(FN-074): verify against Rust.
 */
export const REGISTER_AGENT_METADATA_URI_MAX = 256;

/** PDA seed prefix for AgentCard accounts. */
export const AGENT_CARD_PDA_PREFIX = "agent_card";

/* -------------------------------------------------------------------------- */
/* Inline-metadata encoding                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Encode `tags` as a `data:application/json;base64,…` URL.
 *
 * Returns the URL string when the result fits inside
 * `REGISTER_AGENT_METADATA_URI_MAX` bytes; returns `null` when the
 * caller must fall back to a `MetadataPinner`.
 */
export function encodeMetadataUri(tags: CapabilityTags): string | null {
  // Validate shape before serialising — gives BPP authors a clean error
  // surface instead of silent corruption.
  zCapabilityTags.parse(tags);
  const json = JSON.stringify(tags);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  const uri = `data:application/json;base64,${b64}`;
  return Buffer.byteLength(uri, "utf8") <= REGISTER_AGENT_METADATA_URI_MAX
    ? uri
    : null;
}

/**
 * Pluggable metadata-pinning hook. The default `InMemoryPinner` is used
 * by tests and the worked example; production deploys inject an IPFS
 * client returning `ipfs://<cid>`.
 */
export interface MetadataPinner {
  pin(value: CapabilityTags): Promise<string>;
}

/** Test/example pinner: stores in a Map keyed by sha-ish content hash. */
export class InMemoryPinner implements MetadataPinner {
  private readonly store = new Map<string, string>();
  public async pin(value: CapabilityTags): Promise<string> {
    const json = JSON.stringify(value);
    const tag = `inmem://${this.store.size + 1}`;
    this.store.set(tag, json);
    return tag;
  }
  public get(uri: string): string | undefined {
    return this.store.get(uri);
  }
}

/* -------------------------------------------------------------------------- */
/* Borsh instruction builder                                                  */
/* -------------------------------------------------------------------------- */

export interface RegisterAgentArgs {
  readonly name: string;
  readonly modelId: string;
  readonly metadataUri: string;
}

const zRegisterAgentArgs = z
  .object({
    name: z.string().min(1),
    modelId: z.string().min(1),
    metadataUri: z.string().min(1),
  })
  .strict();

/**
 * Produce the exact byte sequence the on-chain program will deserialise
 * as `RegisterAgent { name, model_id, metadata_uri }`. Layout:
 *
 *     [u8 discriminator=0][u32 LE name_len][name bytes]
 *     [u32 LE model_id_len][model_id bytes]
 *     [u32 LE uri_len][uri bytes]
 *
 * Strings are UTF-8. Throws when any field exceeds its on-chain cap so
 * BPP authors fail loudly at build time rather than at submission.
 */
export function buildRegisterAgentInstruction(
  args: RegisterAgentArgs,
): Uint8Array {
  zRegisterAgentArgs.parse(args);
  const enc = new TextEncoder();
  const nameBytes = enc.encode(args.name);
  const modelBytes = enc.encode(args.modelId);
  const uriBytes = enc.encode(args.metadataUri);
  if (nameBytes.length > REGISTER_AGENT_NAME_MAX) {
    throw new Error(
      `RegisterAgent: name exceeds ${REGISTER_AGENT_NAME_MAX} bytes (got ${nameBytes.length})`,
    );
  }
  if (uriBytes.length > REGISTER_AGENT_METADATA_URI_MAX) {
    throw new Error(
      `RegisterAgent: metadata_uri exceeds ${REGISTER_AGENT_METADATA_URI_MAX} bytes (got ${uriBytes.length})`,
    );
  }
  const total = 1 + 4 + nameBytes.length + 4 + modelBytes.length + 4 + uriBytes.length;
  const out = new Uint8Array(total);
  let off = 0;
  out[off++] = REGISTER_AGENT_DISCRIMINATOR;
  off = writeBorshString(out, off, nameBytes);
  off = writeBorshString(out, off, modelBytes);
  off = writeBorshString(out, off, uriBytes);
  return out;
}

function writeBorshString(
  out: Uint8Array,
  off: number,
  bytes: Uint8Array,
): number {
  const len = bytes.length;
  out[off] = len & 0xff;
  out[off + 1] = (len >>> 8) & 0xff;
  out[off + 2] = (len >>> 16) & 0xff;
  out[off + 3] = (len >>> 24) & 0xff;
  out.set(bytes, off + 4);
  return off + 4 + len;
}

/* -------------------------------------------------------------------------- */
/* Chain adapter (subset for registration)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Subset of the runtime `ChainAdapter` that registration needs. Kept
 * separate so a registration-only flow (e.g. an operator CLI) does not
 * have to stub `completeTask` / `failTask`.
 */
export interface RegistrationChain {
  /** Resolve the AgentCard PDA for `authority`, or `null` if not yet registered. */
  findAgentCardPda(authority: Pubkey): Promise<string | null>;
  /** Submit a `RegisterAgent` tx and return the resulting PDA + signature. */
  registerAgent(args: {
    readonly authority: Pubkey;
    readonly instruction: Uint8Array;
  }): Promise<{ readonly pda: string; readonly txSignature: string }>;
}

export interface RegisterBppDeps {
  readonly chain: RegistrationChain;
  readonly pinner?: MetadataPinner;
}

export interface RegisterBppResult {
  readonly pda: string;
  readonly txSignature: string;
  readonly metadataUri: string;
  readonly idempotent: boolean;
}

/**
 * Idempotent BPP AgentCard registration. Looks up an existing PDA
 * before submitting; encodes the capability tags inline when small,
 * else delegates to the injected `MetadataPinner`.
 */
export async function registerBppAgentCard(
  config: BppConfig | (AgentConfig & { capabilityTags: CapabilityTags }),
  deps: RegisterBppDeps,
): Promise<RegisterBppResult> {
  const existing = await deps.chain.findAgentCardPda(config.authority);
  if (existing) {
    return {
      pda: existing,
      txSignature: "",
      metadataUri: "",
      idempotent: true,
    };
  }

  let metadataUri = encodeMetadataUri(config.capabilityTags);
  if (metadataUri === null) {
    if (!deps.pinner) {
      throw new Error(
        "registerBppAgentCard: capability tags exceed inline budget; supply a MetadataPinner",
      );
    }
    metadataUri = await deps.pinner.pin(config.capabilityTags);
  }

  const ix = buildRegisterAgentInstruction({
    name: config.name,
    modelId: config.modelId,
    metadataUri,
  });

  const { pda, txSignature } = await deps.chain.registerAgent({
    authority: config.authority,
    instruction: ix,
  });

  return { pda, txSignature, metadataUri, idempotent: false };
}

/* -------------------------------------------------------------------------- */
/* TODO(FN-074): cross-check `REGISTER_AGENT_*` constants against the Rust   */
/* `RegisterAgent` struct once it lands in `src/runtime/`.                    */
/* -------------------------------------------------------------------------- */
