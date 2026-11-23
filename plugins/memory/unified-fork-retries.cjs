"use strict";
const { get, put, state, save } = require("./unified-state.cjs");
const LIMIT = 3, MAX_ROUNDS = 128;
const key = scope => `plus:fork-retries:${scope.chatId}`;
const identity = snapshot => snapshot.boundaryId || snapshot.id;
const rounds = (storage, scope) => get(storage, key(scope), []);
const ready = (storage, scope, id) => {
  const round = rounds(storage, scope).find(item => item.id === id || item.round === id);
  return !round || round.failures < LIMIT && !(round.retryAt > Date.now());
};
function write(storage, scope, round) {
  put(storage, key(scope), [...rounds(storage, scope).filter(item => item.id !== round.id), round].slice(-MAX_ROUNDS));
}
function failed(storage, scope, id, error) {
  const previous = rounds(storage, scope).find(item => item.id === id);
  const failures = Math.min(LIMIT, (previous?.failures || 0) + 1);
  const retryAt = failures < LIMIT ? Date.now() + 60000 * 2 ** failures : 0;
  write(storage, scope, { id, round: previous?.round || id, failures, retryAt });
  save(storage, scope, { forkFailureId: id, failures, retryAt, error: String(error.message || error) });
}
function clear(storage, scope, id) {
  put(storage, key(scope), rounds(storage, scope).filter(item => item.id !== id));
  if (state(storage, scope).forkFailureId === id) save(storage, scope, { forkFailureId: null, failures: 0, retryAt: 0, error: "" });
}
// A new boundary may retry an already prepared, idempotent write. Repeated delivery
// of the same boundary must never replenish its retry budget.
function reopenPrepared(storage, scope, id, boundaryId) {
  if (!id || !boundaryId) return;
  const previous = rounds(storage, scope).find(item => item.id === id);
  if (previous && previous.round !== boundaryId) write(storage, scope, { id, round: boundaryId, failures: 0, retryAt: 0 });
}
function reset(storage, scope) { put(storage, key(scope), []); }
module.exports = { LIMIT, key, identity, ready, failed, clear, reopenPrepared, reset };
