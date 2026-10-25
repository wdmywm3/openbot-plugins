'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { fixture } = require('./butler.cjs');
const code = fs.readFileSync(path.join(__dirname, '../plugins/bilibili-explorer/index.js'), 'utf8');
function setup() {
  const f = fixture(), events = [], writes = []; let nextId = 30, fault = '', failRestore = false;
  f.ctx.principal = { role: 'owner', messageType: 'private' };
  f.ctx.api.log = async e => events.push(structuredClone(e));
  const read = f.ctx.api.fetchJson;
  f.ctx.api.fetchJson = async (url, options = {}) => {
    const u = new URL(url), p = u.pathname, q = u.searchParams;
    if (p.endsWith('/folder/info')) {
      const id = q.get('media_id'), folder = f.folders.find(x => String(x.id) === id);
      return { code: 0, data: { ...folder, upper: { mid: 1 }, media_count: f.memberships.get(id)?.size, attr: folder?.privacy || 0 } };
    }
    if (p.endsWith('/resource/list')) {
      const all = [...(f.memberships.get(q.get('media_id')) || [])], start = (Number(q.get('pn')) - 1) * 20;
      return { code: 0, data: { has_more: all.length > start + 20, medias: all.slice(start, start + 20).map(id => ({ id, type: 2, bvid: 'BV1234567890', title: '视频' })) } };
    }
    if (options.method === 'POST') {
      const b = new URLSearchParams(options.body); writes.push({ p, b: Object.fromEntries(b) });
      if (fault === 'before') { fault = ''; throw Error('lost before response'); }
      let data = {};
      if (p.endsWith('/resource/deal')) {
        if (failRestore && b.get('add_media_ids') === '10') throw Error('source unavailable');
        if (b.has('add_media_ids')) f.memberships.get(b.get('add_media_ids')).add(b.get('rid'));
        if (b.has('del_media_ids')) f.memberships.get(b.get('del_media_ids')).delete(b.get('rid'));
      } else if (p.endsWith('/folder/add')) {
        data = { id: nextId++ }; f.folders.push({ ...data, title: b.get('title'), intro: b.get('intro'), privacy: Number(b.get('privacy')) }); f.memberships.set(String(data.id), new Set());
      } else if (p.endsWith('/folder/del')) {
        const id = b.get('media_ids'); f.folders.splice(f.folders.findIndex(x => String(x.id) === id), 1); f.memberships.delete(id);
      } else throw Error('unexpected write');
      if (fault === 'after') { fault = ''; throw Error('lost after response'); }
      return { code: 0, data };
    }
    return read(url, options);
  };
  const call = async (tool, input = {}) => {
    const sandbox = { module: { exports: {} } }; vm.runInNewContext(code, sandbox);
    return sandbox.module.exports.agentTool({ ...f.ctx, tool, input });
  };
  return { ...f, call, events, writes, fault: value => { fault = value; }, failRestore: value => { failRestore = value; } };
}
async function move(f) {
  f.ctx.config.organizeMode = 'move';
  const scan = await f.call('scan', { folderIds: ['10'], previewOnly: false });
  await f.call('classify', { scanId: scan.scanId });
  await f.call('apply', { planId: scan.scanId });
  return [...f.state.values()].find(x => x?.kind === 'move');
}
(async () => {
  const f = setup(), row = await move(f);
  assert.equal(f.memberships.get('10').has('100'), false);
  await f.call('undo', { operationId: row.id });
  assert.ok(f.memberships.get('10').has('100')); assert.equal(f.memberships.get('20').has('100'), false);
  const count = f.writes.length; await f.call('undo', { operationId: row.id }); assert.equal(f.writes.length, count);
  await f.call('apply', { planId: row.planId }); assert.equal(f.writes.length, count, 'old plans cannot replay an undone move');
  assert.ok(f.events.some(e => e.undo?.input?.operationId === row.id)); assert.ok(!f.events.at(-1).undo);
  await assert.rejects(f.call('undo', { operationId: row.id, accountUid: '2' }), /另一个大号/);

  const existing = setup(); existing.memberships.get('20').add('100'); const ex = await move(existing);
  await existing.call('undo', { operationId: ex.id }); assert.ok(existing.memberships.get('20').has('100'), 'pre-existing target is retained');

  const failed = setup(), fr = await move(failed); failed.failRestore(true);
  await assert.rejects(failed.call('undo', { operationId: fr.id }), /source unavailable/);
  assert.ok(failed.memberships.get('20').has('100'), 'failed source restore must not delete last copy');
  failed.failRestore(false); await assert.rejects(failed.call('undo', { operationId: fr.id }), /结果不明/);

  const lost = setup(); lost.memberships.get('20').add('100'); lost.fault('after');
  const remove = { operationId: 'remove-1', reason: '重复收藏', bvid: 'BV1234567890', folderId: '10' };
  await assert.rejects(lost.call('remove', remove), /lost after/);
  assert.equal((await lost.call('remove', remove)).status, 'completed'); assert.equal(lost.writes.length, 1);
  await lost.call('undo', { operationId: 'remove-1' }); assert.ok(lost.memberships.get('10').has('100'));

  const unknown = setup(); unknown.fault('before'); await assert.rejects(unknown.call('remove', remove), /lost before/);
  await assert.rejects(unknown.call('undo', { operationId: 'remove-1' }), /结果不明/);
  assert.equal(unknown.writes.length, 1);

  const folders = setup();
  for (let i = 101; i < 124; i++) folders.memberships.get('10').add(String(i));
  const deleted = await folders.call('delete_folder', { operationId: 'del-folder', folderId: '10', reason: '合并空闲分类' });
  assert.equal(deleted.status, 'completed'); assert.equal(deleted.videos, 24);
  let result; do { result = await folders.call('undo', { operationId: 'del-folder' }); } while (result.status === 'restoring');
  assert.equal(result.status, 'reverted'); assert.notEqual(result.folderId, '10'); assert.equal(folders.memberships.get(result.folderId).size, 24);
  const created = await folders.call('create_folder', { operationId: 'create-1', title: '新的分类', reason: '用户要求' });
  folders.memberships.get(created.folderId).add('999');
  await assert.rejects(folders.call('undo', { operationId: 'create-1' }), /已有内容/);

  const protect = setup(); protect.ctx.config.backupEnabled = true;
  await assert.rejects(protect.call('remove', remove), /备份/); assert.equal(protect.writes.length, 0);
  console.log('Recovery: move/remove undo, original targets, idempotency, uncertain writes, restore ordering, folder snapshots/rebuild, changed folders, backup gate passed (fixtures)');
})().catch(e => { console.error(e); process.exitCode = 1; });
