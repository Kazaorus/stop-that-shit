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
整批拒绝，不排队、不部分执行；完成、停止或 session 结束会释放并发槽位，但不退还
总量。旧的 `agents=N` 命令会返回迁移错误。
