"use strict";

const STATE_KEY = "workshop.tools.v1";
const MAX_TOOLS = 20;
const MAX_STATE_BYTES = 900000;
const MAX_CODE_BYTES = 48000;
const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fail = message => { throw new Error(message); };
const bytes = value => { let size = 0; for (const char of String(value)) { const point = char.codePointAt(0); size += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4; } return size; };
function privateOwner(ctx) {
  if (ctx.principal?.role !== "owner" || ctx.principal?.messageType !== "private") fail("工具工坊仅限实例主人私聊使用");
  ctx.signal?.throwIfAborted();
}
function validId(id) { if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(id)) fail("工具 ID 应以小写字母开头，只含小写字母、数字和短横线，最多 48 字符"); return id; }
function boundedText(value, max, title) { if (typeof value !== "string" || !value.trim() || value.length > max) fail(`${title}不能为空且不能超过 ${max} 字符`); return value.trim(); }
function validateSchema(schema) {
  let count = 0;
  function walk(rule, depth) {
    if (!object(rule) || depth > 8 || ++count > 128) fail("参数规则过大或嵌套过深");
    const keys = ["type", "title", "description", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"];
    if (Object.keys(rule).some(key => !keys.includes(key)) || !TYPES.includes(rule.type)) fail("参数规则包含不支持的字段或类型");
    for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) if (rule[key] !== undefined && (!Number.isInteger(rule[key]) || rule[key] < 0 || rule[key] > 65536)) fail("参数长度限制无效");
    for (const key of ["minimum", "maximum"]) if (rule[key] !== undefined && !Number.isFinite(rule[key])) fail("参数数值限制无效");
    for (const [min, max] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"]]) if (rule[min] !== undefined && rule[max] !== undefined && rule[min] > rule[max]) fail("参数最小值不能大于最大值");
    if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.length || rule.enum.length > 32 || rule.enum.some(value => value !== null && !["string", "number", "boolean"].includes(typeof value)))) fail("枚举只支持最多 32 个简单值");
    if (rule.type === "object") {
      if (!object(rule.properties) || Object.keys(rule.properties).length > 32 || rule.additionalProperties !== false) fail("对象参数必须声明 properties 和 additionalProperties:false，最多 32 个字段");
      if (rule.required !== undefined && (!Array.isArray(rule.required) || rule.required.length > 32 || rule.required.some(key => typeof key !== "string" || !own(rule.properties, key)))) fail("必填参数必须来自 properties");
      for (const [key, child] of Object.entries(rule.properties)) { if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 80) fail("参数名无效"); walk(child, depth + 1); }
    } else if (rule.type === "array") { if (!object(rule.items)) fail("数组参数需要 items"); walk(rule.items, depth + 1); }
  }
  walk(schema, 0); if (schema.type !== "object") fail("工具参数顶层必须是 object");
  if (bytes(JSON.stringify(schema)) > 12000) fail("参数规则超过 12 KiB");
  return copy(schema);
}
function validateInput(schema, input, label = "input", depth = 0) {
  if (depth > 8) fail("输入嵌套过深");
  const valid = schema.type === "object" ? object(input) : schema.type === "array" ? Array.isArray(input)
    : schema.type === "null" ? input === null : schema.type === "integer" ? Number.isInteger(input)
      : schema.type === "number" ? typeof input === "number" && Number.isFinite(input) : typeof input === schema.type;
  if (!valid) fail(`${label} 类型应为 ${schema.type}`);
  if (schema.enum && !schema.enum.some(value => value === input)) fail(`${label} 不在可选值中`);
  if (schema.type === "object") {
    for (const key of schema.required || []) if (!own(input, key)) fail(`${label}.${key} 为必填参数`);
    for (const [key, value] of Object.entries(input)) { if (!own(schema.properties, key)) fail(`${label}.${key} 未声明`); validateInput(schema.properties[key], value, `${label}.${key}`, depth + 1); }
  } else if (schema.type === "array") {
    if (input.length > (schema.maxItems ?? 1000) || input.length < (schema.minItems ?? 0)) fail(`${label} 数量超出范围`);
    input.forEach((value, index) => validateInput(schema.items, value, `${label}[${index}]`, depth + 1));
  } else if (schema.type === "string" && (input.length < (schema.minLength ?? 0) || input.length > (schema.maxLength ?? 65536))) fail(`${label} 长度超出范围`);
  else if (["integer", "number"].includes(schema.type) && (input < (schema.minimum ?? -Infinity) || input > (schema.maximum ?? Infinity))) fail(`${label} 数值超出范围`);
}
function registry(value) {
  const state = value && value.version === 1 && Array.isArray(value.tools) ? copy(value) : { version: 1, tools: [] };
  // Clocks survive removal. Recreating an ID must never reuse an old draft,
  // saved revision, or a still-running test's identity.
  state.revisionClock = Math.max(state.revisionClock || 0, ...state.tools.flatMap(row => [row.revision || 0, row.saved?.revision || 0]));
  state.testClock = Math.max(state.testClock || 0, ...state.tools.map(row => row.test?.attempt || 0));
  for (const key of ["revisionClock", "testClock"]) if (!Number.isSafeInteger(state[key]) || state[key] < 0) fail("工具版本记录无效");
  return state;
}
function nextClock(state, key) {
  if (state[key] >= Number.MAX_SAFE_INTEGER) fail("工具版本计数已达上限");
  return ++state[key];
}
async function update(ctx, change) {
  return ctx.api.updateState(STATE_KEY, value => {
    const state = registry(value); change(state);
    if (bytes(JSON.stringify(state)) > MAX_STATE_BYTES) fail("工具保存空间已满，请移除不用的工具");
    return state;
  }, "chat");
}
function find(state, id) { const row = state.tools.find(item => item.id === id); if (!row) fail("没有找到这个工具，请先 list"); return row; }
function matchRevision(row, revision) { if (!Number.isInteger(revision) || revision !== row.revision) fail("工具版本已变化，请先 read 并使用当前 revision"); }
function checkCapabilities(ctx, capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length > 3 || new Set(capabilities).size !== capabilities.length
    || capabilities.some(value => !["request", "modelRequest", "assets"].includes(value))) fail("工具只支持可选的 request、modelRequest 和 assets 能力");
  if (capabilities.includes("request") && ctx.config?.allowNetwork !== true) fail("尚未允许工具联网，请在工具工坊设置中开启");
  if (capabilities.includes("modelRequest") && ctx.config?.allowModelRequests !== true) fail("尚未允许工具调用模型，请在工具工坊设置中开启");
  if (capabilities.includes("assets") && ctx.config?.allowMedia !== true) fail("尚未允许工具保存媒体，请在工具工坊设置中开启");
}
function describe(row) { return { id: row.id, title: row.draft.title, description: row.draft.description, revision: row.revision,
  tested: row.test?.revision === row.revision && row.test?.passed === true, savedRevision: row.saved?.revision ?? null }; }
async function execute(ctx, draft, input, timeoutMs) {
  checkCapabilities(ctx, draft.capabilities);
  if (typeof ctx.api.runScript !== "function") fail("当前 OpenBot 版本不支持运行工具，请升级");
  const value = input ?? {};
  if (bytes(JSON.stringify(value)) > 60000) fail("工具输入超过 60 KiB");
  validateInput(draft.inputSchema, value);
  return ctx.api.runScript({ code: draft.code, input: value, capabilities: draft.capabilities,
    timeoutMs: timeoutMs ?? (draft.capabilities.includes("modelRequest") ? 180000 : 3000) });
}

module.exports.manage = async function manage(ctx) {
  privateOwner(ctx);
  const input = ctx.input || {}, state = registry(await ctx.api.getState(STATE_KEY, "chat"));
  if (input.action === "list") return { tools: state.tools.map(describe), limit: MAX_TOOLS };
  const id = validId(input.id);
  if (input.action === "read") return copy(find(state, id));
  if (input.action === "draft") {
    const draft = { title: boundedText(input.title, 80, "名称"), description: boundedText(input.description, 500, "说明"),
      code: boundedText(input.code, MAX_CODE_BYTES, "代码"), inputSchema: validateSchema(input.inputSchema), capabilities: input.capabilities ?? [] };
    if (bytes(draft.code) > MAX_CODE_BYTES) fail("工具代码超过 48 KiB");
    checkCapabilities(ctx, draft.capabilities);
    const next = await update(ctx, value => {
      let row = value.tools.find(item => item.id === id);
      if (!row) { if (input.revision !== 0) fail("新工具 revision 应为 0"); if (value.tools.length >= MAX_TOOLS) fail(`最多保存 ${MAX_TOOLS} 个工具`); row = { id, revision: 0 }; value.tools.push(row); }
      matchRevision(row, input.revision); row.revision = nextClock(value, "revisionClock"); row.draft = draft; delete row.test;
    });
    return describe(find(next, id));
  }
  const row = find(state, id); matchRevision(row, input.revision);
  if (input.action === "test") {
    let expected;
    if (input.expectedJson !== undefined) {
      if (typeof input.expectedJson !== "string" || bytes(input.expectedJson) > 60000) fail("预期结果应为最多 60 KiB 的 JSON 文本");
      try { expected = JSON.parse(input.expectedJson); } catch { fail("预期结果不是有效 JSON"); }
    }
    const started = await update(ctx, value => {
      const latest = find(value, id); matchRevision(latest, input.revision);
      latest.test = { revision: latest.revision, attempt: nextClock(value, "testClock"), passed: false, at: Date.now() };
    });
    const attempt = find(started, id).test.attempt;
    const result = await execute(ctx, row.draft, input.input, input.timeoutMs);
    const passed = input.expectedJson === undefined || JSON.stringify(canonical(result)) === JSON.stringify(canonical(expected));
    await update(ctx, value => {
      const latest = find(value, id); matchRevision(latest, input.revision);
      if (latest.test?.attempt !== attempt) fail("已有更新的试运行，请读取当前结果");
      latest.test = { revision: latest.revision, attempt, passed, checkedExpected: input.expectedJson !== undefined, at: Date.now() };
    });
    return { id, revision: row.revision, passed, result };
  }
  if (input.action === "save") {
    const next = await update(ctx, value => { const latest = find(value, id); matchRevision(latest, input.revision);
      if (latest.test?.revision !== latest.revision || latest.test?.passed !== true) fail("请先让当前草稿通过试运行，再保存");
      latest.saved = { ...copy(latest.draft), revision: latest.revision, savedAt: Date.now() };
    });
    return describe(find(next, id));
  }
  if (input.action === "remove") {
    await update(ctx, value => { const latest = find(value, id); matchRevision(latest, input.revision); value.tools = value.tools.filter(item => item.id !== id); });
    return { id, removed: true };
  }
  fail("不支持的工具管理操作");
};
module.exports.run = async function run(ctx) {
  privateOwner(ctx);
  const input = ctx.input || {}, row = find(registry(await ctx.api.getState(STATE_KEY, "chat")), validId(input.id));
  if (!row.saved) fail("工具尚未保存，请先试运行并保存");
  if (row.saved.revision !== input.revision) fail("已保存版本已变化，请先 read 并使用 saved.revision");
  const result = await execute(ctx, row.saved, input.input, input.timeoutMs);
  return { id: row.id, revision: row.saved.revision, result };
};
module.exports.context = async () => ({ content: "可使用工具工坊编写、试运行、保存和复用当前主人私聊的 JavaScript 工具。需要时先读取 tool-workshop Skill，再通过 manage 的 list/read 查看已有工具。" });
