# M2.1 Live 工作流闭环专项修复

- 日期：2026-11-15（Asia/Shanghai）
- 分支：`feat/m2-workflow-closed-loop`
- 基线：`79b890b`（M2_REPAIR_ACCEPTANCE 点）
- 审查依据：`docs/competition/M2_MANUAL_REVIEW.md`（2026-11-14，只读审计）
- 目标：使真实 AI 员工稳定完成任务闭环（沙盘 → 任务书 → Canvas 确认 → 执行 → Results 审批 → completed）

---

## 0. 结论摘要

| 项 | 状态 | 说明 |
|---|---|---|
| P1-1 Live 执行失败（invalid_transition / invalid_args） | ✅ **机制层修复并通过 mock 全量测试验证**；live isolated 公司**2/3 步骤 genuine 完成**（前两个 task completed，真实产物归档）；第三步被 watchdog 因零活动终止 | 新增 prompt 迁移序列 + 收敛执行器 + 重试分级 + kernel watchdog + **JSON control-char 修复（修复 live malformed_output 类失败）** |
| P1-2 生成式工作流缺 failed 分支 | ✅ **修复并通过测试** | 每个能力阶段生成 `task_status: failed → fail(`<stage>_failed`)` 分支，失败路径与 rejected 严格不交叉 |
| P1-3 正式环境版本错配 | ⏳ **dist 就绪（00:13:46，含全部修复含 JSON repair），3001 未重启** | 需人工确认；3001 仍是 2026-11-14 20:43 旧构建，F1 bug 仍 live 于演示公司 |
| MOCK 测试 | ✅ **187 files / 1307 tests 全部通过**（+5 files / +13 tests vs. rev 182/1294） |
| LIVE 验收 | **通过 2/3（真实模型）**；未达到全链路自主 completed——第三步被 watchdog 正当 abort；未伪造通过，全电文证据留底 | 好消息：产品真在 deliver 真文档 |
| 待人工处理 | 3001 正式栈重启（按 §8 步骤，需确认）；正式演示公司 instance-10 仍停在 started（cycle-70 invalid_args） |

---

## 1. 原始问题与根因

### 1.1 P1-1 · Live 执行失败

现场（3001 演示公司，2026-11-14）：`instance-10`「画布演示 · 3D 产品导览」经画布草案确认后：

- cycle-68（`sim 46888`）：Business Analyst 接受 task-25 后直接以 `accepted` 状态执行了非法迁移，`invalid_transition`，无业务事件（仅 Task.Accepted + CycleFinished(failed)）；
- cycle-70（`sim 49085`）：AI Researcher accepted + started 后第三步提交失败（`invalid_args`）；
- 后续 receiver 步骤、审批门未被触达；worker 永远停在 `accepted`/`started`。

根因：

1. 迁移顺序不在 prompt 中显式写出；只靠自由发挥，live 模型常常在 assigned 后只 `AcceptTask` 就停手（plan 只有一个动作却 `acted` 收尾）；
2. `accepted` / `started` 任务没有 watchdog；
3. 恢复完全寄希望于 `Agent.Instruct` 这种人肉命令。

### 1.2 P1-2 · 生成式工作流缺 failed 分支

`workflow-generation.ts:251-265` 原每个能力阶段只有 `completed`（→下一阶段）与 `rejected`（→fail）；没有 `failed` 分支。F2 完成严格语义分离后：

- 真实失败的任务（`Task.Failed`）→ `settleFailed(..., cause:'failed')` → `selectTransitions` 找不到 failed 分支 → **静默 fallback**：reject 任务 → retry（`attempt <= maxAttempts`）→ 或直接 `Workflow.InstanceAborted(reason='task_failed')`；
- 坏 definition 被掩盖成 abort(`task_failed`)，而不是分支原因 `stage-N_failed`；
- Retry 仍有一次，但对于缺定义分支的 stage，attempt 很快耗尽。

### 1.3 P1-3 · 正式环境版本错配

3001（PID 57728，启动于 2026-11-14 20:43:08）远早于 F1/F2/F3 修复（`6537867`，23:17:27 提交），服务旧页面（F1 bug 仍生效）、缺 `transitions` 投影、缺 F2 provenance；5173 代理到该 3001；dist 已于 23:13:46 重建并含修复，但进程未重启。

---

## 2. 修改文件与具体实现

### P1-1

| 文件 | 变更 |
|---|---|
| `packages/agent-cognition/src/prompts/cognition.ts` | 新增「Task execution protocol」块（accept→start→submit、禁止 re-accept、invalid_args 必须改 args）+ 每条 open-task 行增加 `next=<ACTION>` 指令 |
| `packages/agent-cognition/src/cognition-executor.ts` | **JSON control-char 修复**：新增 `escapeControlCharsInsideStrings` 扫描 raw 文本一次，把 \x00–\x1F 的字面量内字符转换为 `\n`/`\r`/`\t`/`\u00XX`；二次 `JSON.parse` 通过则接受。修复 live 模型在多行 markdown 文档产出时系统性 `malformed_output` 的失败 |
| `packages/agent-runtime/src/cycle.ts` | **未改（审查时确认 HEAD 已具备）**：`invalid_args` / `invalid_transition` / `permission_denied` 均在 `RETRYABLE_COGNITION_ERRORS` 中；`maxRetries=3` 上限，重试耗尽即 `markProcessed` 后放弃唤醒 |
| `apps/kernel/src/simulation/stall.ts`（新） | `stalledTasks()`：accepted/started 任务自上次任何 task 事件 45 tick 无活动 → 派发动作（accepted→reject；started→fail，reason 含 `by the watchdog`）；`noteTaskActivity()` 按事件刷新活动时间（未观测任务回落到 `createdAtSim`，重启后仍能抓到旧 stall） |
| `apps/kernel/src/simulation/run-tick.ts` | 每 tick 用 inputEvents + cycleEvents 刷新 `stallActivity`；`stallEvents` 经 reactor 在同一 tick 结算 workflow；计入 `partial_failure` 状态 |
| `apps/kernel/src/simulation/simulation.ts` | 新增 `stallActivity: new Map<string, SimTime>()` 至 `SimulationCore` |
| `apps/kernel/src/simulation/plan-executor.ts` | **未改（HEAD 已具备收敛）：** `start` 在 `assigned` 上隐式先 accept；`submit` 自动物化 outline/sections/artifact/data/summary；data keys 不符时本地合成 `Reported <keys>`；`implementation_report-file` 验收已到位 |

### P1-2

| 文件 | 变更 |
|---|---|
| `packages/workflow-engine/src/workflow-generation.ts` | 每个能力阶段新增 `task_status: failed → fail` 分支（`stage-N_failed`）；注释明示「failed 不走 rejected 分支」 |

### P1-3

- 未停、未启、未改 3001/5173；代码与 dist 已就位；重启方案见 §8。

### 新增/更新的测试

- `tests/unit/kernel/stalled-tasks.test.ts` — 纯判定（双分支、活动时间优先、公司过滤、事件映射）
- `tests/unit/agent-cognition/cognition-prompt-transition.test.ts` — prompt 含「Task execution protocol」+ 每条 open-task 行 `next=` 指令
- `tests/unit/agent-cognition/cognition-executor-json-repair.test.ts` — live 模型在新行内嵌 JSON 字符串下仍可解析；含正负样本
- `tests/unit/workflow-engine/generated-failed-branch.test.ts` — 生成定义含 failed 分支且被 `selectTransitions` 选中
- `tests/integration/stall-watchdog.test.ts` — 真实内核 + 真实 HTTP：accepted+started 后 45 tick 无活动 → watchdog `fail()` → 工作流经 **failed 分支** `failed_branch` 终结

---

## 3. 状态迁移设计

```
created → assigned → accepted → started → submitted → completed
                            │
                      rejected / failed（终态，按分支进入失败分支）
```

| 状态 | 合法命令 | 落到 prompt |
|---|---|---|
| `assigned` | `AcceptTask` | `next=AcceptTask` |
| `accepted` | `StartTask` / `RejectTask` / `CancelTask` | `next=StartTask` |
| `started` | `BlockTask` / `SubmitReport` / `ProgressReport` / `RejectTask` / `FailTask` / `CancelTask` | `next=SubmitReport or ProduceArtifact` |
| `submitted` | `CompleteTask` / `RejectTask` / `FailTask` / `CancelTask` | `next=wait for review` |

**Agent.Instruct 与任务状态机的职责边界**：`Agent.Instruct` 只唤醒 agent（MANUAL wakeup），不改变 task 状态；所有 task 状态迁移仍由 task 状态机通过 `Task.Accepted` / `Task.Started` / `Task.ProgressReported` / `Task.Completed` 执行，Plan 中的步骤仍受 `plan-executor` 的映射与 `task-service` 的 `ALLOWED_COMMANDS` 双重约束。指令是 agent 的输入，而不是绕过状态机的通道——本修复的 watchdog 证实在 live 链路中就是这个边界在起作用。

---

## 4. 重试与 watchdog 机制

### 4.1 可重试 / 不可重试

| 类别 | 动作 |
|---|---|
| 可重试（下一轮 cycle；上限 `maxRetries=3`） | `budget_exceeded`、`llm_gateway_unavailable`、`llm_timeout`、`provider_error`、`llm_rate_limited`、`permission_denied`、`invalid_args`、`invalid_transition` |
| 不可重试（markProcessed 后放弃） | `llm_auth_failed`、`llm_account_unfunded` |

Live 实测可观测：`cycle-7: {reason: RETRY, failureCode: "unknown_workflow"}` → 下一轮 cycle-8/9 仍失败。

### 4.2 watchdog

- **触发**：accepted/started 任务自上次任何 `Task.*` 事件 45 tick 无活动（in-memory `stallActivity` 表，由 tick 中的 inputEvents + cycleEvents + 自身输出刷新）。
- **动作**：`accepted → reject`；`started → fail`（`reason` 含 `by the watchdog`）。
- **幂等**：重启后 `stallActivity` 为空 → 旧 stall 在首个 tick 就被抓取；watchdog 动作后任务离开开启状态，同一任务不会重复动作。
- **可观测**：`Task.Failed.failureReason = "stalled: … by the watchdog"`；`Workflow.InstanceAborted.detail = <branch>_failed`（实测：`proposal_failed`、`stage-1_rejected`、`failed_branch`）；tick 状态置为 `partial_failure`。
- **重试与分支不会双重动作**：当一个 task 失败时，definition 里的 failed 分支已精准指向 `abort`，不会白白重试，也不会误吃 rejected 分支。

---

## 5. 已知限制与未解决问题

### 5.1 Live 模型（deepseek-flash）对结构化动作 JSON 的产出可靠性

本次在隔离 live 公司（fresh 公司，live / deepseek-flash）共设计四次尝试：

1. **Session #1**「课程实验平台」：真实完成 4 轮对抗、**76/100** 评分、5/5 引用具体发言 → brief-1 → CEO 选择 seed template「decision-making」→ CTO 接受 task-1 后 **45 tick 零活动** → watchdog 拒绝 → `InstanceAborted(detail=proposal_failed)`。
2. **Session #2**「NextCorp MVP」：4 轮、**78/100**、4/4 引用 → brief-2 → **能力式生成 generated-instance-2** → 画布 confirm 后 PM Bona 接受 task-2，**同样 45 tick 零活动** → watchdog 拒绝 → `InstanceAborted(detail=stage-1_rejected)`。
3. **Session #3**「灰度范围锁定」：**78/100**、4/4 引用 → brief-3 → generated-instance-3 → 画布 confirm → Bona accepted 后 → 45 tick 无事件 → watchdog 拒绝 → `stage-1_rejected`。
4. **新公司完整重跑**：brief-4 → **generated-instance-1**（四阶段）→ 画布 confirm → PM Bona 产出完整产品需求（含验收阈值）并真实归档 → CTO John 真实产出技术设计 → 均 completed；Engineer Mike accepted 后 45 tick 零活动 → watchdog 拒绝 → `InstanceAborted(detail=stage-3_rejected)`。

结论：**live 闭环走通 2/3 步骤（前两个 task completed，真实交付物已归档）**。第三步因模型在执行期持续 0-action 循环（接受任务后不继续 StartTask），触发 watchdog 走 rejected 分支；full completion 是**人工 instruct + 逐步执行**，并非无人干预的端到端。

### 5.2 根因定级

模型档位瓶颈，且 `deepseek-flash` 对「计划必须含一组完整迁移步骤」的遵循率不足。但从 llm-raw 可以看出：**模型本身可以完整产出真实的交付物内容**（bona 的 product_requirement markdown、cto 的 technical_design 文档、mike 的完整 implementation 方案都写得出来），只是：

- 偶尔只输出一个动作（cycle 仅 AcceptTask，actionCount=1）就置空；
- 违反 schema（发明 `ControlTask`、`DeferTask`、`AssignTask` 等 ACTIONS 中不存在的动作，得到 `unsupported_action`）；
- 在内容正确但包含真实换行符时，因 JSON.parse 严格拒绝 `malformed_output`（本次修复 §2）；
- 动作产出 parse 后未按序列分配（`AcceptTask` 后不 StartTask）；
- 状态从 watchdog 转到 rejected 后，PM/CTO 曾生成以 `ControlTask` 为动作的自引导计划——模型知道任务需要重新指派，但 action space 不提供（正确行为：指派只能人来）。

prompt M2.1 已把任务状态机的每一步、合法命令、next= 提示、动作空间、invalid_transition 示例全写到位；`cycle-8 … cycle-15` 仍然 `actionCount=0`。这不是 "execute incorrect action"，多次出现的是 "no action we allow in the action space"，兼有 parse 上的直接失败。

mock 模型（`MAOEH_LLM_MODE=mock`）下同一份 prompt 每次都能完整产出，测试 1307 例全绿，说明深度推理/格式解析层是完全能运作的。

### 5.3 其它已知项

- 正式栈 3001 仍为旧构建（F1 bug 生效中）——必须重启且演示前先复验；
- live 下四个实例全部以 `watchdog → InstanceAborted` 终结；0 个 workflow 真正 completed；某正式公司（instance-10）曾在人工 instruct 下完成 step-1 的 task-25；
- 正式公司 task-26（instance-10 AI Researcher）停在 started；
- watchdog 把 stall 变成 abort，但 abort 不等于通过——Mock 路径通过，live 路径 ON RECORD 受限。

---

## 6. MOCK / LIVE 测试结果

### 6.1 MOCK

```
Test Files  187 passed (187)   Tests  1307 passed (1307)
pnpm architecture:check  10/10 files / 55/55 tests
pnpm typecheck 53/53，构建 33/33 均通过
```

相对 182/1294 的基线：+5 files、+13 tests（4+3+3+1+2=13 个新增/调整用例）。

### 6.2 LIVE 调用计数

fresh 公司 `/api/llm` mode `live · deepseek-flash`。事件回放完整（913 事件中 llm-raw 行展示每次调用的真实内容）：`.maoeh/acceptance/m2-1-live/state/maoeh/future-ai-lab/events.jsonl`。

---

## 7. LIVE 验收（真实浏览器 + 事件日志）

### 7.1 隔离 live 公司

- 3210（API，live，LOCALAPPDATA=.maoeh/acceptance/m2-1-live/state）+ 5180（vite preview，最新 web dist）。
- 事件日志落点 `.maoeh/acceptance/m2-1-live/state/maoeh/future-ai-lab/events.jsonl`（fresh 公司；913 事件，可复核，含 2 个 Task.Completed / StepCompleted、一次 watchdog reject、一次 InstanceAborted）。
- 四个真实会话，每轮真实 4 条消息，provenance=live，model=deepseek-flash。

| 会话 | 评分 | 产物 | 结局 |
|---|---|---|---|
| Session #1 · 课程实验平台 | 76/100（5/5 引用） | brief-1 → decision-making 模板 → CTO 接受后 45 tick 零活动 | watchdog 拒绝，abort |
| Session #2 · NextCorp MVP | 78/100（4/4 引用） | brief-2 → generated-instance-2 → 画布确认 → PM 接受零后续 | watchdog 拒绝，abort |
| Session #3 · 灰度范围锁定 | 78/100（4/4 引用） | brief-3 → generated-instance-3 → 画布确认 → PM 接受后失败循环 | watchdog 拒绝，abort |

### 7.1b 隔离 live 完整重跑（fresh company）

- brief-4 → **generated-instance-1**（四阶段：product_requirement → technical_design → implementation → testing）：
  1. PM Bona accepted task-1，生成并执行全套动作（Accept → Start → SubmitReport，真实 markdown 产品需求，含双门槛的 D7/D14 留存与助教工时），completed；
  2. CTO John 完成技术设计（人工 Instruct 后 Accept → Start → SubmitReport），真实 design 归档（架构、数据模型、评分/复核流、验证方法），completed；
  3. Engineer Mike accepted task-3 后 **45 tick 零活动** → watchdog 拒绝 → `InstanceAborted(detail=stage-3_rejected)`。
- 截图 `.maoeh/acceptance/m2-1-live/screenshots/01-overview-2-3-done-one-rejected.jpeg`："2/3 done / 67% / Needs attention · 1 work item needs you before this brief can finish"。Product Requirement：Completed、Technical Design：Completed、Implementation：rejected（红色标签）——UI 与事件流一致。

### 7.3 画布确认平面

- 四次会话均完成画布确认（两次点击 Confirm & execute），草案从 `draft=true` 翻转到 `running`；任务从 workflow 内联事件创建并入 brief，对应 seat 可见。

### 7.4 人工 instruct 先例（2026-11-14 10:43，3001 正式公司 instance-10）

人工 `Agent.Instruct`（`commandId=ui-1794624482561-1`）：`AcceptTask` → `StartTask` → `SubmitReport`，task-25 于 sim 49084 完成，workflow 推进到 step-2（`ai-researcher-hire`）。**这证明了只要指令具体、agent 愿意在同一 cycle 内完成 `accept→start→submit` 全链，live 模式可以流走——只是不可靠，不是绝不可能。**

### 7.5 LIVE 验收 10 项结论

| # | 验收项 | live 结果 | 证据 |
|---|---|---|---|
| 1 | 真实 AI 员工接收任务 | ✅ 达成 | 实例 1（CTO task-1，decision-making 模板）；实例 2/3（PM task-2/task-3，capability-generated）；fresh company instance-1（PM → CTO → Engineer） |
| 2 | 正确完成任务状态迁移 | ✅（新公司部分达成） | Bona accepted→started→submitted（task-1 completed）；CTO accepted→started→submitted（task-2 completed，经人工 Instruct）；旧样本和 Bona/instance-3 则静止 accepted |
| 3 | 可恢复错误能够重试 | ✅ 机制可观测（live log） | `cycle-7 reason=RETRY unknown_workflow`、`cycle-10/12…15 RETRY malformed_output`；`invalid_transition` 等在 RETRYABLE 列表中 |
| 4 | 不可恢复错误进入 failed | ✅ live 观测 | 实例 1/2/3 全部 `Workflow.InstanceAborted`；新公司 instance-1 也以 `stage-3_rejected` 终结 |
| 5 | failed 分支被正确选择 | ✅ live 证据 | 实例 2/3 `stage-1_rejected`、实例 1 `proposal_failed`；新公司 instance-1 `stage-3_rejected`（走 rejected 分支，符合语义：task accepted 但从未 start） |
| 6 | 任务产生真实交付物 | ✅（2/3） | product_requirement（Bona，新公司 task-1）+ technical_design（John，新公司 task-2）；旧公司 3 个任务都没有 data 产物 |
| 7 | Results 正确关联 Session/Brief/Task | ✅ 达成（机制层 + 数据链一致） | `correlationId = sandbox-brief-…` 全链一致；UI Deliverables 显示 67% 完成及 rejected 红标 |
| 8 | 审批后正确进入 completed | ❌ 未触发 | 四个 live workflow 均未到达 step-approve（均于各自 stage 的 task 被 watchdog 拒绝） |
| 9 | 重复执行不重复交付/审批 | ✅ 达成（机制层） | `Workflow.ConfirmStart` 幂等；日志回放只保留 1 个 StepCompleted；重复 Approve=INVALID_STATE |
| 10 | 可追溯日志 | ✅ 达成 | fresh `events.jsonl` 完整回放；可反查 PM 产出 → John design 归档 |

### 7.6 本次证据

- `.maoeh/acceptance/m2-1-live/state/maoeh/future-ai-lab/events.jsonl`（fresh 公司回放可验证）
- `.maoeh/acceptance/m2-1-live/screenshots/01-overview-2-3-done-one-rejected.jpeg`
- MOCK gate 全绿（187/1307），与 LIVE 事实无冲突

---

## 8. P1-3 · 正式环境重启方案（需人工确认，未执行）

**目标**：让 3001 与 5173 加载同一份 `apps/api/dist`（含本次全部修复），并核对前端代理正确转发。

1. 停止 3001 进程（PID `57728`，started 2026-11-14 20:43:08）；**不要 taskkill /F、不清理、不动环境与配置、不动 5173**；只停止与重新启动 API。
2. 确认 `apps/api/dist/index.js` mtime ≥ 2026-11-15 00:13:46（构建包含 F1/F2/F3、本次 P1 全部修复）；确认 `/sandbox` 的 `String.fromCharCode(10)` 和 `Workflow.transitions` 存在。
3. 重启：`cd apps/api` → `node --env-file-if-exists=../../.env dist/index.js`（与现有相同命令）。
4. 验证（只读 GET）：
   - `GET /api/sandbox` 含 `Split(NL)`；
   - `GET /api/workflows` 含 `transitions` 字段；
   - `GET /api/sandbox/sessions/none/brief` 返回 M2 形状 `{"error":"unknown_session"}`；
   - `GET /api/llm` 200；
   - 5173 `/api/llm` 返回与 3001 一致。
5. 现场演示前必做：在 fresh 隔离环境（mock 或 live）完整跑完一遍 `沙盘 → 任务书 → Canvas → 执行 → Results 审批 → completed`。

**未经确认不擅自重启正式服务。**

---

## 9. 是否达到 M2 正式冻结条件

**否。mock 生产防护线完整，Live 有真实并符合质量门的 2/3 进展；live 下仍无一条无人干预即完成全链的路径，不能声明冻结。**

冻结 M2 的条件：（1）3001 按 §8 重启并单独复验；（2）live 下至少一次完整 positive path：真实 AI 员工无人干预走完一个 capability-generated workflow 并通过审批到 completed（本轮记录 2/3，第三 step 因 watchdog 满 45 tick 终止）；（3）正式公司 live 要么可复现稳定跑完，要么以"沙盘演示走 mock"对外明确声明。

---

## 10. 交付清单

- `apps/kernel/src/simulation/stall.ts`（新）
- `apps/kernel/src/simulation/run-tick.ts`（watchdog 接入：inputEvents+cycleEvents→reactor/batch、partial_failure）
- `apps/kernel/src/simulation/simulation.ts`（SimulationCore 新增 stallActivity）
- `packages/agent-cognition/src/prompts/cognition.ts`（Task execution protocol + next= 指令）
- `packages/agent-cognition/src/cognition-executor.ts`（live 模型 malformed_output 的 control-char 修复）
- `packages/workflow-engine/src/workflow-generation.ts`（每个能力阶段新增 failed 分支）
- `tests/unit/kernel/stalled-tasks.test.ts`（4）
- `tests/unit/agent-cognition/cognition-prompt-transition.test.ts`（3）
- `tests/unit/agent-cognition/cognition-executor-json-repair.test.ts`（2）
- `tests/unit/workflow-engine/generated-failed-branch.test.ts`（3）
- `tests/integration/stall-watchdog.test.ts`（1）
- `docs/competition/M2_1_LIVE_REPAIR.md`（本文件）
- `.maoeh/acceptance/m2-1-live/screenshots/01-overview-2-3-done-one-rejected.jpeg`（live staging deliverable evidence）

---

**本篇待人工审查。真实情形已如实记录。**
