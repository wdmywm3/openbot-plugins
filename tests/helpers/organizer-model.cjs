"use strict";
// Drive the real organizer tools with a deterministic proposal provider. Other
// agent work (matter follow-ups) retains the fixture's own implementation.
function organizerModel(ctx) {
  const original = ctx.api.runAgent;
  ctx.api.runAgent = async request => {
    if (!request.continuation) return original(request);
    const { current, get } = require("../../plugins/memory/unified-state.cjs");
    const { storage, scope } = current({ ...ctx, input: { chatId: request.chatId } });
    const batch = get(storage, `plus:organizer-batch:${scope.chatId}`);
    const input = JSON.parse(request.continuation.content);
    const call = value => require("../../plugins/memory/unified-organizer.cjs").tool(
      { ...ctx, input: { ...value, ticket: input.ticket } }, storage, scope);
    const response = await ctx.api.generate({ usageCategory: "memory", systemPrompt: request.prompt,
      prompt: JSON.stringify({ context: input.context, messages: batch.materials, existing: batch.existing }) });
    const result = JSON.parse(response.text);
    if (["facts", "records", "revisions", "updates", "invalidations"].some(key => result[key]?.length)) {
      await call({ operation: "search", query: "本批对象和事项" });
      for (const item of [...result.revisions || [], ...result.updates || [], ...result.invalidations || []]) {
        await call({ operation: "read", id: item.supersedes?.id || item.id });
      }
    }
    await call({ operation: "commit", result });
    return { taskId: request.taskId, status: "completed", summary: "已提交本批" };
  };
  return ctx;
}
module.exports = { organizerModel };
