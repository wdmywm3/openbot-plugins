"use strict";
const { createHash } = require("node:crypto");
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sorted = values => [...new Set(values || [])].sort();
const normalized = value => String(value || "").normalize("NFKC").trim().replace(/\s+/gu, " ");
function factIdentity(record) {
  const fact = record.attributes?.fact;
  if (!fact || typeof fact !== "object" || !["subjectId", "facet", "value"].every(key => typeof fact[key] === "string" && fact[key].trim())) return null;
  if (fact.contentHash && fact.contentHash !== createHash("sha256").update(String(record.content || "")).digest("hex")) return null;
  // contentHash proves which prose the projection accompanied; it is not part
  // of the fact itself. A paraphrase must keep the same fact identity.
  return { subjectId: normalized(fact.subjectId), facet: normalized(fact.facet), value: normalized(fact.value),
    conditions: sorted((fact.conditions || []).map(normalized)), assertion: fact.assertion || "reported" };
}
function identity(record) {
  const fact = factIdentity(record);
  return JSON.stringify(stable({ ...(fact ? {} : { content: normalized(record.content), ...(record.nextOffset != null ? { truncated: [record.id, record.revision] } : {}) }), kind: record.kind || "fact", subtype: record.subtype || null,
    subjectRefs: sorted(record.subjectRefs), conditions: sorted(record.conditions), validFrom: record.validFrom || null, validTo: record.validTo || null,
    progress: record.progress || null, fact, nextReviewAt: record.attributes?.nextReviewAt || null,
    reviewIntervalMinutes: record.attributes?.reviewIntervalMinutes || null, reviewOnChange: record.attributes?.reviewOnChange === true,
    watchActivityId: record.attributes?.watchActivityId || null }));
}
function mergeSources(left = [], right = []) {
  return [...new Map([...left, ...right].map(ref => [JSON.stringify(stable(ref)), ref])).values()].slice(0, 100);
}
function mergeRetention(old, record) {
  const prior = old.attributes?.retention, incoming = record.attributes?.retention;
  if (old.updatedBy && old.createdBy && old.updatedBy !== old.createdBy) {
    // Adding an automatic source must not erase the protection established by
    // a person's edit when the host updates updatedBy back to this plugin.
    return { ...prior, version: prior?.version || 1, protected: true,
      ...(prior?.reason ? {} : { reason: "保留用户手动修订的记忆" }) };
  }
  if (!incoming || prior?.protected && !incoming.protected) return prior;
  return { ...prior, ...incoming, observedAt: Math.max(prior?.observedAt || 0, incoming.observedAt || 0) };
}
function candidates(existing, operations, before, reserved = new Set()) {
  const known = new Map(), proposed = new Map();
  for (const item of existing) {
    const key = identity(item), previous = known.get(key);
    if (!previous || item.status === "active" && previous.status !== "active"
      || item.status === previous.status && (item.revision || 0) > (previous.revision || 0)) known.set(key, item);
  }
  return record => {
    const key = identity(record), pending = proposed.get(key), old = known.get(key);
    if (old && reserved.has(old.id)) return;
    if (pending) {
      pending.sources = mergeSources(pending.sources, record.sources);
      if (record.category) pending.category = record.category;
      const retention = mergeRetention({ attributes: { ...old?.attributes, ...pending.attributes } }, record);
      if (retention || record.attributes?.profile) pending.attributes = { ...old?.attributes, ...pending.attributes,
        ...(retention ? { retention } : {}), ...(record.attributes?.profile ? { profile: record.attributes.profile } : {}) };
      if (record.status === "active" && (!old || old.status === "pending" || record.tier === "long_term" && old.tier !== "long_term")) {
        pending.status = "active"; pending.tier = old?.tier === "long_term" ? "long_term" : record.tier;
        pending.expiresAt = record.expiresAt ?? null;
      } else if (record.status === "pending" && pending.status !== "active" && (!old || old.status === "pending") && record.attributes?.retention?.version === 1) {
        pending.expiresAt = Math.max(old?.expiresAt || 0, pending.expiresAt || 0, record.expiresAt || 0) || null;
      }
      return;
    }
    if (old) {
      const sources = mergeSources(old.sources, record.sources);
      const profileChanged = record.attributes?.profile && JSON.stringify(record.attributes.profile) !== JSON.stringify(old.attributes?.profile);
      const categoryChanged = record.category && record.category !== old.category;
      const retention = mergeRetention(old, record), retentionChanged = JSON.stringify(stable(retention)) !== JSON.stringify(stable(old.attributes?.retention));
      const promote = record.status === "active" && (old.status === "pending" || record.tier === "long_term" && old.tier !== "long_term");
      const renew = old.status === "pending" && record.status === "pending" && record.attributes?.retention?.version === 1
        && record.expiresAt > (old.expiresAt || 0);
      if (!categoryChanged && !profileChanged && !retentionChanged && !promote && !renew && JSON.stringify(stable(sources)) === JSON.stringify(stable(old.sources || []))) return;
      const patch = { sources, ...(categoryChanged ? { category: record.category } : {}),
        ...(profileChanged || retentionChanged ? { attributes: { ...old.attributes, ...(retention ? { retention } : {}), ...(profileChanged ? { profile: record.attributes.profile } : {}) } } : {}),
        ...(promote ? { status: "active", tier: old.tier === "long_term" ? "long_term" : record.tier, expiresAt: record.expiresAt ?? null } : renew ? { expiresAt: record.expiresAt } : {}) }; proposed.set(key, patch);
      operations.push({ action: "revise", id: old.id, expectedRevision: old.revision, changeType: "edit", patch }); before.push({ id: old.id, revision: old.revision });
    } else { proposed.set(key, record); operations.push({ action: "create", record }); before.push(null); }
  };
}
module.exports = { identity, candidates, factIdentity };
