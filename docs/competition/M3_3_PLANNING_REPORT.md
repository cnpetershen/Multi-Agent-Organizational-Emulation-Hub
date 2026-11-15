# M3.3 需求沙盘与智能体编排 · 交付与验收记录

> 日期：2026-11-15 · 基线 `feat/m2-workflow-closed-loop`（HEAD `79b890b`）
> 架构契约：[`docs/architecture/M3.3-requirements-orchestration.md`](../architecture/M3.3-requirements-orchestration.md)
> 前序：M3.0 遗留核查 / M3.1 协作协议 / M3.2 协作剧场

---

## 1. 交付内容

### 1.1 需求沙盘

- 真实业务目标 → 结构化需求方案：目标、背景、受众、约束、范围、交付物、验收标准、风险、所需能力。
- 三种来源且边界清晰：
  - live：真实模型 + 严格 JSON schema；
  - sandbox：复用现有赛博沙盘会话（真实 transcript + `buildSandboxBriefDraft`）；
  - deterministic：无模型时只保留用户原话，其余变成澄清问题，不编造。
- 识别模糊/缺失：blocking clarifications + gaps；未回答不可确认。
- 来源标注：`provenance.stated` 永远只有 `source.goal`；其余字段全部标为 inferred，UI 明示「AI 建议/推导」。
- 版本：需求 v1…vN 追加式保存；`baseVersion` 乐观锁；已确认版本不可变，编辑生成新 draft。
- API：analyze / list / get / update / confirm。

### 1.2 智能体编排

- 基于已确认需求与真实组织：
  - capability → `resolveCapabilityAssignments` → 真实员工（`isExecutableEmployment`）；
  - 无席位/无员工 → `missingCapability` + `unassigned`，草案 blocked；
  - 同一员工多节点 → resource contention warning；
  - 节点含 inputs / outputs / acceptance / dependsOn / order / owner；
  - 显式 DAG + Kahn 拓扑排序 + 人类审批门；
  - 冲突、缺失能力、未分配任务全部结构化返回。
- 不虚构员工、不静默分配、不调用模型选择员工。

### 1.3 交给 M3.4 的草案

- ready 时调用现有 workflow-engine 的 `start({capabilities, awaitConfirmation:true, context.planning})`；
- 只创建 `Workflow.InstanceStarted` 等 workflow 事件（并 append 到日志），**不创建任何 Task**；
- `context.planning` 带需求/编排版本与节点摘要；
- 通过 `overrideAssignments` 固定真实员工（失败 warning，不阻塞）；
- 画布显示「草案 / 草稿 / 等待确认」，可读取、可改派；确认执行留给 M3.4 的人类按钮。

### 1.4 与 M3.2 剧场

- 草案实例事件阶段 = orchestration；
- 卡片文案「工作流草案已生成 · 等待画布确认」；
- 需求分析本身是规划工具调用，不伪造 Agent 消息/事件；
- 本阶段没有 Task 事件，任务实施阶段保持干净。

---

## 2. 真实端到端演示（隔离环境）

为避免污染正式演示公司，本轮在**隔离 API（3211）+ 隔离 Vite（5182）+ 临时状态目录**跑完整界面流程；未向正式 3001 写入任何需求/编排/事件。

| 步骤 | 结果 |
| --- | --- |
| 企业 | 隔离的 Future AI Lab（seed 组织，真实 7 名员工配置） |
| 需求分析 | deterministic（无模型）→ 4 个阻塞问题；用户补齐 9 类字段并逐条回答 |
| 需求确认 | v3 · 已确认；版本历史 v1→v2→v3 |
| 编排 | `ready`；3 个 task 节点 + 1 个人类审批门 |
| 负责人 | John（Technical Design）、Mike（Implementation）、Peter（Testing）——来自真实席位/能力 |
| 依赖 | Technical Design → Implementation → Testing → 人类审批 |
| 草案实例 | `instance-1`；画布显示「草案：设计咨询公司周报生成器 / 草稿 / 等待确认」 |
| Task | **0 条**（集成测试硬断言） |
| 剧场 | `Workflow.InstanceStarted` (draft) 阶段为 orchestration |
| 前端 | 规划台渲染、需求编辑、问答、版本切换、编排节点/负责人/依赖、跳转画布；0 console error |

截图（本机 `.maoeh`，不提交）：`.maoeh/audit/planning-ui/planning.png`、`planning-canvas.png`、`summary.json`。

> 说明：演示环境没有 live 模型 key，需求解析走 deterministic；真实模型路径由单元测试用注入 gateway 验证（JSON 解析、非法响应失败、provider 失败不伪造）。

---

## 3. 自动化验证

| 检查 | 结果 |
| --- | --- |
| 全量测试 | **205 文件 / 1424 测试全部通过**（37s） |
| M3.3 专项 | 需求分析器 7 + 编排器 5 + 规划读模型 3 + 剧场草案 1 + 草案阶段 1 + HTTP 集成 6 |
| 架构测试 | 11 文件 / 62 通过；dependency-cruiser 0 违规 |
| 类型检查 | 全 workspace `tsc --noEmit` 通过 |
| Lint | ESLint 通过 |
| 前端构建 | `pnpm --filter @maoeh/web build` 通过 |

集成测试 `tests/integration/planning-http.test.ts` 覆盖：

1. 目标 → 结构化方案；`needs_clarification`；provenance 只有 goal 是 stated；
2. 阻塞问题未回答 → 确认 422；
3. 编辑 + 回答 → 新版本；确认 → v3 confirmed；旧 baseVersion → 409；
4. 未确认需求编排 → 409 `not_confirmed`；
5. 确认后编排 → ready；真实员工、依赖、输入输出、验收；创建画布草案实例；
6. `/api/tasks` 为空；剧场无 `Task.Created`；草案事件 stage=orchestration；context.draft=true；
7. 未知能力（quantum_chip_design）→ blocked + missing + unassigned，不创建实例。

---

## 4. 运行环境保护

- HEAD 仍为 `79b890b`；**未提交、未 reset/clean/stash、未删除任何文件**。
- 正式 3001 未收到停止/重启命令；由既有 `turbo watch build dev` + `node --watch` 托管，源码变更后自动重建/重启。
- 正式公司未写入需求、编排或 draft 实例；所有演示数据在隔离临时目录，验证后已关闭 3211/5182。
- 未点击任何画布「确认执行」按钮；任务实施保持未启动。

---

## 5. 遗留与演示注意

1. **live 模型路径**：需要 `.env` 的 DeepSeek key；mock 模式是 deterministic，会要求人工补齐字段，这是诚实行为，不是 bug。
2. **需求存储是文件版本库**，不是事件；只有画布草案实例进入事件日志。演示时应说明这一点。
3. **编排串行**：DAG 依赖已记录，但工作流引擎阶段是串行进入；并行分支留待 M3.4/M3.5。
4. **能力缺失**：当前 seed 组织没有 `marketing` 等部分能力时，相关节点会 blocked；应演示「明确报告」而不是硬塞员工。
5. **画布确认**：现有画布已有「确认执行」按钮；本轮只创建草稿，未点击。M3.4 才处理画布调整、人工确认和任务实施。
6. **全量测试的既有偶发**：`preview-runtime-http` 在极高并发/负载下仍可能超时；安静环境本轮 1424/1424 全绿。
