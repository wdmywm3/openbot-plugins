"use strict";
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sorted = values => [...new Set(values || [])].sort();
function identity(record) {
  return JSON.stringify(stable({ content: String(record.content || "").normalize("NFKC").trim(), kind: record.kind || "fact", subtype: record.subtype || null,
    subjectRefs: sorted(record.subjectRefs), conditions: sorted(record.conditions), validFrom: record.validFrom || null, validTo: record.validTo || null,
    progress: record.progress || null, fact: record.attributes?.fact || null, nextReviewAt: record.attributes?.nextReviewAt || null,
    reviewIntervalMinutes: record.attributes?.reviewIntervalMinutes || null, reviewOnChange: record.attributes?.reviewOnChange === true,
    watchActivityId: record.attributes?.watchActivityId || null }));
}
function mergeSources(left = [], right = []) {
  return [...new Map([...left, ...right].map(ref => [JSON.stringify(stable(ref)), ref])).values()].slice(0, 100);
}
function candidates(existing, operations, before, reserved = new Set()) {
  const known = new Map(existing.map(item => [identity(item), item])), proposed = new Map();
  return record => {
    const key = identity(record), pending = proposed.get(key), old = known.get(key);
    if (old && reserved.has(old.id)) return;
    if (pending) {
      pending.sources = mergeSources(pending.sources, record.sources);
      if (record.category) pending.category = record.category;
      if (record.attributes?.profile) pending.attributes = { ...old?.attributes, ...pending.attributes, profile: record.attributes.profile };
      return;
    }
    if (old) {
      const sources = mergeSources(old.sources, record.sources);
      const profileChanged = record.attributes?.profile && JSON.stringify(record.attributes.profile) !== JSON.stringify(old.attributes?.profile);
      const categoryChanged = record.category && record.category !== old.category;
      if (!categoryChanged && !profileChanged && JSON.stringify(stable(sources)) === JSON.stringify(stable(old.sources || []))) return;
      const patch = { sources, ...(categoryChanged ? { category: record.category } : {}), ...(profileChanged ? { attributes: { ...old.attributes, profile: record.attributes.profile } } : {}) }; proposed.set(key, patch);
      operations.push({ action: "revise", id: old.id, expectedRevision: old.revision, changeType: "edit", patch }); before.push({ id: old.id, revision: old.revision });
    } else { proposed.set(key, record); operations.push({ action: "create", record }); before.push(null); }
  };
}
module.exports = { identity, candidates };
