import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@halochat/shared": path.resolve(__dirname, "./packages/shared/src/index.ts"),
      "@halochat/db": path.resolve(__dirname, "./packages/db/src/index.ts"),
    },
  },
});
