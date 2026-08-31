import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [
      "node_modules",
      "extensions",
      "build",
      ".netlify",
      "tests/**/*.integration.test.ts",
    ],
  },
});
