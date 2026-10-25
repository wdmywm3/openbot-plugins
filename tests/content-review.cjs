'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { fixture } = require('./butler.cjs');
const code = fs.readFileSync(path.join(__dirname, '../plugins/bilibili-explorer/index.js'), 'utf8');
function setup({ noContent = false, fakeQuote = false } = {}) {
  const f = fixture(), media = [], logs = [], comments = [], prompts = [];
  f.ctx.principal = { role: 'owner', messageType: 'private' };
  const original = f.ctx.api.fetchJson;
  f.ctx.api.fetchJson = async (url, options) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/view')) return { code: 0, data: { aid: 100, title: '一个 skill 解决剪辑', desc: '关注后领取', pages: [{ duration: 30, cid: 1 }] } };
    if (u.pathname.endsWith('/player/v2')) return { code: 0, data: { subtitle: { subtitles: noContent ? [] : [{ lan: 'zh', subtitle_url: 'https://test.hdslb.com/subtitle' }] } } };
    if (u.pathname === '/subtitle') return { body: [{ from: 0, to: 30, content: '只说速度快，没有提供项目名。' }] };
    if (u.pathname === '/x/v2/reply') {
      comments.push(url); const sort = u.searchParams.get('sort'), limit = Number(u.searchParams.get('ps'));
      return { code: 0, data: { replies: Array.from({ length: limit }, (_, i) => ({ rpid_str: String(1000 + Number(sort) * 100 + i), content: { message: '已关注' } })) } };
    }
    return original(url, options);
  };
  f.ctx.api.media = async input => { media.push(input); return noContent ? { status: 'unavailable' } : { status: 'completed', observations: [{ start: 0, end: 30, text: '展示速度，没有入口' }] }; };
  f.ctx.api.log = async input => logs.push(input);
  f.ctx.api.runAgent = async request => {
    prompts.push(request); assert.equal(request.maxOutputTokens, undefined);
    if (request.prompt.startsWith('评价')) return { text: JSON.stringify({ assessment: 'marketing_risk', summary: '未提供可定位的项目入口，建议核对。', reason: '承诺与内容不一致',
      evidence: noContent ? [{ source: 'description', quote: '关注后领取', finding: '资源引流' }] : [{ source: 'content', quote: fakeQuote ? '捏造的内容' : '未提供具体步骤', finding: '缺少实质讲解' }], recommendation: '待核对，不自动删除' }) };
    return { text: JSON.stringify({ summary: '未提供具体步骤', needAudio: false, needVisual: true, reason: '需要核对画面入口', evidence: [{ start: 0, end: 30, claim: '只强调速度' }] }) };
  };
  const call = async (level, extra = {}) => { const sandbox = { module: { exports: {} } }; vm.runInNewContext(code, sandbox);
    return sandbox.module.exports.agentTool({ ...f.ctx, tool: 'review', input: { bvid: 'BV1234567890', level, ...extra } }); };
  return { ...f, media, logs, comments, prompts, call };
}
(async () => {
  const f = setup();
  const medium = await f.call('medium'); assert.equal(medium.assessment, 'marketing_risk'); assert.equal(medium.comments.items.length, 30);
  assert.equal(f.media.length, 0, 'medium never escalates to frames'); assert.equal(f.comments.length, 2);
  const calls = f.prompts.length; await f.call('medium'); assert.equal(f.prompts.length, calls);
  const advanced = await f.call('advanced'); assert.ok(advanced.sources.includes('抽样画面')); assert.equal(f.media.length, 1);
  assert.equal(f.prompts.filter(r => r.taskId.endsWith('-text')).length, 1, 'advanced reuses medium text analysis');
  assert.equal(f.writes.length, 0); assert.ok(f.logs.every(l => !l.undo));
  const insufficient = setup({ noContent: true }); assert.equal((await insufficient.call('medium')).assessment, 'insufficient_evidence');
  const invalid = setup({ fakeQuote: true }); await assert.rejects(invalid.call('medium'), /证据/);
  assert.equal(invalid.state.get('bili:1:review:BV1234567890:1:medium').status, 'analyzing');
  console.log('Content review: bounded comments, medium/advanced routing, evidence validation, missing sources, cache and no writes passed (fixtures)');
})().catch(e => { console.error(e); process.exitCode = 1; });
