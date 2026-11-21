"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const { randomBytes, createHash } = require("node:crypto");

async function authorize(installed) {
  if (!installed?.client_id || !installed.client_secret) throw Error("请选择桌面应用类型的 Google OAuth 客户端文件。");
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
  let redirect, used = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirect);
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (req.method !== "GET" || req.headers.host !== new URL(redirect).host || url.origin !== new URL(redirect).origin ||
        url.pathname !== "/" || used || url.searchParams.get("state") !== state) {
      res.writeHead(403).end(); return;
    }
    used = true;
    try {
      if (url.searchParams.has("error")) throw Error("Google 登录未获授权。");
      const code = url.searchParams.get("code");
      if (!code) throw Error("Google 回调缺少授权码。");
      const reply = await fetch("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: installed.client_id, client_secret: installed.client_secret,
          code, code_verifier: verifier, redirect_uri: redirect }) });
      if (!reply.ok) throw Error("交换 Google 授权码失败（HTTP " + reply.status + "）。");
      const { refresh_token } = await reply.json();
      if (!refresh_token) throw Error("Google 未签发刷新令牌。");
      const credential = JSON.stringify({ client_id: installed.client_id, client_secret: installed.client_secret, refresh_token });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><meta charset=utf-8><title>Gmail 已授权</title><p>将以下内容复制到此实例邮箱设置的「Google OAuth 授权凭据」中，然后关闭本页。</p><textarea readonly rows="7" cols="80">' +
        credential.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") + "</textarea>");
    } catch (e) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(e.message);
    } finally { server.close(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  redirect = "http://127.0.0.1:" + server.address().port + "/";
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: installed.client_id, response_type: "code", redirect_uri: redirect,
    scope: "https://www.googleapis.com/auth/gmail.modify", access_type: "offline", prompt: "consent", state,
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
  const timeout = setTimeout(() => server.close(), 5 * 60 * 1000);
  timeout.unref();
  server.once("close", () => clearTimeout(timeout));
  return { url: url.href, close: () => server.close() };
}
let login;
async function desktopLogin(ctx) {
  if (ctx.principal.source !== "desktop") throw Error("请在实例的邮箱设置中连接 Google。");
  const value = await ctx.api.getSecret("gmailOAuth");
  if (!value) throw Error("请先将桌面应用的 Google OAuth 客户端 JSON 填入授权凭据并保存。");
  let config;
  try { config = JSON.parse(value); } catch { throw Error("Google OAuth 客户端 JSON 格式无效。"); }
  login?.close();
  login = await authorize(config.installed || config);
  const { execFile } = require("node:child_process");
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", login.url] : [login.url];
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(command, args, { windowsHide: true }, error => { if (error) reject(Error("打开默认浏览器失败。")); });
      child.once("spawn", resolve); child.once("error", reject);
    });
    return { opened: true };
  } catch { login.close(); throw Error("打开默认浏览器失败。"); }
}
module.exports = { authorize, desktopLogin };
if (require.main === module) (async () => {
  if (!process.argv[2]) throw Error("请指定 Google Cloud 桌面应用客户端 JSON 文件。");
  const client = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  const result = await authorize(client.installed);
  console.log("请在这台电脑的浏览器中打开 Google 登录地址：\n" + result.url);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
