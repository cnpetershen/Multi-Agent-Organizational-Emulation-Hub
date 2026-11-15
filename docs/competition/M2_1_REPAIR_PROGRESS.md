# M2.1 定向修复与 Live 闭环进度报告

- 日期：2026-11-15（Asia/Shanghai）
- 分支：`feat/m2-workflow-closed-loop`
- 基线：`79b890b`（原 M2.1 修复基线）
- 审查依据：`M2_MANUAL_REVIEW.md`、`M2_1_LIVE_REPAIR.md`
- 工作方式：只修复 P1-A/B/C/D；不开发 M3；不提交代码；不重启 3001/5173；不删除原始证据

---

## 0. 结论摘要

| 项 | 状态 | 证据 |
|---|---|---|
| P1-A Watchdog 可靠性 | ✅ 修复 | 心跳（inference/tool/idle）、暂停排除、重启日志播种、幂等去重、45 tick 不变 |
| P1-B Live 执行停滞（Mike accepted） | ✅ 根因修复 | accepted/started 任务获得确定性 continuation wakeup；live 5 个任务全部走完 accept→start→submit→completed |
| P1-C JSON 修复可靠性 | ✅ 修复并扩展测试 | 合法转义不改、原始控制字符修复、结构错误/非法转义仍拒绝；额外字段归一化 |
| P1-D 生成式工作流分支 | ✅ 修复并回归 | 每个能力阶段 failed 分支；rejected/failed/cancelled 独立；真实分支详情断言 |
| Live 真实 AI 全链路 | ✅ **通过** | DeepSeek live，17 次真实调用；5 个任务真实完成；真实 `index.html`；人工审批；completed |
| 全量测试 | ⚠️ 默认并行 1 个 preview 超时；2 worker 全量通过 | 默认 188 files/1322，1 failed（timeout）；`--maxWorkers=2` 188/1322 全通过 |
| 门禁 | ✅ 通过 | typecheck 53/53、lint 0、architecture 55/55、build 33/33 |

**达到完整闭环验收条件：是（在隔离 live 环境完成一条真实链路）。**

默认并行全量的 `preview-runtime-http` 超时仍存在，单跑 2/2 通过；本轮没有修改该测试或任何断言。

---

## 1. Git 与受保护工作区

### 1.1 当前状态

| 项 | 值 |
|---|---|
| HEAD | `79b890b`（本轮未提交代码） |
| 工作区 | 48 项（含本报告；其余 47 项为 M2.1 目标文件、19 个既有 web 并行改动、临时抓取/交付数据/角色改动） |
| 原始 live 证据 | `.maoeh/acceptance/m2-1-live/**` 原样保留（events 504823 bytes，截图 442452 bytes，mtime 未变） |
| 3001 | PID 57728，启动 `2026-11-14 20:43:08`，未重启、未写入；`/api/llm` 仍 `live · deepseek-flash` |
| 5173 | 未重启；仍代理到 3001 |
| 本轮 live 环境 | 3210（最新 dist，live deepseek-flash）+ 5180（最新 web dist），临时目录 `.maoeh/acceptance/m2-1-live-repair5` |

### 1.2 本轮修改/新增

**修改（M2.1 目标）**

- `apps/kernel/src/simulation/stall.ts`（重写心跳/判定/continuation 选择）
- `apps/kernel/src/simulation/run-tick.ts`（心跳、暂停过滤、日志播种、continuation 调度、workflow context）
- `apps/kernel/src/simulation/simulation.ts`（`stallHeartbeats`、`stallBootstrapped`、`taskContinuations`）
- `apps/kernel/src/simulation/plan-executor.ts`（top-level/artifacts → data 归一化）
- `packages/agent-cognition/src/cognition-executor.ts`（控制字符修复 + 输出形状归一化）
- `packages/agent-cognition/src/context/cognition-context.ts`（`workflowContext`）
- `packages/agent-cognition/src/prompts/cognition.ts`（任务协议、真实文件要求、confirmed workflow 提示）
- `packages/workflow-engine/src/workflow-generation.ts`（failed 分支，沿用已存在的修复并补强测试）

**新增测试**

- `tests/unit/kernel/stalled-tasks.test.ts`（9）
- `tests/integration/stall-watchdog.test.ts`（2，含暂停排除）
- `tests/integration/task-continuation.test.ts`（1，Accept→Start→Submit 三段 continuation）
- `tests/unit/agent-cognition/cognition-executor-json-repair.test.ts`（8）
- `tests/unit/agent-cognition/cognition-prompt-transition.test.ts`（4，新增 workflow context/真实文件要求）
- `tests/unit/workflow-engine/generated-failed-branch.test.ts`（4，新增 cancelled 与 `stage-1_failed` 详情）

**未修改**：19 个 web 并行改动、`.tmp-*`、`apps/web/src/{roles.ts,roles.css,components/RoleAvatar.tsx}`、`deliverables/cyber-sandbox/`、原始 `.maoeh/acceptance/m2-1-live/`。

---

## 2. P1-A · Watchdog 可靠性

### 2.1 根因

原实现只有 `stallActivity: taskId -> last Task.* event`，45 tick 无 Task 事件就 reject/fail：

- 模型推理、工具执行都不产生 Task 事件，长 turn 被误判为停滞；
- accepted/started 任务在暂停工作流中仍可能被 watchdog 动；
- 进程重启后内存表为空，只能回退到 `createdAtSim`，可能误杀最近有活动的旧任务；
- 同一任务重复出现在读模型时可能重复 action；
- 没有区分“模型在推理 / 工具在跑 / 任务真的停滞”。

### 2.2 修复

`stall.ts` 现在是显式心跳模型：

```ts
TaskHeartbeat = { atSim, phase: 'inference' | 'tool' | 'idle' }
```

- `noteTaskHeartbeat`：agent turn 开始 → `inference`；PlanExecutor 每个 step 前/后 → `tool`；cycle 完成 → `idle`。
- `noteTaskActivity`：任何 `Task.*` 事件 → `tool` 心跳。
- `stalledTasks`：`accepted`/`started` 才可能触发；`STALL_THRESHOLD_TICKS` 仍为 **45**（未延长）；按 taskId 去重；`pausedWorkflowIds` 排除暂停实例；reason 带 last phase。
- `run-tick` 首个 tick 从完整事件日志播种 heartbeat；重启后旧任务若有近期事件不会被误杀。
- 暂停判定同时覆盖 `status=paused` 与 `status=blocked + blockedReason.kind='manual'`（实际引擎用 blocked 表示人工暂停）。
- watchdog 动作仍走 `tasks.reject/fail`，不直接完成；workflow reactor 再走真实分支。
- 新增 continuation：`accepted`/`started` 任务在当前 cycle 结束后获得 `TURN` wakeup（下一 tick），最多 `MAX_TASK_CONTINUATIONS=3`；不是 auto-start，不是伪造完成，只让真实模型在下一 turn 看到 `next=StartTask/SubmitReport`。

### 2.3 测试

- 心跳 phase/最近活动；暂停排除；去重；重启日志播种（9 unit）。
- 真实内核：started 无活动 → 45 tick fail → failed 分支；暂停实例 → 60 tick 不动（2 integration）。
- continuation：模型第一轮只 Accept、第二轮只 Start、第三轮 Submit；三 tick 完成，无 Rejected/Failed（1 integration）。
- 现有 pause 完成/拒绝/取消用例保持通过。

证据：`.maoeh/acceptance/m2-1-typecheck2.log`、`m2-1-architecture2.log`；测试见 `.maoeh/acceptance/m2-1-full-test-2workers.log`。

---

## 3. P1-B · Live 执行停滞

### 3.1 事件链根因（repair3/repair4 观察）

`repair3` 现场（`.maoeh/acceptance/m2-1-live-repair3/events.jsonl`）：

```
Task.Assigned task-3 → Task.Accepted (cycle-4, actionCount=1)
45 tick 无 Task.Started → kernel-watchdog Task.Rejected
Workflow.InstanceAborted(detail=stage-3_rejected)
```

模型 plan 只有 `AcceptTask`（有效但只走半步）。`Task.Accepted` 后：
- 状态机允许 `StartTask`；
- 但没有事件再唤醒 Mike；
- scheduler 不会因为“accepted 尚未开始”自动给下一次 turn；
- 45 tick 后 watchdog 只能 abort。

**根因定级**：不是工具执行、不是状态机；是 **scheduler 缺少 accepted/started 的后续唤醒**，叠加 prompt/模型只输出半段动作。修复不能只靠 watchdog，也不能把 watchdog reject 当完成。

### 3.2 修复

- continuation wakeup（见 §2.2）让 Mike 在下一 tick 获得真实 turn，prompt 显示 `status=accepted | next=StartTask`；再下一 tick `status=started | next=SubmitReport`。
- `run-tick` 对 TURN 跳过 processed-event guard（continuation 是合成 follow-up，不是 replay），避免同 tick 多任务互相吞掉。
- `plan-executor` 把 live 常见的 `data` 顶层字段、`artifacts` 对象归入 `data`，但真实文件门槛仍保留；`implementation` 必须有 `.html/.js/...` 文件内容或声明的 artifact。
- prompt 明确：
  - `SubmitReport` 必须是 `taskId + summary + data`；
  - implementation 的 data 必须含真实可运行文件（例如 `"index.html": "<!doctype html>..."`）；
  - workflow step 已经过画布确认，不要 BlockTask 等第二次确认。
- 认知输出归一化：只丢弃无害额外字段（`steps_notes` 等），只默认 `reasonRef=0`；缺 goal/action/steps 仍 schema_violation。

### 3.3 Live 结果

**成功 run**：`.maoeh/acceptance/m2-1-live-repair5`，`browser-report.json` **ok=true**。

- `/api/llm`: `{"callCount":17,"provider":"deepseek","mode":"live","model":"deepseek-flash"}`（非 mock）。
- 5 个能力任务（Product Requirement / Technical Design / Implementation / Frontend / Testing）全部：
  - `Task.Accepted` → `Task.Started` → `Task.ProgressReported` → `Task.Completed`；
  - `Task.Rejected` = 0，`Task.Failed` = 0（无 watchdog abort）；
  - 每个任务 1 次完成，无重复结算。
- 真实交付：
  - task-3 `index.html`，6213 chars，`<!doctype html>`，含 `<script>`，标题「课程实验平台 MVP」；
  - task-4 `index.html`，2962 chars；
  - task-5 `testing=true` + `qa_report` 的通过/失败矩阵。
- 人工审批：`Workflow.ApprovalGranted` by `ceo-alex`（Results 页面 Accept delivery）；`Workflow.InstanceCompleted`。
- 事件：153 条，13 个 cycle，5 个 Task.Completed，6 个 StepCompleted，1 个 ApprovalRequested/Granted/InstanceCompleted。

早期失败也保留：
- repair3：CEO 输出 `steps_notes`/缺 `reasonRef` → `schema_violation`（已由归一化修复）；
- repair4：Mike 开始后 SubmitReport 顶层字段/无真实文件 → `invalid_args`（已由 data 归一化 + prompt 真实文件要求修复）；
- repair4：QA 因未看到 confirmed 状态而 BlockTask（已由 `workflowContext` + prompt 规则修复）；
- 这些失败没有降低验收标准，也没有被当作通过。

---

## 4. P1-C · JSON 修复可靠性

### 4.1 修复

`cognition-executor.ts`：

- 先严格 `JSON.parse`；成功则完全不改内容。
- 失败后只扫描字符串内部，转义 `\x00–\x1F`：
  - `\n`、`\r`、`\t` 用短转义；
  - 其余（NUL 等）用 `\u00XX`；
  - 跟踪反斜杠，合法 `\\`、`\"`、`\uXXXX` 不被改写；
  - 仅在字符串内生效，结构空白不改。
- 二次 parse 失败即 `malformed_output`；不修逗号/括号/非法转义。
- `normalizeOutputShape` 只删除未知字段、补 `reasonRef=0`，缺语义字段仍由 strict schema 拒绝。

### 4.2 测试（8）

- raw newline/tab/CR/NUL 修复且内容精确保持；
- 合法 escaped quote/backslash/`\n` 内容完全不变；
- 缺括号/trailing comma → 仍拒绝；
- 非法 `\x41` → 仍拒绝；
- 额外 `steps_notes` + 缺 `reasonRef` → 接受（只归一化非语义字段）；
- 缺 `plan.goal` → schema_violation（不被归一化掩盖）。

---

## 5. P1-D · 工作流分支

`workflow-generation.ts` 每个能力阶段都有：

```
completed → 下一阶段 / approval
rejected  → fail(reason: stage-N_rejected)
failed    → fail(reason: stage-N_failed)
```

- `generated-failed-branch.test.ts` 4 项通过：
  - 每个能力阶段都有 failed transition；
  - 真实 `Task.Failed` → `stage-1_failed`，不走 rejected；
  - 真实 `Task.Rejected` → `stage-1_rejected`；
  - 真实 `Task.Cancelled` → `InstanceAborted(reason=task_cancelled)`，不完成。
- F2 的 pause 分支测试仍通过（completed/rejected/cancelled/failed）。

---

## 6. 测试与门禁

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 53/53，exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm architecture:check` | 10 files / 55 tests，exit 0 |
| `turbo run build --force` | 33/33，0 cached |
| `pnpm test`（默认并行） | 188 files / 1322 tests，**1 failed**：`preview-runtime-http` 65.9s timeout；1321 passed |
| `pnpm test` 重跑（默认并行） | 同样 1 failed：preview 61.8s timeout；其余 1321 passed |
| `pnpm exec vitest run tests/integration/preview-runtime-http.test.ts` | 2/2 通过，1.45s |
| `pnpm exec vitest run --maxWorkers=2` | **188 files / 1322 tests 全部通过**，72.8s |

结论：默认并行的唯一失败是已知的 preview 子进程启动超时，单跑与 2-worker 全量均通过；未修改断言或测试逻辑。与基线 1307 tests 相比 +15 tests，全部来自本轮新增/补强。

日志：`.maoeh/acceptance/m2-1-{full-test,full-test2,full-test3,full-test-2workers,preview-single,typecheck2,lint2,architecture2,build-final}.log`。

---

## 7. Live 证据清单

- 事件日志：`.maoeh/acceptance/m2-1-live-repair5/events.jsonl`（153 events）
- 事实汇总：`.maoeh/acceptance/m2-1-live-repair5/facts.json`
- 浏览器报告：`.maoeh/acceptance/m2-1-live-repair5/browser-report.json`（ok=true）
- 截图：`.maoeh/acceptance/m2-1-live-repair5/screenshots/01…06`（沙盘会话、任务书、Canvas、Results 审批、完成）
- 交付物原文件：`task-3-index.html`（6213 chars）、`task-4-index.html`（2962 chars）
- 失败过程证据：`.maoeh/acceptance/m2-1-live-repair3`、`repair4`（保留，未覆盖）
- 原始 M2.1 证据：`.maoeh/acceptance/m2-1-live/**` 未改动

Live 关键事实：

- `llm: live / deepseek-flash / callCount 17`
- `workflow instance-1: completed`
- `approval: granted by ceo-alex`
- 5 tasks 全部 completed；无 Rejected/Failed
- `brief-1.sourceSessionId = sandbox-session-20261114181811-3167`

---

## 8. 剩余风险与未解决问题

1. **默认并行全量仍有 preview 超时**：单跑/2-worker 通过，说明是并行资源竞争；未改测试/断言，仍需后续在 CI 层限制并发或延长该测试的进程启动预算（本轮不调整阈值）。
2. **Live 沙盘评分仍可能不可解析**：成功 run 的沙盘显示“评分未能解析”，但不影响真实 AI 任务执行；brief 仍可用，验收标准部分依赖兜底。
3. **模型仍会输出额外对话/半段计划**：continuation 修复了 accepted/started 的后续 turn，但模型可能发大量消息；本轮 live 仍产生 13 cycles。不是闭环阻塞。
4. **blocked 任务不受 watchdog 处理**：repair4 的 QA BlockTask 暴露了这一点；本轮用 `workflowContext` + prompt 规则避免误 block，但若 agent 真正 BlockTask，实例仍可能长期 blocked。未在本轮扩展 blocked 的自动恢复语义。
5. **45 tick 阈值未改**：心跳覆盖 inference/tool，但若进程/模型长时间无任何心跳，仍会在 45 tick 后终止；没有无限延长。
6. **3001/5173 未重启**：正式演示栈仍是旧进程/旧构建；本轮只在 3210/5180 隔离 live 验证。现场演示前必须按既有方案重启并复验。
7. **工作流上下文只含已完成步骤的 evidence keys**：不包含完整交付物内容；下游 QA 可据此判断证据存在，但无法在 prompt 中直接读取 6KB HTML。
8. **未提交代码**：按要求 HEAD 仍 `79b890b`，所有修复在工作区，等待人工审查；未清理 19 个 web 并行改动。

---

## 9. 是否达到完整闭环验收条件

**达到（在隔离 live 环境下）。**

本轮真实模型链路已经完成：

```
沙盘（4 条真实消息）
  → brief-1（sourceSessionId）
  → 生成式工作流（6 节点 / 17 transitions）
  → Canvas 人工确认
  → 5 个 AI 员工任务（accept/start/submit/completed，无 watchdog reject）
  → 真实 index.html 交付（6213 / 2962 chars）
  → Testing QA 报告
  → Results 人工 Approve（ceo-alex）
  → Workflow.InstanceCompleted
```

但“默认并行全量测试”仍有 preview 超时，且 3001/5173 未重启；因此这是**隔离 live 闭环通过**，不是正式演示环境冻结通过。

本阶段停止，等待人工审查。
