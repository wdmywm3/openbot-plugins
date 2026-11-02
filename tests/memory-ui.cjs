"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
module.exports = async ({ fromHost, runtime, channel, plugin, action, scope, root }) => {
  const { chromium, expect } = fromHost("playwright/test"), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1060, height: 760 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const calls = [];
    await page.exposeFunction("nativeAction", async (id, input) => { const result = await runtime.runPluginAction(channel, plugin, action(id), input); calls.push({ id, input, settings: result.settings }); return result; });
    await page.addInitScript(() => { window.openbotPlugin = { callAction: (id, input) => window.nativeAction(id, input), selectFiles: async () => ({ files: [] }) }; });
    await page.route("http://memory.test/**", async route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (!["", "index.html", "app.js", "style.css"].includes(name)) return route.abort();
      await route.fulfill({ path: path.join(plugin.basePath, "ui", name || "index.html") });
    });
    await page.goto("http://memory.test/");
    await page.addStyleTag({ content: ":root{--bg-primary:#101318;--bg-secondary:#191e26;--bg-hover:#232b36;--text-primary:#eee;--text-secondary:#aab4c2;--border-color:#3a4350;--accent-primary:#6f9aff;--color-error:#ff7272;--overlay-bg:#0009}" });
    await expect(page.locator("#chat option")).not.toHaveCount(1);
    await page.locator("#chat").selectOption(scope.chatId);
    await expect(page.locator("#items .item")).not.toHaveCount(0);
    await page.locator("#items .item").first().locator("button").first().click();
    await expect(page.locator("#details-body")).toContainText("迁移后仍能读到的运行日志");
    await page.locator('[data-close="details"]').click();
    await page.locator("#settings").click();
    await page.locator("#inherit").uncheck(); await page.locator("#schedule").selectOption("daily"); await page.locator("#daily-time").fill("04:30");
    await page.locator('#settings-form button[type="submit"],#settings-form button.primary').click();
    await expect(page.locator("#preferences")).not.toBeVisible(); await page.locator("#settings").click();
    try { await expect(page.locator("#daily-time")).toHaveValue("04:30"); } catch (error) { console.error(JSON.stringify(calls.slice(-10))); throw error; } await page.locator('[data-close="preferences"]').click();
    await expect(page.locator("#error")).not.toBeVisible(); assert.deepEqual(errors, []);
    if (process.env.OPENBOT_MEMORY_UI_SCREENSHOT) await page.screenshot({ path: path.resolve(process.env.OPENBOT_MEMORY_UI_SCREENSHOT), fullPage: true });
    console.log("Memory Plus UI: browser reads actual migrated journals and changes strategy settings through public desktop actions passed");
  } finally { await browser.close(); }
};
