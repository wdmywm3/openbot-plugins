"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");

module.exports = async function checkUi({ hostRequire, runtime, channel, plugin, action, media, actor, root }) {
  const { chromium, expect } = hostRequire("playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("nativeAction", (id, input) => runtime.runPluginAction(channel, plugin, action(id), input));
    await page.addInitScript(() => {
      window.openbotPlugin = { callAction: (id, input) => window.nativeAction(id, input), assetUrl: ref => "/media/" + ref,
        selectFiles: async () => ({ files: [] }), saveFiles: async () => ({ canceled: true, saved: [] }) };
    });
    await page.route("http://meme.test/**", async route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name.startsWith("media/")) {
        const asset = media.read(actor, name.slice(6)); await route.fulfill({ contentType: asset.mimeType, body: asset.data }); return;
      }
      if (!["", "index.html", "app.js", "style.css"].includes(name)) { await route.abort(); return; }
      await route.fulfill({ path: path.join(plugin.basePath, "ui", name || "index.html") });
    });
    await page.goto("http://meme.test/");
    await page.addStyleTag({ content: ":root{--bg-primary:#101318;--bg-secondary:#191e26;--bg-hover:#232b36;--text-primary:#eee;--text-secondary:#aab4c2;--border-color:#3a4350;--accent-primary:#6f9aff;--color-error:#ff7272;--overlay-bg:#0009}" });
    await expect(page.locator(".tile")).toHaveCount(1);
    await expect(page.locator("#paging")).not.toBeVisible();
    await page.locator(".tile").click();
    await expect(page.locator("#editor")).toBeVisible();
    await page.locator("#caption").fill("可编辑的蓝色方块");
    await page.locator("#tags").fill("冷静，蓝色");
    await page.locator("#edit-form").getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("#editor")).not.toBeVisible();
    await expect(page.locator(".tile")).toContainText("可编辑的蓝色方块");
    await page.locator(".tile").click(); await page.locator("#recognition-history").click();
    await expect(page.locator("#history-items summary")).toHaveCount(1);
    await page.locator("#history-items summary").click(); await expect(page.locator("#history-items pre")).toContainText("蓝色方块");
    await page.locator('[data-close="history"]').click(); await page.locator('#editor [aria-label="关闭"]').click();
    await page.locator("#settings").click();
    await page.locator("#frequency").fill("90"); await page.locator("#cooldown").fill("0");
    await page.locator("#settings-form").getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("#preferences")).not.toBeVisible();
    await page.locator("#settings").click(); await expect(page.locator("#frequency")).toHaveValue("90");
    await page.locator('#preferences [aria-label="关闭"]').click();
    await expect(page.locator('#error')).not.toBeVisible(); assert.deepEqual(errors, []);
    if (process.env.OPENBOT_MEME_UI_SCREENSHOT) await page.screenshot({ path: path.resolve(process.env.OPENBOT_MEME_UI_SCREENSHOT), fullPage: true });
    console.log("Meme UI: real plugin actions, image editing, automatic reindex, recognition history and persisted frequency settings passed");
  } finally { await browser.close(); }
};
