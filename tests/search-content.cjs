#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const vm = require("node:vm");
const sandbox = vm.createContext({ module: { exports: {} } });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugins/search/index.js"), "utf8"), sandbox);
const { normalizeWebContent, mediaTypeOf } = vm.runInContext("webContent", sandbox);

assert.equal(typeof normalizeWebContent, "function", "normalizeWebContent should be exported");
assert.equal(typeof mediaTypeOf, "function", "mediaTypeOf should be exported");
assert.equal(mediaTypeOf("Text/HTML; charset=utf-8"), "text/html", "mediaTypeOf should normalize media types");

const htmlPayload = normalizeWebContent({
  url: "https://example.com/post",
  contentType: "text/html; charset=utf-8",
  rawText: [
    "<html><head><title>Readable Page</title><script>window.secret = 'drop me'</script></head>",
    "<body><nav>global navigation should disappear</nav>",
    "<main><h1>Story Headline</h1><p>First useful paragraph for the agent.</p>",
    "<p>Second useful paragraph with&nbsp;entity text.</p></main>",
    "<footer>copyright footer should disappear</footer></body></html>",
  ].join(""),
  maxChars: 240,
});

assert.equal(htmlPayload.kind, "web_fetch_result", "HTML payload should use the stable web_fetch result kind");
assert.equal(htmlPayload.mediaType, "text/html", "HTML payload should preserve normalized media type");
assert.equal(htmlPayload.title, "Readable Page", "HTML payload should extract title");
assert.match(htmlPayload.content, /Story Headline/, "HTML payload should keep useful headings");
assert.match(htmlPayload.content, /First useful paragraph/, "HTML payload should keep useful body text");
assert.doesNotMatch(htmlPayload.content, /secret|global navigation|copyright footer|<script|<main/i, "HTML payload should remove page chrome and tags");
assert.ok(htmlPayload.stats.rawChars > htmlPayload.stats.returnedChars, "HTML stats should expose shrinkage");

const jsonPayload = normalizeWebContent({
  url: "https://api.example.com/items",
  contentType: "application/json",
  rawText: JSON.stringify({
    total: 3,
    items: [
      { id: 1, name: "alpha", body: "A".repeat(500) },
      { id: 2, name: "beta", body: "B".repeat(500) },
      { id: 3, name: "gamma", body: "C".repeat(500) },
    ],
  }),
  maxChars: 420,
});

assert.equal(jsonPayload.mediaType, "application/json", "JSON payload should detect JSON media type");
assert.match(jsonPayload.content, /keys: total, items/, "JSON payload should summarize object keys");
assert.match(jsonPayload.content, /items: array\(3\)/, "JSON payload should summarize array lengths");
assert.doesNotMatch(jsonPayload.content, /AAAAA|BBBBB|CCCCC/, "JSON payload should not inline long repeated values");

const csvPayload = normalizeWebContent({
  url: "https://example.com/data.csv",
  contentType: "text/csv",
  rawText: "name,score,notes\nA,10,kept\nB,9,kept\nC,8,kept\nD,7,drop",
  maxChars: 300,
});

assert.match(csvPayload.content, /columns: 3/, "CSV payload should summarize column count");
assert.match(csvPayload.content, /headers: name, score, notes/, "CSV payload should include headers");
assert.match(csvPayload.content, /A,10,kept/, "CSV payload should include a small sample");
assert.doesNotMatch(csvPayload.content, /D,7,drop/, "CSV payload should avoid returning the full table by default");

const xmlPayload = normalizeWebContent({
  url: "https://example.com/feed.xml",
  contentType: "application/rss+xml",
  rawText: "<rss><channel><title>Feed Title</title><item><title>Item One</title><description>Useful item text.</description></item></channel></rss>",
  maxChars: 260,
});

assert.match(xmlPayload.content, /root: rss/, "XML payload should identify the root element");
assert.match(xmlPayload.content, /Feed Title/, "XML payload should retain readable text");
assert.doesNotMatch(xmlPayload.content, /<channel>|<item>/, "XML payload should not return raw XML tags");

const textPayload = normalizeWebContent({
  url: "https://example.com/plain.txt",
  contentType: "text/plain",
  rawText: `Line one.\n\n\n${"Long ".repeat(120)}\nLine end.`,
  maxChars: 160,
});

assert.match(textPayload.content, /Line one/, "plain text payload should keep content");
assert.equal(textPayload.truncated, true, "plain text payload should report truncation");
assert.doesNotMatch(textPayload.readPolicy, /read_tool_result/, "fetch guidance must not send the model to an unavailable tool");
assert.ok(textPayload.content.length <= 190, "plain text payload should honor maxChars with a short suffix");

console.log("web_fetch normalizer contract ok");
