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
const PROFILE_STANDARD = `人物画像通过 facts 的 profileSection 分类：identity（本人明确性别、身份、职业或技能）、habits（长期习惯）、interests（持续兴趣）、communication（交流与称呼偏好）、boundaries（明确禁忌与边界）、self_description（本人明确的自我描述）。
稳定的个人事实和偏好必须归入对应画像分类；事件经过、一次性行为、项目进展、设备参数、未注明平台的账号或临时状态不写入画像，也不跨聊天自动拼接同一账号的资料。
自述类画像用 subjectId 存账号，content 写一条能独立理解的事实（不把姓名和“本人自述”写进正文），evidence 逐字摘录原话。例：“我到现在不吃鱼”写 content="不吃鱼"、fact.facet="饮食习惯"；“我不喜欢吃鱼”写“不喜欢吃鱼”、facet="饮食偏好"。区分行为、喜恶、过敏和猜测，保留条件、否定、程度与时效。单次要求、玩笑、反问、引用他人的话不升级为长期画像；bot 发言不单独支撑用户事实或画像。
每条新增 facts 必须给 retention:{basis,reason}：basis 仅取 explicit（明确要求记住）、boundary（持续边界）、stable（稳定事实或偏好）、ongoing（bot 持续协助事项所需事实）、ephemeral（一次性状态，不保存）。reason 须说明在什么后续情境如何改变回答或决定，不能只写“有用”“供参考”或“有原话依据”；没有明确后续用途就省略。
“下载了 RVC 但还没测试”“朋友中转站也许会加 Gemini”等随口进度通常不提取；仅当 bot 正在持续协助同一部署时，必要条件才可作候选。新增前核对已有对象与属性，语义相同不另建一条，明确纠正或变化则修订原记录并保留历史。`;
const STANDARD = `${PROFILE_STANDARD}
聊天印象单独提交 impressions，说明具体做法给人的感觉并保留多次互动原话；常用表达按 usages 处理。`;

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

module.exports = { STANDARD, PROFILE_STANDARD, USAGE_PROMPT, SECTIONS, profileAttributes, sectionForSelfFact };
