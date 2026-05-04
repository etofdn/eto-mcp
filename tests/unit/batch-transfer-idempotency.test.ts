import { describe, test, expect } from "vitest";
import { z } from "zod";

// Mirror the transfer entry schema from batch_transfer so we can test it in isolation.
const transferEntrySchema = z.object({
  to: z.string(),
  amount: z.string(),
  memo: z.string().optional(),
  idempotency_key: z.string().optional(),
});

// Mirror the key derivation logic from batch_transfer's iteration loop.
function deriveIdempotencyKey(opts: {
  i: number;
  fromSvm: string;
  toSvm: string;
  lamports: bigint;
  idempotency_key?: string;
  blockhash: string;
  memo?: string;
}): string {
  const { i, fromSvm, toSvm, lamports, idempotency_key, blockhash, memo } = opts;
  const memoSuffix = memo ? `-m:${memo}` : "";
  const effectiveKey = idempotency_key ?? `batch-${i}-${fromSvm}-${toSvm}-${lamports}`;
  return `${effectiveKey}-${blockhash}${memoSuffix}`;
}

describe("batch_transfer transfer entry schema", () => {
  test("accepts entry without idempotency_key", () => {
    const result = transferEntrySchema.safeParse({ to: "addr", amount: "1.0" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.idempotency_key).toBeUndefined();
  });

  test("accepts entry with idempotency_key", () => {
    const result = transferEntrySchema.safeParse({ to: "addr", amount: "1.0", idempotency_key: "my-key" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.idempotency_key).toBe("my-key");
  });
});

describe("batch_transfer idempotency key derivation", () => {
  const FROM = "FromAddr";
  const TO = "ToAddr";
  const LAMPORTS = BigInt(1_000_000_000);
  const BLOCKHASH = "blockhash123";

  test("provided key wins over default", () => {
    const key = deriveIdempotencyKey({
      i: 0,
      fromSvm: FROM,
      toSvm: TO,
      lamports: LAMPORTS,
      idempotency_key: "caller-supplied-key",
      blockhash: BLOCKHASH,
    });
    expect(key).toBe(`caller-supplied-key-${BLOCKHASH}`);
    expect(key).not.toContain(`batch-0-${FROM}-${TO}-${LAMPORTS}`);
  });

  test("default key encodes index, from, to, and lamports", () => {
    const key = deriveIdempotencyKey({
      i: 3,
      fromSvm: FROM,
      toSvm: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
    });
    expect(key).toContain(`batch-3-${FROM}-${TO}-${LAMPORTS}`);
    expect(key).toContain(BLOCKHASH);
  });

  test("default keys differ across iterations (index changes)", () => {
    const key0 = deriveIdempotencyKey({ i: 0, fromSvm: FROM, toSvm: TO, lamports: LAMPORTS, blockhash: BLOCKHASH });
    const key1 = deriveIdempotencyKey({ i: 1, fromSvm: FROM, toSvm: TO, lamports: LAMPORTS, blockhash: BLOCKHASH });
    expect(key0).not.toBe(key1);
  });

  test("memo suffix appended after effective key", () => {
    const key = deriveIdempotencyKey({
      i: 0,
      fromSvm: FROM,
      toSvm: TO,
      lamports: LAMPORTS,
      blockhash: BLOCKHASH,
      memo: "hello",
    });
    expect(key).toMatch(/-m:hello$/);
  });

  test("provided key with memo still appends memo suffix", () => {
    const key = deriveIdempotencyKey({
      i: 0,
      fromSvm: FROM,
      toSvm: TO,
      lamports: LAMPORTS,
      idempotency_key: "my-custom",
      blockhash: BLOCKHASH,
      memo: "note",
    });
    expect(key).toBe(`my-custom-${BLOCKHASH}-m:note`);
  });
});
