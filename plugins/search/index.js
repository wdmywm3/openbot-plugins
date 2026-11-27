"use strict";

const webContent = (() => {
"use strict";

function charLen(value) {
  return [...String(value || "")].length;
}

function byteLen(value) {
  return [...String(value || "")].reduce((bytes, character) => { const code = character.codePointAt(0); return bytes + (code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4); }, 0);
}

function mediaTypeOf(contentType = "") {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

function limitText(value, maxChars, suffix = "\n...[web_fetch normalized content truncated]") {
  const chars = [...String(value || "")];
  const max = Math.max(1, Number(maxChars || 1));
  if (chars.length <= max) return { text: chars.join(""), truncated: false };
  const suffixText = String(suffix || "");
  const keep = Math.max(1, max - charLen(suffixText));
  return { text: `${chars.slice(0, keep).join("")}${suffixText}`, truncated: true };
}

function compactText(value = "") {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntity(name) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  if (Object.prototype.hasOwnProperty.call(named, name)) return named[name];
  if (/^#x[0-9a-f]+$/i.test(name)) {
    const code = Number.parseInt(name.slice(2), 16);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : `&${name};`;
  }
  if (/^#\d+$/.test(name)) {
    const code = Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : `&${name};`;
  }
  return `&${name};`;
}

function decodeHtml(value = "") {
  return String(value || "").replace(/&([a-zA-Z][\w.-]*|#\d+|#x[0-9a-fA-F]+);/g, (_match, name) => decodeEntity(name));
}

function stripHtmlNoise(html = "") {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<canvas\b[\s\S]*?<\/canvas>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
}

function screenInlineHtml(html) {
  const stack = [], output = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const hiddenTags = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe"]);
  const pattern = /<!--[\s\S]*?(?:-->|$)|<\/?[a-zA-Z][\w:-]*(?:"[^"]*"|'[^']*'|[^'"<>])*?>/g;
  const color = value => value?.replace(/\s+/g, "").replace(/^white$/, "#ffffff").replace(/^#fff$/, "#ffffff").replace(/^rgb\(255,255,255\)$/, "#ffffff");
  let last = 0, hiddenTextCount = 0;
  const add = text => {
    if (stack.at(-1)?.hidden) { if (text.trim()) hiddenTextCount++; }
    else if (!stack.at(-1)?.ignored) output.push(text);
  };
  for (const match of html.matchAll(pattern)) {
    add(html.slice(last, match.index)); last = match.index + match[0].length;
    const markup = match[0], tag = /^<(\/?)([a-z][\w:-]*)/i.exec(markup);
    if (!tag) continue;
    const name = tag[2].toLowerCase();
    if (tag[1]) {
      const index = stack.findLastIndex(item => item.name === name);
      if (index < 0) continue;
      const closed = stack[index]; stack.length = index;
      if (!closed.hidden && !closed.ignored) add(markup);
      continue;
    }
    const attributes = markup.slice(tag[0].length);
    const style = decodeHtml(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes)?.slice(1).find(value => value !== undefined) || "").toLowerCase();
    const rules = Object.fromEntries(style.split(";").map(part => part.trim().split(/:\s*/)).filter(pair => pair.length === 2).map(([key, value]) => [key.trim(), value.replace(/\s*!important\s*$/, "").trim()]));
    const parent = stack.at(-1), background = color(rules["background-color"] || rules.background) || parent?.background || "#ffffff";
    const foreground = color(rules.color) || parent?.foreground;
    const hidden = parent?.hidden || /(?:^|\s)hidden(?:\s|=|\/?>)/i.test(attributes)
      || rules.display === "none" || ["hidden", "collapse"].includes(rules.visibility) || rules["content-visibility"] === "hidden"
      || rules.opacity !== undefined && Number(rules.opacity) <= 0.01 || foreground === "transparent" || foreground === background;
    const ignored = parent?.ignored || hiddenTags.has(name);
    if (!hidden && !ignored) add(markup);
    if (!voidTags.has(name) && !markup.endsWith("/>")) {
      if (stack.length >= 128) break;
      stack.push({ name, hidden, ignored, background, foreground });
    }
  }
  if (stack.length < 128) add(html.slice(last));
  return { html: output.join(""), hiddenTextCount };
}

function firstMatch(value, re) {
  const match = re.exec(String(value || ""));
  return match ? decodeHtml(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
}

function primaryHtml(value = "") {
  const text = String(value || "");
  const main = text.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (main?.[2]) return main[2];
  const body = text.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body?.[1] || text;
}

function htmlToText(html = "") {
  const clean = stripHtmlNoise(primaryHtml(html))
    .replace(/<(h[1-6]|p|li|blockquote|pre|tr|div|section|article|main)\b[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(h[1-6]|p|li|blockquote|pre|tr|div|section|article|main)>/gi, "\n")
    .replace(/<td\b[^>]*>/gi, " | ")
    .replace(/<th\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  return compactText(decodeHtml(clean));
}

function normalizeHtml(rawText, maxChars, pageUrl, includeImages) {
  const { html, hiddenTextCount } = screenInlineHtml(rawText);
  const title = firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const text = htmlToText(html);
  const limited = limitText(text || title || "", maxChars);
  return {
    title,
    extractionMode: "html_clean",
    ...pageReferences(html, pageUrl, includeImages),
    content: limited.text,
    cleanChars: charLen(text || title || ""),
    truncated: limited.truncated,
    diagnostics: hiddenTextCount ? [{ code: "html_hidden_text_removed", count: hiddenTextCount }] : [],
  };
}

function summarizeJsonValue(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const lines = [`array(${value.length})`];
    if (depth < 2 && value.length) {
      for (let idx = 0; idx < Math.min(3, value.length); idx += 1) {
        lines.push(`[${idx}]: ${summarizeJsonValue(value[idx], depth + 1)}`);
      }
    }
    return lines.join("\n");
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (depth >= 2) return `object keys: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", ..." : ""}`;
    const lines = [`object keys: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", ..." : ""}`];
    for (const key of keys.slice(0, 8)) {
      lines.push(`${key}: ${summarizeJsonValue(value[key], depth + 1).replace(/\n/g, "\n  ")}`);
    }
    return lines.join("\n");
  }
  if (typeof value === "string") {
    return value.length > 120 ? `string(${charLen(value)} chars)` : JSON.stringify(value);
  }
  return String(value);
}

function normalizeJson(rawText, maxChars) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawText || ""));
  } catch {
    const limited = limitText(compactText(rawText), maxChars);
    return {
      extractionMode: "json_parse_failed",
      content: `Invalid JSON text\n\n${limited.text}`,
      cleanChars: charLen(limited.text),
      truncated: limited.truncated,
      diagnostics: [{ code: "json_parse_failed", message: "Response advertised JSON but could not be parsed." }],
    };
  }
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  const lines = [
    "JSON summary",
    Array.isArray(parsed) ? `type: array(${parsed.length})` : `type: ${parsed === null ? "null" : typeof parsed}`,
    keys.length ? `keys: ${keys.slice(0, 20).join(", ")}${keys.length > 20 ? ", ..." : ""}` : "",
    summarizeJsonValue(parsed),
  ].filter(Boolean);
  const text = compactText(lines.join("\n"));
  const limited = limitText(text, maxChars);
  return {
    extractionMode: "json_summary",
    content: limited.text,
    cleanChars: charLen(text),
    truncated: limited.truncated,
  };
}

function detectDelim(line = "") {
  const tabs = (String(line).match(/\t/g) || []).length;
  const commas = (String(line).match(/,/g) || []).length;
  const semis = (String(line).match(/;/g) || []).length;
  if (tabs >= commas && tabs >= semis && tabs > 0) return "\t";
  if (semis > commas) return ";";
  return ",";
}

function splitRow(line, delim) {
  const out = [];
  let cell = "";
  let quoted = false;
  const text = String(line || "");
  for (let idx = 0; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (ch === "\"" && text[idx + 1] === "\"") {
      cell += "\"";
      idx += 1;
    } else if (ch === "\"") {
      quoted = !quoted;
    } else if (ch === delim && !quoted) {
      out.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell.trim());
  return out;
}

function normalizeCsv(rawText, maxChars) {
  const lines = String(rawText || "").split(/\r?\n/).filter((line) => line.trim());
  const delim = detectDelim(lines[0] || "");
  const headers = splitRow(lines[0] || "", delim);
  const rows = lines.slice(1).map((line) => splitRow(line, delim));
  const sample = rows.slice(0, 3).map((row) => row.join(delim === "\t" ? "\t" : ","));
  const text = [
    "Delimited text summary",
    `rows: ${rows.length}`,
    `columns: ${headers.length}`,
    headers.length ? `headers: ${headers.join(", ")}` : "",
    sample.length ? "sample:\n" + sample.join("\n") : "",
  ].filter(Boolean).join("\n");
  const limited = limitText(text, maxChars);
  return {
    extractionMode: "table_summary",
    content: limited.text,
    cleanChars: charLen(text),
    truncated: limited.truncated || rows.length > sample.length,
  };
}

function normalizeXml(rawText, maxChars) {
  const root = firstMatch(rawText, /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<([a-zA-Z_][\w:.-]*)\b/i);
  const text = compactText(decodeHtml(
    stripHtmlNoise(rawText)
      .replace(/<[^>]+>/g, " ")
  ));
  const body = [
    "XML summary",
    root ? `root: ${root}` : "",
    text ? `text:\n${text}` : "",
  ].filter(Boolean).join("\n");
  const limited = limitText(body, maxChars);
  return {
    extractionMode: "xml_text_summary",
    content: limited.text,
    cleanChars: charLen(body),
    truncated: limited.truncated,
  };
}

function isJsonType(type) {
  return type === "application/json" || type.endsWith("+json");
}

function isXmlType(type) {
  return type === "application/xml"
    || type === "text/xml"
    || type === "application/rss+xml"
    || type === "application/atom+xml"
    || type === "application/xhtml+xml"
    || type.endsWith("+xml");
}

function isCsvType(type, url = "") {
  return type === "text/csv"
    || type === "text/tab-separated-values"
    || /\.csv(?:$|[?#])/i.test(url)
    || /\.tsv(?:$|[?#])/i.test(url);
}

function normalizeText(rawText, maxChars) {
  const text = compactText(rawText);
  const limited = limitText(text, maxChars);
  return {
    extractionMode: "plain_text",
    content: limited.text,
    cleanChars: charLen(text),
    truncated: limited.truncated,
  };
}

function sniffType(rawText, contentType, url = "") {
  const type = mediaTypeOf(contentType);
  if (type) return type;
  const text = String(rawText || "").trimStart();
  if (/^<!doctype html\b|^<html\b/i.test(text)) return "text/html";
  if (/^[\[{]/.test(text)) return "application/json";
  if (/^<\?xml\b|^<[a-zA-Z_][\w:.-]*\b/.test(text)) return "application/xml";
  if (/\.csv(?:$|[?#])/i.test(url)) return "text/csv";
  if (/\.tsv(?:$|[?#])/i.test(url)) return "text/tab-separated-values";
  return "text/plain";
}

function normalizeWebContent({ rawText = "", contentType = "", url = "", maxChars = 12000, includeImages = false } = {}) {
  const type = sniffType(rawText, contentType, url);
  const budget = Math.max(1, Math.min(50_000, Number(maxChars || 12_000)));
  const raw = String(rawText || "");
  const normalized = (() => {
    if (type === "text/html" || type === "application/xhtml+xml") return normalizeHtml(raw, budget, url, includeImages);
    if (isJsonType(type)) return normalizeJson(raw, budget);
    if (isCsvType(type, url)) return normalizeCsv(raw, budget);
    if (isXmlType(type)) return normalizeXml(raw, budget);
    return normalizeText(raw, budget);
  })();
  return {
    schemaVersion: 1,
    kind: "web_fetch_result",
    url: String(url || ""),
    mediaType: type,
    title: normalized.title || "",
    extractionMode: normalized.extractionMode,
    content: normalized.content,
    truncated: !!normalized.truncated,
    stats: {
      rawBytes: byteLen(raw),
      rawChars: charLen(raw),
      cleanChars: Number(normalized.cleanChars || 0),
      returnedChars: charLen(normalized.content),
    },
    diagnostics: normalized.diagnostics || [],
    ...(normalized.links ? { links: normalized.links } : {}),
    ...(normalized.images ? { images: normalized.images } : {}),
    readPolicy: "This fetch is complete. Use the returned content to answer. If relevant text is truncated, fetch with a larger maxChars (up to 50000); otherwise use a more relevant source when information is missing. Repeating the same fetch with unchanged arguments does not retrieve a next page.",
  };
}

// The plugin VM has no URL constructor. Resolve ordinary HTML references against
// the final page address; the network API validates every destination on fetch.
function pageReferences(html, pageUrl, includeImages) {
  const pictures = new Map(), screenshots = new Map(), links = new Map();
  function resolve(rawUrl, base) {
    const value = rawUrl?.trim();
    if (!value || value.length > 3000 || /[\s\\]/.test(value) || value.startsWith("#")) return "";
    if (/^https?:\/\//i.test(value)) return value;
    if (/^[a-z][\w+.-]*:/i.test(value)) return "";
    const origin = /^(https?:)\/\/[^/?#]+/i.exec(base);
    if (!origin) return "";
    if (value.startsWith("//")) return origin[1] + value;
    const path = base.slice(origin[0].length).split(/[?#]/)[0] || "/";
    if (value.startsWith("?")) return origin[0] + path + value;
    const joined = value.startsWith("/") ? value : path.replace(/[^/]*$/, "") + value;
    const [pathname] = joined.split(/[?#]/), parts = [];
    for (const part of pathname.split("/").slice(1)) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    return origin[0] + "/" + parts.join("/") + joined.slice(pathname.length);
  }
  // Keep document metadata, then prioritize the article's links over site navigation.
  const metadata = (html.match(/<(?:base|meta)\b[^>]*>/gi) || []).slice(0, 128).join("");
  const content = metadata + stripHtmlNoise(primaryHtml(html));
  let base = pageUrl;
  for (const match of content.matchAll(/<(base|meta|img|a|div|section)\b((?:"[^"]*"|'[^']*'|[^<>"'])*)>/gi)) {
    const tag = match[1].toLowerCase(), attrs = {};
    const container = tag === "div" || tag === "section";
    if (container && (!includeImages || screenshots.size >= 16 || match[2].length > 131072 || !/\bdata-props\s*=/i.test(match[2]))) continue;
    for (const a of match[2].matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs[a[1].toLowerCase()] = decodeHtml(a[2] ?? a[3] ?? a[4]);
    if (tag === "base") { base = resolve(attrs.href, pageUrl) || base; continue; }
    if (container) {
      // Some galleries render their images client-side from JSON on the visible element.
      let slides;
      try { slides = JSON.parse(attrs["data-props"]).screenshots; } catch { continue; }
      if (!Array.isArray(slides)) continue;
      for (const slide of slides.slice(0, 16)) {
        const imageUrl = [slide?.full, slide?.standard, slide?.thumbnail]
          .map(value => typeof value === "string" ? resolve(value, base) : "").find(Boolean);
        if (imageUrl && screenshots.size < 16) screenshots.set(imageUrl, { imageUrl, sourceUrl: pageUrl,
          caption: typeof slide.altText === "string" ? clip(slide.altText, 300) : "" });
      }
      continue;
    }
    const meta = tag === "meta" && /^(og:image(?::url|:secure_url)?|twitter:image(?::src)?)$/i.test(attrs.property || attrs.name || "");
    const address = resolve(tag === "a" ? attrs.href : meta ? attrs.content : tag === "img" ? attrs["data-src"] || attrs.src : "", base);
    if (!address) continue;
    const label = attrs.alt || attrs.title || (tag === "a" ? firstMatch(content.slice(match.index + match[0].length, match.index + match[0].length + 300), /^([^<]+)/) : "");
    if (tag === "a" && !/\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(address)) {
      if (links.size < 24) links.set(address, { url: address, title: clip(label, 160) });
    } else if (includeImages && pictures.size < 16) pictures.set(address, { imageUrl: address, sourceUrl: pageUrl, caption: clip(label || pictures.get(address)?.caption, 300) });
  }
  const images = [...screenshots.values(), ...[...pictures.values()].filter(item => !screenshots.has(item.imageUrl))].slice(0, 16);
  return { ...(includeImages ? { images } : {}), links: [...links.values()] };
}
return { normalizeWebContent, mediaTypeOf };
})();

const ANYSEARCH = "https://api.anysearch.com/mcp";
const PROVIDERS = ["anysearch", "tavily", "exa", "brave", "openai"];
const domains = ["academic", "agriculture", "business", "code", "energy", "environment", "film", "finance", "gaming", "general", "health", "ip", "legal", "resource", "security", "social_media", "travel"];
const clip = (value, max = 3000) => String(value || "").slice(0, max);
const limit = value => Math.max(1, Math.min(10, Number(value) || 5));
const object = value => value && typeof value === "object" && !Array.isArray(value);
function url(value) {
  if (typeof value !== "string" || value.length > 3000 || !/^https?:\/\/[^\s/@]+(?:[/:?#]|$)/i.test(value) || /^https?:\/\/[^/]*@/i.test(value)) throw new Error("请提供有效的网页地址");
  return value;
}
function provider(ctx) {
  const selected = ctx.config.webProvider || "anysearch";
  if (!PROVIDERS.includes(selected)) throw new Error("请在搜索插件中选择网页搜索服务");
  return selected;
}
async function secret(ctx, name, optional = false) {
  const key = String(await ctx.api.getSecret(name + "Key") || "").trim();
  if (!key && !optional) throw new Error(`请在搜索插件设置中填写 ${name === "google" ? "Cloud Vision" : name} API Key`);
  return key;
}
function rejectionDetails(payload) {
  if (typeof payload === "string" && payload.length <= 8192) {
    try { payload = JSON.parse(payload); } catch { return {}; }
  }
  const error = payload?.error ?? payload;
  const code = error?.code ?? error?.status;
  const param = error?.param;
  const details = {};
  if (Number.isSafeInteger(code) || typeof code === "string" && /^[a-z][a-z0-9_]{0,99}$/i.test(code)) details.upstreamCode = code;
  if (typeof param === "string" && /^[a-z_][a-z0-9_.]{0,159}$/i.test(param)) details.upstreamParam = param;
  return details;
}
async function request(ctx, endpoint, options = {}) {
  ctx.signal?.throwIfAborted();
  const response = await ctx.api.request(endpoint, { timeoutMs: 30000, ...options });
  ctx.signal?.throwIfAborted();
  if (!response.ok) {
    const explanation = response.status === 401 ? "搜索服务未通过身份验证"
      : response.status === 403 ? "搜索服务拒绝访问"
      : response.status === 429 ? "搜索服务限制本次请求" : "搜索服务请求失败";
    throw Object.assign(new Error(`${explanation}（HTTP ${response.status}）。`), {
      code: "SEARCH_HTTP_ERROR", status: response.status, retryAfter: response.headers?.["retry-after"],
      details: rejectionDetails(response.body),
    });
  }
  return response;
}
async function json(ctx, endpoint, body, headers = {}, extra = {}) {
  return (await request(ctx, endpoint, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, responseType: "json", ...extra })).body;
}
function rpcFailure(operation, payload) {
  const details = rejectionDetails(payload);
  const code = details.upstreamCode;
  return Object.assign(new Error("AnySearch " + operation + "失败" + (code === undefined ? "。" : "（错误码 " + code + "）。")),
    { code: "SEARCH_RPC_ERROR", details });
}
function rpcPayload(response, id, operation) {
  const body = response.body;
  let messages;
  try {
    messages = typeof body === "string" && /^\s*(?:event:|data:|:)/.test(body)
      ? body.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean).map(JSON.parse)
      : [typeof body === "string" ? JSON.parse(body) : body];
  } catch { throw Object.assign(new Error("AnySearch 响应格式无效。"), { code: "SEARCH_RPC_RESPONSE" }); }
  const result = messages.find(message => message?.id === id);
  if (!result) throw Object.assign(new Error("AnySearch 未返回本次调用的结果。"), { code: "SEARCH_RPC_RESPONSE" });
  if (result.error) throw rpcFailure(operation, result.error);
  return result.result;
}
async function anySearch(ctx) {
  const key = await secret(ctx, "anysearch", true);
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  let id = 1;
  const initial = await request(ctx, ANYSEARCH, { method: "POST", headers, body: { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "OpenBot Search", version: "0.1.0" } } } });
  const initialized = rpcPayload(initial, id++, "初始化连接");
  if (initial.headers?.["mcp-session-id"]) headers["mcp-session-id"] = initial.headers["mcp-session-id"];
  if (initialized.protocolVersion) headers["mcp-protocol-version"] = initialized.protocolVersion;
  await request(ctx, ANYSEARCH, { method: "POST", headers, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  return async (name, args) => {
    const current = id++;
    const response = await request(ctx, ANYSEARCH, { method: "POST", headers, body: { jsonrpc: "2.0", id: current, method: "tools/call", params: { name, arguments: args } } });
    const result = rpcPayload(response, current, "调用工具");
    if (result?.isError) throw rpcFailure("调用工具", result.structuredContent);
    if (!result || !Array.isArray(result.content)) throw new Error("AnySearch 返回格式无效");
    return { provider: "anysearch", content: result.content.filter(part => part.type === "text").map(part => ({ type: "text", text: clip(part.text, 50000) })), ...(result.structuredContent ? { data: result.structuredContent } : {}) };
  };
}
function searchInput(input) {
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 1000) throw new Error("请提供 1–1000 个字的搜索词");
  if (input.domain && !domains.includes(input.domain)) throw new Error("请使用 get_sub_domains 支持的领域");
  if ((input.sub_domain || input.sub_domain_params) && !input.domain) throw new Error("专业查询需要先获取领域和参数");
  if (input.sub_domain_params && !object(input.sub_domain_params)) throw new Error("专业查询参数须为对象");
  return { query: input.query.trim(), max_results: limit(input.max_results),
    ...(input.domain ? { domain: input.domain, sub_domain: input.sub_domain, sub_domain_params: input.sub_domain_params } : {}) };
}
function results(rows, count) {
  if (!Array.isArray(rows)) throw new Error("搜索服务返回格式无效");
  return rows.slice(0, count).map(row => ({ title: clip(row.title || row.name, 300), url: clip(row.url || row.link),
    snippet: clip(row.content || row.snippet || row.description || row.text), publishedAt: clip(row.published_date || row.publishedAt || row.page_age, 100) }))
    .filter(row => /^https?:\/\//i.test(row.url));
}
async function nativeSearch(ctx, args, input) {
  if (!ctx.api.modelRequest) throw new Error("当前宿主未提供原生模型请求");
  const images = input.resultType === "images";
  const tool = { type: "web_search" };
  if (images) {
    tool.search_content_types = ["image", "text"];
    tool.image_settings = { max_results: args.max_results, caption: true };
  }
  if (input.include_domains?.length || input.exclude_domains?.length) tool.filters = {
    ...(input.include_domains?.length ? { allowed_domains: input.include_domains } : {}),
    ...(input.exclude_domains?.length ? { blocked_domains: input.exclude_domains } : {}),
  };
  const response = await ctx.api.modelRequest({
    tools: [tool], include: images ? ["web_search_call.results", "web_search_call.action.sources"] : ["web_search_call.action.sources"],
    input: [{ role: "developer", content: images
      ? "Search the web for relevant images and their source pages. Return brief captions with citations."
      : "Use web search. Follow relevant leads to the original source, check dates and resolve material contradictions. Cite the pages supporting the answer." },
      { role: "user", content: args.query }],
  });
  const calls = response.output.filter(item => item.type === "web_search_call");
  if (!calls.length) throw new Error("模型没有执行网页搜索");
  const completed = calls.filter(item => item.status === "completed");
  if (!completed.length) throw new Error("网页搜索未完成（" + String(calls.at(-1).status || "无状态") + "）");
  const sources = new Map(), pictures = new Map(), paragraphs = [];
  function addSource(link, title) {
    if (/^https?:\/\//i.test(link) && (sources.size < args.max_results || sources.has(link)))
      sources.set(link, { url: link, title: clip(title || sources.get(link)?.title, 300) });
  }
  for (const message of response.output.filter(item => item.type === "message")) {
    for (const part of message.content || []) {
      if (part.type !== "output_text") continue;
      paragraphs.push(clip(part.text, 4000));
      for (const citation of part.annotations || []) if (citation.type === "url_citation") addSource(citation.url, citation.title);
    }
  }
  for (const call of completed) {
    for (const source of call.action?.sources || []) addSource(source.url, source.title);
    for (const result of call.results || []) {
      if (result.type === "image_result" && pictures.size < args.max_results
        && /^https?:\/\//i.test(result.image_url) && /^https?:\/\//i.test(result.source_website_url))
        pictures.set(result.image_url, { imageUrl: result.image_url, sourceUrl: result.source_website_url, caption: clip(result.caption, 500) });
    }
  }
  return { provider: "openai", query: args.query, answer: clip(paragraphs.join("\n"), 8000),
    results: [...sources.values()], ...(images ? { images: [...pictures.values()] } : {}) };
}
async function web(ctx, input, rpc) {
  const p = provider(ctx), args = searchInput(input);
  if (p === "anysearch") return (rpc || await anySearch(ctx))("search", args);
  if (args.domain) throw new Error("专业领域参数仅适用于 AnySearch");
  if (p === "openai") return nativeSearch(ctx, args, input);
  const key = await secret(ctx, p);
  let rows;
  if (p === "tavily") {
    const raw = await json(ctx, "https://api.tavily.com/search", { api_key: key, query: args.query, max_results: args.max_results,
      search_depth: input.search_depth === "advanced" ? "advanced" : "basic", include_domains: input.include_domains,
      exclude_domains: input.exclude_domains, include_answer: false, include_raw_content: false });
    rows = raw?.results;
  } else if (p === "exa") {
    const raw = await json(ctx, "https://api.exa.ai/search", { query: args.query, numResults: args.max_results,
      type: input.search_depth === "advanced" ? "deep" : "auto", contents: { text: { maxCharacters: 2000 } } }, { "x-api-key": key });
    rows = raw?.results;
  } else {
    const raw = await request(ctx, `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=${args.max_results}`,
      { headers: { Accept: "application/json", "X-Subscription-Token": key }, responseType: "json" });
    rows = raw.body?.web?.results || [];
  }
  const found = results(rows, args.max_results);
  return { provider: p, query: args.query, resultCount: found.length, results: found };
}
module.exports.web_search = ctx => web(ctx, ctx.input || {});
module.exports.batch_search = async ctx => {
  const queries = ctx.input?.queries;
  if (!Array.isArray(queries) || !queries.length || queries.length > 5) throw new Error("一次批量搜索需要 1–5 个问题");
  const normalized = queries.map(searchInput);
  if (provider(ctx) === "anysearch") return (await anySearch(ctx))("batch_search", { queries: normalized });
  const output = [];
  for (const query of queries) {
    try { output.push(await web(ctx, query)); }
    catch (error) { ctx.signal?.throwIfAborted(); output.push({ query: query.query, error: clip(error.message, 500) }); }
  }
  return { results: output };
};
module.exports.get_sub_domains = async ctx => {
  if (provider(ctx) !== "anysearch") throw new Error("当前搜索服务不支持领域查询");
  const args = ctx.input || {}, requested = args.domains || (args.domain ? [args.domain] : []);
  if (requested.length > 5 || requested.some(value => !domains.includes(value))) throw new Error("领域名称无效");
  return (await anySearch(ctx))("get_sub_domains", args);
};
module.exports.read_webpage = async ctx => {
  const address = url(ctx.input?.url);
  if (provider(ctx) === "anysearch" && !ctx.input.includeImages) return (await anySearch(ctx))("extract", { url: address });
  const response = await request(ctx, address, { headers: { accept: "text/html,text/plain,application/json,text/markdown" } });
  const type = response.headers?.["content-type"] || "";
  if (type && !/text\/|application\/(?:json|xml|[^;]*\+(?:json|xml))/i.test(type)) throw new Error("这个地址不是可读取的网页文本");
  const raw = String(response.body || "");
  if (!raw.trim()) throw new Error("网页没有可读取的正文");
  const maxChars = Math.max(1000, Math.min(50000, Number(ctx.input?.maxChars) || 20000));
  const pageUrl = response.url || address;
  return webContent.normalizeWebContent({ rawText: raw, contentType: type, url: pageUrl, maxChars, includeImages: ctx.input.includeImages });
};
module.exports.search_by_image = async ctx => {
  if (ctx.config.imageProvider !== "google") throw new Error("请在搜索插件设置中启用以图搜图");
  const key = await secret(ctx, "google");
  if (typeof ctx.api.readMessageAttachment !== "function") throw new Error("请更新 OpenBot，以支持读取图片附件");
  const input = ctx.input || {};
  const limitBytes = 10000000; // Google Vision limits the entire JSON request to 10 MB.
  const count = limit(input.max_results);
  const body = { requests: [{ image: { content: "" }, features: [{ type: "WEB_DETECTION", maxResults: count }] }] };
  const imageChars = limitBytes - JSON.stringify(body).length;
  const host = (await ctx.api.getCapabilities?.())?.limits;
  const maximum = Math.min(host?.attachmentInlineBytes || 6 * 1024 * 1024, Math.floor(imageChars / 4) * 3);
  const attachment = await ctx.api.readMessageAttachment({ messageId: input.messageId, index: input.index ?? 0, maxBytes: maximum });
  if (attachment.type !== "image" || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(attachment.mimeType)
    || typeof attachment.data !== "string" || !attachment.data) throw new Error("请选择一张 JPEG、PNG、WebP 或 GIF 图片");
  if (attachment.data.length > imageChars) throw Object.assign(new Error("图片编码后超过 Google Vision 的 10 MB 请求上限"), { code: "PLUGIN_INPUT_LIMIT" });
  body.requests[0].image.content = attachment.data;
  const raw = await json(ctx, "https://vision.googleapis.com/v1/images:annotate", body,
    { "x-goog-api-key": key }, { maxBodyBytes: limitBytes });
  const response = raw?.responses?.[0];
  if (!response) throw Object.assign(new Error("Cloud Vision 未返回本次图片的搜索结果。"), { code: "SEARCH_VISION_RESPONSE" });
  if (response.error) {
    const details = rejectionDetails(response.error);
    const code = details.upstreamCode;
    throw Object.assign(new Error("Cloud Vision 图片搜索失败" + (code === undefined ? "。" : "（错误码 " + code + "）。")),
      { code: "SEARCH_VISION_ERROR", details });
  }
  const web = response.webDetection || {};
  const images = values => (Array.isArray(values) ? values : []).slice(0, count).filter(item => /^https?:\/\//i.test(item?.url || "")).map(item => ({ url: clip(item.url) }));
  const matches = {
    fullMatches: images(web.fullMatchingImages), partialMatches: images(web.partialMatchingImages), similarImages: images(web.visuallySimilarImages),
    pages: (Array.isArray(web.pagesWithMatchingImages) ? web.pagesWithMatchingImages : []).slice(0, count).filter(item => /^https?:\/\//i.test(item?.url || "")).map(item => ({ url: clip(item.url), title: clip(item.pageTitle, 300), fullMatches: images(item.fullMatchingImages), partialMatches: images(item.partialMatchingImages) })),
    entities: (Array.isArray(web.webEntities) ? web.webEntities : []).slice(0, count).map(item => ({ description: clip(item.description, 300), ...(Number.isFinite(item.score) ? { score: item.score } : {}) })),
    labels: (Array.isArray(web.bestGuessLabels) ? web.bestGuessLabels : []).slice(0, count).map(item => clip(item.label, 300)),
  };
  return { provider: "google-cloud-vision", image: { messageId: attachment.messageId, index: attachment.index }, found: Object.values(matches).some(items => items.length > 0), ...matches };
};

// Stream pages are independently base64 encoded, including partial last triples.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytes64(value) {
  const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(value.length / 4 * 3 - pad);
  for (let i = 0, n = 0; i < value.length; i += 4) {
    const bits = ALPHABET.indexOf(value[i]) << 18 | ALPHABET.indexOf(value[i + 1]) << 12
      | Math.max(0, ALPHABET.indexOf(value[i + 2])) << 6 | Math.max(0, ALPHABET.indexOf(value[i + 3]));
    if (n < bytes.length) bytes[n++] = bits >> 16 & 255;
    if (n < bytes.length) bytes[n++] = bits >> 8 & 255;
    if (n < bytes.length) bytes[n++] = bits & 255;
  }
  return bytes;
}
function join64(parts) {
  if (parts.slice(0, -1).every(part => !part.endsWith("="))) return parts.join("");
  let carry = [], result = [];
  for (const part of parts) {
    const bytes = bytes64(part), chars = [];
    for (const byte of bytes) {
      carry.push(byte);
      if (carry.length === 3) {
        const bits = carry[0] << 16 | carry[1] << 8 | carry[2];
        chars.push(ALPHABET[bits >> 18], ALPHABET[bits >> 12 & 63], ALPHABET[bits >> 6 & 63], ALPHABET[bits & 63]); carry = [];
      }
    }
    result.push(chars.join(""));
  }
  if (carry.length) result.push(ALPHABET[carry[0] >> 2], ALPHABET[(carry[0] & 3) << 4 | (carry[1] || 0) >> 4],
    carry.length === 2 ? ALPHABET[(carry[1] & 15) << 2] : "=", "=");
  return result.join("");
}

module.exports.prepare_reference = async ctx => {
  const imageUrl = url(ctx.input.imageUrl), sourceUrl = url(ctx.input.sourceUrl);
  const { limits } = await ctx.api.getCapabilities();
  const maxBytes = Math.min(limits.assetBytes, limits.attachmentInlineBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error("当前宿主未提供参考图容量");
  const stream = await ctx.api.openStream(imageUrl, { encoding: "base64", redirect: "follow", timeoutMs: 45000,
    headers: { accept: "image/png,image/jpeg,image/webp" } });
  const parts = [];
  let size = 0;
  try {
    if (stream.status < 200 || stream.status >= 300) throw Object.assign(Error("读取参考图失败（HTTP " + stream.status + "）"),
      { code: "SEARCH_REFERENCE_HTTP", status: stream.status });
    const declared = Number(stream.headers?.["content-length"]);
    const checkSize = bytes => {
      if (bytes > maxBytes) throw Object.assign(new Error("参考图为 " + bytes + " 字节，超过 " + maxBytes + " 字节上限"), { code: "PLUGIN_INPUT_LIMIT" });
    };
    checkSize(declared);
    while (true) {
      ctx.signal?.throwIfAborted();
      const page = await ctx.api.readStream({ id: stream.id, maxBytes: Math.min(196608, limits.streamReadBytes), waitMs: 10000 });
      if (page.data) {
        size += page.data.length / 4 * 3 - (page.data.endsWith("==") ? 2 : page.data.endsWith("=") ? 1 : 0);
        checkSize(size);
        parts.push(page.data);
      }
      if (page.done) break;
    }
  } finally { await ctx.api.closeStream({ id: stream.id }).catch(() => {}); }
  if (!size) throw Error("参考图响应为空");
  const data = join64(parts), header = bytes64(data.slice(0, 32));
  const magic = String.fromCharCode(...header);
  let mimeType;
  if (magic.startsWith("\x89PNG\r\n\x1a\n") && magic.slice(12, 16) === "IHDR") mimeType = "image/png";
  else if (magic.startsWith("\xff\xd8\xff")) mimeType = "image/jpeg";
  else if (magic.startsWith("RIFF") && magic.slice(8, 12) === "WEBP") mimeType = "image/webp";
  else throw Error("参考图响应不是 PNG、JPEG 或 WebP 图片");
  const stored = await ctx.api.assets({ action: "put", data, mimeType });
  // Decode before publishing. A matching header alone does not make a usable image.
  await ctx.api.assets({ action: "preview", ref: stored.ref, maxEdge: 64 });
  const published = await ctx.api.assets({ action: "publish", ref: stored.ref, shareable: true });
  return { reference: { url: published.url }, sourceUrl, imageUrl: stream.url || imageUrl,
    attachments: [{ assetRef: stored.ref, caption: "待核对的参考图" }] };
};
