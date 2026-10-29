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

function normalizeHtml(rawText, maxChars) {
  const title = firstMatch(rawText, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const text = htmlToText(rawText);
  const limited = limitText(text || title || "", maxChars);
  return {
    title,
    extractionMode: "html_clean",
    content: limited.text,
    cleanChars: charLen(text || title || ""),
    truncated: limited.truncated,
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

function normalizeWebContent({ rawText = "", contentType = "", url = "", maxChars = 12000 } = {}) {
  const type = sniffType(rawText, contentType, url);
  const budget = Math.max(1, Math.min(50_000, Number(maxChars || 12_000)));
  const raw = String(rawText || "");
  const normalized = (() => {
    if (type === "text/html" || type === "application/xhtml+xml") return normalizeHtml(raw, budget);
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
    readPolicy: "This fetch is complete. Use the returned content to answer. If relevant text is truncated, fetch with a larger maxChars (up to 50000); otherwise use a more relevant source when information is missing. Repeating the same fetch with unchanged arguments does not retrieve a next page.",
  };
}

return { normalizeWebContent, mediaTypeOf };
})();

const ANYSEARCH = "https://api.anysearch.com/mcp";
const PROVIDERS = ["anysearch", "tavily", "exa", "brave"];
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
async function request(ctx, endpoint, options = {}) {
  ctx.signal?.throwIfAborted();
  const response = await ctx.api.request(endpoint, { timeoutMs: 30000, ...options });
  ctx.signal?.throwIfAborted();
  if (!response.ok) {
    const explanation = response.status === 401 ? "凭据无效，请检查 API Key"
      : response.status === 403 ? "访问被拒绝，请检查 API 是否启用、凭据限制和项目权限"
      : response.status === 429 ? "请求达到服务额度或频率限制，请稍后再试" : "搜索服务暂不可用";
    const error = new Error(`${explanation}（HTTP ${response.status}）`);
    error.status = response.status;
    error.retryAfter = response.headers?.["retry-after"];
    throw error;
  }
  return response;
}
async function json(ctx, endpoint, body, headers = {}, extra = {}) {
  return (await request(ctx, endpoint, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, responseType: "json", ...extra })).body;
}
function rpcPayload(response, id) {
  const body = response.body;
  const messages = typeof body === "string" && /^\s*(?:event:|data:|:)/.test(body)
    ? body.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean).map(JSON.parse)
    : [typeof body === "string" ? JSON.parse(body) : body];
  const result = messages.find(message => message?.id === id);
  if (!result || result.error) throw new Error("AnySearch 未返回有效的调用结果");
  return result.result;
}
async function anySearch(ctx) {
  const key = await secret(ctx, "anysearch", true);
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  let id = 1;
  const initial = await request(ctx, ANYSEARCH, { method: "POST", headers, body: { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "OpenBot Search", version: "0.1.0" } } } });
  const initialized = rpcPayload(initial, id++);
  if (initial.headers?.["mcp-session-id"]) headers["mcp-session-id"] = initial.headers["mcp-session-id"];
  if (initialized.protocolVersion) headers["mcp-protocol-version"] = initialized.protocolVersion;
  await request(ctx, ANYSEARCH, { method: "POST", headers, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  return async (name, args) => {
    const current = id++;
    const response = await request(ctx, ANYSEARCH, { method: "POST", headers, body: { jsonrpc: "2.0", id: current, method: "tools/call", params: { name, arguments: args } } });
    const result = rpcPayload(response, current);
    if (result?.isError) throw new Error(`AnySearch ${name} 调用失败，请检查查询参数或服务额度`);
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
async function web(ctx, input, rpc) {
  const p = provider(ctx), args = searchInput(input), key = await secret(ctx, p, p === "anysearch");
  if (p === "anysearch") return (rpc || await anySearch(ctx))("search", args);
  if (args.domain) throw new Error("专业领域参数仅适用于 AnySearch");
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
  if (provider(ctx) === "anysearch") return (await anySearch(ctx))("extract", { url: address });
  const response = await request(ctx, address, { headers: { accept: "text/html,text/plain,application/json,text/markdown" } });
  const type = response.headers?.["content-type"] || "";
  if (type && !/text\/|application\/(?:json|xml|[^;]*\+(?:json|xml))/i.test(type)) throw new Error("这个地址不是可读取的网页文本");
  const raw = String(response.body || "");
  if (!raw.trim()) throw new Error("网页没有可读取的正文");
  const maxChars = Math.max(1000, Math.min(50000, Number(ctx.input?.maxChars) || 20000));
  return webContent.normalizeWebContent({ rawText: raw, contentType: type, url: response.url || address, maxChars });
};
module.exports.search_by_image = async ctx => {
  if (ctx.config.imageProvider !== "google") throw new Error("请在搜索插件设置中启用以图搜图");
  const key = await secret(ctx, "google");
  if (typeof ctx.api.readMessageAttachment !== "function") throw new Error("请更新 OpenBot，以支持读取图片附件");
  const input = ctx.input || {};
  const attachment = await ctx.api.readMessageAttachment({ messageId: input.messageId, index: input.index ?? 0, maxBytes: 6 * 1024 * 1024 });
  if (attachment.type !== "image" || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(attachment.mimeType)
    || typeof attachment.data !== "string" || !attachment.data || attachment.data.length > 8 * 1024 * 1024) throw new Error("请选择一张不超过 6 MiB 的 JPEG、PNG、WebP 或 GIF 图片");
  const count = limit(input.max_results);
  const raw = await json(ctx, "https://vision.googleapis.com/v1/images:annotate", { requests: [{ image: { content: attachment.data }, features: [{ type: "WEB_DETECTION", maxResults: count }] }] },
    { "x-goog-api-key": key }, { maxBodyBytes: 10 * 1024 * 1024 });
  const response = raw?.responses?.[0];
  if (!response || response.error) throw new Error(`Cloud Vision 图片搜索失败${response?.error?.code ? `（${response.error.code}）` : ""}，请检查图片、API 启用状态及额度`);
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
