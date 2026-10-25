# 并发状态更新

需要“读出后修改”的插件状态使用 `await api.updateState(key, update, scope)`。`update` 是同步、无外部副作用的函数：输入当前值，返回下一值。宿主通过比较后写入避免并发覆盖；冲突时重新运行函数，最多重试 32 次。网络发送、随机抽样和模型调用应在函数之外完成。

```js
const count = await api.updateState("count", current => (current || 0) + 1);
```

原有 `getState`、`setState` 继续可用；`setState` 也会使已读出的过期更新失效。单项状态最多 1 MiB，键最多 256 个字符，`__host:` 前缀属于宿主。作用域仍为 `chat`、`channel`、`user`、`groupUser`、`global`；全局状态需要 `state:global` 权限。

大量用户数据应按用户或条目分键保存。排行榜等聚合数据限制条数，避免每条消息重写整群记录。需要兼容旧宿主时先检查 `api.updateState`，缺失则提示升级，不退回会丢更新的读改写方式。
