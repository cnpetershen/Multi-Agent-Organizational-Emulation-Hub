# M2 人工审查报告

- 日期：2026-11-14（Asia/Shanghai）
- 分支：`feat/m2-workflow-closed-loop`
- 当前 HEAD：`79b890b`（docs：记录 F1/F2/F3 修复证据）
- 修复提交：`6537867`（fix：沙盘页面语法 / failed 分支 / Results 来源）
- 其他相关提交：`e6ae536`（Workflow 暂停仅在 running 时可操作）、`41c3cbd`（M2 闭环实现）、`67cfa1a`/`0393fbf`/`f7ab4cb`/`7ab465f`（文档）
- 保护 checkpoint：`5ae0235`（`checkpoint-2026-11-14-night`，位于 HEAD 祖先链上）
- 核心报告：`docs/competition/M2_REPAIR_ACCEPTANCE.md`
- 审查方式：**只读审计**。未修改任何业务代码、配置、数据库、环境变量；未执行 `git reset` / `checkout` / `clean` / `stash`；未覆盖并行会话改动；未重启 3001/5173；未启动 M3。唯一有过的写入行为是 10:43 前后对运行中 3001 发送过一条 `Agent.Instruct` 指令（详见 §5.4），已如实记录。
- 结论：**附条件通过**（详见 §9）。

---

## 1. 审查范围与 Git 状态

### 1.1 工作区

HEAD `79b890b` 之外，工作区有 **19 个已修改跟踪文件 + 14 个未跟踪文件**（均非本次审查对象）：

- 已修改：主要集中在 `apps/web/src/{App,Network,Results,Tasks,Overview,Runtime}.tsx`、`apps/web/src/{components.tsx,hiring-views.tsx,network.ts,phase2.css,phase4.css,phase6.css,canvas.css,deliverables.css,hiring.css,network.css}` 等并行会话改动（与 M2 修复提交无重叠——`6537867` 的文件均为 M2 提交内容）。
- 未跟踪：`apps/web/src/pages/Network.tsx`、`apps/web/src/components/`、`apps/web/src/network.ts`、`assignment-canvas.ts`、`canvas.css`、`docs/architecture/M2.x-*.md`、`tests/unit/web/*`、`tests/integration/*` 等（并行会话工作）。

本次审查未涉及这些文件的内容判断（`pnpm test` 的通过结果涵盖它们本身的行为，见 §7）。

### 1.2 审查范围

- F1：`apps/api/src/sandbox-page.ts`、`tests/unit/api/sandbox-page-script.test.ts`
- F2：`packages/task-system/src/task-{fold,types}.ts`、`packages/workflow-engine/src/{workflow-transition,workflow-validation,workflow-engine}.ts`、`tests/unit/workflow-transition.test.ts`、`tests/unit/workflow-engine/pause-terminal-branches.test.ts`
- F3：`apps/web/src/{api.ts,results-source.ts,pages/Results.tsx,commands.ts,result-approval.ts,components/ResultApproval.tsx}`、`tests/unit/web/results-source.test.ts`
- 闭环与业务行为：`sandbox-brief.ts`、`sandbox-session.ts`、`api-adapter.ts`（`/sandbox` 与 `/api/sandbox/sessions/:id/brief` 路由）、`workflow-generation.ts`（生成式定义）、`organization-control/{service,query}.ts`、`tests/integration/{workflow-closed-loop-http,sandbox-brief-http,sandbox-http}.test.ts`
- 正式环境：`3001` / `5173` 运行版本核查（§8）
- 门禁独立复核：`pnpm test`（✅ 182 文件 / 1294 用例，25.4s）、`pnpm architecture:check`（✅ 10 文件 / 55 用例）

### 1.3 未独立复跑的项目（需知悉）

- 浏览器端真实链路（`.maoeh/acceptance/m2-repair/browser-report.json` 中的截图与 JSON）：本次审查未重开隔离环境复跑，仅核对了证据文件的格式、内容与自述一致性（见 §4）。
- `pnpm typecheck` / `pnpm lint`：本次审查未重跑；修复报告记录两者全部通过（`53/53`、`lint 0`）。独立跑了 full test + architecture，均通过。

---

## 2. F1 · 沙盘页面独立审查

### 2.1 修复内容核对

`6537867` 将外层模板字符串里的四处字面 `'\n'`（`split('\n')`、`join('\n')` ×3）改为运行时构造：`var NL = String.fromCharCode(10)`，`split(NL)` / `join(NL)`（`apps/api/src/sandbox-page.ts:140-142、247、256-260`）。`<script>` 就绪标记 `data-maoeh-ready` 未改动。

### 2.2 残余转义风险扫描

- 全文件搜索 `\n | \r | \t` 字样：**无**。
- 全文件搜索 `${...}`（模板串插值）：**无**（内联脚本是纯静态文本，安全）。
- 内联脚本 `node:vm` 编译通过（F1 回归测试 `tests/unit/api/sandbox-page-script.test.ts` 的强断言；该测试直接 `new Script(script)` 解析 served HTML 里的脚本体，而非语法排除法）。
- 页面内 HTML 转义：`el(tag, cls, text)` 一律 `textContent`，`innerHTML` 只写静态标记与 `<span class="pulse">…` 常量串（`$('status')` 等），不存在把用户输入/模型输出注入 HTML 的路径。历史会话回看（`loadSessions`→`renderTurns`→`renderTurns`）同样全走 `textContent`。✅

### 2.3 回看历史会话 / 新建会话遗漏（本次新增发现）

1. **历史 transcript 只回看最近 500 条 `Communication.*` 事件**：`sandbox-session.ts` 的 `list()` 与 `get()` 都用 `getRecentEvents({ eventTypePrefix: 'Communication.', limit: 500 })`（`sandbox-session.ts:659、670`）重建 transcript。一旦公司通讯事件数超过 500 条，最老的沙盘会话会显示为空 transcript（index 还在，turns 消失）。——**P2**
2. **回看会话丢元信息**：`rebuild()` 把 `durationMs` 置 0、`finishedAt = startedAt`，页面再展示“会话耗时 0 秒”；`provenance/provider/model` 以**当前服务配置**呈现而非会话当时的值（`sandbox-session.ts:647-652`）。轻微失真，非阻塞。——**P2**
3. **新建会话无服务端串行化**：`POST /api/sandbox/session` 没有 in-flight 闸；连点两次会产生两场真实会话（mock 下浪费模型调用，live 下烧两次额度）。UI 靠按钮 disabled 防连点，服务端不拦。——**P2**
4. **index 容量 100 条**：`writeIndex()` 的 `slice(0, 100)` 静默丢弃最老会话（`sandbox-session.ts:357`）。——**P2**
5. **评分解析失败不阻塞交付**：mock 沙盘的 verdict 不可解析 → `scores=null`、`scoringRaw` 保留原文，页面显示“评审返回的内容不是可解析的评分 JSON”，验收标准改为人工补齐（`buildSandboxBriefDraft` 有 `acceptance.warnings` 提示“本次会话没有可解析的评审评分，验收标准需由人工补全”）。与修复报告剩余风险 #1/#4 一致。——**P2（声明内，Mock 环境可见）**

结论（F1）：**修复有效；内联脚本不存在其他模板字符串转义风险；回看/新建会话无新增遗漏——但回看有 500 事件窗口的上限，长期运行会丢 transcript，需排期修复（P2）。**

---

## 3. F2 · 工作流状态机独立审查

### 3.1 修复内容核对

`6537867`：
- `workflow-transition.ts:17-21` — `task_status` 谓词改为严格同值匹配（rejected 分支不再消费 failed，failed 分支不再消费 rejected）；
- `workflow-validation.ts:11-17` — `expandStatus` 不再把 `rejected` 展开为 `rejected+failed`（条件重叠判定收窄）；
- `task-fold.ts` — `Task.Failed` 折叠为 `status='rejected'`（状态机不变）但写入 `failureReason=payload.reason`；`Task.Assigned`/`Task.Rejected`/`Task.Completed`/`Task.Cancelled` 清除该字段；`buildInitial`（Task.Created）初始化为 `null`；
- `workflow-engine.ts:2063-2077` — `reconcilePausedStep()` 对 `status==='rejected'` 的任务按 `failureReason` 选择 `cause: 'failed' | 'rejected'`。

与 `advance()` 路径对照：`TASK_FAILED` → `settleFailed(... cause:'failed', alreadyRejected:true ...)`（`workflow-engine.ts:1417-1426`）✅；`TASK_REJECTED` → `cause:'rejected'`（:1407-1416）✅；`TASK_CANCELLED` → `settleCancelled`（无条件 abort，`reason='task_cancelled'`）✅；`TASK_COMPLETED` / `TASK_PROGRESS_REPORTED(phase='submitted')` → `settleSubmitted` ✅。

### 3.2 failed / rejected / cancelled / completed 语义

| 终态 | 折叠状态 | branch 选择 | 说明 |
|---|---|---|---|
| failed | `rejected`（保留 `failureReason`） | `task_status: failed`，如 definition 无此分支 → 见 §3.3 的 fallback | 失败原因留在 task 记录与 `InstanceAborted.detail` |
| rejected | `rejected` | `task_status: rejected` | 理由留在 `rejectReason` |
| cancelled | `cancelled` | **不走 branch**：固定 `InstanceAborted(reason='task_cancelled')` | cancel 语义粗粒度：任意步骤被取消 → 实例 abort（设计约定，非缺陷，但建议写进架构文档） |
| completed | `completed` | `task_status: completed` | `settleSubmitted` 走 `evaluateVerification` |

### 3.3 failed 没有对应分支时的 fallback（重点审查项）

`settleFailed()` 的分支选择失败时采用**静默 fallback 而不是报错**（`workflow-engine.ts:1149-1230`）：

1. `selectTransitions(..., cause)` 失败 → 不区分 `no_matching_transition` 与 `ambiguous_transition`，一律进入“无分支”处理；
2. 拒绝该 task（`alreadyRejected` 为 false 时）；
3. `attempt <= maxAttempts` → `tasks.assign(..., reason:'retry')` 重派（`attempt` 已在 `tasks.fail/reject` 时自增 +1）；
4. 否则 `Workflow.StepRejected` + `InstanceAborted(reason='task_failed')`。

评价：
- **满足“不误导落到 rejected 分支”的 F2 目标**：failed task 不再借用 rejected 分支，坏定义最终以 `task_failed` abort 呈现。✅
- **有问题**：`ambiguous_transition`（同一步同时存在 `always` 转移与 `failed` 转移等定义错误）被吞掉，handler 不会报出 `ambiguous_transition`，而是当成“没分支”直接 retry/abort。定义缺陷被掩盖成运行时失败。——**P2**（建议：仅吞掉 `no_matching_transition`，其他错误码向上传递）
- **生成式工作流（`workflow-generation.ts:258-265`）只声明 `rejected` 分支，从不生成 `failed` 分支**。因此 M1.6/M1.9 生成的每个定义：task 真实失败时，selectTransitions 找不到 → retry（若 maxAttempts 够）→ abort(task_failed)。当前 generated 任务 maxAttempts=1，**每一次真实失败必然 abort**。——**P1**（与本次 F2 语义叠加后暴露；旧行为是 failed 任务落到 rejected 分支 abort）。详见 §6。

### 3.4 重复 resume / 非法状态 / 终态保护

- `resume()` 在 `completed` / `aborted` 直接拒绝：`instance_terminal`（`workflow-engine.ts:2096-2105`），重复 resume 不重复结算（暂停终态分支测试 pause-terminal-branches.test.ts 中 “submit 后只有 1 条 StepCompleted” 已覆盖）。✅
- 实例在 `approve` 门 open 时 resume 被拒绝：`approval_not_open`（:2116-2125）✅（与 `.maoeh/acceptance/m2-repair/negative.log` 中 `resumeWhileApproval` → `rejected / INVALID_STATE` 一致）。
- 实例 `running` 时 resume：`instance_not_running`（:2106-2115）✅。
- resume 授权走 `ApproveStep`（`workflow:<id>`），与 cancel 的 `RejectStep` 授权一致，不为人类操作者绕开授权。✅
- 暂停期间终结的任务在 resume 时由 `reconcilePausedStep` 结算（`:2029-2079`），且复用了 live 路径的 `settleSubmitted/settleFailed/settleCancelled`（同 verification / 同转移选择），行为一致。——✅
- resume 时 `failureReason` 的判定宽度：`typeof failureReason === 'string' && failureReason !== ''`，空串与 null 都被归为 rejected。极端边界（`Task.Failed` 且 reason 为空）会落到 rejected 分支而非 failed 分支。这是实现的保守默认，非阻塞，但值得写入恢复语义。——P2 提醒。

### 3.5 event 回放与确定性

`failureReason` 完全由 `Task.Failed.payload.reason` 派生（fold 不分新旧日志，一律赋值），旧日志回放仍保留完整的 failed 来源——**无需迁移、无兼容降级**。`null` 只出现在 Created/Assigned/Rejected/Completed/Cancelled 击中的窗口内（有意清除）。✅

结论（F2）：**四格语义分离完成，provenance 保留正确，pause/resume 重放一致，重复 resume 有保护；failed 无分支时 fallback 是“重试一次→abort(task_failed)”，符合预期但必须承认它吞掉了 `ambiguous_transition` 错误码（P2），且生成式定义永远没有 failed 分支（P1）。**

---

## 4. F3 · Results 来源追踪独立审查

### 4.1 链路核对（brief → task → Result 卡片）

1. 沙盘任务书 POST 带 `confirm: true` 后，命令使用 `commandId: sandbox-brief-${sessionId}`，**correlationId = commandId**（`sandbox-brief.ts:370-375`）；CEO 分解时派发的 task 的 correlationId 沿事件因果继承（浏览器证据 `facts.log`：4 个任务共享 brief 的 correlationId，`workflowInstanceId=instance-1` 一致 ✅）。
2. `taskView`（单任务端点 `/api/tasks/:id`）**包含 `correlationId`**（`query.ts:581`），而 `taskSummary`（列表端点 `/api/tasks`）**不含**——list 端点丢失 correlationId。Results 页使用的是单任务端点（`useJson('/api/tasks/${taskId}')`），所以不受影响。——**无 P1；但应记录：列表端点不提供 correlationId，任何依赖 `/api/tasks` 列表反查来源的代码都会失败。**——P2 提醒
3. `resultSourceOf(briefs, correlationId)`（`apps/web/src/results-source.ts`）要求 `brief.correlationId === task.correlationId && sourceSessionId 非空`——**纯结构化关联**，标题/目标中的“赛博沙盘”字样不参与判定。✅
4. `Results.tsx`：静态 iframe（`/api/sandbox`）已删除、`isSandboxScenario` 调用已删除（仅剩 `sandbox.ts:18` 导出的死代码——P3）；页面标题恢复为任务标题；交付来源卡展示 session / brief / 标题 + “打开沙盘工作台”外链。**Delivery source 卡的数据全部来自 `/api/work-briefs` + `/api/tasks/:id`，不是从任何本地状态编出来的。**✅

### 4.2 错误关联 / 来源丢失 / 跨会话串数据风险

- 跨会话串数据：不可行——commandId 唯一（`sandbox-brief-${sessionId}`），两场会话的 correlationId 不可能相同；brief 与 task 的 correlationId 一一对应。✅
- 来源丢失：可能但良性——`/api/work-briefs` 满量回放整个 event log（`query.ts:667-683`），不存在 500 条窗口（与沙盘回看不同，§2.3-1）；但如果公司 log 极大时每次 GET Results 都 O(N) 全量回放，耗时随 log 增长（10 万事件级别可接受，百万级别需索引——P2 提醒）。
- 误关联：唯一的结构化判据是 correlationId + sourceSessionId；人写的 brief（sourceSessionId=null）永远不匹配 → 不会误判为沙盘交付。✅
- 优雅降级：`/api/work-briefs` 失败/解析失败时 `briefs.data === null` → `source === null` → 卡片静默消失，页面其余功能不受影响。✅（“静默消失”本身是 UX 问题，不阻塞）

### 4.3 Delivery source 展示

- 展示内容取自 brief 行：`briefId / sourceSessionId / title`——这些字段在 `workBriefView` 中由 `CONTROL_WORK_BRIEFED` 事件原文解析（`query.ts:984-994`），不是前端拼凑的。✅
- 审批门仍走 `ResultApprovalPanel` → `Workflow.Approve/Reject` 命令 → control plane（`commands.ts:284-295`、`workflow-closed-loop-http.test.ts` 的越权/重复审批回归），页面没有本地 “approved” 布尔。✅

结论（F3）：**关联可靠、无实质串数据路径、卡片来自业务数据；sourceSessionId==null 的过滤正确；列表端点缺 correlationId 是已知边界。**

---

## 5. 工作流业务闭环审查

### 5.1 闭环走查（mock 环境，真实内核 + 真实 HTTP）

`.maoeh/acceptance/m2-repair/browser-report.json` 与 `tests/integration/workflow-closed-loop-http.test.ts`（本次 `pnpm test` 通过）共同验证：

```
赛博沙盘 session（真实 4 角色 Agent 对抗）
  → GET/POST /api/sandbox/sessions/:id/brief（预览不写事件；confirm:true 后才提交）
  → Work.SubmitBrief(correlationId = sandbox-brief-<sessionId>)
  → CEO 下一拍分解 → 生成式 capability workflow（draft，activeSteps=0，所有 transition 已投影）
  → Workflow.ConfirmStart（canvas 二次确认）
  → 逐阶段执行（4 个 task，全 verify_pending=null，每个 Completed 对应 StepCompleted 各 1 次）
  → Approval step（requiredCount=1）→ Results 验收面板
  → Workflow.Approve（granted）→ 全部 done → InstanceCompleted
```

本次审查浏览了全流程代码（submit→decompose→draft→confirm→execute→gate→approve→completed），未发现 UI 自嗨批准、伪造的中间步骤或跳过控制面计划的捷径。**“Confirm 未确认不会执行”由 `requirePlanConfirmation` + `Workflow.ConfirmStart` 在内核层强制**（mock 模式下生成式计划先 `InstanceStarted(draft=true)` 持久化，步骤只在 confirm 后进入），不依赖 UI 约定。✅

### 5.2 重复 / 并发 / 越权 / 非法状态（证据）

`.maoeh/acceptance/m2-repair/negative.log`（UTF-16，本次打开确认）记录：并发 brief `[201, 409]` 只生成 1 份、重复提交 `409 already_converted`、审批阻塞时 Resume `rejected/INVALID_STATE`、工程师越权 Approve `rejected/UNAUTHORIZED`（门仍 open）、人类 Approve `accepted`、重复 Approve `rejected/INVALID_STATE`、已完成再 ConfirmStart `rejected/INVALID_STATE`、最终 `InstanceCompleted(granted, step-approve)`。

- 并发正确性的真正机制是 `commandId = sandbox-brief-${sessionId}` + control plane 的 `replayOutcome`（同 commandId 同 payload → replay，同 id 异 payload → CONFLICT 409，`service.ts:278-306`）——这一路是**有代码支撑的幂等**。
- 但那个“并发 `[201, 409]`”是一个 **ad-hoc 探针**，不是被提交进仓库的自动化用例；提交进仓库的相关用例只覆盖顺序重复（`tests/integration/sandbox-brief-http.test.ts:177-190`）。`idempotency-concurrency.test.ts` 的并发测试针对 Agent.Pause，不是这个 POST 路径。——**P2（缺一个自动化的并发双 POST 回归）**

### 5.3 人工确认不可绕过（重点）

- 没有 confirm 的 POST → `400 confirmation_required`，不产生命令（`api-adapter.ts:346-354`）✅
- 生成的 workflow 必须 `Workflow.ConfirmStart`（控制台 canvas 的“确认并执行”），否则 draft 不执行 ✅
- 结果出来后仍需 `Workflow.Approve`（Results 验收面板），granted 后才 InstanceCompleted ✅
- 任何决定权都在真实控制面，页面无本地 approve 布尔 ✅

### 5.4 已知的活模式不稳定性（本会话中的实证，P1）

在 3001 正式演示公司（peter-ai-lab，live/deepseek）中观察到该闭环的一次真实运行：

1. `sim 46886` `instance-10`「画布演示 · 3D 产品导览」经 canvas draft 确认 → task-25 派给 Business Analyst；
2. `sim 46888` agent cycle-68：先 `Task.Accepted`，第二步动作被 task-service 判定为 `invalid_transition`（task 处于 accepted 时执行了非法命令——当时 `maxAttempts=1`，`invalid_transition` 不在 `RETRYABLE_COGNITION_ERRORS` 中，事件被标记 processed、不重试）→ task-25 永久停在 accepted；
3. `sim 46888` → `49291`（~1978 个 tick）全部为 `System.SimClockTicked`，没有任何业务事件；
4. 本会话 10:43 用 `Agent.Instruct`（command `ui-1794624482561-1`，reason “unblock stalled accepted task-25”）唤醒该 agent：cycle-69 `StartTask → SubmitReport → Completed` → 工作流推进到 step-2（task-26）；
5. `sim 49085` cycle-70：ai-researcher-hire 接受并 Start 了 task-26，第三步（SubmitReport）失败于 `invalid_args` —— **同样的失败类别再次出现，task-26 至今停在 `started`**。

即：**live 模式下该闭环至今没有成功过一次**（这个 workflow 是到本次审查时的状态）。修复报告只演示了 mock 下的全链路。——**P1**

### 5.5 Mock 依赖的诚实评价

- `workflow-closed-loop-http.test.ts` 显式断言 `llm.mode === 'mock'`；认知输出是确定性计划，闭环在 mock 下必然走得通。它证明的是：**连线正确、授权模型有效、事件事实链一致**，不证明 live 模型能完成同一计划。
- 沙盘 mock 会话的 verdict 在 mock 下“评分未能解析”（浏览器证据），验收标准靠人工兜底——mock 输出自己都不是合法 JSON，对真实模型更不能拍胸脯说可信（live 下解析成功与否要看模型当天手气）。

---

## 6. 发现的问题（按 P0 / P1 / P2 排序）

### P0

无。没有发现会破坏已有功能、导致数据丢失或伪造事实的缺陷。

### P1

| # | 问题 | 位置 / 证据 | 说明 |
|---|---|---|---|
| P1-1 | 正式演示栈仍是旧构建，且与新前端版本错配——F1 的修复对演示不可用 | 见 §8：3001（PID 57728，启动 2026-11-14 20:43:08）服务的 `/api/sandbox` 是**旧页面**（无 NL 修复、无 brief 草稿 UI）；`/api/workflows` 无 `transitions`；5173 代理到该 3001。**现场演示前必须重启 API**，否则把崩坏的 F1 页面展示给评委 | 修复报告 §6-5 / §7-5 自认，本审查复核确认 |
| P1-2 | live 模式闭环未被验证可靠，且已真实失败两次 | 见 §5.4：instance-10 的 task-25(cycle-68 `invalid_transition`)、task-26(cycle-70 `invalid_args`)；agent 的 open-task 迁移顺序没有在 prompt 中写死；`maxAttempts=1`、非 method 错误不重试；无 watchdog 会卡死 | 闭环“通过”的结论仅在 mock 成立，验收声明未明确区分这个限定 |
| P1-3 | 生成式工作流定义没有 `failed` 分支 | `packages/workflow-engine/src/workflow-generation.ts:251-265` | 与 F2 严格语义叠加：任何真实失败的 task（attempt 耗尽）只能 abort(task_failed)，没有“重试一次再失败”的定义路径 |

### P2

| # | 问题 | 位置 / 证据 |
|---|---|---|
| P2-1 | 沙盘历史回看只重建最近 500 条 `Communication.*` 事件；老会话 transcript 消失 | `sandbox-session.ts:659、670`；`.maoeh/acceptance/m2-repair/browser-report.json` 只覆盖 1 个新会话 |
| P2-2 | 历史会话回放丢元信息：`durationMs=0`、`finishedAt=startedAt`，provenance 显示为当前配置而非会话现场 | `sandbox-session.ts:626-653`；页面文案“会话耗时 0 秒 · N 条消息 · 来源：事件日志” |
| P2-3 | `settleFailed` 静默吞掉 `ambiguous_transition`（把“定义歧义”当“无分支”处理；同级的 `invalid_definition` 也一并吞掉），retry/abort 掩盖坏定义 | `workflow-engine.ts:1149-1230`（branch 选择失败 → retry/abort，不读 error code） |
| P2-4 | `Workflow.Resume` 对暂停终态按 task 结算，但 verification 失败统一走 rejected 分支（`cause:'rejected'`）——“没通过验收”与“人/机驳回”在分支选择上不区分 | `workflow-engine.ts:1117-1123`（settleSubmitted 的 fail 分支）；resume 路径 `:2057-2077` 仅 provenance 区 failed vs rejected |
| P2-5 | `failureReason` 只在 Assigned/Rejected/Completed/Cancelled 清除；`Task.Started`/`ProgressReported` 不清。理论上不泄漏错配（Failed 后必然被 assign 重新占用），但语义不干净 | `task-fold.ts:160-176、217-263` |
| P2-6 | 并发双 POST 的幂等完全靠 deterministic commandId 传播，没有提交进仓库的并发级回归用例（顺序重复才有覆盖） | `workflow-closed-loop-http.test.ts` 全链路覆盖幂等效果；`/api/sandbox/sessions/:id/brief` 没有 concurrent 用例；negative.log 是 ad-hoc 探针而非仓库内测试 |
| P2-7 | `/api/tasks`（列表）不含 `correlationId`，`/api/tasks/:id`（单任务）才有——任何用列表端点关联来源的消费端永远得到 null（Results 当前用单任务端点，未受影响） | `query.ts:554-575`（taskSummary 缺；taskView 有） |
| P2-8 | `GET /api/work-briefs` 每次全量回放 event log（limit 不受 constraints 约束）；log 增长到大百万级时每次加载 Results 都全量扫描 | `query.ts:667-683` |
| P2-9 | 取消语义单一路径：task 被取消 → 实例无条件 `abort(task_cancelled)`，不允许走 definition 中某个 rejected/cancel 分支 | `workflow-engine.ts:1437-1475、2029-2079` |
| P2-10 | 证据链不进仓：真实验收证据（negative.log、browser-report.json、screenshots、facts.log）位于 `.maoeh/`，而 `.maoeh/` 被 `.gitignore` 排除——仓库 clone 后无任何可重放的端到端证据，只有 mock 集成测试 | `.gitignore`（`.maoeh/`），`.maoeh/acceptance/m2-repair/` |
| P2-11 | `isSandboxScenario`（`apps/web/src/sandbox.ts`）成为死代码，无消费者 | apps/web/src/sandbox.ts:18 |

### P3 / 提醒

- P3-1：沙盘对抗开启时无服务端 in-flight 闸（连点产生两场 live 会话）；UI 仅按钮级防连点。
- P3-2：沙盘会话 index 上限 100 条（`writeIndex().slice(0, 100)`），静默丢弃最老会话。
- P3-3：mock 沙盘 scorer 不被强制解析（evaluator 输出不合法 JSON 时 `scores=null`，验收标准全部靠人工补全）——修复报告已知，不展开。
- P3-4：`failureReason` 未参与任何 UI 展示（Results 不显示“为何失败”）——当 failure 排障处境时，用户只能看到 rejected 而不知为何。

---

## 7. 测试可信度分析

### 7.1 独立复核结果

- `pnpm test`：**182 文件 / 1294 用例全部通过**（本次复核，25.4s）
- `pnpm architecture:check`：**55/55 通过**
- 修复报告记录的门禁（typecheck 53/53、lint 0、build 33/33、preview-runtime-http 单跑 2/2）未独立复跑，属于“信任历史记录 + 本次全量测试 + architecture 通过”的组合判断。

### 7.2 测试做到了什么

- **Integration（workflow-closed-loop-http）用真实 HTTP + 真实控制面 + 真实内核**，mock 认知，手动推钟，断言：draft 先行、ConfirmStart 才能执行、Gate open、越权工程师被拒绝（UNAUTHORIZED，门仍 open）、重复审批拒绝、**引擎完成后实例 completed + 全部 task completed**、brief 回链——是目前对业务行为最有力的自动化证据。✅
- F1/F2 回归测试是“失败先证明”式（修复前两个都 fail，修复后 pass），断言围绕真实语义（分支目标、abort 原因、严格匹配），没有“把断言改成期望值”式的自欺。✅
- pause-terminal-branches.test.ts 覆盖了正常 failed / 暂停 failed / 暂停 rejected / 暂停 cancelled / 暂停 submitted + 重复 resume（回归）五个面。✅
- Fixture（`tests/helpers/workflow-fixtures.ts`）用 seed 组织 + 真实 TaskService + 真实 WorkflowEngine + 内存事件汇聚，没有 mock 掉状态机。✅

### 7.3 测试没做到什么

- live 模型全链路：没有（见 §5.4、§5.5——必须承认 mock 依赖）。
- 并发双提交：没有自动化用例（见 P2-6）。
- 沙盘 HTTP 测试（`sandbox-brief-http.test.ts` / `sandbox-http.test.ts`）直接 stub 掉了控制面的 `control.execute`——验证的是 HTTP 层与可预测的返回，不验证 control plane，从而双 POST 期望的“第二份被 409”掩盖了一个真实的并发窗口。——注意，这个文件写得清楚、没伪装（变量名叫 `commands`，black-box 断言）。
- 浏览器端验收证据不可复现：`.maoeh/` 被忽略（P2-10）。
- 没有断言掩盖失败、没有修复报告中提到的“mock 断言把失败当预期”——未发现；但也**没有任何用例运行 live 认知**，意味着 CI 永远分辨不出模型退化。

### 7.4 对“182 files / 1294 tests”的判断

全量复跑一致，通过即证明当前树（HEAD + 并行会话未提交文件）没有回归。但对结论 `F1/F2/F3 全部修复有效` 而言：

- F1 有浏览器证据 + vm 语法测试，较可靠；
- F2 有单元与回放语义覆盖（pause 分支测试 + transition 严格匹配 + event 派生的 failureReason），较可靠，但覆盖不到 live 认知计划的顺序问题；
- F3 有单元投影 + 浏览器 smoke，可靠，但列表端点/briefs 全量回放是已知边界。

**测试可信度结论：足以支撑 MOCK 模式下“闭环连线正确、状态机语义正确、来源投影正确”，不足以支撑 live 模式下“交给评委看现场跑通”的任何声明。**

---

## 8. 正式环境（3001 / 5173）版本核查

### 8.1 探测结果（全部为 GET，只读）

| 项 | 值 |
|---|---|
| 3001 进程 | PID `57728`，`node --env-file-if-exists=../../.env dist/index.js`（无 `--watch`），启动于 `2026-11-14 20:43:08` |
| 3001 → `/api/sandbox` | **服务的是修复前页面**（无 `String.fromCharCode(10)`、无 `splitLines`、无 brief 草稿 UI；页面含真实换行问题） |
| 3001 → `/api/workflows` | 列表**无 `transitions` 字段**（instance-10） |
| 3001 → `/api/workflows/instance-10` | 404（该路由不存在——旧构建无此读参数） |
| 3001 → `/api/sandbox/sessions/none/brief` | **404 `{"error":"unknown_session"}`**（该 404 的 error 形状是 M2 的 brief 路由形态——旧构建含 M2 的部分实现但不完整） |
| 3001 → `/api/llm` | `{"callCount":0, "provider":"deepseek", "mode":"live", "model":"deepseek-flash"}` |
| 3001 → `/api/tasks/task-25` | 存在 `correlationId`（= workflow 的 correlationId，§4 链路可见） |
| 3001 → `/api/simulation` | `running`；instance-10 曾因 task-25 卡死于 live 模式；本会话 10:43 曾发 `Agent.Instruct` 推进；task-26 在 `49085` 因 `invalid_args` 再次卡死于 `started` |
| 5173 进程 | PID `42184`，`apps/web/.../vite dev`，启动于 `2026-11-14 23:08:25`，`host 0.0.0.0` |
| 5173 → `/api/llm` | 返回与 3001 **完全相同的 payload** ⇒ 5173 的 `/api` 代理指向 3001（与 `dev-proxy.ts` 默认一致，未设置 `PORT`） |
| `apps/api/dist/index.js` mtime | `2026-11-14 23:13:46`（**包含修复**：`NL = String.fromCharCode` 确认存在；`failureReason` 在 task-fold/workflow-engine 的 dist 中） |
| 3210 / 5180 | 已停止（所有验收临时实例停止，仅本报告 3001/5173 对外） |

### 8.2 结论

**正式环境仍是旧构建 + 新前端的版本错配，且属“不完整 M2”：缺 F1 修复、缺 transitions 投影、缺 F2/F3 修复，而 live 模式 stall 状态保留在公司记录中（instance-10/task-26）。任何现场演示前必须重启 API（并验证一遍 mock 链路），否则演示将完整复现 F1 事发的页面故障。**

### 8.3 安全的重启与复验步骤（供现场执行，本次未执行）

1. 核对 `apps/api/dist` 为最新（已重建于 `23:13:46`，含修复；如不确定，先 `pnpm --filter @maoeh/api build && pnpm --filter @maoeh/kernel build && pnpm --filter @maoeh/workflow-engine build && pnpm --filter @maoeh/task-system build` 再重建 `turbo run build --force` 保守全量一次）。
2. 找到并优雅停止 3001 进程（PID `57728`）：按本项目 README 记录的 API 启动方式停止该进程（向其发送正常终止信号；**不要**用 `taskkill /F` 或清仓工具）；确认端口释放后重新以 `node --env-file-if-exists=../../.env dist/index.js`（`..\apps\api` 目录）启动。**不要动 5173**（它是 Vite dev，页面总是加载最新源码）。
3. 启动后复验（只读）：
   - `GET http://localhost:3001/api/sandbox` — 页面内应出现 `var NL = String.fromCharCode(10);` 与 `split(NL)`（与 `/api/sandbox` 源码一致）；
   - `GET http://localhost:3001/api/workflows` — instance-10 应含 `transitions` 字段；
   - `GET http://localhost:3001/api/sandbox/sessions/x/brief` — 应返回 M2 错误形状 `{"error":"unknown_session", ...}` 而非 404 HTML；
   - `GET http://localhost:5173/api/llm` — 返回与 3001 一致（5173 代理即是 3001，无需改动）。
4. 演示前在隔离环境（3210/5180 模式，mock LLM）完整走一遍：沙盘 → 任务书草稿（编辑→确认）→ Canvas Confirm → 四步执行 → Results 验收 → completed；截图入 `.maoeh/acceptance/`，最后停止 3210/5180。
5. 演示正式环境前决定 LLM 模式：mock（确定性，链路稳定）或 live（真实模型但有 §5.4 的 stall 风险）——**推荐演示期用 mock**；live 只跑前两步必须用 live 模型时，先把 agent 指令/task log 预热到稳定计划。
6. 重启后 instance-10 会被 replay 到当前状态（task-26 在 started）——演示可直接用它展示“resume 推进”，或保持不动，演示使用新建 session。
7. 演示前不要再对 3001 发送任何指令命令（本审查期间的那条指令已记录）。

### 8.4 与本审查并行的命令（透明度）

本次审查对 3001 只进行了 GET；唯一一次 POST 是本会话 10:43 的 `Agent.Instruct`（`commandId=ui-1794624482561-1`），无其他写入。

---

## 9. 最终结论

**结论：附条件通过。**

依据：

- F1：修复真实有效（vm 语法测试 + mock 浏览器链路），残余回看 500 事件窗口与元信息丢失属 P2 执行级问题，不阻塞本交付，但需排期。
- F2：正确完成 failed/rejected 语义分离与 provenance 保留，pause/resume 分支正确，重复 resume 有保护；fallback 行为（无分支 → retry → abort）方向正确但 P2-3（吞掉 ambiguous 错误码）、P1-3（生成式定义无 failed 分支）需要后续修复。
- F3：来源绑定可靠（correlationId + sourceSessionId），无实质串数据；source 展示全部取自业务数据。
- 闭环：mock 下完整连线与越权/重复/非法状态回归全部通过；**live 模型下闭环失败过两次（task-25、task-26）且尚未验证通过**——这不是 M2 “修复”引入的新缺陷，但意味着“现场演示真实跑通”的声明不能无条件成立。
- 正式环境仍是旧构建 + 前端错配；**演示前必须按 §8.3 重启并复验**。
- 测试与门禁：本次独立复核 `pnpm test`（182/1294）与 `pnpm architecture:check`（55/55）通过，修复报告中的浏览器证据未重跑但文件完整一致、与 mock 模式结论相符；`.maoeh/` 证据不进仓（P2-10）。

**冻结建议：不建议按当前状态“正式冻结 M2”作为发布线 / 对外发布。** 它足以作为竞赛/演示交付的“已修复”结论，但不能公开声称 live 闭环已验证，也不能带着 3001/5173 旧构建进场演示。冻结 M2 的条件：§8.3 重启复验通过 + P1-1/P1-2 明确化（要么 live 验证一次闭环完成，要么演示明确使用 mock 并口头限定）+ P1-3 至少记录为已接受的风险。

**M3 启动条件：具备条件启动 M3 的开发工作，但不具备“并行演示落地”的条件。** 建议 M3 规划中把 §6 的 P1 项列为前置任务（或正式waive 并书面确认），尤其 P1-3（生成式定义 failed 分支）与“stall watchdog / plan-executor 收敛”（invalid_transition / invalid_args 不重试的结构缺陷）——这两项是 M3 任何以 agent 自主闭环为目标的工作都绕不开的地基。P2 项建议进入 M3 backlog。

本审查未做任何代码、配置、数据库或环境变量的修改；如需修复以上任何一项，按正常开发流程执行并带回归测试。
