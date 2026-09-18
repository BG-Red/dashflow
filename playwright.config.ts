import { defineConfig, devices } from "@playwright/test";

/**
 * The end-to-end suite runs against the demo build: the real UI, the mock API, no database.
 * That keeps CI fast and makes the tests meaningful on a fork with no secrets.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    colorScheme: "dark",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command:
      "bun run build:demo && bunx vite preview --host 127.0.0.1 --port 4173 --strictPort --outDir dist-demo",
    cwd: "apps/web",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
