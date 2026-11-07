"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
module.exports = async ({ fromHost, runtime, channel, plugin, action, scope, root, legacyRunId }) => {
  const { chromium, expect } = fromHost("playwright/test"), browser = await chromium.launch({ headless: true });
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1060, height: 760 } }); const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await require("./helpers/view-host.cjs")({ page, hostRequire: fromHost, runtime, channel, plugin });
    await page.locator(".channel-edit-tabs").getByRole("button", { name: "记忆", exact: true }).click();
    await page.getByRole("navigation", { name: "页面内容" }).getByRole("button", { name: "整理", exact: true }).click();
    const view = page.frameLocator('iframe[title="记忆整理"]');
    await expect(view.locator("#chat")).toBeVisible();
    await expect(view.locator("#chat option")).not.toHaveCount(1);
    await view.locator("#chat").selectOption(scope.chatId);
    await expect(view.locator("#items .item")).not.toHaveCount(0);
    const runs = (await runtime.runPluginAction(channel, plugin, action("list"), { chatId: scope.chatId })).runs.items;
    const index = legacyRunId ? runs.findIndex(run => run.id === legacyRunId) : 0;
    assert(index >= 0, "the imported journal remains in the public run list alongside new idle runs");
    await view.locator("#items .item").nth(index).locator("button").first().click();
    const details = page.frameLocator('iframe[title="整理记录"]');
    await expect(details.locator("#events")).toContainText("迁移后仍能读到的运行日志");
    await expect(details.locator("#events")).toContainText("长日志分页开头");
    while (await details.getByRole("button", { name: "继续阅读", exact: true }).count()) {
      const remaining = details.getByRole("button", { name: "继续阅读", exact: true }).filter({ visible: true });
      if (!await remaining.count()) break;
      const previousLength = (await details.locator("#events").innerText()).length;
      await remaining.first().click();
      await expect.poll(async () => (await details.locator("#events").innerText()).length).toBeGreaterThan(previousLength);
      await expect(details.locator("#error")).not.toBeVisible();
      await expect(page.getByRole("dialog", { name: "整理记录", exact: true }).getByRole("button", { name: "关闭", exact: true })).toBeEnabled();
    }
    await expect(details.locator("#events")).toContainText("长日志分页结尾");
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
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(path.dirname(fromHost.resolve("./package.json")), "artifacts/memory-plugin-ui-error.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
};
