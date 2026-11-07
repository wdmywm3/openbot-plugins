"use strict";
const assert = require("node:assert/strict"), path = require("node:path");

module.exports = async function checkUi({ hostRequire, runtime, channel, plugin, action, media, actor, root, picker }) {
  const { chromium, expect } = hostRequire("playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let listCalls = 0, rejectList, holdList = false, gridFixture = false;
    await require("./helpers/view-host.cjs")({ page, hostRequire, runtime, channel, plugin, async onAction(args, next) {
      if (args.actionId === "list") {
        listCalls++;
        if (holdList) { holdList = false; return new Promise((_resolve, reject) => { rejectList = reject; }); }
        if (gridFixture) {
          const data = await runtime.runPluginAction(channel, plugin, action("list"), {});
          return { ...data, total: 48, nextOffset: null, items: Array.from({ length: 48 }, (_, index) => ({ ...data.items[0], id: `scroll-${index}`, name: `表情 ${index}` })) };
        }
      }
      return next();
    } });
    await page.locator(".channel-edit-tabs").getByRole("button", { name: "表情包", exact: true }).click();
    const view = page.frameLocator('iframe[title="表情包"]');
    await expect(view.locator('#source option[value="profile"]')).toHaveText("专属角色表情");
    await expect(page.locator(".channel-overview-facts")).toHaveCount(0);
    await expect(view.locator(".tile")).toHaveCount(1);
    gridFixture = true;
    await view.locator("#query").fill("scroll");
    await expect(view.locator(".tile")).toHaveCount(48);
    await view.locator("#select-mode").click();
    const last = view.locator(".tile").last();
    await last.scrollIntoViewIfNeeded();
    await last.evaluate(tile => { window.scrollProbe = { tile, image: tile.querySelector('img'), scroll: window.scrollY, changes: 0 };
      window.scrollProbe.observer = new MutationObserver(records => { window.scrollProbe.changes += records.filter(record => record.type === 'childList').length; });
      window.scrollProbe.observer.observe(document.getElementById('grid'), { childList: true, subtree: true }); });
    const beforeSelection = listCalls;
    await last.locator('input').check();
    await expect(last).toHaveClass(/selected/);
    await last.evaluate(tile => {
      if (tile !== window.scrollProbe.tile || tile.querySelector('img') !== window.scrollProbe.image || Math.abs(window.scrollY - window.scrollProbe.scroll) > 2 || window.scrollProbe.changes) throw Error('Selection rebuilt cards or changed scroll');
    });
    assert.equal(listCalls, beforeSelection, "selecting a card does not reload the library");
    await expect.poll(() => listCalls, { timeout: 8000 }).toBeGreaterThan(beforeSelection);
    await last.evaluate(tile => {
      if (tile !== window.scrollProbe.tile || tile.querySelector('img') !== window.scrollProbe.image || Math.abs(window.scrollY - window.scrollProbe.scroll) > 2 || window.scrollProbe.changes) throw Error('Polling rebuilt cards or changed scroll');
      window.scrollProbe.observer.disconnect();
    });
    await last.locator('input').uncheck(); await last.locator('button').click(); await expect(last.locator('input')).toBeChecked();
    await view.locator('#select-mode').click(); gridFixture = false;
    await view.locator('#query').fill(''); await expect(view.locator('.tile')).toHaveCount(1);
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
    await editor.getByLabel('名称', { exact: true }).fill('嘻嘻正比：冷静');
    await editor.getByLabel('专属角色', { exact: true }).selectOption('builtin-channelOperator');
    await expect(editor.locator('#profile-scope')).not.toBeVisible();
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
    await expect(editor.getByLabel('专属角色', { exact: true })).toHaveValue('builtin-channelOperator');
    await expect(editor.locator('#chat-mode')).toHaveValue('include');
    await expect(editor.locator('#chats input[value="onebot:group:123456"]')).toBeChecked();
    await expect(editor.locator('#chats input[value="onebot:group:876543"]')).not.toBeChecked();
    await editor.getByText("识别与详细描述", { exact: true }).click();
    await expect(editor.locator("#caption")).toHaveValue("可编辑的蓝色方块");
    await expect(editor.locator('#name')).toHaveValue('嘻嘻正比：冷静');
    await expect(editor.locator('[data-field]')).toHaveCount(2);
    await editor.locator("#recognition > summary").click();
    await expect(editor.locator("#history-items summary")).toHaveCount(1);
    await editor.locator("#history-items summary").click();
    await expect(editor.locator("#history-items pre")).toContainText("蓝色方块");
    await page.getByRole("dialog", { name: "编辑表情", exact: true }).getByRole("button", { name: "重新识别", exact: true }).click();
    await page.getByRole('dialog', { name: '重新识别这张表情', exact: true }).getByRole('button', { name: '重新识别', exact: true }).click();
    await expect(page.locator('iframe[title="编辑表情"]')).toHaveCount(0);
    await expect.poll(async () => {
      const result = await runtime.runPluginAction(channel, plugin, action('list'), {});
      return result.items[0]?.caption;
    }).toBe('蓝色方块');
    await expect(view.locator('.tile .caption')).toHaveText('嘻嘻正比：冷静');
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
    await scope.getByLabel('专属角色', { exact: true }).selectOption('builtin-channelOperator');
    await scope.locator('#chat-mode').selectOption('exclude');
    await scope.locator('#chats > input[type=search]').fill('876543');
    await expect(scope.locator('#chats label:visible')).toHaveText(['表情交流群（876543）']);
    await scope.locator('#chats input[value="onebot:group:876543"]').check();
    await page.getByRole('dialog', { name: '设置适用范围', exact: true }).getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.locator('iframe[title="设置适用范围"]')).toHaveCount(0);
    await expect(view.locator('#selected-count')).toHaveText('已选 0 张');
    const beforeRecognition = await runtime.runPluginAction(channel, plugin, action('list'), {});
    assert.equal(beforeRecognition.items[0].roleProfileId, 'builtin-channelOperator', 'batch scope persists explicit role identity');
    const originalId = beforeRecognition.items[0].id;
    const historyBefore = await runtime.runPluginAction(channel, plugin, action('history'), { id: originalId });
    await view.locator('.tile > input').check(); await view.locator('[data-batch="reanalyze"]').click();
    await page.getByRole('dialog', { name: '重新识别 1 张表情', exact: true }).getByRole('button', { name: '重新识别', exact: true }).click();
    await expect.poll(async () => (await runtime.runPluginAction(channel, plugin, action('history'), { id: originalId })).records.filter(row => row.value.status === 'completed').length)
      .toBe(historyBefore.records.filter(row => row.value.status === 'completed').length + 1);
    await expect(view.locator('#selected-count')).toHaveText('已选 0 张');
    // Wait for the next list snapshot so subsequent edits use its current revision.
    await expect.poll(async () => {
      const result = await runtime.runPluginAction(channel, plugin, action('list'), {});
      return result.jobs.every(job => !['queued', 'running'].includes(job.status));
    }).toBe(true);
    await view.locator('#query').fill('嘻嘻正比');
    await expect(view.locator('.tile .caption')).toHaveText('嘻嘻正比：冷静');
    await page.waitForTimeout(350);
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
