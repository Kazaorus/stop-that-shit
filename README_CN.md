# Stop That Shit（别再造史了）

中文文档已迁移到仓库默认 README：

- [阅读中文 README](./README.md)
- [安装说明](./INSTALL.md)
- [English README](./README_EN.md)
- [官方产品页](https://take-a-deep-breath0.com/zh/stop-that-shit)
- [LINUX DO 社区](https://linux.do)

## 子智能体限制

使用以下指令分别设置 session 总量和活动并发量：

```text
$stop-that-shit change total-agents=N concurrent-agents=M -- 执行任务
```

`total-agents=N` 是 session 内成功预留过的 child 总数，累计值不会因修改限制
而重置；`concurrent-agents=M` 是当前活动 reservation 数。两项同时检查，未设置
时均为 `Number.MAX_SAFE_INTEGER`，`0` 表示禁止 delegation。batch 超出任一限制时
整批拒绝，不排队、不部分执行。只有明确确认同步完成的 `action.after` 才会释放
对应槽位；后台或状态未知的调用会保留到明确的 subagent stop 或 session 结束。
session 结束会清理活动槽位，但不退还总量，适配器也不会按事件到达顺序猜测关联。

旧的 `agents=N` 仍暂时兼容但已弃用：会映射为 `total-agents=N` 并给出 warning。
它与 `total-agents=M` 冲突或数值非法时，整个指令不会部分更新合同。
