import { describe, it, expect } from "vitest";
import {
  MEMO_PROGRAM_ID_BS58,
  extractMemosFromLogs,
  parseMemoPayload,
  matchesFilter,
} from "../../src/utils/memo-parse.js";

describe("extractMemosFromLogs", () => {
  it("returns [] for undefined / empty / no-memo log arrays", () => {
    expect(extractMemosFromLogs(undefined)).toEqual([]);
    expect(extractMemosFromLogs([])).toEqual([]);
    expect(
      extractMemosFromLogs([
        "Program 11111111111111111111111111111111 invoke [1]",
        "Program 11111111111111111111111111111111 success",
      ])
    ).toEqual([]);
  });

  it("extracts a JSON-escaped Memo (len N) payload", () => {
    const logs = [
      `Program ${MEMO_PROGRAM_ID_BS58} invoke [1]`,
      `Program log: Memo (len 13): "{\\"k\\":\\"v\\"}"`,
      `Program ${MEMO_PROGRAM_ID_BS58} consumed 100 of 200000 compute units`,
      `Program ${MEMO_PROGRAM_ID_BS58} success`,
    ];
    expect(extractMemosFromLogs(logs)).toEqual([`{"k":"v"}`]);
  });

  it("falls back to the next Program log: line after a memo invoke", () => {
    const logs = [
      `Program ${MEMO_PROGRAM_ID_BS58} invoke [1]`,
      `Program log: hello world`,
      `Program ${MEMO_PROGRAM_ID_BS58} success`,
    ];
    expect(extractMemosFromLogs(logs)).toEqual(["hello world"]);
  });

  it("returns multiple memos in order", () => {
    const logs = [
      `Program ${MEMO_PROGRAM_ID_BS58} invoke [1]`,
      `Program log: Memo (len 5): "first"`,
      `Program ${MEMO_PROGRAM_ID_BS58} success`,
      `Program 11111111111111111111111111111111 invoke [1]`,
      `Program 11111111111111111111111111111111 success`,
      `Program ${MEMO_PROGRAM_ID_BS58} invoke [1]`,
      `Program log: second-raw`,
      `Program ${MEMO_PROGRAM_ID_BS58} success`,
    ];
    expect(extractMemosFromLogs(logs)).toEqual(["first", "second-raw"]);
  });
});

describe("parseMemoPayload", () => {
  it("parses valid JSON objects", () => {
    expect(parseMemoPayload('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns the raw string on parse failure", () => {
    expect(parseMemoPayload("not json")).toBe("not json");
  });

  it("returns empty string for empty input", () => {
    expect(parseMemoPayload("")).toBe("");
  });
});

describe("matchesFilter", () => {
  it("returns true when both args are undefined", () => {
    expect(matchesFilter({ anything: 1 })).toBe(true);
    expect(matchesFilter("raw")).toBe(true);
  });

  it("matches a top-level JSON field equality", () => {
    expect(matchesFilter({ type: "transfer" }, "type", "transfer")).toBe(true);
  });

  it("rejects a value mismatch", () => {
    expect(matchesFilter({ type: "transfer" }, "type", "swap")).toBe(false);
  });

  it("returns false when parsed is a non-object string", () => {
    expect(matchesFilter("hello", "type", "hello")).toBe(false);
  });

  it("returns false when the field is missing", () => {
    expect(matchesFilter({ other: 1 }, "type", "transfer")).toBe(false);
  });

  it("returns false when only one of field/value is provided", () => {
    expect(matchesFilter({ type: "transfer" }, "type", undefined)).toBe(false);
    expect(matchesFilter({ type: "transfer" }, undefined, "transfer")).toBe(false);
  });

  it("coerces non-string values via String()", () => {
    expect(matchesFilter({ n: 42 }, "n", "42")).toBe(true);
  });

  it("rejects arrays", () => {
    expect(matchesFilter([{ type: "transfer" }], "type", "transfer")).toBe(false);
  });
});
