# M3.6 人工审批与交付物审核 · 交付记录

> 日期：2026-11-15 · 基线 HEAD `79b890b`
> 架构契约：[`docs/architecture/M3.6-delivery-approval.md`](../architecture/M3.6-delivery-approval.md)
> 前序：M3.5 任务实施 / M3.4 方案确认 / M3.2 Theater

---

## 1. 审计结论

可复用：

- M3.5 执行读模型（真实 tasks / Task.result / artifacts / approval）；
- workflow approval stage、`Workflow.ApprovalRequested`、`workflow.approve(granted/denied, humanApproval)`；
- TaskSystem 已完成后端事实；
- M3.1 事件协议、M3.2 Theater；既有 Results 单任务完整结果页。

本轮补齐：

1. execution 级审批记录（审批人/时间/动作/意见/前后状态/关联任务/交付物）；
2. 服务端归属、完整性、gate 状态、原因必填校验；
3. 幂等 + 并发单决定保护；
4. 交付审批工作台（真实内容预览 + 验收对照 + 三动作 + 历史）；
5. M3.7 的 approved 交接读模型。

未新建审批引擎/事件总线；审批仍由既有 workflow gate 推进。

---

## 2. 实际修改文件

| 文件 | 内容 |
| --- | --- |
| `apps/api/src/planning-types.ts` | `ExecutionApprovalRecord`、`ExecutionReviewView`、`ExecutionApprovalSummary`、动作枚举 |
| `apps/api/src/planning-store.ts` | approvals 持久化/ID/查询 |
| `apps/api/src/planning-service.ts` | pending/history/approved、review、decide、服务端校验、幂等/并发 |
| `apps/api/src/api-adapter.ts` | `/execution-approvals` 读、review、decide；错误状态映射 |
| `packages/organization-control/src/service.ts` | 拒绝 execution 实例走 generic Workflow.Approve/Reject，必须走交付工作台 |
| `packages/organization-control/src/query.ts` / `types.ts` | workflow summary 增加 `executionPlan` 标记，旧 Approvals 不再列入 execution gate |
| `apps/web/src/approval.ts` | 审批读模型、artifact 内容定位 |
| `apps/web/src/pages/DeliveryApprovals.tsx` | 交付审批工作台 |
| `apps/web/src/delivery-approval.css` | 工作台样式 |
| `apps/web/src/App.tsx` / `control.ts` / locales | 交付审批导航、页面、中英文 |
| `apps/web/src/pages/PlanCanvas.tsx` | 执行面板「去审批交付」入口 |
| `tests/integration/planning-approval-http.test.ts` | 三路径/并发/gate/命令绕过/事件/M3.7/返工重提 |
| `tests/integration/planning-execution-restart.test.ts` | 审批历史重启一致性 |
| `tests/unit/web/approval.test.ts` | 审批读模型/预览/动作 |

---

## 3. 审批 API

```http
GET  /api/execution-approvals
GET  /api/execution-approvals/:executionId
POST /api/execution-approvals/:executionId/decide
```

`decide`：

```json
{ "action": "approve | reject | request_changes", "reason": "...", "approvalKey": "optional" }
```

服务端校验：

- execution 存在、状态 `awaiting_approval`；
- workflow approval open；
- 所有 plan task 已完成，且 `Task.result` 非空、至少一个真实 artifact；
- reject/request_changes 必须写原因；
- actor 是人类 operator；
- 可选 approvalKey 必须匹配当前 gate。

---

## 4. 三条真实路径

| 路径 | 引擎动作 | 结果 |
| --- | --- | --- |
| 批准 | granted + humanApproval | execution `completed`；workflow `completed`；记录 approved |
| 驳回 | denied + humanApproval | execution `failed`；workflow failed/aborted；记录 reject，不进入 approved |
| 要求修改 | denied + humanApproval，记录 action=request_changes | execution `failed`；记录 taskIds/artifacts/返工意见；不进入 approved |

`request_changes` 与 `reject` 共用现有 gate 的 denied 分支；区别在不可变审批记录 action 与返工意见。返工由人回到 M3.4 调整方案、M3.5 新 execution；M3.6 不自动建任务。集成测试实际走通了「要求修改 → 计划新版本 → 新 execution」的重新提交链。

幂等：

- 相同 action 重复 → 返回原 decision，`idempotent=true`；
- 不同 action → `409 approval_already_decided`；
- gate 未开/已关 → `409 approval_not_open`；
- 并发相同 action → 只有一条 history；测试用 `Promise.all` 验证。

---

## 5. 真实验证

### 5.1 真实模型执行 + 审批（隔离 live）

隔离 API 3211、临时状态目录、`MAOEH_LLM_MODE=live`（DeepSeek）；正式 3001 未写入。

| 项 | 结果 |
| --- | --- |
| 需求/方案 | 需求 v3；方案 v2 confirmed |
| 执行 | `exec-1`，3/3 tasks completed |
| 负责人 | John / Mike / Peter |
| 真实交付 | technical-design.md、index.html、qa_report |
| 审批人 | `ceo-alex` |
| 决定 | approve |
| after | execution completed / approval granted / workflow completed |
| 方案 | 执行与审批后仍为 v2 confirmed，未改 |

结果：`.maoeh/audit/m35/live-approval.json`。

### 5.2 三条路径集成（真实 kernel/workflow/TaskSystem）

`planning-approval-http.test.ts` 运行 7 个用例，真实创建 execution/tasks，真实 work approval gate：

- 批准 → completed；重复幂等；改判 409；
- 驳回 → failed，不进入 approved；
- 要求修改 → failed，记录原因/taskIds/artifacts，不进入 approved；
- gate 未打开 → 409；
- 并发批准 → 只有一条 decision；
- generic `Workflow.Approve` command 对 execution 被拒绝（必须走工作台）；
- Theater history 含 ApprovalRequested/Granted/Denied；
- approved handoff 含 execution/plan/审批人/artifacts。

### 5.3 重启一致性

`planning-execution-restart.test.ts` 使用文件事件日志：执行 → 关闭 API → 重启 → 继续执行 → 批准 → 再次重启；execution 仍 completed，history 仍恰有一条 approve，approved 列表仍可读。

### 5.4 工作台 UI

隔离 API 3212 + Vite 5183，真实 execution（mock 模型执行、真实 workflow/tasks）打开「交付审批」：

- 3 个任务、4 个真实 artifact、9 条验收标准；
- inline 预览 technical-design.md 内容；
- 点击「批准交付」→ 审批记录 `ceo-alex`、`awaiting_approval → completed`、关联 4 个 artifact；pending 变 0，history 显示批准。

截图：`.maoeh/audit/m36/approval-review.png`、`approval-approved.png`。

---

## 6. Theater

真实事件：

- `Workflow.ApprovalRequested`
- `Workflow.ApprovalGranted`
- `Workflow.ApprovalDenied`

集成测试直接读取 `/theater/history` 断言上述事件存在；Theater 未承担审批逻辑，也未伪造 Agent 消息。

---

## 7. M3.7 交接

只读 **approved**：

```http
GET /api/execution-approvals
→ approved[]
```

每条 approved 提供：

- executionId
- planId / planVersion
- approvalId
- decidedBy / decidedAt
- artifacts[]
- taskIds[]
- before / after 状态

详情：

```http
GET /api/execution-approvals/:executionId
GET /api/executions/:executionId
```

pending/rejected/request_changes 不会出现在 approved；M3.7 不得推广未批准执行。

---

## 8. 测试与构建

| 检查 | 结果 |
| --- | --- |
| 全量测试 | **214 文件 / 1463 测试全部通过**（`vitest run --maxWorkers=4`；默认极高并行下既有 preview-runtime 偶发超时，单独复跑通过） |
| M3.6 专项 | 后端审批 8；web 审批 4；重启审批 1 |
| 架构 | 11 文件 / 62 通过；dependency-cruiser 0 违规 |
| 类型检查 | 全 workspace `tsc --noEmit` 通过 |
| Lint | 通过 |
| 前端构建 | 通过 |

---

## 9. 环境保护

- HEAD 仍为 `79b890b`；未提交、未 reset/clean/stash、未删除文件。
- 未修改正式业务数据；正式 3001 只读核验，`/api/plans` 与 `/api/executions` 为空。
- 未手动停止/重启正式 3001；隔离 3211/3212/5182/5183 验证后关闭。
- 未自动推广或发布；M3.6 只审批。

---

## 10. 未完成与边界

1. `request_changes` 采用现有 gate 的 denied 分支，因此执行进入 failed；返工需要 M3.4 改方案 + M3.5 新 execution，M3.6 不自动创建返工任务。
2. 单租户单 operator；不做多级审批/多角色权限。
3. 审批记录写 planning store；workflow/task 事实在事件日志；极端进程崩溃窗口仍需后续对账。
4. 不自动批准、推广、发布。
5. artifact 内联预览依赖 Agent 把内容放进 `Task.result.data`；没有内联内容时提供 Results 完整结果入口。
