# M3.5 任务实施与真实智能体执行 · 交付记录

> 日期：2026-11-15 · 基线 HEAD `79b890b`
> 架构契约：[`docs/architecture/M3.5-plan-execution.md`](../architecture/M3.5-plan-execution.md)
> 前序：M3.4 方案确认 / M3.3 编排 / M3.1 协作协议 / M3.2 Theater

---

## 1. 审计结论

已有可直接复用：confirmed plan 读取、workflow-engine start/stage/confirm/resume、TaskSystem 全生命周期、Agent tick 调度、M3.1 事件、M3.2 Theater、Results 结果读取。

本轮补缺：

1. confirmed plan → workflow definition 的忠实翻译（不是重新规划）；
2. 受保护、幂等的 `start` API 与 execution 记录；
3. 真实执行读取（任务、负责人、结果、artifacts、审批门）；
4. 方案画布的「开始执行」入口与执行面板；
5. 修复 workflow-engine 对 `AssignmentRule.kind='employee'` 只在 preflight 接受、激活时未真正按员工落任务的问题。

没有新建第二套 workflow engine / TaskSystem / 事件总线 / 调度器。

---

## 2. 实际实现

| 文件 | 内容 |
| --- | --- |
| `packages/workflow-engine/src/execution-plan-workflow.ts` | plan snapshot → workflow definition；节点顺序/负责人/输入输出/验收/approval 全部来自 plan；replay 重建 |
| `packages/workflow-engine/src/workflow-engine.ts` | 员工 assignment 激活修复；执行实例仍走既有引擎 |
| `packages/workflow-engine/src/workflow-generation.ts` | 重启时从 `context.executionPlan` 重建 definition |
| `apps/api/src/planning-types.ts` | `ExecutionRecord`、`ExecutionView`、任务/摘要/审批类型 |
| `apps/api/src/planning-store.ts` | executions 持久化、ID、幂等查询 |
| `apps/api/src/planning-service.ts` | `startExecution`、`listExecutions`、`getExecution`、执行状态派生、artifacts 派生 |
| `apps/api/src/api-adapter.ts` | `POST /api/plans/:id/start`、`GET /api/executions[/:id]` |
| `apps/web/src/execution.ts` | 执行读模型 |
| `apps/web/src/pages/PlanCanvas.tsx` | confirmed plan 执行摘要、开始执行、执行面板、轮询、真实任务/交付物/审批状态 |
| `apps/web/src/plan-canvas.css` | 执行面板样式 |

### 关键 API

```http
POST /api/plans/:id/start      { baseVersion }
GET  /api/executions
GET  /api/executions/:id
```

启动校验：confirmed + baseVersion 当前 + 重新校验 plan + approval gate + 幂等。重复启动返回同一 execution。

---

## 3. 真实执行链路

```text
M3.4 confirmed ExecutionPlan v2
  → execution-plan-workflow: 一个节点一个 stage/step（plan.order）
  → simulation.workflow.start（既有引擎，新 execution instance）
  → Workflow.InstanceStarted / StepEntered
  → TaskSystem Task.Created / Assigned（负责人 = plan.employeeId）
  → tick + scheduler 唤醒真实 Agent
  → Agent AcceptTask / StartTask / ProgressReport（真实结果）
  → Task.Completed → 下一 stage → 下一个 Task
  → 所有 task 完成 → approval stage
  → Workflow.ApprovalRequested，execution = awaiting_approval
  → M3.6 读取 /executions/:id + /workflows
```

M3.3 的 draft 实例不被启动、不被改写；执行实例的 `context.executionPlan` 保留来源 plan/version，`sourceWorkflowInstanceId` 记录来源草案。

---

## 4. 隔离环境完整演示

### 4.1 真实模型执行（live）

隔离 API 3211，临时 event log / planning 目录，`MAOEH_LLM_MODE=live`（DeepSeek）；正式 3001 未写入、未启动。

| 项 | 结果 |
| --- | --- |
| 需求 | v3 已确认 |
| 方案 | v2 confirmed（人类确认） |
| 执行 | `exec-1`，workflow `execution-plan-1-v2`，startedBy `ceo-alex` |
| 任务 | 3/3 completed |
| 负责人 | John（Technical Design）、Mike（Implementation）、Peter（Testing） |
| 真实交付 | technical_design、server.js、qa_report（来自 Agent 的真实 `Task.result.data`） |
| 审批 | `Workflow.ApprovalRequested`，approval open，sim 16 |
| 状态 | `awaiting_approval` |
| Plan | 执行后仍为 v2 confirmed，未变 |
| Task 数 | 3（未重复；重复 start 返回同一 execution） |

结果文件：`.maoeh/audit/m35/live-execution.json`。

### 4.2 UI 启动（隔离 mock 运行）

隔离 API 3212 + Vite 5183：

- confirmed 方案展示执行摘要（v2、3 tasks、3 employees、交付物）；
- 人类点击「开始执行（M3.5）」；
- 首任务创建后状态 `running`，1 个任务、0/3；
- tick 驱动后 3/3 completed、审批请求打开；
- 截图：`.maoeh/audit/planning-ui/plan-canvas.png`（live 执行面板）、`plan-started.png`（点击启动后）。

> 真实模型执行使用 live 环境；mock 只用于 UI 交互与自动化回归，不用 mock 结果替代 live 验收。

---

## 5. 测试与构建

| 检查 | 结果 |
| --- | --- |
| 全量测试 | **212 文件 / 1451 测试全部通过**（42s） |
| M3.5 专项 | plan→workflow 3；执行读模型 3；HTTP 执行 4；重启一致性 1 |
| 架构 | 11 文件 / 62 通过；dependency-cruiser 0 违规 |
| 类型检查 | 全 workspace `tsc --noEmit` 通过 |
| Lint | 通过 |
| 前端构建 | 通过 |

覆盖：未确认拒绝、版本锁、幂等启动、首任务、mock Agent 真实链路、3 任务按 plan 顺序、Task/Workflow 事件、审批门、plan 不变、重启后同一 execution/instance/task。

---

## 6. 环境保护

- HEAD 仍为 `79b890b`；未提交、未 reset/clean/stash、未删除文件。
- 未启动或重启正式 3001；正式公司未写入 M3.5 execution。
- 所有验证在 3211/3212/5182/5183 临时环境，结束后关闭。
- 未新增第二套执行引擎；未自动批准、推广或发布。

> **环境状态**：正式 3001 在验证结束时已由既有 watcher 自动恢复监听（PID 60272，12:00:33 启动）；本轮没有手动执行停止/重启命令。正式 `/api/plans` 与 `/api/executions` 为空，未写入 M3.5 数据。现场演示前只需刷新控制台。

---

## 7. M3.6 交接

```http
GET /api/executions/:id
GET /api/workflows
```

M3.6 读取：

- execution `planId/planVersion`、`planConfirmedBy/At`；
- tasks（完成、负责人、result.summary/data/artifacts）；
- `approval.status='open'`、stepId、requiredCount；
- workflow instance / plan 版本。

M3.6 只做审批、推广、发布；M3.5 不自动通过。

---

## 8. 未完成事项与边界

1. 执行按现有引擎串行 stage；plan DAG 已记录，不做并行调度。
2. 一个 plan 版本一个 execution；要再跑需新的 confirmed 版本（或后续显式运行版本机制）。
3. 暂停/恢复/取消沿用既有 control/task 命令；UI 只读展示真实状态，不新造控制状态机。
4. 失败重试沿用现有 `maxAttempts:1`；没有新增重试策略。
5. `Task.result.artifacts` 为空但 Agent 在 `data` 文件键/`files[]` 中交付时，执行视图从真实 data 派生 artifact 名称；不生成占位文件。
6. 审批只打开请求，不自动批准；M3.6 负责后续。
