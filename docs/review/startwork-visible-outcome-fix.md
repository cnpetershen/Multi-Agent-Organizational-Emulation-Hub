# 修复报告 · 「发起公司任务书 → 开始工作」无可见结果

> 现象：在总览页的 **发起公司任务书** 面板填好任务书后点击 **开始工作**，页面看起来「什么都没有发生」。
>
> 结论：**前端命令链路是通的，后端也确实建了任务书与工作项**；缺的是「结果出现在操作员正在看的地方」。
> 结果只写进了文档顶部的全局横幅（不在视口内）并在 8 秒后自动消失，按钮的忙碌态只有约 300ms，
> 而任务书卡片出现在表单下方的另一个面板里。本次把结果做成 **提交按钮正下方、常驻、实时** 的结果块。

Gates：`pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build` · `node tests/e2e/startwork-probe.mjs` ·
`node tests/e2e/work-brief.mjs` — **全部 PASS**（§6）。

---

## 1. 根因（浏览器实测证据）

在用户正在运行的开发服务器上（`pnpm dev`：web `:5173` + api `:3001`）用真实 Chrome 复现，
点击后 150ms 起可见状态变化，但**都不在表单附近**：

| 时刻 | 页面变化 | 是否在操作员视线内 |
|---|---|---|
| +152ms | 顶部 `.feedback` 横幅「✓ 任务书已提交 — …」 | ✗ 横幅在文档流顶部（`console.css` 里没有 `sticky`/`fixed`），页面被 PageIntro 按钮 `scrollIntoView` 滚到表单后它就在视口之外 |
| +152ms | 侧边栏 `.side-runtime` 变「已为你挂起」、顶栏「为你挂起待审」 | 边缘提示，不说明「任务是否创建成功」 |
| +306ms | 按钮从「提交中…」恢复成「开始工作」 | 忙碌态只存在约 300ms |
| +414ms | 「公司任务书」面板出现新卡片（含工作项） | ✗ 在表单下方的另一个面板，可能在视口外 |
| +8s | 全局横幅被 `SUCCESS_FEEDBACK_MS` 自动清除 | 唯一的结果提示彻底消失，只剩远处的卡片 |

同时确认后端链路完全正常（§5）：`Simulation.Pause` → `Work.SubmitBrief` → `Simulation.Step` 全部 `200 accepted`，
`/api/tasks` 立即能读到新建任务，控制台无 JS 异常、无 4xx/5xx。

因此这不是「请求没发出去」，而是**成功/失败反馈的可见性问题**：命令失败时同理，错误只出现在同一个不可见横幅里，
操作员看到的就是「点了没反应」。

## 2. 修复

**一个原则**：提交结果必须出现在按钮旁边、常驻、并随读模型实时更新；成功与失败都不能靠远处横幅。

| 文件 | 改动 |
|---|---|
| `apps/web/src/pages/Overview.tsx` | 新增 `SubmissionAttempt`（`creating` / `filed` / `failed`）本地状态；点击后**在任何 await 之前**先置 `creating`（同帧产生可见变化）；`stepToBrief`（改用 `runDetailed`）在拆分超时/命令失败时写入真实原因；新增 `SubmissionReport` 组件：紧贴按钮下方常驻渲染「任务已创建 — {标题}」、状态药丸、任务书 ID / 命令 ID / 工作项进度、**逐条工作项的 taskId + 岗位 + 状态 + 打开任务**、审批闸门信息与「去审批 / 在 Tasks 页查看 / 运行时」动作；「公司任务书」卡片的工作项也补上 taskId |
| `apps/web/src/derive.ts` | 新增纯函数 `briefItemViews` / `workflowsForCommand` / `openGate` / `briefSubmission` / `submissionStatus`：把「已受理→等待拆分→进行中→已暂停→等待审批→已完成」的判定集中在一处，全部只读 API 返回值 |
| `apps/web/src/control.ts` · `apps/web/src/App.tsx` | 新增 `runDetailed`（返回 `{ ok, failure }`），`run` 委托给它，20 处既有调用点行为不变；`beginHold` 返回同结构，使「挂起失败」也能显示真实原因 |
| `apps/web/src/i18n/locales/{zh-CN,en-US}.json` | 新增 `overview.brief.result.*` 与 `overview.briefs.taskId`（两语言键集保持 parity，`assertLocaleParity` 通过） |
| `apps/web/src/phase2.css` | `.submit-result*` 样式（沿用既有 `--green/--amber/--red` 令牌与 panel 语言） |
| `tests/unit/web/start-work.test.ts` | 新增 12 条纯函数/契约测试：命令 payload 与 `Work.SubmitBrief` 契约一致、拒绝结果原样呈现、按 `commandId` 找回任务书、工作项 taskId、按 `correlationId` 关联工作流与审批闸门、各状态优先级 |
| `tests/e2e/startwork-probe.mjs` | 由「打印诊断」升级为**验收门**：1 秒内可见变化（实测 7ms）、taskId 落地、暂停/审批状态、Tasks 页可见、API 断开时显示真实错误、控制台无异常；子进程改为文件描述符输出，便于在受限沙箱内运行 |
| `tests/e2e/work-brief.mjs` | 既有 M1.4 验收门新增断言：内联结果块必须按 taskId 列出工作项，且状态为 `held`/`approval` |

**未改动**：`Position.capabilities`、Agent capability matching、CEO goal → workflow 生成、`Work.SubmitBrief` /
`Control.WorkBriefed` / 命令信封与校验、任何后端包。命令 payload 与 `packages/organization-control/src/validation.ts`
的字段要求逐条对齐（由单测固定）。

## 3. 验收对照

| 要求 | 结果 | 证据 |
|---|---|---|
| 点击后 1 秒内出现明显 UI 状态变化 | ✅ **7ms** 出现「正在提交任务书…」，随后同位置变为「任务已创建」 | probe 第 [2] 步 |
| 能确认任务是否创建成功 | ✅ 结果块 + 状态药丸 + 任务书 ID | 截图 `startwork-probe-report.png` |
| 能看到 taskId 对应的任务 | ✅ 结果块逐条显示 `任务 ID task-1/task-2`，并可「打开任务」；「公司任务书」卡片同样带 taskId | probe 第 [3] 步 |
| 勾选「在审批闸门暂停，让我来决定」→ 明确的 Pending Approval / Paused | ✅ 药丸「已暂停 — 等待你的决定」+ 说明「运行时已为你挂起」；服务端 `simulationPaused === true` 经 `/api/runtime` 校验；闸门打开时切换为「等待审批（Pending approval）」并列出 工作流/步骤/批准人数 + 「去审批」 | probe 第 [3] 步、`submissionStatus` 单测 |
| 创建失败时显示真实原因 | ✅ 关闭 API 后结果块显示 `POST /api/command 返回 HTTP 500: 空响应体`（命令拒绝则显示 `CODE — field: reason`） | probe 第 [5] 步 |
| 不使用 mock 伪造成功 | ✅ 结果全部来自 `/api/work-briefs`、`/api/workflows`、`/api/runtime` 与命令返回；失败路径实测 | §5 |
| Tasks 页立即看到该任务 | ✅ 点击「在 Tasks 页查看」后 `.task-card` 中同时出现 `task-1`；实时开发服务器上验证到 `task-12`/`task-13` | probe 第 [4] 步、实时运行验证 |
| 是否要跳转到详情页 | 未自动跳转：控制在操作员手里（沿用仓库「不自动跳走」的既有约定），每个工作项一键「打开任务」→ `/results/:taskId`，另有「在 Tasks 页查看」 |
| Network / Console 检查 | ✅ 全链路 200；断开 API 后为 500（由预览代理产生）并被如实展示；`window.__pageErrors` 为空 | probe 第 [6] 步 |

## 4. 实际 API 请求链路（实测）

```
POST /api/command  {"commandType":"Simulation.Pause","target":{"targetType":"simulation","targetId":"<company>"}}
   -> 200 {"status":"accepted","events":["ctrl-evt-…"],"auditId":"audit-…"}
POST /api/command  {"commandType":"Work.SubmitBrief","target":{"targetType":"agent","targetId":"ceo-alex"},
                    "workBrief":{"title":…,"goal":…,"verificationKeys":[...]},"reason":…,"correlationId":<commandId>}
   -> 200 {"status":"accepted","replayed":false,"failure":null}
GET  /api/work-briefs        -> 该 commandId 的 brief（briefId、items[].taskId、counts）
GET  /api/workflows          -> correlationId 对应的实例（含 approval.status）
POST /api/command  {"commandType":"Simulation.Step"}   -> 200（hold 期间控制台自行推进拆分）
GET  /api/snapshot           -> Tasks 页数据（含新建 taskId）
```

注意：`POST /api/command` 的响应**不含** `taskId`/`workflowId`，它返回命令自身的 `status/events/auditId`。
所以结果块的 id 一律从读模型（`/api/work-briefs`、`/api/workflows`）按 `commandId`/`correlationId` 读回——
与仓库「日志即真相、事件驱动」的既有做法一致，未新增第二数据源。

## 5. 验证命令与结果

```
pnpm lint            -> 0 errors
pnpm typecheck       -> 53/53 tasks ok
pnpm build           -> 33/33 tasks ok
pnpm test            -> 125 files / 908 tests passed（含新增 12 条）
node tests/e2e/startwork-probe.mjs -> PASS（点击→7ms 可见变化→briefId+taskIds→Tasks 页→断网真实报错）
node tests/e2e/work-brief.mjs      -> PASS（M1.4 任务书→工作项→审批→完成，无回归）
```

实测截图：`tests/e2e/artifacts/startwork-probe-report.png`；证据 JSON：`tests/e2e/artifacts/startwork-probe.json`。

## 6. 说明

- 验证过程中在活动公司 `peter-ai-lab` 真实创建了任务书 `brief-1` / `brief-2` 与任务 `task-10`…`task-13`
  （标题为 `DIAG 开始工作链路自检`），用于证明链路；事件日志只追加，未做删除。诊断结束时运行时已恢复运行。
- 未引入新的命令、事件、包或权限；`Simulation.Pause` 的挂起语义、审批闸门的判定（`approval.status === 'open'`）
  与 M1.6 的能力匹配/工作流生成逻辑保持原样。
