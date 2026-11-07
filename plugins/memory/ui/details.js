"use strict";
const api = window.openbotPlugin, $ = id => document.getElementById(id), input = api.getContext().input;
let before = 0, preview, busy = false;
const eventRows = new Map();
const call = (action, args = {}) => api.callAction('manage', { ...args, action, chatId: input.chatId, runId: input.runId });
async function task(work) {
  if (busy) return;
  busy = true; api.ui.setBusy(true); $("error").hidden = true;
  try { await work(); }
  catch (error) { $("error").hidden = false; $("error").textContent = error.message; }
  finally { busy = false; api.ui.setBusy(false); }
}
function eventRow(event) {
  const row = document.createElement('div'), text = document.createElement('pre');
  text.textContent = event.text || event.kind; row.append(text);
  if (event.nextOffset != null) {
    const more = document.createElement('button'); more.type = 'button'; more.textContent = '继续阅读';
    let offset = event.nextOffset;
    more.onclick = () => task(async () => {
      const result = await call('readRunEvent', { eventSeq: event.seq, offset });
      text.textContent += result.text || ''; offset = result.nextOffset;
      more.hidden = offset == null;
    });
    row.append(more);
  }
  return row;
}
async function events(older = false) {
  const result = await call('readRun', older ? { before } : {});
  if (!older) eventRows.clear();
  for (const event of result.events || []) if (!eventRows.has(event.seq)) eventRows.set(event.seq, eventRow(event));
  $("events").replaceChildren(...[...eventRows].sort((a, b) => a[0] - b[0]).map(([, row]) => row));
  before = result.nextBefore || 0; $("older").hidden = !result.hasMore;
  api.ui.setActions([{ id: 'close', label: '关闭' }, { id: 'preview', label: '预览回滚', variant: 'primary' }]);
}
api.ui.onAction(id => {
  if (id === 'close') { api.ui.requestClose(); return; }
  task(async () => {
    if (id === 'preview') {
      let offset = 0, combined;
      do {
        const page = await call('rollbackPreview', { offset, ...(combined?.previewSnapshot ? { previewSnapshot: combined.previewSnapshot } : {}) });
        if (combined && (page.token !== combined.token || page.previewSnapshot !== combined.previewSnapshot)) throw Error('回滚预览已变化，请重新预览');
        combined ||= { ...page, changes: [], conflicts: [] };
        combined.changes.push(...(page.changes || [])); combined.conflicts.push(...(page.conflicts || []));
        offset = page.nextOffset ?? null;
      } while (offset !== null);
      preview = combined; $("preview").hidden = false;
      const text = document.createElement('pre');
      text.textContent = [...(preview.conflicts || []), ...(preview.changes || []).map(change => change.beforeRevision ? `恢复版本 ${change.beforeRevision}` : '撤销本轮新增记忆')].join('\n') || '没有可以回滚的变更';
      $("preview").replaceChildren(text);
      api.ui.setActions([{ id: 'close', label: '关闭' }, ...(preview.token ? [{ id: 'rollback', label: '确认回滚', variant: 'danger' }] : [])]);
    } else if (id === 'rollback' && preview?.token) {
      if (!await api.ui.confirm({ title: '回滚整理', message: '按预览撤销本次整理对记忆的修改？', confirmLabel: '回滚', danger: true })) return;
      await call('rollback', { token: preview.token }); api.ui.close({ rolledBack: true });
    }
  });
});
$("older").onclick = () => task(() => events(true));
api.ui.setActions([{ id: 'close', label: '关闭' }]); task(() => events());
