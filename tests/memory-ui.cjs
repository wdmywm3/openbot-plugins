"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
module.exports = async ({ fromHost, runtime, channel, plugin, action, scope, root }) => {
  const { chromium, expect } = fromHost("playwright/test"), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1060, height: 760 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await require("./helpers/view-host.cjs")({ page, hostRequire: fromHost, runtime, channel, plugin });
    await page.locator(".channel-edit-tabs").getByRole("button", { name: "记忆", exact: true }).click();
    await page.getByRole("navigation", { name: "页面内容" }).getByRole("button", { name: "整理", exact: true }).click();
    const view = page.frameLocator('iframe[title="记忆整理"]');
    await expect(view.locator("#chat option")).not.toHaveCount(1);
    await view.locator("#chat").selectOption(scope.chatId);
    await expect(view.locator("#items .item")).not.toHaveCount(0);
    await view.locator("#items .item").first().locator("button").first().click();
    const details = page.frameLocator('iframe[title="整理记录"]');
    await expect(details.locator("#events")).toContainText("迁移后仍能读到的运行日志");
    await page.getByRole("dialog", { name: "整理记录", exact: true }).getByRole("button", { name: "关闭弹窗" }).click();
    await view.locator("#inherit").selectOption("override");
    if (await view.locator("#enabled").getAttribute("aria-checked") !== "true") await view.locator("#enabled").click();
    await view.locator("#schedule").selectOption("daily"); await view.locator("#daily-time").fill("04:30");
    await expect(view.locator("#save-status")).toHaveText("已保存");
    await expect(view.locator("#daily-time")).toHaveValue("04:30");
    await view.locator("#advanced > summary").click();
    await view.locator("#start-now").click();
    await page.getByRole("dialog", { name: "跳过此前记录", exact: true }).getByRole("button", { name: "跳过", exact: true }).click();
    await expect(view.locator("#scan-start")).toContainText("整理起点更新于");
    await expect(view.locator("#error")).not.toBeVisible(); assert.deepEqual(errors, []);
    if (process.env.OPENBOT_MEMORY_UI_SCREENSHOT) {
      await view.locator("#advanced > summary").click();
      await view.locator("#chat").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.resolve(process.env.OPENBOT_MEMORY_UI_SCREENSHOT), fullPage: true });
    }
    console.log("Memory Plus UI: browser reads actual migrated journals and changes strategy settings through public desktop actions passed");
  } finally { await browser.close(); }
};
