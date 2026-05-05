import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "tests/**/*.test.ts", "src/gateway/**/*.test.ts", "keeper/bpps/__tests__/**/*.test.ts", "keeper/bpps/bank/handlers/**/*.test.ts", "keeper/bpps/bank/*.test.ts"],
    // Exclude bun:test-only suites that vitest cannot transform.
    // These suites import from "bun:test" and are pre-existing.
    exclude: [
      "tests/unit/auth.test.ts",
      "tests/unit/error-recovery.test.ts",
      "tests/unit/signer.test.ts",
      "tests/unit/validation.test.ts",
      "tests/unit/wasm.test.ts",
      "node_modules/**",
    ],
    environment: "node",
    testTimeout: 10_000,
  },
});
