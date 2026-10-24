import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: [
    {
      command: "pnpm --filter @halochat/help dev",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: true,
    },
    {
      command: "pnpm --filter @halochat/mobile exec expo start --web --port 8081 --clear",
      url: "http://127.0.0.1:8081",
      reuseExistingServer: false,
    },
    {
      command: "NODE_ENV=test REQUIRE_EMAIL_VERIFICATION=false pnpm --filter @halochat/server dev",
      url: "http://127.0.0.1:3000/health",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
