# Stop That Shit（别再造史了）

中文文档已迁移到仓库默认 README：

- [阅读中文 README](./README.md)
- [安装说明](./INSTALL.md)
- [English README](./README_EN.md)
- [官方产品页](https://take-a-deep-breath0.com/zh/stop-that-shit)
- [LINUX DO 社区](https://linux.do)

## 子智能体限制

使用以下指令设置当前活动并发 subagent 数量：

```text
$stop-that-shit change agents=N -- 执行任务
```

`agents=N` 表示当前同时活动的 subagent 上限。未设置时为
`Number.MAX_SAFE_INTEGER`，`0` 表示禁止 delegation；batch 超出限制时整批拒绝，
不排队、不部分执行。明确确认同步完成的 `action.after`、subagent stop 或 session
结束会释放活动槽位；后台或状态未知的调用会保守保留到明确的生命周期事件。
适配器不会按事件到达顺序猜测 reservation 的归属。旧 schema 中的有效
`agentBudget`（包括 `0`）会被保留，不会在迁移时静默放宽。
