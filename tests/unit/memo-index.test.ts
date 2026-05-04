import { describe, test, expect, beforeEach } from "vitest";
import { InMemoryMemoIndex } from "../../src/services/indexer/memo-index.js";
import type { MemoEntry } from "../../src/services/indexer/memo-index.js";

// FN-093: InMemoryMemoIndex unit tests.
// Covers: ingest, ingestBatch, filter by signer, schema, programId,
// since/until time bounds, limit, and cursor-based pagination.

function makeEntry(overrides: Partial<MemoEntry> & { signature: string }): MemoEntry {
  return {
    slot: 1000,
    block_time: 1_700_000_000,
    signer: "signer1",
    accounts: [],
    program_ids: ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"],
    memo_text: "hello",
    ...overrides,
  };
}

describe("InMemoryMemoIndex (FN-093)", () => {
  let idx: InMemoryMemoIndex;

  beforeEach(() => {
    idx = new InMemoryMemoIndex();
  });

  test("ingest and query all returns entry", async () => {
    await idx.ingest(makeEntry({ signature: "sig1" }));
    const { entries } = await idx.query({});
    expect(entries).toHaveLength(1);
    expect(entries[0].signature).toBe("sig1");
  });

  test("ingestBatch stores all entries", async () => {
    await idx.ingestBatch([
      makeEntry({ signature: "sigA", block_time: 1_700_000_003 }),
      makeEntry({ signature: "sigB", block_time: 1_700_000_002 }),
      makeEntry({ signature: "sigC", block_time: 1_700_000_001 }),
    ]);
    const { entries } = await idx.query({});
    expect(entries).toHaveLength(3);
    // Should be sorted by block_time desc
    expect(entries[0].signature).toBe("sigA");
    expect(entries[1].signature).toBe("sigB");
    expect(entries[2].signature).toBe("sigC");
  });

  test("ingest is idempotent on signature", async () => {
    await idx.ingest(makeEntry({ signature: "sig1", memo_text: "first" }));
    await idx.ingest(makeEntry({ signature: "sig1", memo_text: "second" }));
    const { entries } = await idx.query({});
    expect(entries).toHaveLength(1);
    expect(entries[0].memo_text).toBe("second");
  });

  test("filter by signer", async () => {
    await idx.ingestBatch([
      makeEntry({ signature: "s1", signer: "alice" }),
      makeEntry({ signature: "s2", signer: "bob" }),
      makeEntry({ signature: "s3", signer: "alice" }),
    ]);
    const { entries } = await idx.query({ signers: ["alice"] });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.signer === "alice")).toBe(true);
  });

  test("filter by schema_name", async () => {
    await idx.ingestBatch([
      makeEntry({ signature: "s1", schema_name: "eto.vc.1" }),
      makeEntry({ signature: "s2", schema_name: "eto.vc.2" }),
      makeEntry({ signature: "s3" }), // no schema
    ]);
    const { entries } = await idx.query({ schemas: ["eto.vc.1"] });
    expect(entries).toHaveLength(1);
    expect(entries[0].schema_name).toBe("eto.vc.1");
  });

  test("filter by programIds (OR match)", async () => {
    const memoProgram = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
    const otherProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    await idx.ingestBatch([
      makeEntry({ signature: "s1", program_ids: [memoProgram] }),
      makeEntry({ signature: "s2", program_ids: [otherProgram] }),
      makeEntry({ signature: "s3", program_ids: ["SystemProgram111111111111111111111111111111"] }),
    ]);
    const { entries } = await idx.query({ programIds: [memoProgram, otherProgram] });
    expect(entries).toHaveLength(2);
    const sigs = entries.map((e) => e.signature);
    expect(sigs).toContain("s1");
    expect(sigs).toContain("s2");
  });

  test("filter by since/until (inclusive)", async () => {
    await idx.ingestBatch([
      makeEntry({ signature: "s1", block_time: 1000 }),
      makeEntry({ signature: "s2", block_time: 2000 }),
      makeEntry({ signature: "s3", block_time: 3000 }),
    ]);
    const { entries } = await idx.query({ since: 1000, until: 2000 });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.block_time).sort()).toEqual([1000, 2000]);
  });

  test("limit caps result count", async () => {
    await idx.ingestBatch(
      Array.from({ length: 10 }, (_, i) =>
        makeEntry({ signature: `sig${i}`, block_time: i }),
      ),
    );
    const { entries } = await idx.query({ limit: 3 });
    expect(entries).toHaveLength(3);
  });

  test("cursor-based pagination returns subsequent page", async () => {
    await idx.ingestBatch([
      makeEntry({ signature: "sA", block_time: 5 }),
      makeEntry({ signature: "sB", block_time: 4 }),
      makeEntry({ signature: "sC", block_time: 3 }),
      makeEntry({ signature: "sD", block_time: 2 }),
    ]);
    const page1 = await idx.query({ limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.entries[0].signature).toBe("sA");
    expect(page1.entries[1].signature).toBe("sB");
    expect(page1.nextCursor).toBe("sB");

    const page2 = await idx.query({ limit: 2, cursor: page1.nextCursor });
    expect(page2.entries).toHaveLength(2);
    expect(page2.entries[0].signature).toBe("sC");
    expect(page2.entries[1].signature).toBe("sD");
    expect(page2.nextCursor).toBeUndefined();
  });

  test("empty result when no entries match filter", async () => {
    await idx.ingest(makeEntry({ signature: "s1", signer: "alice" }));
    const { entries } = await idx.query({ signers: ["charlie"] });
    expect(entries).toHaveLength(0);
  });

  test("query with no entries returns empty", async () => {
    const { entries, nextCursor } = await idx.query({});
    expect(entries).toHaveLength(0);
    expect(nextCursor).toBeUndefined();
  });
});
