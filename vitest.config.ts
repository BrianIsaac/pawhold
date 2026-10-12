import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["tests/setup/database.ts"],
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: ["tests/integration/**"],
        },
      },
      {
        // Against PayPal's sandbox (`pnpm test:integration`): skipped without
        // PAYPAL_CLIENT_ID; one file at a time, each step waiting on PayPal
        // and a headless buyer.
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
