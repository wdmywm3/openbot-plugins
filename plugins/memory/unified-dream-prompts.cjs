"use strict";
const { DREAM_PROMPT, FACT_PROMPT, REVISION_PROMPT } = require("./lib/features/channels/channel-dream-analysis.cjs");
const GROUP = `这是群聊，按 senderId 区分每个发言人。昵称、群名片、称呼相似不代表同一人；“我”属于原发言人，“你/他”须有实际引用或明确指向。不能把 A 的话记到 B 身上，也不能把一个成员的意见记为全群共识。
保留以后确有用途的群内约定、明确决定、重要共同经历及有适用时间的事实。普通插话、复读、表情、战绩、口嗨、暂时邀约无需逐条成文。不同成员交错讨论的事项按原消息分别索引；没有达成决定就保持话题 open。
style 必须为 null，records 不包含 matter。facts 中的 preference 必须明确 subjectId 并有该成员本人的原话依据。群成员身份由已有身份资料辅助确认，整理不能自创身份或将传闻升级为身份结论。群内的公开决定不等于授权主动私聊或创建个人跟进。`;
const PRIVATE = `这是当前对话方与 bot 的私聊。所有偏好和事项都限定在这个对话方及明确涉及的对象，不外推到其他用户或其他聊天。context.relationship 仅描述宿主最近确认的关系；unknown 时不猜测对方是主人，任何关系都不授予执行权限。
本人明确且持续有效的偏好放在 facts 中，kind=preference，subjectId 使用 context.peerId；临时需求保留适用条件，不能变成永久偏好。明确的交流方式反馈才进入 style；闲聊、反问、讽刺和引用别人的喜好不改变对话方的偏好。
一段私聊可以切换多个话题。只为确有后续用途的未完事项保存记录；明确说想做一件事不等于已经委派 bot 执行，bot 答应了也不等于工具已成功。`;
const OWNER = `宿主最近一次确认此私聊对话方为主人。将私聊视为连续讨论串，同时区分其中并行的事项：每件事保留目标、当前进度、条件、依赖、截止时间和明确的下一步，不把换话题后的消息自动并入上一件事。
优先保留主人明确交办、正在推进、等待反馈或尚未解决的重要问题。闲谈愿望不自动变为承诺或待办；只有明确要求复查、持续关注或按变化继续检查时才设置复查策略。事项归属于提出它的对话方，不能用主人的称谓绕过宿主权限或将私聊内容共享到群聊。
“已交给分身”“模型回答结束”“任务自述完成”仅说明相应阶段。完成须有明确的本人确认或可核查结果；结果不完整就保留 waiting 或原进度，并写清已知部分。取消后不擅自恢复，多个目标都可能对应“那个/继续/取消”时不替用户选一个。`;
const MATTERS = `暂不保存 experience 或第一人称回忆；仅私聊可在 records 保存 matter，subtype 为 goal（明确目标）、question（未解决问题）或 followup（明确约定的只读复查）。bot 回复只作理解上下文，不能单独证明本人执行或事项完成。
事项正文简明保留对象、目标、条件和已有进展。progress 只可为 active（尚在推进）、waiting（等待依赖或答复）、completed（已完成）、canceled（明确取消）、closed（已结束或不再跟进）。不要因为聊天结束、模型回合结束或没有新消息而宣布完成。
已有事项有变化时使用 updates，id 和 revision 必须来自 existing，更新同一条记录，不再生成同一事项的新 records。保留未变化的条件、进度和设置；仅写本次有证据的变化。completed/canceled/closed 的事项只有本人明确重新开启时才附 reopen:true；否则保持终止状态。
复查字段只用于 subtype=followup：nextReviewAt 为首次复查的毫秒时间；reviewIntervalMinutes 为明确要求的重复间隔（5–43200 分钟）；reviewOnChange:true 仅用于明确要求有新资料后再查；watchActivityId 仅能使用已提供且可读取的真实工作事项编号。默认只查一次，不因一个事项存在就安排重复检查。
截止日期不是复查授权，也不是 nextReviewAt。相对日期按原消息 at（发送时间）与 context.timeZone 计算，不能按处理旧消息的当前时间随意后移；无法确定时间或意图时保留问题，不编造日期。纯定时提醒或实际外部操作须由相应工具确认，写入记忆不表示已经安排提醒或执行。
事项改期须在 updates 中同时给出新的 nextReviewAt；未给出的复查字段保留旧值。nextReviewAt:null 表示停止全部自动复查并清除重复和订阅设置；reviewIntervalMinutes:null 表示停止周期，reviewOnChange:false 表示停止按新消息复查，watchActivityId:null 表示解除订阅。终止进度自动停止复查；重新开启不会恢复旧的自动设置，须有新授权。
复查设置的新建、变更、清除与重新开启，需要当前私聊对话方的原消息依据；可以提供 reviewEvidence:[{id,quote}] 指明对应请求。它不能只来自 bot 的回复、任务报告或平台通知。普通进展更新不重复填写未变化的复查字段。
格式：records:[{kind:"matter",subtype:"goal|question|followup",content:"完整正文",progress:"active|waiting|completed|canceled|closed",evidence:[{id,quote}],relatedIds:["已查询的相关记忆编号"],nextReviewAt:可选时间或null,reviewIntervalMinutes:可选间隔或null,reviewOnChange:可选布尔值,watchActivityId:可选编号或null}]。
updates:[{id:"existing 中编号",revision:1,content:"更新后的完整正文",progress:"可省略，省略则保留",evidence:[{id,quote}],nextReviewAt:可选,reviewIntervalMinutes:可选,reviewOnChange:可选,watchActivityId:可选,reopen:仅明确重开时为true}]。
没有值得保留的内容就返回空数组。不要制造待办、通知、人格要求或新记忆类型。`;
function build(ctx, storage, scope) {
  const context = { ...require("./unified-peer.cjs").context(ctx, storage, scope), now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  return { context, system: [DREAM_PROMPT, FACT_PROMPT, REVISION_PROMPT, context.chatType === "group" ? GROUP : PRIVATE,
    ...(context.relationship === "owner" ? [OWNER] : []), MATTERS,
    require("./unified-profile-policy.cjs").STANDARD].join("\n\n") };
}
module.exports = { build };
