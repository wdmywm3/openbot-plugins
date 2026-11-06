"use strict";
const assert = require("node:assert/strict"), path = require("node:path");

module.exports = async function checkUi({ hostRequire, runtime, channel, plugin, action, media, actor, root, picker }) {
  const { chromium, expect } = hostRequire("playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let listCalls = 0, rejectList, holdList = false;
    await require("./helpers/view-host.cjs")({ page, hostRequire, runtime, channel, plugin, onAction(args, next) {
      if (args.actionId === "list") {
        listCalls++;
        if (holdList) { holdList = false; return new Promise((_resolve, reject) => { rejectList = reject; }); }
      }
      return next();
    } });
    await page.locator(".channel-edit-tabs").getByRole("button", { name: "表情包", exact: true }).click();
    const view = page.frameLocator('iframe[title="表情包"]');
    await expect(view.locator('#source option[value="profile"]')).toHaveText("专属角色表情");
    await expect(page.locator(".channel-overview-facts")).toHaveCount(0);
    await expect(view.locator(".tile")).toHaveCount(1);
    holdList = true;
    await view.locator("#query").fill("测试");
    await expect.poll(() => !!rejectList).toBe(true);
    await view.locator("#import").click();
    await expect.poll(() => typeof picker.release === "function").toBe(true);
    rejectList(new Error("Plugin initialization failed"));
    const whilePicking = listCalls;
    await page.waitForTimeout(5200);
    assert.equal(listCalls, whilePicking, "background list polling pauses while the file picker is open");
    await expect(view.locator("#error")).not.toBeVisible();
    picker.release([]); picker.release = null;
    await expect(view.locator("#import")).toBeEnabled();
    await view.locator("#query").fill("");
    await expect(view.locator(".tile")).toHaveCount(1);
    await expect(view.locator('#chat-filter option')).toHaveText(['全部聊天', '表情交流群（123456）', '表情交流群（876543）']);
    await view.locator(".tile > button").click();
    const editor = page.frameLocator('iframe[title="编辑表情"]');
    await editor.locator('#chat-mode').selectOption('include');
    const search = editor.locator('#chats > input[type=search]');
    await search.fill('表情交流群'); await expect(editor.locator('#chats label:visible')).toHaveCount(2);
    await search.fill('123456'); await expect(editor.locator('#chats label:visible')).toHaveCount(1);
    await editor.locator('#chats input[value="onebot:group:123456"]').check();
    await search.fill('');
    await editor.getByText("识别与详细描述", { exact: true }).click();
    await editor.locator("#caption").fill("可编辑的蓝色方块");
    await editor.locator("#tags").fill("冷静，蓝色");
    await page.getByRole("dialog", { name: "编辑表情", exact: true }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator('iframe[title="编辑表情"]')).toHaveCount(0);
    await view.locator(".tile > button").click();
    await expect(editor.locator('#chat-mode')).toHaveValue('include');
    await expect(editor.locator('#chats input[value="onebot:group:123456"]')).toBeChecked();
    await expect(editor.locator('#chats input[value="onebot:group:876543"]')).not.toBeChecked();
    await editor.getByText("识别与详细描述", { exact: true }).click();
    await expect(editor.locator("#caption")).toHaveValue("可编辑的蓝色方块");
    await editor.locator("#recognition > summary").click();
    await expect(editor.locator("#history-items summary")).toHaveCount(1);
    await editor.locator("#history-items summary").click();
    await expect(editor.locator("#history-items pre")).toContainText("蓝色方块");
    await page.getByRole("dialog", { name: "编辑表情", exact: true }).getByRole("button", { name: "关闭弹窗" }).click();
    await view.locator("#settings").click();
    const preferences = page.frameLocator('iframe[title="表情设置"]');
    await expect(preferences.locator('#setting-chat option')).toHaveText(['实例默认', '表情交流群（123456）', '表情交流群（876543）']);
    await preferences.locator("#frequency").fill("90"); await preferences.locator("#cooldown").fill("0");
    await page.getByRole("dialog", { name: "表情设置", exact: true }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator('iframe[title="表情设置"]')).toHaveCount(0);
    await view.locator("#settings").click(); await expect(preferences.locator("#frequency")).toHaveValue("90");
    await page.getByRole("dialog", { name: "表情设置", exact: true }).getByRole("button", { name: "关闭弹窗" }).click();
    await view.locator("#select-mode").click(); await view.locator(".tile > input").check();
    await view.locator('[data-batch="scope"]').click();
    const scope = page.frameLocator('iframe[title="设置适用范围"]');
    await scope.locator('#chat-mode').selectOption('exclude');
    await scope.locator('#chats > input[type=search]').fill('876543');
    await expect(scope.locator('#chats label:visible')).toHaveText(['表情交流群（876543）']);
    await scope.locator('#chats input[value="onebot:group:876543"]').check();
    await page.getByRole('dialog', { name: '设置适用范围', exact: true }).getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.locator('iframe[title="设置适用范围"]')).toHaveCount(0);
    await expect(view.locator('#selected-count')).toHaveText('已选 0 张');
    await view.locator(".tile > input").check(); await view.locator('[data-batch="disable"]').click();
    await expect(view.locator(".tile .status")).toHaveText("已停用");
    await view.locator("#status").selectOption("enabled"); await expect(view.locator(".tile")).toHaveCount(0);
    await view.locator("#status").selectOption("disabled"); await expect(view.locator(".tile")).toHaveCount(1);
    await expect(view.locator('#error')).not.toBeVisible(); assert.deepEqual(errors, []);
    if (process.env.OPENBOT_MEME_UI_SCREENSHOT) {
      await view.locator("#select-mode").click();
      await view.locator(".tile > button").click();
      await expect(editor.locator('#chat-mode')).toHaveValue('exclude');
      await expect(editor.locator('#chats input[value="onebot:group:876543"]')).toBeChecked();
      await expect(page.getByRole("dialog", { name: "编辑表情", exact: true }).getByRole("button", { name: "保存", exact: true })).toBeInViewport();
      const screenshot = path.resolve(process.env.OPENBOT_MEME_UI_SCREENSHOT), parsed = path.parse(screenshot);
      await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
      await editor.locator('#chats').screenshot({ path: path.join(parsed.dir, `${parsed.name}-picker${parsed.ext}`), animations: "disabled" });
    }
    console.log("Meme UI: real plugin actions, image editing, automatic reindex, recognition history and persisted frequency settings passed");
  } finally { await browser.close(); }
};
