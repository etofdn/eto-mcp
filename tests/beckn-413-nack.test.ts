/**
 * SB-16 conformance — 413 PayloadTooLarge response shape
 *
 * Closes FN-092 (eto-mcp FN-093 follow-up): the Beckn bridge must return
 * a Beckn NACK envelope when a request body exceeds the 1 MiB body-parser
 * limit, not Express's default HTML/JSON error.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { createBecknApp } from "../src/gateway/beckn.js";

let activeServer: http.Server | undefined;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = undefined;
  }
});

function startServer(): Promise<http.Server> {
  const app = createBecknApp();
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function rawPost(
  server: http.Server,
  path: string,
  bodyBytes: Buffer,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": bodyBytes.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // body may be empty or non-json on raw express errors
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(bodyBytes);
    req.end();
  });
}

describe("SB-16 — 413 PayloadTooLargeError returns Beckn NACK shape (FN-092)", () => {
  it("rejects a >1 MiB JSON body with 413 + NACK envelope", async () => {
    activeServer = await startServer();
    // 1 MiB + a kilobyte buffer is more than enough to trip express body-parser's
    // `limit: "1mb"`. We construct a syntactically-valid JSON object that is
    // larger than the threshold so the parser fails on size, not parse.
    const padding = "x".repeat(1024 * 1024 + 1024);
    const bodyBytes = Buffer.from(JSON.stringify({ payload: padding }));
    const { status, body } = await rawPost(activeServer, "/search", bodyBytes);
    expect(status).toBe(413);
    expect(body).toMatchObject({
      message: { ack: { status: "NACK" } },
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect((body as { error: { message: string } }).error.message).toContain("1 MiB");
  });

  it("does not affect normal-sized requests (regression check)", async () => {
    activeServer = await startServer();
    const small = Buffer.from(JSON.stringify({ context: {} }));
    const { status } = await rawPost(activeServer, "/search", small);
    // Should be 400 (invalid envelope) — NOT 413, NOT a 5xx, NOT swallowed.
    expect(status).toBe(400);
  });
});
