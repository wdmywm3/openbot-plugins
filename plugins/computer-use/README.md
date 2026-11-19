# 电脑操作

在 OpenBot 实例主人的私聊里使用本机 Windows 应用。例如打开测试用的记事本窗口后说“在这份记事本中填写‘明天三点开会’，再读回来核对”。也可以要求“把这个窗口的截图私聊给我”。

在 OpenBot 的「插件 → 导入插件」选择「OpenBot 插件」，选中含 `plugin.json` 的本目录并导入，确认授权后启用所需实例。OpenBot 的受管 Python 3.12 环境按锁文件安装 Cua Driver 0.51.5。需要 Windows x64 和已登录的交互桌面。支持图片的模型还能按窗口截图定位控件。

默认后台操作。需要前台点击时，在该实例的插件设置中开启「允许打开应用或激活窗口」，然后在主人私聊里说，例如“把测试窗口切到前台，点击『验证』，再告诉我按钮变成了什么”。这一步会使用 Windows 鼠标输入，驱动会尝试恢复原窗口焦点。需要让运行 OpenBot 的 Windows 桌面保持解锁并接收键鼠输入。远程桌面已断开时，先恢复该连接。若只是某个窗口无法被 Windows 激活，可以手动将它切到前台后再继续。可从 OpenBot 停止任务或停用服务。

每次输入绑定刚刚看到的具体窗口及控件或截图。不同实例在同一 Windows 登录会话中共用桌面占用，正常结束即归还，空闲 90 秒也会释放。窗口截图按需保存为本次私聊的插件资源，普通观察只提供模型预览，要求回传截图时才生成该私聊可发送的地址。

依赖版本与平台校验值见 [requirements.lock](requirements.lock)。窗口后台输入的应用适配由 Cua Driver 提供。[上游 Windows 说明](https://github.com/trycua/cua/blob/cua-driver-rs-v0.51.5/libs/cua-driver/rust/Skills/cua-driver/WINDOWS.md)

在 Windows 开发环境中，从插件仓库运行 `npm run test:computer-use -- <OpenBot 仓库路径>`，会在临时实例和独立窗口中验证安装、输入、截图、取消和撤权。验收真实前台鼠标时，加上 `--require-foreground`。该模式要求测试按钮和自绘画布各收到一次窗口有焦点的鼠标点击。桌面不具备输入条件时，命令会报告失败。
