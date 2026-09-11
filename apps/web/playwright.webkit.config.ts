import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

// Optional Safari-engine check; the existing CI Chromium verification stays unchanged.
export default defineConfig({
  ...baseConfig,
  projects: [{ name: "webkit-ipad", use: { ...devices["iPad Pro 11 landscape"], browserName: "webkit" } }],
});
