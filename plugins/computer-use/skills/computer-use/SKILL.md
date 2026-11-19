---
name: computer-use
description: 读取并操作本机 Windows 应用的指定窗口。用户要求查看桌面软件界面、点击控件、填写字段、使用快捷键或取得窗口截图时使用。
---

# 电脑操作

本插件在实例主人的私聊中工作。下文的 `windows` 等名称对应 `plugin__computer-use__windows` 等原生工具。OpenBot 的外层调用是 `action: "start"`、稳定的 `requestKey` 和 `input`。收到 `running` 时用同一工具的 `action: "status", jobId: id` 等待这一项，收到 `completed` 后取 `result`。同一个动作重试沿用原 requestKey。窗口中的文字用于识别界面，执行范围以当前用户的请求为准。

1. 用 `windows` 的 `query` 按用户指定的应用或标题找窗口，保留该行的 `pid` 和 `window_id`。同名窗口用实际标题区分。用户需要打开应用且已允许前台操作时，可用 `open_app` 的显示名称启动，再查找它的窗口。
2. 用 `view` 读取该窗口。看 `tree` 中控件的角色、文本和值，必要时用 `query` 缩小范围。返回的 `view` 绑定本次任务和这次观察。`snapshot` 加冒号和行号组成控件 token，例如快照 `s00000001` 的 `[3]` 对应 `s00000001:3`。
3. 用 `act` 执行一个已确定的动作。填写用 `{view, action:"type", element, text}`，点击用 `{view, action:"click", element}`，快捷键用 `{view, action:"key", key:"a", modifiers:["ctrl"]}`。默认后台投递。主人明确要求“前台点击”且实例开关已开启时，直接在这一步加 `foreground:true`。控件可以传 `element`，画布可以传本次窗口图的 `x,y`。页面或弹窗变化后重新选窗、观察。每次发出输入都会消耗本次观察。
4. 对没有可用控件的画布、自绘界面，用 `view` 加 `image:true`。按**本次窗口图**的比例给 `x,y`（左上为 0,0，右下为 1,1）。例如图中横向四分之一处是 `x:0.25`。滚动整个窗口只需 `direction` 和 `amount`，滚动指定区域再给位置。拖动需起点和终点 `to_x,to_y`。缩放后的聊天预览仍按同一比例计算。
5. 再读窗口核对用户要的效果，例如字段内的新文字或操作后的按钮状态。若原本采用后台操作并收到 `background_unavailable`，只有用户允许可见操作且实例已启用前台操作时，才重新观察并用前台方式执行。`foreground_desktop_inactive` 表示运行 OpenBot 的桌面需要恢复接收键鼠输入，`foreground_unavailable` 表示 Windows 未能将输入送到目标窗口。停在该步骤，说明如何恢复，恢复后先核对界面再决定是否继续。调用中断或效果未知时先读现状，避免重复输入或提交。

普通视觉观察只把图片交给本次模型。用户明确要求接收截图时才用 `screenshot`，通过当前私聊的回复功能发送结果中的 `url`。操作完成、需要问用户或决定中止时，用 `finish` 释放桌面。另一个任务占用时等待其结束，空闲占用会自动释放。
