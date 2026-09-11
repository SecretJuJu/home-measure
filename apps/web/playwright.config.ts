import { defineConfig, devices } from "@playwright/test";

const port = 4173;
const baseURL = `http://127.0.0.1:${port}`;

/**
 * Playwright owns this loopback-only Vite process and terminates it after the
 * suite. Keeping the API unavailable is intentional: this smoke test proves
 * the local-first flow does not require a deployed Worker.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    timeout: 30_000,
    reuseExistingServer: false,
  },
  projects: [{
    name: "chromium",
    use: { ...devices["Desktop Chrome"] },
  }],
});
