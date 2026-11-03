"use strict";
const fs = require("node:fs"), path = require("node:path");

// Exercise bundled plugin pages inside the real host renderer. Only the Electron
// transport is adapted to HTTP; view sessions/actions use the real runtime.
module.exports = async function mountView({ page, hostRequire, runtime, channel, plugin }) {
  const host = path.dirname(hostRequire.resolve("./package.json")), dist = path.join(host, "dist");
  const authorization = { required: false, status: "approved", fingerprint: "ui-test", permissions: [], components: [] };
  const binding = { ...plugin, sourcePluginId: plugin.id, sourcePluginVersion: plugin.version || "test", authorization };
  await page.addInitScript({ path: path.join(host, "tests/e2e/electron-mock.js") });
  await page.exposeFunction("fixtureOpen", args => {
    const view = runtime.openPluginView(channel.id, plugin.id, args.viewId, args);
    return { ...view, url: `/__fixture_view/${view.token}/${new URL(view.url).pathname.slice(1)}` };
  });
  await page.exposeFunction("fixtureCall", args => runtime.callPluginViewAction(args.token, args.actionId, args.input));
  await page.exposeFunction("fixtureClose", args => runtime.closePluginView(args.token));
  await page.addInitScript(({ binding, channel }) => {
    const info = { id: channel.id, name: "界面测试", platform: "qq", enabled: true, status: "disconnected", configSummary: { provider: "qq-official", appId: "test" } };
    const installed = { id: binding.id, name: binding.name || binding.id, version: binding.sourcePluginVersion, enabled: true, permissions: binding.permissions || [], authorization: binding.authorization, channelRuntime: { ui: binding.ui } };
    const config = { ...channel.config, provider: "qq-official", modelId: "model", replyPrivate: true, groupReplyTriggers: ["mention"], botPlugins: [binding], replyRules: [] };
    window.__e2eMock = {
      listChannels: [info], getChannelConfig: () => config, listChannelSessions: [],
      listInstalledPlugins: [installed], listInstalledChannelPlugins: [{ ...installed, definition: binding }],
      listChannelPluginBindingsSummary: [{ channelId: channel.id, channelName: info.name, enabled: true, plugins: [binding] }],
      getPluginCatalog: [], manage_channel_memory_space: { spaces: [] }, manage_channel_memory: { items: [] },
      openChannelPluginView: args => window.fixtureOpen(args), callChannelPluginViewAction: args => window.fixtureCall(args), closeChannelPluginView: args => window.fixtureClose(args),
    };
  }, { binding: JSON.parse(JSON.stringify(binding)), channel: { id: channel.id, config: channel.config } });
  await page.route("http://host.test/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/__fixture_view/")) {
      const [, token, ...segments] = url.pathname.split("/").slice(1);
      const result = await runtime.resolvePluginViewAsset(`openbot-plugin-view://${token}/${segments.join("/")}${url.search}`);
      let body = result.body;
      if (result.headers["content-type"].startsWith("text/html")) body = body.toString()
        .replaceAll('href="/__ui/', `href="/__fixture_view/${token}/__ui/`)
        .replaceAll(`openbot-plugin-view://${token}/__media/`, `/__fixture_view/${token}/__media/`);
      await route.fulfill({ contentType: result.headers["content-type"], headers: { "access-control-allow-origin": "*",
        "content-security-policy": result.headers["content-security-policy"].replaceAll("openbot-plugin-view:", "http://host.test") }, body });
      return;
    }
    const file = path.resolve(dist, url.pathname === "/" ? "index.html" : "." + url.pathname);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) return route.abort();
    await route.fulfill({ path: file });
  });
  await page.goto("http://host.test/");
  await page.getByRole("button", { name: "实例设置", exact: true }).click();
};
