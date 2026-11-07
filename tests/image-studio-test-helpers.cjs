"use strict";
const manifest = require("../plugins/image-studio/plugin.json").extensions["com.openbot"];
const defaults = manifest.config;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function mockDatabase() {
  let row = null;
  return async input => {
    if (input.scope !== "global" || input.name !== "limits" || input.collection !== "usage" || input.key !== "current") throw Error("unexpected database scope");
    if (input.action === "get") return { record: clone(row) };
    if (input.action !== "put" || input.expectedRevision !== (row?.revision || 0)) throw Error("记录已改变，请重新读取版本后更新");
    row = { key: input.key, revision: (row?.revision || 0) + 1, value: clone(input.value) };
    return { ok: true, record: clone(row) };
  };
}
module.exports = { defaults, mockDatabase };
