# M3.4 可视化调整画布与人工方案确认 · 交付记录

> 日期：2026-11-15 · 基线 HEAD `79b890b`
> 架构契约：[`docs/architecture/M3.4-plan-canvas-confirmation.md`](../architecture/M3.4-plan-canvas-confirmation.md)
> 前序：M3.1 协作协议 / M3.2 协作剧场 / M3.3 需求沙盘与智能体编排

---

## 1. 交付内容

### 1.1 版本化执行方案

- 从 M3.3 的 `orchestrationId` 打开真实执行方案（`POST /api/plans`，幂等）。
- 每次保存 → 新 `ExecutionPlan` version（draft）；M3.3 编排文档不改。
- 每次确认 → 新 version（confirmed），记录确认人、时间、版本、备注、方案摘要。
- `baseVersion` 乐观锁；旧版本写入 409。
- 已确认版本不可覆盖；编辑已确认版本会派生新的 draft version（原 confirmed 保留）。
- 一个 orchestration 对应一个 plan，避免重复方案。

### 1.2 画布编辑

| 能力 | 实现 |
| --- | --- |
| 节点名称/目标/输入/输出/验收 | 右侧 inspector + 文本列表编辑 |
| 员工改派 | 只列真实、可执行、能力覆盖的真实员工；不覆盖则显示并阻塞 |
| 依赖新增/删除/修改 | 复选框；保存后重新构图 |
| 执行顺序 | 服务端 Kahn 拓扑排序写入 `order[]`；画布按依赖深度布局 |
| 风险提示 | 校验面板：缺能力、未分配、循环、员工并行冲突、缺字段、缺工作流草案 |
| 方案预览 | 完整 DAG、负责人、输入/输出/验收、节点/任务/员工/最终交付物 |
| 版本管理 | 版本列表、历史只读、变更计数（改名/改派/依赖/内容） |
| 交互 | 深色画布、缩放 50%–160%（打开自动 fit）、节点拖动、选中、编辑、中英文 |

### 1.3 校验与确认

阻塞项（有任一项禁止确认）：

- 结构：标题/目标/输入/输出/验收缺失；
- 负责人：无真实可执行员工、员工不具备节点能力；
- 依赖：未知依赖、自依赖、循环；
- 完整性：没有关联 M3.3 工作流草案。

警告：同一员工承担无依赖路径的并行任务；引擎拒绝部分改派。

确认接口**不调用** `Workflow.ConfirmStart`、不创建 Task、不进入 stage、不唤醒 Agent；确认仅写入 confirmed plan。

### 1.4 原「确认执行」按钮拆分

既有改派画布的「确认执行」实际调用 `Workflow.ConfirmStart`（会开始执行）。M3.4：

- workflow summary 新增 `planned` / `planningOrchestrationId`；
- 对 planning 草案，按钮改为「在方案画布中确认（M3.4）」；
- 点击跳转 M3.4 方案画布，不调用 `confirmStart`；
- 非 planning 的 M1.9/M2 草案保持原行为。

### 1.5 与 M3.2 剧场

- 不伪造规划事件。
- 改派产生真实的 `Workflow.StepAssignmentOverridden` 事件。
- 确认是人工规划事实，记录在 plan 文档；M3.5 启动后才产生真实任务/执行事件。

---

## 2. 真实端到端演示（隔离环境）

使用隔离 API 3211 + 隔离 Vite 5182 + 临时状态目录，正式 3001 未写入。

| 步骤 | 结果 |
| --- | --- |
| M3.3 | 需求 v3 已确认 → 编排 ready（3 task + 1 approval，John/Mike/Peter） |
| M3.4 打开 | `plan-1` v1 draft，4 节点，validation `ok` |
| 画布 | 4 节点全部可见（自动 fit 80%）、8 条依赖边、负责人/能力/输入输出/验收 |
| 确认前 | 校验「可以确认」；确认按钮可用；底部「开始执行（M3.5）」禁用 |
| 人工确认 | v2 confirmed；确认人 `ceo-alex`；时间与版本写入；备注可填 |
| Task | **0**（页面与 `/api/tasks` 一致） |
| 草案入口 | 改派画布按钮显示「在方案画布中确认（M3.4）」，点击跳回方案画布，无「确认执行」 |
| 前端 | 0 console error；中英文资源通过 |

截图（本机 `.maoeh`，不提交）：

- `.maoeh/audit/planning-ui/plan-canvas.png`
- `.maoeh/audit/planning-ui/plan-confirmed.png`
- `.maoeh/audit/planning-ui/summary-m34.json`

> 演示环境的 M3.3 使用 deterministic 需求分析；live 模型路径由既有 M3.3 单测（注入 gateway）覆盖。

---

## 3. 自动化验证

| 检查 | 结果 |
| --- | --- |
| 全量测试 | **208 文件 / 1440 测试全部通过**（37s） |
| M3.4 专项 | plan validator 8 + web plan 3 + HTTP 集成 5 |
| 架构 | 11 文件 / 62 通过；dependency-cruiser 0 违规 |
| 类型检查 | 全 workspace `tsc --noEmit` 通过 |
| Lint | 通过 |
| 前端构建 | 通过 |

HTTP 集成覆盖：打开草案 → 编辑节点/改派/依赖 → v2 draft（原 v1 不变）→ 旧 baseVersion 409 → 循环 v3 不可确认（422 plan_invalid）→ 修复 v4 → 确认 v5（确认人/时间/摘要）→ `/confirmed` 可读 → Task 0 / 无 StepEntered / 无 DraftConfirmed → 编辑 confirmed 生成 v6 draft，v5 confirmed 不变。

---

## 4. 环境保护

- HEAD 仍为 `79b890b`；未提交、未 reset/clean/stash、未删除文件。
- 未向正式 3001 发送停止/重启命令；由既有 watcher 自动重建/重启。
- 正式公司未写入 M3.4 方案/确认；隔离数据在临时目录，验证后关闭 3211/5182。
- 未创建任何 Task，未调用 `Workflow.ConfirmStart`。

> **环境遗留（如实记录）**：本轮结束时正式 `3001` 未监听。构建/既有 watcher 重建后 API 子进程没有重新绑定端口（父 watcher 仍在，API dist 在临时端口可正常启动）；按“不擅自重启 3001”的保护要求，本轮没有手动执行启动命令。需要继续现场演示时，由负责人按既有 `pnpm dev` 流程恢复即可。

---

## 5. 遗留与 M3.5 交接

### 5.1 M3.5 读取入口

```http
GET /api/plans/:id/confirmed
```

字段：`version / confirmedAt / confirmedBy / confirmationNote / requirementId+version / orchestrationId+version / nodes[] / order[] / workflowInstanceId / summary`。

M3.5 负责把这些已确认节点转成真实任务并进入 workflow stage；M3.4 不提供执行入口。

### 5.2 已知边界

1. 节点集合固定：M3.4 不增删节点（增删需要 engine definition 重建）。
2. 改派同步到 engine 的是分配视图；节点名称/依赖/输入输出/验收只存在 plan 文档，M3.5 按 plan 创建任务。
3. 方案存文件而非事件；确认不是组织事件，避免在任务未开始时污染组织事实。
4. 单人确认：当前单租户，确认人来自 operator identity。
5. 画布位置不持久化；执行顺序始终由 DAG 决定。
6. 工作流引擎目前串行进入 stage；完整 DAG 已记录，真正并行调度属于后续阶段。
