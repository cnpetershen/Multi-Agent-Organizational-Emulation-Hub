# M2 工作流闭环 · 最终验收报告

- 验收时间：2026-11-14 22:32–22:47（Asia/Shanghai）
- 验收对象：`feat/m2-workflow-closed-loop` / HEAD `7ab465f`（代码提交 `41c3cbd` + `e6ae536`，文档 `67cfa1a` 等）
- 基线 checkpoint：`5ae0235` / tag `checkpoint-2026-11-14-night`（未移动）
- 原则：只验证，不修改业务代码、不写正式演示数据、不清理并行会话改动
- 当前工作区：19 个并行会话改动 + 12 个未跟踪文件，数量与验收前一致；本报告新增前 `git status` 仍为 31 项

---

## 0. 最终结论

**未通过（有 1 个 P0 阻塞、1 个 P1 语义缺陷、2 个展示/数据保真问题）。**

| 验收项 | 结论 |
|---|---|
| 分支/提交/并行改动隔离 | ✅ 通过 |
| 隔离环境用最新 M2 构建启动 | ✅ 通过 |
| 真实浏览器完整走通（沙盘页面 → … → Results 审批） | ❌ **失败**：沙盘页面内联脚本语法错误，页面 JS 完全不执行 |
| 补偿路径（同源 fetch 前半段 + Canvas/Results 真实点击） | ✅ 通过，但**不能替代**沙盘页面验收 |
| 重复/并发提交、越权、重复审批、非法状态 | ✅ 通过 |
| 暂停期间 completed/rejected/cancelled 收敛与重复结算 | ✅ 通过（4 个场景） |
| 暂停期间 failed 收敛 | ❌ **失败**：`task.fail` 折叠为 `rejected`，有独立 failed 分支时会走错分支 |
| 前端展示与后端事实一致 | ✅ 数据一致；❌ Results 把沙盘衍生任务误判为沙盘场景并嵌入失效页面 |
| `preview-runtime-http` 全量/单测对照 | ✅ 本次全绿；仍保留环境敏感 flake 记录 |
| 不修改业务代码/正式数据/并行改动 | ✅ 通过 |

---

## 1. 分支、HEAD、工作区与运行版本

### 1.1 代码状态

| 项 | 值 |
|---|---|
| 分支 | `feat/m2-workflow-closed-loop` |
| HEAD | `7ab465f docs(m2): note the operator-identity limitation` |
| M2 代码提交 | `41c3cbd`（30 files, +2477/−45）、`e6ae536`（暂停按钮守卫） |
| checkpoint | `5ae0235`，tag `checkpoint-2026-11-14-night` 仍指向它 |
| 工作区 | 19 M + 12 未跟踪（与验收前一致），均为并行会话改动/临时抓取/交付数据；本次验收未写入这些路径 |
| 本阶段新增 | 仅 `docs/competition/M2_FINAL_ACCEPTANCE.md`（报告）与 `.maoeh/acceptance/**`（本地证据，未跟踪） |

**是否混入他人代码：没有。**

- `41c3cbd` 的 30 个文件里没有 `RoleAvatar`、`roles.css`、`roles.ts`、`role-identity.test.ts`、`.tmp-*`、`deliverables/`。
- `Results.tsx`、`WorkflowCanvas.tsx`、`canvas.css` 三个共享文件在提交中用「HEAD + 本阶段 hunk」构造：提交版本里没有并行会话的 `RoleAvatar`/`AgentAvatar` 等改动；工作区仍保留这些改动，未被覆盖、回滚或清理。
- 验收期间 HEAD 未变，`git status` 条目数未变；未对 19 个并行文件做写操作。

### 1.2 运行进程版本（关键风险）

| 端口 | 进程/启动 | 版本事实 |
|---|---|---|
| 3001 | pid 57728，启动 `2026-11-14 20:43:08` | **旧构建**（早于 M2 22:30 的 dist）。`GET /api/sandbox/sessions/none/brief` → **404**；`/api/workflows` 没有 `transitions` 字段 |
| 5173 | pid 17120，启动 `22:28:38`（Vite dev） | 加载了含 M2 的前端源码，但 `/api` 代理到 3001 旧 API；`/api/workflows` 无 `transitions`，`/api/llm` 仍是 `live/deepseek` |
| 3210 | pid 9356，启动 `22:35:25` | 验收隔离 API：`apps/api/dist`（构建于 22:30:09），临时事件日志 + 临时沙盘目录，`mock` 模型 |
| 5180 | pid 37348，启动 `22:35:55` | 验收隔离控制台：`vite preview` 服务 `apps/web/dist`（构建于 22:30:00），代理到 3210 |

结论：**正式演示栈处于「新前端 + 旧后端」的版本错配**；验收没有重启 3001/5173（避免影响演示），而是另起 3210/5180 隔离环境。任何现场演示前必须重启 API（或至少让控制台代理到 M2 API），否则 `/api/sandbox/sessions/:id/brief` 与 `transitions` 都不存在。

---

## 2. 真实浏览器完整链路

### 2.1 阻塞失败：沙盘页面脚本不执行

隔离环境 `http://127.0.0.1:5180/api/sandbox` 打开后：

- `document.documentElement.dataset.maoehReady` 永不置为 `"1"`；
- 历史会话一直显示「加载中……」，点击「开始对抗质询」无任何反应；
- 页面截图：`.maoeh/acceptance/m2-final/screenshots/01-sandbox-page-dead.png`。

根因（源码级）：

`apps/api/src/sandbox-page.ts` 的页面脚本写在模板字符串里，四处 `'\n'` 没有转义成 `'\\n'`：

```
244: split('\n')
253: join('\n')
255: join('\n')
256: join('\n')
```

模板生成 HTML 时变成真正的换行，浏览器收到的是：

```js
return $(id).value.split('
').map(...)
```

`node --check` 对服务端返回的内联脚本报：

```
sandbox-page-acceptance.js:109
SyntaxError: Invalid or unexpected token
```

证据：`.maoeh/acceptance/m2-final/sandbox-page-syntax.log`。

**影响**：P0-1 的「沙盘页面预览/编辑/确认」在真实浏览器里完全不可用；所有依赖该页面的演示（包括 Results 页嵌入的 iframe）都是死页面。API 端点本身正常，但用户无法从页面进入。

### 2.2 补偿验证（不能算通过）

因为页面 JS 死掉，验收改用**同一浏览器控制台的 same-origin fetch**完成前半段，再用真实点击完成后半段：

1. Foundry 门禁进入 `Future AI Lab`（截图 `02-console-after-brief.png` 背景）；
2. 浏览器内 `POST /api/sandbox/session` → 4 条消息，`scores=null`（mock 的沙盘发言是认知 JSON，评分割不出来）；
3. 浏览器内 GET brief → 编辑标题/目标/补充说明；POST `confirm:true` → `201 brief-1`；
4. 等待 CEO 生成 draft（`activeStepIds=0`、5 个 pending 步骤、10 条 transitions）；
5. 真实点击侧栏 **Canvas** → 真实点击 **Confirm & execute** → 模态框再确认；
6. 等待审批门；打开 `/results/task-1` → 真实点击 **Accept delivery**（填写意见）；
7. 工作流 completed；4 个任务全部 completed 且有 result。

证据：`.maoeh/acceptance/m2-final/browser-report.json`，截图：

```
01-sandbox-page-dead.png     死页面
02-console-after-brief.png   brief 已提交后的控制台
04-canvas-draft.png          真实 Canvas 草案（5 nodes / 5 stages）
05-results-approval.png      Results 审批面板 + 4 条已交付任务
06-results-completed.png     审批后完成页
07-results-top.png           完成页顶部
```

补偿路径的通过只能说明 **Console + API + 审批 UI 可用**，不能说明 P0-1 的沙盘页面可用。

### 2.3 Results 场景误判（P1 展示缺陷）

Results 页把这次「课程实验平台」的任务标题显示成 **Cyber Sandbox · Multi-role adversarial review**，并嵌入 `/api/sandbox` iframe（截图 `05`）。

原因：`apps/web/src/sandbox.ts` 用正则匹配任务标题/目标中的「赛博沙盘」；而沙盘生成的 brief 目标固定包含「依据赛博沙盘会话…」，所以**每个沙盘衍生任务都会被误判为沙盘场景**。该 iframe 当前又正好是死页面，视觉上是一个空白/加载中的坏面板。

---

## 3. 重复、并发、越权与非法状态

隔离 API 实跑，证据 `.maoeh/acceptance/m2-final/negative-report.json`。

| 场景 | 结果 | 判定 |
|---|---|---|
| 同一会话并发两次 `POST brief` | `[201, 409]`，只生成 1 份 `brief-2` | ✅ |
| 已转换后再次 POST | `409 already_converted` | ✅ |
| 审批阻塞时 `Workflow.Resume` | `rejected / INVALID_STATE` | ✅ |
| 工程师身份 `Workflow.Approve` | `rejected / UNAUTHORIZED`，门仍 `open` | ✅ |
| 人类 `Workflow.Approve` | `accepted` | ✅ |
| 重复 `Workflow.Approve` | `rejected / INVALID_STATE` | ✅ |
| 已完成实例再 `Workflow.ConfirmStart` | `rejected / INVALID_STATE` | ✅ |

并发请求中没有出现「两份 brief、重复任务」；`brief-2` 的任务/工作流关联正常。

---

## 4. 暂停期间终态任务的收敛

临时验收测试（未提交）：`tests/acceptance/m2-pause-cases.test.ts`，5 个场景 4 通过 1 失败。日志：`.maoeh/acceptance/m2-final/pause-cases.log`。

| 场景 | 结果 | 判定 |
|---|---|---|
| paused + task submitted → resume | 实例 completed；仅 1 条 `Workflow.StepCompleted`；第二次 resume 被 `instance_terminal` 拒绝 | ✅ 无重复结算 |
| paused + task rejected → resume | 实例 aborted；`StepRejected`；走 rejected 分支；无 `InstanceCompleted` | ✅ |
| paused + task cancelled → resume | 实例 aborted；`reason=task_cancelled`；无重复结算 | ✅（但 detail 丢失原始取消理由，见 §7） |
| paused + task failed（定义只有 failed 分支） | 实例 aborted；不重试 | ✅ |
| paused + task failed（定义同时有 rejected/failed 分支） | 实际走 **rejected_branch**，期望 failed_branch | ❌ |

失败证据：

```
AssertionError: expected 'rejected_branch' to be 'failed_branch'
```

根因：`Task.Failed` 在 task-fold 中折叠为 `status='rejected'`，`rejectReason` 保留原因但不保留「failed」这一类型；M2 的 `resume()` 只能按 `rejected` 结算。因此：

- 对只有 rejected/failed 之一、且目标相同的定义，结果正确（abort）；
- 对两者目标不同的定义，**会走错分支**，属于错误结果。

这是本阶段暂停收敛的已知边界，不能声称「失败任务总是正确收敛」。

---

## 5. 事件日志、任务结果、审批记录与关联 ID

事实核对脚本：`.maoeh/acceptance/facts.mjs`，结果 `.maoeh/acceptance/m2-final/facts.json`，10 项检查全部 true：

- `brief-1.sourceSessionId = sandbox-session-20261114144131-2388`；
- `Control.WorkBriefed` 的 `briefId/commandId/sourceSessionId` 与 brief 一致，correlation = `sandbox-brief-<session>`；
- 4 个任务全部 `workflowInstanceId=instance-1`，`correlationId` 与 brief 一致；
- 每个任务 `completed`、`result.summary` 非空、artifacts 数量 1/1/2/1；
- 每个 task 都有对应 `Workflow.StepCompleted.taskId`，且没有重复；
- `Workflow.ApprovalRequested` → `ApprovalGranted`（`grantedBy=["ceo-alex"]`）→ `InstanceCompleted`；
- 事件链：`InstanceStarted` → `DraftConfirmed` → 4×(StepEntered/StepCompleted) → `ApprovalRequested` → `ApprovalGranted` → `InstanceCompleted`。

Results UI 截图 `05` 里的 4 条任务标题/状态与 `/api/tasks/task-1..4` 一致；审批面板的 `awaiting approval on step-approve` 与 `Workflow.ApprovalRequested` 的 stepId 一致。

**数据保真问题**：沙盘会话 `scores=null` 时，brief 验收标准写入「会话未产生可解析评分；确认前必须补全可检查的验收标准」，但 API 允许直接 `confirm:true`，不会强制编辑。本次补偿路径就是未编辑验收标准直接确认的；live 模式下会话有评分时不会触发。该 fallback 的语义需要收紧（要么拒绝确认，要么把 warning 变成必填项）。

---

## 6. `preview-runtime-http` 全量与单测对照

| 运行 | 结果 |
|---|---|
| 本次全量 `pnpm test` | 179 files / 1286 tests，**1286 通过**，exit 0，24.40s |
| 本次单跑 `preview-runtime-http` | 2/2 通过，1.43s，exit 0 |
| 22:19 的 M2 全量（同一代码） | 1285 通过 / 1 失败（该文件 61s 超时），exit 1 |
| 失败项单跑（22:20） | 2/2 通过，1.47s |

结论：本次全量与单测都通过，但该文件仍有**环境/负载敏感**的历史记录（并行全量时真实预览子进程 60s 内未启动，单跑 1.4s）。没有修改任何断言或测试逻辑；两次全量之间代码一致，本次只是未复现。

证据：`.maoeh/acceptance/m2-final/full-test.log`、`preview-single.log`。

---

## 7. 其他门禁

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 53/53，exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm architecture:check` | 10 files / 55 tests 通过，depcruise 0 |
| `turbo run build --force`（M2 启动前） | 33/33，0 cached，29.45s |

日志：`.maoeh/acceptance/m2-final/{typecheck,lint,architecture}.log`。

---

## 8. 未通过项汇总

| # | 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| F1 | **P0** | 沙盘页面内联脚本 `'\n'` 未转义，整页 JS 失效 | `sandbox-page-syntax.log`、`01-sandbox-page-dead.png` | `sandbox-page.ts:244/253/255/256` 改为 `'\\n'`，重建并重启 API 后重跑浏览器链路 |
| F2 | **P1** | 暂停期间 `task.fail` 被按 `rejected` 结算；有独立 failed 分支时走错 | `pause-cases.log` | 在 Task 折叠中保留失败类型（或延迟 reactor 事件而不是丢弃），再结算 |
| F3 | P1 | Results 将所有沙盘衍生任务误判为「Cyber Sandbox」并嵌入失效 iframe | 截图 `05`；`sandbox.ts` 正则 | 用真实领域关联（sourceSessionId/workflow 类型）代替标题正则，或至少不嵌入页面 |
| F4 | P2 | 取消任务的原始理由在聚合上丢失（detail 为通用句） | `pause-cases.log` | Task.Cancelled 折叠保留 reason，reconcile 使用它 |
| F5 | P2 | 无评分会话允许带占位验收标准确认 | facts/brief 事件 | 确认时校验 acceptance 不是 warning 占位，或强制编辑 |
| F6 | 运维 | 3001/5173 是旧后端 + 新前端错配 | 进程时间与 404 检查 | 演示前重启 API，或把控制台代理指向 M2 API |

---

## 9. 未修改声明与证据位置

- 未修改任何业务代码；HEAD 仍为 `7ab465f`；验收期间 `git status` 条目数未变（31）。
- 未向 3001 发送任何 POST/tick；未创建会话到正式沙盘目录；所有验收数据在 `.maoeh/acceptance/state`（临时）。
- 未清理/回滚并行会话的 19 个改动与 12 个未跟踪文件。
- 证据根目录：`.maoeh/acceptance/m2-final/`

```
browser-report.json         真实浏览器补偿链路 + 死页面记录
negative-report.json        并发/重复/越权/非法状态
facts.json                  brief↔workflow↔tasks↔events 关联
pause-cases.log             暂停 5 场景（4 通过 1 失败）
sandbox-page-syntax.log     页面脚本 SyntaxError
canvas-edge.json            画布 4 条真实转换边
full-test.log               全量 179/1286 通过
preview-single.log          单跑 2/2 通过
typecheck/lint/architecture.log
screenshots/01..07
```

---

## 10. 验收结论

- **可以确认通过**：隔离构建、API 端到端、Canvas 确认、Results 就地审批、并发/重复/越权/非法状态、completed/rejected/cancelled 的暂停收敛、事件与结果一致性、全量测试与门禁。
- **不能确认通过**：真实浏览器从沙盘页面开始的完整链路（F1）；暂停期间 failed 的独立分支正确性（F2）；Results 对沙盘衍生任务的场景识别（F3）。
- 按「只验证、不修复」要求，本次不提交任何修复；等待确认后另开修复阶段。
