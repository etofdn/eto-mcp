// Unit tests for createKytEventSourceFromEnv (FN-083).
// These tests do NOT require a running Postgres instance.

import { describe, it, expect } from "vitest";
import {
  createKytEventSourceFromEnv,
  PostgresKytEventSource,
} from "../../src/services/indexer/postgres-event-source.js";
import { InMemoryKytEventSource } from "../../src/services/indexer/audit-trail.js";

describe("createKytEventSourceFromEnv", () => {
  it("returns InMemoryKytEventSource when env is empty object", () => {
    const src = createKytEventSourceFromEnv({});
    expect(src).toBeInstanceOf(InMemoryKytEventSource);
  });

  it("returns InMemoryKytEventSource when AUDIT_DB_URL is empty string", () => {
    const src = createKytEventSourceFromEnv({ AUDIT_DB_URL: "" });
    expect(src).toBeInstanceOf(InMemoryKytEventSource);
  });

  it("returns PostgresKytEventSource when AUDIT_DB_URL is set (no actual connection)", () => {
    const src = createKytEventSourceFromEnv({
      AUDIT_DB_URL: "postgres://localhost/x",
    });
    expect(src).toBeInstanceOf(PostgresKytEventSource);
    // Do NOT connect — only assert instanceof. Release the owned pool
    // without actually connecting to avoid leaving dangling handles.
    void (src as PostgresKytEventSource).close();
  });
});
