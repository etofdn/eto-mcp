import { describe, test, expect } from "vitest";
import { buildTransferIdempotencyKey } from "../../src/tools/transfer.js";

const FROM = "FromAddr11111111111111111111111111111111111";
const TO = "ToAddr2222222222222222222222222222222222222";
const LAMPORTS = 1_000_000n;
const BLOCKHASH = "Blockhash3333333333333333333333333333333333";

describe("buildTransferIdempotencyKey", () => {
  test("base key with no memo and no idempotency_key has no trailing suffixes", () => {
    const key = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
    });
    expect(key).toBe(`transfer-${FROM}-${TO}-${LAMPORTS}-${BLOCKHASH}`);
    expect(key).not.toContain("-m:");
    expect(key).not.toContain("-i:");
  });

  test("memo only: ends with -m:<memo> and no -i: segment", () => {
    const key = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
      memo: "my-memo",
    });
    expect(key.endsWith("-m:my-memo")).toBe(true);
    expect(key).not.toContain("-i:");
  });

  test("idempotency_key only: ends with -i:<key> and no -m: segment", () => {
    const key = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
      idempotencyKey: "caller-supplied",
    });
    expect(key.endsWith("-i:caller-supplied")).toBe(true);
    expect(key).not.toContain("-m:");
  });

  test("memo + idempotency_key: ends with -m:foo-i:bar in that order", () => {
    const key = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
      memo: "foo",
      idempotencyKey: "bar",
    });
    expect(key.endsWith("-m:foo-i:bar")).toBe(true);
  });

  test("distinct idempotency_keys produce distinct keys", () => {
    const a = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
      memo: "same-memo",
      idempotencyKey: "alpha",
    });
    const b = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
      memo: "same-memo",
      idempotencyKey: "beta",
    });
    expect(a).not.toBe(b);
  });

  test("distinct memos produce distinct keys", () => {
    const a = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
      memo: "memo-one",
    });
    const b = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
      memo: "memo-two",
    });
    expect(a).not.toBe(b);
  });

  test("empty-string memo behaves like undefined memo", () => {
    const noMemo = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
    });
    const emptyMemo = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
      memo: "",
    });
    expect(emptyMemo).toBe(noMemo);
    expect(emptyMemo).not.toContain("-m:");
  });

  test("bigint lamports interpolate as plain decimal string (no n suffix, no scientific notation)", () => {
    const key = buildTransferIdempotencyKey({
      from: FROM,
      to: TO,
      lamports: 1_500_000_000n,
      blockhash: BLOCKHASH,
    });
    expect(key).toContain("-1500000000-");
    expect(key).not.toContain("1500000000n");
    expect(key).not.toContain("e+");
    expect(key).not.toContain("1.5e");
  });

  test("stable contract: known inputs produce the exact literal key", () => {
    const key = buildTransferIdempotencyKey({
      from: "A",
      to: "B",
      lamports: 1n,
      blockhash: "BH",
    });
    expect(key).toBe("transfer-A-B-1-BH");
  });
});
