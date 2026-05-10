import { describe, it, expect } from "vitest";
import {
  buildInterimAgentIdentity,
  type AgentIdentity,
  type InterimAgentIdentityInput,
} from "../../src/models/agent-identity.js";

function baseInput(overrides: Partial<InterimAgentIdentityInput> = {}): InterimAgentIdentityInput {
  return {
    scope: "0xAlice",
    active_wallet_id: "w-1",
    wallets: [
      { id: "w-1", label: "primary", svm: "SoMeBaSe58Pubkey", evm: "0xabc" },
    ],
    auth_strategy: "siwe",
    token_expires_at: "2030-01-01T00:00:00.000Z",
    last_restart_iso: "2026-05-01T00:00:00.000Z",
    capabilities: ["wallet:read", "transfer:write"],
    ...overrides,
  };
}

function verifiedInput(
  overrides: Partial<InterimAgentIdentityInput> = {},
): InterimAgentIdentityInput {
  return baseInput({
    verified_session_jws:
      "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIweEFsaWNlIn0.sig",
    verified_session_jws_claims: {
      provider: "anthropic",
      model_id: "claude-sonnet-4-5",
      kid: "kid-test-1",
      issued_at: 1_730_000_000,
    },
    ...overrides,
  });
}

describe("buildInterimAgentIdentity", () => {
  it("builds a thirdweb-kind identity with self_declared attestation when declared_model is supplied", () => {
    const id = buildInterimAgentIdentity(
      baseInput({
        declared_model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
      }),
    );

    expect(id.human_authority.kind).toBe("thirdweb");
    expect(id.human_authority.sub).toBe("0xAlice");
    expect(id.human_authority.auth_strategy).toBe("siwe");

    expect(id.model_attestation.attestation_status).toBe("self_declared");
    if (id.model_attestation.attestation_status === "self_declared") {
      expect(id.model_attestation.provider).toBe("anthropic");
      expect(id.model_attestation.model_id).toBe("claude-sonnet-4-5");
    }

    expect(id.environment.surface).toBe("sse");
    expect(id.environment.wallet_anchor).toEqual({
      id: "w-1",
      svm: "SoMeBaSe58Pubkey",
      evm: "0xabc",
      label: "primary",
    });

    expect(id.session_scope.scope).toBe("0xAlice");
    expect(id.session_scope.expires_at_iso).toBe("2030-01-01T00:00:00.000Z");
    expect(id.session_scope.capabilities).toEqual(["wallet:read", "transfer:write"]);
  });

  it("emits attestation_status: absent when declared_model is omitted", () => {
    const id = buildInterimAgentIdentity(baseInput());
    expect(id.model_attestation.attestation_status).toBe("absent");
  });

  it("falls back to kind=stdio with surface=stdio under __stdio__ scope and no auth_strategy", () => {
    const id = buildInterimAgentIdentity(
      baseInput({ scope: "__stdio__", auth_strategy: null }),
    );
    expect(id.human_authority.kind).toBe("stdio");
    expect(id.human_authority.auth_strategy).toBeUndefined();
    expect(id.environment.surface).toBe("stdio");
  });

  it("falls back to kind=dev with surface=dev under __dev__ scope and no auth_strategy", () => {
    const id = buildInterimAgentIdentity(
      baseInput({ scope: "__dev__", auth_strategy: null }),
    );
    expect(id.human_authority.kind).toBe("dev");
    expect(id.environment.surface).toBe("dev");
  });

  it("defaults capabilities to [] when omitted (no throw)", () => {
    const input = baseInput();
    delete (input as Partial<InterimAgentIdentityInput>).capabilities;
    const id = buildInterimAgentIdentity(input);
    expect(id.session_scope.capabilities).toEqual([]);
  });

  it("falls back to first wallet when active_wallet_id is null", () => {
    const id = buildInterimAgentIdentity(baseInput({ active_wallet_id: null }));
    expect(id.environment.wallet_anchor.id).toBe("w-1");
  });

  it("emits an empty wallet_anchor when wallets is empty", () => {
    const id = buildInterimAgentIdentity(
      baseInput({ wallets: [], active_wallet_id: null }),
    );
    expect(id.environment.wallet_anchor).toEqual({
      id: "",
      svm: null,
      evm: null,
      label: null,
    });
  });

  it("rejects an input with no scope, referencing session_scope in the error", () => {
    const bad = baseInput({ scope: "" });
    expect(() => buildInterimAgentIdentity(bad)).toThrow(/session_scope/);
  });

  it("type-level: a fully-populated literal satisfies AgentIdentity", () => {
    const literal = {
      human_authority: {
        sub: "0xAlice",
        kind: "thirdweb",
        auth_strategy: "siwe",
      },
      model_attestation: {
        attestation_status: "verified" as const,
        source: "session_signed" as const,
        provider_verified: false as const,
        provider: "anthropic",
        model_id: "claude-sonnet-4-5",
        kid: "kid-1",
        issued_at: 1_730_000_000,
        jws: "eyJhbGciOiJFZERTQSJ9.e30.sig",
      },
      environment: {
        surface: "sse",
        server_instance: "2026-05-01T00:00:00.000Z",
        wallet_anchor: { id: "w-1", svm: null, evm: null, label: null },
      },
      session_scope: {
        scope: "0xAlice",
        jti: "jti-1",
        expires_at_iso: "2030-01-01T00:00:00.000Z",
        capabilities: ["wallet:read"],
      },
    } satisfies AgentIdentity;

    expect(literal.human_authority.kind).toBe("thirdweb");
  });

  it("emits source=session_signed verified attestation when verified_session_jws + claims are supplied", () => {
    const id = buildInterimAgentIdentity(verifiedInput());

    expect(id.model_attestation.attestation_status).toBe("verified");
    if (id.model_attestation.attestation_status === "verified") {
      // Sub-discriminator narrows to a literal union here.
      expect(id.model_attestation.source).toBe("session_signed");
      if (id.model_attestation.source === "session_signed") {
        expect(id.model_attestation.provider_verified).toBe(false);
        expect(id.model_attestation.provider).toBe("anthropic");
        expect(id.model_attestation.model_id).toBe("claude-sonnet-4-5");
        expect(id.model_attestation.kid).toBe("kid-test-1");
        expect(id.model_attestation.issued_at).toBe(1_730_000_000);
        expect(id.model_attestation.jws).toBe(
          "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIweEFsaWNlIn0.sig",
        );
      }
    }
  });

  it("verified arm overrides declared_model (precedence rule)", () => {
    const id = buildInterimAgentIdentity(
      verifiedInput({
        declared_model: { provider: "openai", model_id: "gpt-4o" },
      }),
    );

    expect(id.model_attestation.attestation_status).toBe("verified");
    if (id.model_attestation.attestation_status === "verified") {
      // Verified-arm provider wins over declared_model.
      expect(id.model_attestation.provider).toBe("anthropic");
      expect(id.model_attestation.model_id).toBe("claude-sonnet-4-5");
    }
  });

  it("suppresses verified arm under __stdio__ scope", () => {
    const id = buildInterimAgentIdentity(
      verifiedInput({ scope: "__stdio__", auth_strategy: null }),
    );
    expect(id.model_attestation.attestation_status).toBe("absent");
  });

  it("suppresses verified arm under __dev__ scope", () => {
    const id = buildInterimAgentIdentity(
      verifiedInput({ scope: "__dev__", auth_strategy: null }),
    );
    expect(id.model_attestation.attestation_status).toBe("absent");
  });

  it("suppresses verified arm under auth_strategy: 'dev'", () => {
    const id = buildInterimAgentIdentity(verifiedInput({ auth_strategy: "dev" }));
    expect(id.model_attestation.attestation_status).toBe("absent");
  });

  it("falls through to absent when verified_session_jws is supplied without claims", () => {
    const id = buildInterimAgentIdentity(
      baseInput({ verified_session_jws: "abc.def.ghi" }),
    );
    expect(id.model_attestation.attestation_status).toBe("absent");
  });

  it("falls through to absent when verified_session_jws_claims is supplied without jws", () => {
    const id = buildInterimAgentIdentity(
      baseInput({
        verified_session_jws_claims: {
          provider: "p",
          model_id: "m",
          kid: "k",
          issued_at: 1,
        },
      }),
    );
    expect(id.model_attestation.attestation_status).toBe("absent");
  });

  it("type-level: a provider_oidc verified literal satisfies AgentIdentity", () => {
    const literal = {
      human_authority: {
        sub: "0xAlice",
        kind: "thirdweb",
        auth_strategy: "siwe",
      },
      model_attestation: {
        attestation_status: "verified" as const,
        source: "provider_oidc" as const,
        provider_verified: true as const,
        provider: "anthropic",
        model_id: "claude-sonnet-4-5",
        kid: "kid-oidc-1",
        issued_at: 1_730_000_000,
        jws: "eyJhbGciOiJFZERTQSJ9.e30.providerSig",
      },
      environment: {
        surface: "sse",
        server_instance: "2026-05-01T00:00:00.000Z",
        wallet_anchor: { id: "w-1", svm: null, evm: null, label: null },
      },
      session_scope: {
        scope: "0xAlice",
        jti: "jti-1",
        expires_at_iso: "2030-01-01T00:00:00.000Z",
        capabilities: ["wallet:read"],
      },
    } satisfies AgentIdentity;

    expect(literal.model_attestation.source).toBe("provider_oidc");
    expect(literal.model_attestation.provider_verified).toBe(true);
  });
});
