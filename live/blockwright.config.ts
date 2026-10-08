import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 600_000,
  workers: 2,
  retries: 0,
});
