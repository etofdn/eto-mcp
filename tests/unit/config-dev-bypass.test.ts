/**
 * Unit tests for `config.auth.devBypass` consolidation (FN-081).
 *
 * Acceptance criteria:
 * (a) devBypass=false when ETO_AUTH_DEV_BYPASS is unset
 * (b) devBypass=true only when ETO_AUTH_DEV_BYPASS=true explicitly
 * (c) production NODE_ENV alone cannot enable devBypass
 *
 * These tests exercise the real `loadRuntimeConfig` loader (not just the
 * literal expression) so a regression that re-introduces a NODE_ENV-based
 * default would be caught here.
 */

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../../src/config.js";

function envOnly(overrides: Record<string, string>): NodeJS.ProcessEnv {
  // Build a hermetic env — we deliberately do not inherit process.env so the
  // test isn't sensitive to whatever the host shell has set.
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("config.auth.devBypass — FN-081 single-source-of-truth", () => {
  it("(a) devBypass is false when ETO_AUTH_DEV_BYPASS is unset (development)", () => {
    const cfg = loadRuntimeConfig(envOnly({ NODE_ENV: "development" }));
    expect(cfg.auth.devBypass).toBe(false);
  });

  it("(b) devBypass is true when ETO_AUTH_DEV_BYPASS=true is set explicitly", () => {
    const cfg = loadRuntimeConfig(envOnly({ ETO_AUTH_DEV_BYPASS: "true" }));
    expect(cfg.auth.devBypass).toBe(true);
  });

  it('(b2) only the literal string "true" enables devBypass — "1" does not', () => {
    const cfg = loadRuntimeConfig(envOnly({ ETO_AUTH_DEV_BYPASS: "1" }));
    expect(cfg.auth.devBypass).toBe(false);
  });

  it('(b3) "TRUE" (uppercase) does not enable devBypass — case-sensitive', () => {
    const cfg = loadRuntimeConfig(envOnly({ ETO_AUTH_DEV_BYPASS: "TRUE" }));
    expect(cfg.auth.devBypass).toBe(false);
  });

  it("(c) production NODE_ENV alone does NOT enable devBypass", () => {
    const cfg = loadRuntimeConfig(envOnly({ NODE_ENV: "production" }));
    expect(cfg.auth.devBypass).toBe(false);
  });

  it("(c2) test NODE_ENV alone does NOT enable devBypass", () => {
    const cfg = loadRuntimeConfig(envOnly({ NODE_ENV: "test" }));
    expect(cfg.auth.devBypass).toBe(false);
  });

  it("(c3) development NODE_ENV alone does NOT enable devBypass", () => {
    const cfg = loadRuntimeConfig(envOnly({ NODE_ENV: "development" }));
    expect(cfg.auth.devBypass).toBe(false);
  });

  it("(d) the legacy AUTH_DEV_BYPASS env var name no longer enables devBypass", () => {
    const cfg = loadRuntimeConfig(envOnly({ AUTH_DEV_BYPASS: "true" }));
    expect(cfg.auth.devBypass).toBe(false);
  });

  it("(e) the legacy ETO_DEV_BYPASS env var name no longer enables devBypass", () => {
    const cfg = loadRuntimeConfig(envOnly({ ETO_DEV_BYPASS: "1" }));
    expect(cfg.auth.devBypass).toBe(false);
  });
});
