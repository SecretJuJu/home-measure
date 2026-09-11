import { test as base, webkit, devices, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const test = base.extend<{ photoPage: Page }>({
  photoPage: async ({ page, browserName, baseURL }, use) => {
    if (browserName !== "webkit") { await use(page); return; }
    // macOS WebKit's ephemeral contexts reject native IndexedDB Blob writes.
    // A temporary persistent profile exercises the real photo cache without mocking it.
    const profile = await mkdtemp(join(tmpdir(), "home-measure-photo-"));
    const context = await webkit.launchPersistentContext(profile, {
      ...devices["iPad Pro 11 landscape"],
      ...(baseURL ? { baseURL } : {}),
      headless: true,
    });
    try { await use(context.pages()[0] ?? await context.newPage()); }
    finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  },
});
