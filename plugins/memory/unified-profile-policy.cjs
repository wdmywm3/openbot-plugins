"use strict";
const SECTIONS = ["identity", "habits", "interests", "communication", "boundaries", "self_description"];
const personalFacets = new Map(Object.entries({
  identity: ["性别", "职业", "身份", "职业技能"],
  habits: ["饮食偏好", "饮食习惯", "饮食禁忌", "饮食口味", "作息习惯", "长期习惯"],
  interests: ["长期爱好", "兴趣爱好", "长期兴趣"],
  communication: ["称呼偏好", "常用称呼", "交流偏好", "沟通偏好"],
  boundaries: ["交流边界", "互动边界", "称呼禁忌"], self_description: ["自我描述"],
}).flatMap(([section, names]) => names.map(name => [name, section])));
function sectionForSelfFact(fact) {
  return fact?.assertion === "self" && typeof fact.subjectId === "string" && fact.subjectId
    ? personalFacets.get(fact.facet?.trim()) : undefined;
}
const USAGE_PROMPT = `usages 最多 24 项，用来分析成员实际怎样表达。本人发送的表情图可给 {type:"sticker",messageId,index:消息中从0开始的图片序号,label:"亲眼看到的画面短名"}，只看到占位符时省略 label。本人使用的有辨识度的口头禅或文字表情可给 {type:"expression",messageId,expression:"实际使用的原文片段"}。即使本批只出现一次也可给例子，整理程序按原消息累计。忽略转发、复述、普通照片和泛用词。实际使用只进入 usages，不写成对表情、角色或作品的喜爱。本人另有明确表述的偏好照常保存。`;
const STANDARD = `只整理有原始依据的事实、偏好和事项，暂不生成第一人称回忆或 experience。
人物画像包含基础资料、偏好与习惯，也可以有基于实际交往的聊天印象。facts 使用 profileSection 标记 identity（本人明确性别、身份、职业或技能）、habits（长期习惯）、interests（持续兴趣）、communication（交流与称呼偏好）、boundaries（明确禁忌与边界）、self_description（本人明确的自我描述）。聊天印象单独提交 impressions，说明具体做法给人的感觉，并保留多次互动的原话。
稳定的个人事实和偏好必须归入对应画像分类；事件经过、一次性行为、项目进展仍是独立事实或事项，不因涉及某人就写入画像。同一账号在不同聊天中的画像各自维护，不能自动拼接另一群或私聊的资料。
自述类画像必须给出 subjectId、独立且完整的陈述和本人原话 evidence。可从同一个人在当前聊天的多次实际发送中归纳常用表情与惯用表达，作为观察到的用法单独保存。群聊按账号区分，昵称只用于展示。记录已有名字，不将“群成员+号码”当作日常称呼。不可由措辞、单次行为、bot 的推测、第三方评论推断人格、心理状态、MBTI 或身份。
保留对象、条件和时效；单次要求、玩笑、反问、引用他人的话不升级为长期画像。本人自述的性格也应写成“本人自述…”，不写成心理测评结论。bot 发言只用于理解用户的回答和引用，不能单独支撑用户事实、画像或完成状态。
新增前按对象和主题查已有记忆：相同内容补充证据，明确纠正或变化修订原记录；新旧值不同时保留生效时间与旧版本。证据不明确就不提取，不用置信分数替代来源。不把聊天话题、工具执行过程、向量召回和系统消息写成用户记忆。
事项必须有用户明确目标、问题或约定，保留进度与条件。记下事项不等于已经执行；临时关注与每日整理各自开关，不因保存画像或事项自动开启关注。没有新信息可提交空结果。
每条新增 facts 必须给 retention:{basis,reason}。basis 只能为 explicit（本人明确要求记住）、boundary（本人明确的持续边界）、stable（已确认的持续事实或偏好）、ongoing（bot确实参与的持续事项所需事实）、ephemeral（一次性状态）。reason 说明这条内容将在什么后续情境改变怎样的回答或决定，不能只写“有用”“供以后参考”或“有原话依据”。没有明确后续用途就省略该条；ephemeral 不保存。
本人明确记住、持续边界及有原话的稳定画像可直接生效；普通事实先作为待整理候选，之后统一审查。不能为了直接生效把设备状态、一次性进度、第三方传闻或单次兴趣硬归入画像。profileSection=identity 用于明确的身份与职责，设备参数、未注明平台的账号和临时项目状态都不属于身份。
“下载了RVC但还没测试”“现在串联TTS和RVC”“朋友的中转站也许会加Gemini”等随口进度通常不提取；当bot正在持续协助同一部署时，必要的设备条件可以给出具体后续用途并作为候选。单次要求不升级为长期偏好，也不从聊天主题或语气推断人格和兴趣。
新增前对每条候选分别核对已有对象、属性或事项；同一事实更新证据，同一事项更新进度，语义相同而措辞不同也不能另建一条。群聊、成员、条件和生效时间不同的事实保持各自范围。`;

function profileAttributes(item, sources, materials) {
  if (!item.profileSection) return {};
  if (!SECTIONS.includes(item.profileSection) || !["fact", "preference"].includes(item.kind)
    || typeof item.subjectId !== "string" || !item.subjectId) throw Error("画像需要明确对象和有效分类");
  if (!sources.length || sources.some(ref => {
    const source = materials.find(value => value.id === ref.id && value.version === ref.version);
    return !source || source.direction !== "in" || source.sender?.isBot
      || String(source.sender?.id || source.senderId || "") !== item.subjectId;
  })) throw Error("用户画像需要该成员本人的原话依据");
  return { profile: { section: item.profileSection, basis: "self_report" } };
}

module.exports = { STANDARD, USAGE_PROMPT, SECTIONS, profileAttributes, sectionForSelfFact };
