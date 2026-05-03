// Unit tests for createKytEventSourceFromEnv factory (FN-083).
// No database connection required — only asserts instance types.

import { describe, expect, it } from "vitest";

import { InMemoryKytEventSource } from "../../src/services/indexer/audit-trail.js";
import {
  PostgresKytEventSource,
  createKytEventSourceFromEnv,
} from "../../src/services/indexer/postgres-event-source.js";

describe("createKytEventSourceFromEnv", () => {
  it("returns InMemoryKytEventSource when env has no AUDIT_DB_URL", () => {
    const source = createKytEventSourceFromEnv({});
    expect(source).toBeInstanceOf(InMemoryKytEventSource);
  });

  it("returns InMemoryKytEventSource when AUDIT_DB_URL is empty string", () => {
    const source = createKytEventSourceFromEnv({ AUDIT_DB_URL: "" });
    expect(source).toBeInstanceOf(InMemoryKytEventSource);
  });

  it("returns PostgresKytEventSource when AUDIT_DB_URL is set (no connect)", () => {
    const source = createKytEventSourceFromEnv({
      AUDIT_DB_URL: "postgres://localhost/x",
    });
    expect(source).toBeInstanceOf(PostgresKytEventSource);
  });
});
