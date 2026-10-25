// Bundled into each plugin at build time; no host or cross-plugin filesystem dependency.
function createActivityLearning(database) {
  const clean = (value, max = 1000) => String(value || "").trim().slice(0, max);
  const hash = value => { let a = 2166136261, b = 5381; for (const c of value) { a = Math.imul(a ^ c.codePointAt(0), 16777619); b = Math.imul(b, 33) ^ c.codePointAt(0); } return (a >>> 0).toString(16) + (b >>> 0).toString(16); };
  const words = value => {
    const result = new Set(), text = clean(value, 8000).toLowerCase();
    for (const token of text.match(/[a-z0-9]{2,}|[\p{Script=Han}]+/gu) || []) {
      if (/^[\p{Script=Han}]+$/u.test(token)) for (let i = 0; i < token.length - 1; i++) result.add(token.slice(i, i + 2));
      else result.add(token);
    }
    return result;
  };
  const overlap = (query, text) => { const found = words(text); return [...query].filter(word => found.has(word)).length; };
  async function read(id) {
    if (!/^lesson-[a-f0-9]{2,16}$/.test(String(id))) throw new Error("经验编号无效");
    return (await database({ action: "get", collection: "lessons", key: id })).record;
  }
  async function write(input, sources, { trusted = false } = {}) {
    const topic = clean(input.topic, 160), understanding = clean(input.understanding, 1200), application = clean(input.application, 800);
    if (!topic || !understanding || !application) throw new Error("经验需要主题、认识和适用条件");
    if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 3) throw new Error("经验需要1至3条已有来源依据");
    const evidence = input.evidence.map(item => {
      const source = sources.find(source => source.id === item.sourceId), quote = clean(item.quote, 600);
      if (!source || !quote || !String(source.text || "").includes(quote)) throw new Error("经验引文必须来自本次实际读取的记录");
      return { sourceId: source.id, quote, kind: source.kind, ...(source.url ? { url: source.url } : {}),
        ...(source.activityId ? { activityId: source.activityId, deviceId: source.deviceId } : {}) };
    });
    const id = input.id || `lesson-${hash(topic.toLowerCase())}`, previous = await read(id);
    if (previous?.value.status === "retracted" && !trusted) throw new Error("这条经验已撤回，不自动恢复");
    const body = { topic, understanding, application, uncertainty: clean(input.uncertainty, 600), evidence, status: "active" };
    if (previous?.value.status === "active" && JSON.stringify(body) === JSON.stringify(previous.value.body)) return { id, revision: previous.revision, unchanged: true };
    if (previous && input.expectedRevision !== previous.revision) throw new Error("修订经验前请读取当前版本");
    if (!previous && input.expectedRevision != null && input.expectedRevision !== 0) throw new Error("经验版本已变化");
    const value = { ...body, body, previous: previous?.value.understanding || "", changedAt: Date.now(),
      sourceIds: evidence.map(item => item.sourceId), revisionNumber: (previous?.value.revisionNumber || 0) + 1 };
    const operations = [];
    if (previous) operations.push({ action: "put", collection: "lesson_revisions", key: `${id}:${previous.revision}`, expectedRevision: 0, value: previous.value });
    operations.push({ action: "put", collection: "lessons", key: id, expectedRevision: previous?.revision || 0, value });
    const saved = await database({ action: "batch", operations });
    return { id, revision: saved.results.at(-1).record.revision };
  }
  async function remember(items, sources) {
    const saved = [], issues = [];
    for (const item of (Array.isArray(items) ? items : []).slice(0, 3)) {
      try { saved.push(await write(item, sources)); } catch (error) { issues.push(clean(error.message, 200)); }
    }
    return { saved, issues };
  }
  async function retrieve(query, sourceIds = [], limit = 6) {
    const tokens = words(query), scored = []; let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await database({ action: "query", collection: "lessons", limit: 50, ...(cursor ? { cursor } : {}) });
      for (const row of result.records) {
        if (row.value.status !== "active") continue;
        const value = row.value, relevance = overlap(tokens, value.topic) * 3 + overlap(tokens, value.application) * 2 + overlap(tokens, value.understanding)
          + (value.sourceIds || []).filter(id => sourceIds.includes(id)).length * 6;
        if (tokens.size && !relevance) continue;
        scored.push({ id: row.key, revision: row.revision, topic: value.topic, understanding: value.understanding,
          application: value.application, uncertainty: value.uncertainty, evidence: value.evidence, relevance, at: row.updatedAt || value.changedAt });
      }
      cursor = result.nextCursor; if (!cursor) break;
    }
    return scored.sort((a, b) => b.relevance - a.relevance || b.at - a.at).slice(0, Math.min(10, limit));
  }
  async function retract(id, expectedRevision) {
    const row = await read(id);
    if (!row || row.revision !== expectedRevision) throw new Error("经验版本已变化，请重新读取");
    if (row.value.status === "retracted") return { id, retracted: true };
    await database({ action: "batch", operations: [
      { action: "put", collection: "lesson_revisions", key: `${id}:${row.revision}`, expectedRevision: 0, value: row.value },
      { action: "put", collection: "lessons", key: id, expectedRevision, value: { ...row.value, status: "retracted", changedAt: Date.now() } },
    ] });
    return { id, retracted: true };
  }
  async function questions(items, sources) {
    for (const item of (Array.isArray(items) ? items : []).slice(0, 3)) {
      const source = sources.find(source => source.id === item.sourceId), question = clean(item.question, 600);
      if (!source || !question) continue;
      const id = `question-${hash(source.id + question)}`, prior = await database({ action: "get", collection: "questions", key: id });
      if (prior.record) continue;
      await database({ action: "put", collection: "questions", key: id, expectedRevision: 0,
        value: { question, sourceId: source.id, url: source.url || "", activityId: source.activityId || "", deviceId: source.deviceId || "",
          status: "pending", createdAt: Date.now() } });
    }
  }
  async function pending(limit = 8) {
    const rows = await database({ action: "query", collection: "questions", where: { status: "pending" }, limit });
    return rows.records.map(row => ({ id: row.key, revision: row.revision, ...row.value }));
  }
  async function resolve(id, answer, source) {
    const prior = await database({ action: "get", collection: "questions", key: id });
    if (!prior.record || prior.record.value.status !== "pending") return;
    await database({ action: "put", collection: "questions", key: id, expectedRevision: prior.record.revision,
      value: { ...prior.record.value, status: "resolved", answer: clean(answer, 1200), resolvedSource: source, resolvedAt: Date.now() } });
  }
  async function tool(input, canWrite, sourceLoader) {
    const action = input.action || "query";
    if (action === "query") return { lessons: await retrieve(input.query || "") };
    if (action === "get") return { record: await read(input.id) };
    if (action === "questions") return { questions: await pending() };
    if (action === "history") { await read(input.id); return database({ action: "query", collection: "lesson_revisions", prefix: `${input.id}:`, limit: 10, cursor: input.cursor }); }
    if (!canWrite) throw new Error("只有主人可以修订或撤回经验");
    if (action === "retract") return retract(input.id, input.expectedRevision);
    if (action === "revise") {
      const sources = [];
      for (const item of (input.evidence || []).slice(0, 3)) { const source = await sourceLoader(item.sourceId); if (source) sources.push(source); }
      return write(input, sources);
    }
    throw new Error("未知经验操作");
  }
  return { read, write, remember, retrieve, retract, questions, pending, resolve, tool,
    history: (id, cursor) => database({ action: "query", collection: "lesson_revisions", prefix: `${id}:`, limit: 10, cursor }) };
}
