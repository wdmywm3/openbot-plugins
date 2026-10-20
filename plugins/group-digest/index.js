module.exports.handle = async function handle({ args, config = {} }) {
  const focus = String(args || config.defaultFocus || "").trim();
  return {
    agent: {
      content: focus ? `请总结近期群聊，重点关注：${focus}` : "请总结近期群聊。",
      prompt: "输出适合直接发回 QQ 群的简洁中文，不展示思维过程。",
      replyToSource: true
    }
  };
};
