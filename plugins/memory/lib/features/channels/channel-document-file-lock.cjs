"use strict";
const path = require("node:path");
const locks = new Map();
async function withDocumentFileLock(target, run) {
  const resolved = path.resolve(target), key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = previous.then(() => gate);
  locks.set(key, pending);
  await previous;
  try { return await run(); }
  finally { release(); if (locks.get(key) === pending) locks.delete(key); }
}
module.exports = { withDocumentFileLock };
