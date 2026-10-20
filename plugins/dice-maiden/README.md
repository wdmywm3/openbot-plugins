# 骰娘

OpenBot 的内置骰娘 JS 插件。它设置 `responseMode: "direct"`，计算和回复都在受限 VM 中完成，不会调用 Agent；申请 `reply`、`state` 和仅供暗骰私聊结果使用的 `napcat:send_private_msg`，不访问本机文件或网络。

## 命令

插件命令同时接受 `/`、`.`、`!` 和 `。` 前缀；全角 `／`、`．`、`！` 也会规范化为对应的半角前缀。

| 命令 | 示例 | 说明 |
|---|---|---|
| `roll`、`r`、`rd`、`d`、`掷骰` | `.d50`、`.rd50`、`.rd 50`、`/r2d6+1 攻击` | 通用骰式；`dN`、`rdN` 以及 `rd N` 都表示投掷 N 面骰，省略骰式时使用本会话默认骰 |
| `ra`、`rc`、`检定` | `.ra 侦查 60`、`.ra b1 侦查` | CoC 7 版检定；可从当前群角色卡读取技能值 |
| `rh`、`rhd`、`rdh`、`暗骰` | `.rh 1d100 潜行` | 群聊中把结果私聊发送给掷骰者，只在群内确认已发送 |
| `rav`、`rcv`、`对抗检定` | `.rav 侦查 60 潜行 45` | 执行双方 CoC 对抗检定 |
| `coc` | `/coc 60 b1` | 兼容旧版百分骰检定 |
| `st` | `.st 侦查 60 SAN 70` | 查看、更新或清空当前用户在当前群的角色卡 |
| `sc` | `.sc 1/1d6 70`、`.sc0/1d6 70` | 理智检定并更新角色卡 SAN |
| `en` | `.en 侦查` | 技能成长检定并更新角色卡 |
| `ti`、`li` | `.ti` | 抽取临时或总结性疯狂症状 |
| `cocchar`、`coc7` | `.cocchar 2`、`.cocchar2` | 生成 CoC 7 版角色属性 |
| `d20` | `.d20`、`.d20 adv +3`、`/d20adv+3`、`/d20+3` | 基础、优势或劣势 D20 检定；基础结果不再显示多余的“普通”和“取 x = x” |
| `set`、`dset`、`setdice` | `.set 20`、`.set4d6`、`.set reset` | 设置当前群或私聊的默认骰式 |
| `dicestats` | `.dicestats` | 查看当前群或私聊的统计 |
| `dicehelp` | `.dicehelp` | 查看帮助 |

机器人插件页可以配置默认骰式、骰子数量和面数上限、明细、Reply 引用及统计。按群聊配置会覆盖机器人默认值，因此不同群可以使用不同默认骰式。

## 骰式格式

- `d20`、`3d6`、`5d`、`d`：骰子数量或面数可省略，缺省面数取本会话默认骰。
- `+ - * / ^`、`× x ÷` 和括号：按标准优先级做整数计算，表达式中可以包含空格。
- `4d6k3`、`4d6q1`、`4d6kh3`、`4d6kl1`：保留最高或最低的若干颗骰子。
- `3#d20`：重复计算三次；重复次数与 `3d20` 的骰子数量含义不同。
- `b`、`b3`、`p`、`p3`：CoC 百分骰的奖励骰和惩罚骰；紧凑形式 `.rb3`、`.rp3` 同样可用。
- 原因可以放在表达式后，也可以写成 `.r 攻击 1d20+3`；冒号可以作为原因与表达式的分隔符。

`.d50`、`.rd50`、`.rd 50` 和 `.roll 50` 都会投掷 `1d50`。`.rd20 1` 的含义是投掷 `1d20`，原因是 `1`，不是投掷一次或固定得到 20。已有的 `.rd 2d6+1` 空格格式继续兼容；`.r 50` 则按主流骰娘约定保留为整数计算，并显示为“计算结果：50”。

## 插件格式

插件目录由 `plugin.json`、`index.js` 和可选的 `README.md` 组成。`plugin.json` 声明命令、权限和配置 schema；`index.js` 导出异步 `handle(ctx)`。可用上下文：

```js
module.exports.handle = async ({ args, message, principal, config, api }) => {
  const value = await api.getState("key", "chat");
  await api.setState("key", value, "chat");
  return { text: `收到：${args}` };
};
```

`plugin.json` 的 `commandPrefixes` 声明插件默认前缀，单条命令也能用 `prefixes` 覆盖。需要接受命令名后紧跟参数的命令声明 `allowAttachedArgs: true`。运行时通过统一命令注册表解析，并向插件传入规范化的 `command.name`、实际使用的 `command.invokedName`、`command.prefix`、`command.attachedArgs` 和 `args`。

`responseMode: "direct"` 是规则回复，返回值可以是字符串、`{ text }`、OneBot `{ segments }` 或 `{ blocks }`，整个过程不进入 Agent。`responseMode: "agent"` 是 AI 回复，需要声明 `agent` 权限并返回：

```js
return {
  agent: {
    content: args,
    prompt: "只回答这个插件命令要求的问题",
    agentId: "generalist",
    replyToSource: true
  }
};
```

插件可以设置默认回复方式，也可以在单条命令上用 `responseMode` 覆盖。状态 scope 支持 `global`、`channel`、`chat`、`user` 和 `groupUser`；调用状态 API 需要声明 `state`，直接发送回复需要声明 `reply`，调用 Agent 需要声明 `agent`。
