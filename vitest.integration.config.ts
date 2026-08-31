import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    exclude: ["node_modules", "extensions", "build", ".netlify"],
    globalSetup: ["tests/integration-global-setup.ts"],
    setupFiles: ["tests/integration-setup-env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
