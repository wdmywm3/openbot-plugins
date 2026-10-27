'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../plugins/bilibili-explorer/index.js'), 'utf8');
function fixture(count = 5) {
  let now = 1800000000000, fault = '', failPath = '', failCode = 0;
  const state = new Map(), requests = [], posts = [], logs = [];
  const data = Array.from({ length: count }, (_, i) => ({ id: 100 + i, type: 2, bvid: `BV${String(i).padStart(10, '0')}`,
    title: `视频 ${i}`, duration: i + 1, pubtime: i + 100, fav_time: i + 1000 }));
  let items = [...data], invalidIds = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const load = () => {
    const sandbox = { module: { exports: {} }, Date: Clock };
    vm.runInNewContext(source + '\nmodule.exports.test = { biliContains, biliRequest, biliSortMoves };', sandbox);
    return sandbox.module.exports;
  };
  let plugin = load();
  const ctx = { config: { mainUid: '1', browseUid: '2' }, message: { chatId: 'onebot:private:99' }, principal: { role: 'owner', messageType: 'private' }, api: {
    getState: async key => structuredClone(state.get(key)),
    setState: async (key, value) => { assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1024 * 1024); state.set(key, structuredClone(value)); },
    updateState: async (key, reducer) => { const next = reducer(structuredClone(state.get(key))); state.set(key, structuredClone(next)); return structuredClone(next); },
    getSecret: async key => `user=${key === 'bilibiliMainCookie' ? 1 : 2}; bili_jct=secret`,
    sleep: async () => {}, log: async item => logs.push(structuredClone(item)),
    fetchJson: async (url, options) => {
      const u = new URL(url), p = u.pathname, q = u.searchParams;
      requests.push({ p, q: Object.fromEntries(q), method: options.method });
      if (p === failPath) {
        if (typeof failCode === 'string') throw Error(failCode);
        return { code: failCode, data: null };
      }
      if (p.endsWith('/nav')) return { code: 0, data: { isLogin: true, mid: options.headers.cookie.includes('user=1') ? 1 : 2 } };
      if (p.endsWith('/created/list-all')) return { code: 0, data: { list: [{ id: 10, title: '待看', media_count: items.length }] } };
      if (p.endsWith('/folder/info')) return { code: 0, data: { id: 10, title: '待看', upper: { mid: 1 }, media_count: items.length } };
      if (p.endsWith('/resource/ids')) return { code: 0, data: [...items, ...invalidIds].map(({ id, type, bvid }) => ({ id, type, bvid })) };
      if (p.endsWith('/resource/list')) {
        const list = q.get('keyword') ? items.filter(item => item.title.includes(q.get('keyword'))) : items;
        const from = (Number(q.get('pn')) - 1) * 20;
        return { code: 0, data: { has_more: from + 20 < list.length, medias: list.slice(from, from + 20) } };
      }
      if (p.endsWith('/resource/sort')) {
        const body = Object.fromEntries(new URLSearchParams(options.body)); posts.push({ p, body });
        const failure = fault; fault = '';
        if (failure === 'before') throw Error('network disconnected before result');
        const ops = body.sort.split(',');
        for (const [index, op] of ops.entries()) {
          if (failure === 'partial' && index > 0) break;
          const [ref, refType, id, type] = op.split(':');
          const pos = items.findIndex(item => String(item.id) === id && String(item.type) === type);
          assert.ok(pos >= 0); const [item] = items.splice(pos, 1);
          const anchor = ref === '0' ? -1 : items.findIndex(x => String(x.id) === ref && String(x.type) === refType);
          if (ref !== '0') assert.ok(anchor >= 0);
          items.splice(anchor + 1, 0, item);
        }
        if (failure) throw Error('network disconnected after result');
        return { code: 0, data: {} };
      }
      if (p.endsWith('/resource/deal')) { const body = new URLSearchParams(options.body); items = items.filter(x => String(x.id) !== body.get('rid')); return { code: 0, data: {} }; }
      throw Error(`Unexpected request ${p}`);
    },
  } };
  return { ctx, state, requests, posts, logs, data, tool: (tool, input = {}) => plugin.agentTool({ ...ctx, tool, input }),
    test: () => plugin.test, items: () => items, setItems: value => { items = [...value]; }, invalid: value => { invalidIds = value; },
    tick: ms => { now += ms; }, fault: value => { fault = value; }, fail: (p, code) => { failPath = p; failCode = code; },
    restart: () => { plugin = load(); }, now: () => now };
}
async function prepare(f, id = 'sort-1', strategy = 'reverse', videoIds) {
  let result;
  do { result = await f.tool('sort_favorites', { action: 'prepare', operationId: id, folderId: '10', strategy, ...(videoIds ? { videoIds } : {}) }); } while (result.status === 'preparing');
  return f.tool('sort_favorites', { action: 'preview', operationId: id });
}
async function finish(f, preview, undo = false) {
  for (let i = 0; i < 100; i++) {
    const result = undo ? await f.tool('undo', { operationId: preview.operationId }) : await f.tool('sort_favorites', { action: 'apply', operationId: preview.operationId, token: preview.token });
    if (['completed', 'reverted'].includes(result.status)) return result;
  }
  assert.fail('sort did not finish within bounded calls');
}
(async () => {
  const search = fixture();
  assert.equal((await search.tool('search_favorites', { folderId: '10', keyword: '视频 2' })).items[0].bvid, search.data[2].bvid);
  assert.equal((await search.tool('search_favorites', { folderId: '10', keyword: search.data[2].bvid })).items.length, 0);
  const account = { uid: '1', cookie: 'user=1', csrf: 'secret' }, contains = id => search.test().biliContains(search.ctx, account, '10', id);
  assert.equal(await contains('102'), true); assert.equal(await contains('999'), false);
  assert.equal(search.requests.filter(x => x.p.endsWith('/resource/ids')).length, 1, 'one compact list serves repeated checks in the same operation');
  await search.test().biliRequest(search.ctx, account, '/x/v3/fav/resource/deal', { rid: 102, type: 2, del_media_ids: 10 }, true);
  assert.equal(await contains('102'), false, 'writes invalidate the membership snapshot');
  search.invalid([{ id: 999, type: 2, bvid: 'BV9999999999' }]);
  assert.equal(await search.test().biliContains(search.ctx, account, '10', '999', true), true, 'invalid videos still have membership');
  assert.equal(await search.test().biliContains(search.ctx, { ...account, memberships: null }, '10', '100'), true);
  const fallback = fixture(); fallback.fail('/x/v3/fav/resource/ids', -404);
  assert.equal(await fallback.test().biliContains(fallback.ctx, { uid: '1', cookie: 'user=1' }, '10', '103'), true);
  assert.equal(fallback.requests.filter(x => x.p.endsWith('/resource/list')).length, 1);
  const malformed = fixture(); malformed.ctx.api.fetchJson = async () => ({ code: 0, data: {} });
  await assert.rejects(malformed.test().biliContains(malformed.ctx, account, '10', '1', true), /清单格式无效/);

  const sorted = fixture(151), original = sorted.data.map(item => item.id), plan = await prepare(sorted);
  assert.equal(sorted.posts.length, 0, 'planning and preview are local only');
  assert.equal(plan.items.length, 20); assert.equal(plan.plannedMoves, 150);
  await assert.rejects(sorted.tool('sort_favorites', { action: 'apply', operationId: plan.operationId, token: 'wrong' }), /预览/);
  await assert.rejects(sorted.tool('sort_favorites', { action: 'prepare', operationId: plan.operationId, folderId: '10', strategy: 'title' }), /另一份/);
  await finish(sorted, plan);
  assert.deepEqual(sorted.items().map(item => item.id), [...original].reverse());
  assert.equal(sorted.posts.length, 2, 'bounded batches with post-write verification');
  const done = sorted.posts.length; await finish(sorted, plan); assert.equal(sorted.posts.length, done);
  sorted.restart(); await finish(sorted, plan, true);
  assert.deepEqual(sorted.items().map(item => item.id), original); assert.equal(sorted.posts.length, 4);
  await finish(sorted, plan, true); assert.equal(sorted.posts.length, 4);
  assert.ok(sorted.logs.some(item => item.undo?.input.operationId === plan.operationId));
  assert.ok(!sorted.logs.at(-1).undo); assert.equal(sorted.state.get('bili:1:sort-active:10'), null);

  const moved = fixture(), custom = await prepare(moved, 'priority', 'custom', [moved.data[4].bvid, moved.data[1].bvid]);
  await finish(moved, custom); assert.deepEqual(moved.items().map(item => item.id), [104, 101, 100, 102, 103]);
  const stale = fixture(), stalePlan = await prepare(stale); stale.setItems([...stale.data].reverse());
  await assert.rejects(finish(stale, stalePlan), /顺序已变化/); assert.equal(stale.posts.length, 0);
  const later = fixture(), laterPlan = await prepare(later); await finish(later, laterPlan);
  later.setItems([later.data[0], later.data[4], later.data[3], later.data[2], later.data[1]]);
  await assert.rejects(finish(later, laterPlan, true), /顺序已变化/); assert.equal(later.posts.length, 1, 'undo preserves later changes');

  const lost = fixture(), lostPlan = await prepare(lost); lost.fault('after');
  await assert.rejects(finish(lost, lostPlan), /network disconnected/); lost.restart();
  assert.equal((await finish(lost, lostPlan)).status, 'completed'); assert.equal(lost.posts.length, 1, 'lost receipt is verified without replay');
  const uncertain = fixture(), up = await prepare(uncertain); uncertain.fault('before');
  await assert.rejects(finish(uncertain, up), /network disconnected/);
  await assert.rejects(finish(uncertain, up), /结果不明/); assert.equal(uncertain.posts.length, 1);
  await assert.rejects(uncertain.tool('undo', { operationId: up.operationId }), /结果不明/);
  const second = await prepare(uncertain, 'second'); await assert.rejects(finish(uncertain, second), /尚未结束/); assert.equal(uncertain.posts.length, 1);
  const partial = fixture(), pp = await prepare(partial); partial.fault('partial');
  await assert.rejects(finish(partial, pp), /network disconnected/);
  await assert.rejects(finish(partial, pp), /结果不明/); assert.equal(partial.posts.length, 1);
  partial.setItems([...partial.data].reverse()); assert.equal((await finish(partial, pp)).status, 'completed', 'late completed request can reconcile');

  // Independently execute generated moves for a collection of permutations.
  const algorithm = fixture().test().biliSortMoves;
  function permutations(list) { return !list.length ? [[]] : list.flatMap((item, i) => permutations(list.filter((_, j) => j !== i)).map(rest => [item, ...rest])); }
  const origin = ['1:2', '2:2', '3:2', '4:2', '5:2'];
  for (const target of permutations(origin)) {
    const result = algorithm(origin, target, 100), values = [...origin];
    for (const packed of result.operations) {
      const [ref, rt, id, type] = packed.split(':'), key = `${id}:${type}`;
      values.splice(values.indexOf(key), 1); values.splice(ref === '0' ? 0 : values.indexOf(`${ref}:${rt}`) + 1, 0, key);
    }
    assert.deepEqual(values, target); assert.deepEqual(Array.from(result.after), target);
  }
  assert.equal(algorithm(['1:2', '2:2', '3:2'], ['2:2', '3:2', '1:2']).total, 1, 'rotation requires only one move');

  const slow = fixture(201), slowPlan = await prepare(slow);
  let slowResult;
  for (let i = 0; i < 40; i++) {
    slow.tick(75000); // Longer total duration than the partial-read idle timeout.
    slowResult = await slow.tool('sort_favorites', { action: 'apply', operationId: slowPlan.operationId, token: slowPlan.token });
    if (slowResult.status === 'completed') break;
  }
  assert.equal(slowResult.status, 'completed', 'continuous pagination progresses even when total elapsed time exceeds two minutes');
  const unchanged = fixture(), noOp = await prepare(unchanged, 'unchanged', 'duration_asc');
  await finish(unchanged, noOp); assert.equal(unchanged.posts.length, 0);
  const missing = fixture(); missing.data[0].duration = 0;
  await assert.rejects(prepare(missing, 'missing', 'duration_asc'), /缺少排序/); assert.equal(missing.posts.length, 0);

  for (const code of [-352, -412, '网站请求失败：HTTP 412', 'HTTP 403']) {
    const risk = fixture(); risk.fail('/x/v3/fav/folder/created/list-all', code);
    await assert.rejects(risk.tool('folders')); const issued = risk.requests.length; risk.restart(); risk.fail('', 0);
    await assert.rejects(risk.tool('folders'), /暂停已保存/); assert.equal(risk.requests.length, issued, 'restart cannot bypass risk pause');
    assert.equal((await risk.tool('network_status')).status, 'paused'); assert.equal(risk.requests.length, issued);
    await assert.rejects(risk.tool('network_resume'), /暂停已保存/); assert.equal(risk.requests.length, issued);
    risk.tick(1800000); await assert.rejects(risk.tool('folders'), /network_resume/);
    assert.equal((await risk.tool('network_resume')).status, 'ready'); assert.equal(risk.requests.length, issued + 1);
    assert.equal((await risk.tool('folders')).folders.length, 1);
  }
  const limited = fixture(); limited.fail('/x/v3/fav/folder/created/list-all', -509);
  await assert.rejects(limited.tool('folders')); limited.restart(); limited.fail('', 0);
  await assert.rejects(limited.tool('folders'), /暂停状态/); limited.tick(300000);
  assert.equal((await limited.tool('folders')).folders.length, 1);
  const rejected = fixture(), rejectedPlan = await prepare(rejected);
  rejected.fail('/x/v3/fav/resource/sort', -352);
  await assert.rejects(finish(rejected, rejectedPlan));
  assert.equal((await rejected.tool('network_status')).status, 'paused');
  assert.equal(rejected.state.get('bili:1:operation:sort-1').pending, undefined, 'explicit API rejection is not an uncertain write');
  rejected.fail('', 0); rejected.tick(1800000); await rejected.tool('network_resume');
  assert.equal((await finish(rejected, rejectedPlan)).status, 'completed');
  assert.equal(rejected.posts.length, 1);
  const auth = fixture(); auth.fail('/x/web-interface/nav', -101); await assert.rejects(auth.tool('folders'));
  auth.fail('', 0); auth.tick(86400000); await assert.rejects(auth.tool('folders'), /登录已失效/);
  assert.equal((await auth.tool('network_resume')).status, 'ready');
  const noFallback = fixture(); noFallback.fail('/x/v3/fav/resource/ids', -352);
  await assert.rejects(noFallback.test().biliContains(noFallback.ctx, { uid: '1', cookie: 'user=1' }, '10', '100'));
  assert.equal(noFallback.requests.filter(x => x.p.endsWith('/resource/list')).length, 0, 'risk never triggers another endpoint');
  const forbidden = fixture(); forbidden.ctx.principal.messageType = 'group';
  await assert.rejects(forbidden.tool('network_resume'), /主人私聊/);
  await assert.rejects(forbidden.tool('sort_favorites', { action: 'prepare', operationId: 'nope', folderId: '10', strategy: 'reverse' }), /主人私聊/);
  assert.equal(forbidden.requests.length, 0);
  console.log('Favorites: keyword search versus exact IDs, compact lookup/cache invalidation, bounded sort/preview/undo, conflict and uncertain-write recovery, persistent risk/auth/rate gates passed (mock network)');
})().catch(error => { console.error(error); process.exitCode = 1; });
