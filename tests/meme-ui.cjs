"use strict";
const assert = require("node:assert/strict"), path = require("node:path");

module.exports = async function checkUi({ hostRequire, runtime, channel, plugin, action, media, actor, root }) {
  const { chromium, expect } = hostRequire("playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await require("./helpers/view-host.cjs")({ page, hostRequire, runtime, channel, plugin });
    await page.locator(".channel-edit-tabs").getByRole("button", { name: "表情包", exact: true }).click();
    const view = page.frameLocator('iframe[title="表情包"]');
    await expect(page.locator(".channel-overview-facts")).toHaveCount(0);
    await expect(view.locator(".tile")).toHaveCount(1);
    await view.locator(".tile > button").click();
    const editor = page.frameLocator('iframe[title="编辑表情"]');
    await editor.getByText("识别与详细描述", { exact: true }).click();
    await editor.locator("#caption").fill("可编辑的蓝色方块");
    await editor.locator("#tags").fill("冷静，蓝色");
    await page.getByRole("dialog", { name: "编辑表情", exact: true }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator('iframe[title="编辑表情"]')).toHaveCount(0);
    await view.locator(".tile > button").click();
    await editor.getByText("识别与详细描述", { exact: true }).click();
    await expect(editor.locator("#caption")).toHaveValue("可编辑的蓝色方块");
    await editor.locator("#recognition > summary").click();
    await expect(editor.locator("#history-items summary")).toHaveCount(1);
    await editor.locator("#history-items summary").click();
    await expect(editor.locator("#history-items pre")).toContainText("蓝色方块");
    await page.getByRole("dialog", { name: "编辑表情", exact: true }).getByRole("button", { name: "关闭弹窗" }).click();
    await view.locator("#settings").click();
    const preferences = page.frameLocator('iframe[title="表情设置"]');
    await preferences.locator("#frequency").fill("90"); await preferences.locator("#cooldown").fill("0");
    await page.getByRole("dialog", { name: "表情设置", exact: true }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator('iframe[title="表情设置"]')).toHaveCount(0);
    await view.locator("#settings").click(); await expect(preferences.locator("#frequency")).toHaveValue("90");
    await page.getByRole("dialog", { name: "表情设置", exact: true }).getByRole("button", { name: "关闭弹窗" }).click();
    await view.locator("#select-mode").click(); await view.locator(".tile > input").check(); await view.locator('[data-batch="disable"]').click();
    await expect(view.locator(".tile .status")).toHaveText("已停用");
    await view.locator("#status").selectOption("enabled"); await expect(view.locator(".tile")).toHaveCount(0);
    await view.locator("#status").selectOption("disabled"); await expect(view.locator(".tile")).toHaveCount(1);
    await expect(view.locator('#error')).not.toBeVisible(); assert.deepEqual(errors, []);
    if (process.env.OPENBOT_MEME_UI_SCREENSHOT) {
      await view.locator("#select-mode").click();
      await view.locator(".tile > button").click();
      await expect(page.getByRole("dialog", { name: "编辑表情", exact: true }).getByRole("button", { name: "保存", exact: true })).toBeInViewport();
      await page.screenshot({ path: path.resolve(process.env.OPENBOT_MEME_UI_SCREENSHOT), fullPage: true });
    }
    console.log("Meme UI: real plugin actions, image editing, automatic reindex, recognition history and persisted frequency settings passed");
  } finally { await browser.close(); }
};
