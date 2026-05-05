/**
 * Shared minimal-valid payload builders for the FN-043 memo coverage suite.
 *
 * These mirror the required fields of the schemas in
 * `spec/memo-schemas/*.v1.json`. Keep tiny — only consolidate when reused
 * across ≥2 spec files (round-trip + query_memos integration in this case).
 */

export function minimalEvalScorePayload() {
  return {
    subject: "did:eto:agent:abc",
    metric: "helpfulness",
    score: 0.5,
    evaluator: "did:eto:judge:llm-1",
  };
}

export function minimalPaymentPayload() {
  return {
    purpose: "service" as const,
    invoice_id: "inv-001",
  };
}

export function minimalCoordinationLogPayload() {
  return {
    event: "task_offered" as const,
    task_id: "t-1",
    actor: "did:eto:agent:a",
  };
}

/** Every optional eval_score field populated at once — still valid. */
export function fullEvalScorePayload() {
  return {
    subject: "did:eto:agent:full",
    metric: "helpfulness",
    score: 0.87,
    evaluator: "did:eto:judge:full",
    notes: "All optionals populated for boundary coverage.",
    evidence_uri: "ipfs://bafy00000000000000000000000000000000000000000000",
  };
}
