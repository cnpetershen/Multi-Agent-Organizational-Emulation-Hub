# M2 验收失败项修复与回归验收

- 修复时间：2026-11-14 22:55–23:20（Asia/Shanghai）
- 分支：`feat/m2-workflow-closed-loop`
- 修复前 HEAD：`7ab465f`（M2 实现 + 验收报告）
- 修复范围：只修 F1、F2、F3；不开发 M3、不接发布、不改无关模块
- 数据：全程隔离环境，正式演示数据未写入

---

## 0. 结论

| 项 | 状态 | 关键证据 |
|---|---|---|
| F1 沙盘页面 JS 语法 | ✅ 修复 | 内联脚本 `node --check` 级测试 2/2；真实浏览器 `data-maoeh-ready=1`，历史会话 1 行可回看，会话 4 条消息 |
| F2 failed/rejected 语义 | ✅ 修复 | 正常 failed、暂停 failed、暂停 rejected、暂停 cancelled 四条分支测试；重复 resume 不重复结算 |
| F3 Results 沙盘误判 | ✅ 修复 | 浏览器 Results 标题恢复为任务标题，无 `iframe.sandbox-frame`，显示结构化来源卡（session/brief/title） |
| 真实浏览器全链路 | ✅ 通过 | 沙盘页面 → 任务书 → Canvas → 执行 → Results 审批 → completed |
| 并发/重复/越权/非法状态 | ✅ 通过 | `negative-report.json` |
| 全量测试 | ✅ 通过 | 182 files / 1294 tests，exit 0，25.3s |
| 门禁 | ✅ 通过 | typecheck 53/53、lint 0、architecture 55/55、build 33/33 |

---

## 1. 原始根因与修复文件

### F1 · 沙盘页面内联脚本

**根因**：`apps/api/src/sandbox-page.ts` 的页面脚本写在 TypeScript 模板字符串里，四处 `'\n'` 在生成 HTML 时变成真实换行：

```
split('\n')        → 浏览器收到 split('⏎')
join('\n') ×3      → 浏览器收到 join('⏎')
```

**修复**：不再依赖嵌套转义，在页面脚本里定义 `var NL = String.fromCharCode(10);`，四处改用 `split(NL)` / `join(NL)`。

**修改文件**：`apps/api/src/sandbox-page.ts`、`tests/unit/api/sandbox-page-script.test.ts`（新）。

**失败证据（修复前）**：

```
× is valid JavaScript once the template is rendered
SyntaxError: Invalid or unexpected token
Tests 2 failed
```

**通过证据（修复后）**：2/2 通过；真实浏览器 `data-maoeh-ready="1"`，`exceptions=[]`、`syntaxException=false`。

### F2 · failed/rejected 语义混淆

**根因有两层**：

1. `workflow-transition.ts` 把 `rejected` 条件当作同时匹配 `rejected` 和 `failed`，导致：
   - 只有 rejected 分支时，failed 被误当 rejected；
   - 同时有两条分支时，failed 输入同时命中两条，直接 `ambiguous_transition` 后落到 fallback。
2. `Task.Failed` 在 task-fold 中折叠为 `status='rejected'`，且没有保留失败来源；`resume()` 只能看到 `rejected`。

**修复**：

- `workflow-transition.ts`：`task_status` 只匹配同值，rejected 不再消费 failed。
- `workflow-validation.ts`：`expandStatus` 不再把 rejected 展开为 rejected+failed。
- `task-types.ts`：新增 `failureReason?: string | null`（保留原始失败原因）。
- `task-fold.ts`：`Task.Failed` 写 `failureReason`；`Task.Rejected`/`Task.Completed`/`Task.Assigned`/`Task.Cancelled` 清除。
- `workflow-engine.ts`：`resume()` 用 `failureReason` 选择 `cause: 'failed'` 或 `'rejected'`。

**修改文件**：上述 5 个源码文件 + `tests/unit/workflow-engine/pause-terminal-branches.test.ts`（新）、`tests/unit/workflow-transition.test.ts`（语义更新）。

**失败证据（修复前）**：

```
normal execution: Task.Failed selects the failed branch
AssertionError: expected 'boom' to be 'failed_branch'

pause + fail + resume selects the failed branch
AssertionError: expected 'rejected_branch' to be 'failed_branch'

Tests 2 failed | 1 passed
```

**通过证据（修复后）**：

```
✓ normal execution: Task.Failed selects the failed branch
✓ pause + fail + resume selects the failed branch
✓ pause + reject + resume selects the rejected branch
✓ pause + cancel + resume aborts as cancelled without a completion
✓ pause + completed ... (existing)
Tests 4 passed / 2 passed
```

### F3 · Results 沙盘误判

**根因**：`Results.tsx` 用 `isSandboxScenario(task, {title, goal})` 正则匹配“赛博沙盘”，而沙盘生成的 brief 目标固定包含“依据赛博沙盘会话…”。因此所有由沙盘任务书产生的任务都被误判为 Cyber Sandbox 场景，并嵌入 `/api/sandbox` iframe。

**修复**：

- `TaskRecord` 增加 `correlationId`（`api.ts` 可选解析）。
- 新增 `results-source.ts`：按 `brief.correlationId === task.correlationId` 且 `brief.sourceSessionId` 非空确定来源；标题/目标不参与判断。
- `Results.tsx`：
  - 删除 `isSandboxScenario` 调用与 `iframe.sandbox-frame`；
  - 增加“Delivery source”卡片：sandbox session、brief id、brief title、打开沙盘工作台链接；
  - 页面标题恢复为任务标题。
- `/api/sandbox` 页面本身保持不变，仍可独立打开、创建会话、回看历史。

**修改文件**：`apps/web/src/api.ts`、`apps/web/src/results-source.ts`（新）、`apps/web/src/pages/Results.tsx`、`apps/web/src/i18n/locales/{en-US,zh-CN}.json`、`tests/unit/web/results-source.test.ts`（新）。

**失败证据（修复前）**：`Cannot find module 'results-source'`；真实浏览器截图 `01-sandbox-page-dead.png`、`05-results-approval.png`（旧验收）。

**通过证据（修复后）**：

```
results: {
  pageTitle: "Product Requirement",
  hasSandboxIframe: false,
  hasCyberTitle: false,
  hasSourcePanel: true,
  sourceText: "SANDBOX SESSION sandbox-session-... WORK BRIEF brief-1 ...",
  tasks: 4
}
```

---

## 2. 真实浏览器回归

环境：3210（最新 `apps/api/dist`，mock LLM）+ 5180（最新 `apps/web/dist`），临时事件日志/沙盘目录，未触碰 3001/5173 正式栈。

完整操作（headless Edge + CDP，真实点击）：

1. Foundry 进入 `Future AI Lab`；
2. 打开 `/api/sandbox`：`data-maoeh-ready="1"`，历史区不再卡在“加载中”；
3. 填入议题、回合 1，点击“开始对抗质询” → 4 条真实 `Communication.MessageSent`，页面显示会话完成；
4. 刷新页面 → 历史会话 1 行；点击历史 → 4 条发言重新显示；
5. 点击“生成任务书草稿” → 编辑标题/目标/补充说明 → “确认并提交任务书” → `brief-1`；
6. 控制台点击 Canvas → 草案 5 节点/10 条 transitions、0 个活动步骤 → Confirm & execute → 二次确认；
7. 等待执行到审批门；打开 `/results/task-1`：标题为 `Product Requirement`，无 Cyber Sandbox iframe，来源卡显示 session/brief；
8. 填写审批意见，点击 Accept delivery → 工作流 completed；4 个任务 completed。

结果文件：`.maoeh/acceptance/m2-repair/browser-report.json`：

```
sandboxInitialized: ready="1", history="还没有历史会话。"
session: 4 turns
history: rows=1, reopenedTurns=4
brief: brief-1 / sandbox-session-20261114151226-3095
draft: instance-1, 5 nodes, 10 transitions, 0 active
gate: step-approve open
results: no iframe, no Cyber title, source card present, 4 tasks
completed: completed, approval granted
exceptions: [], syntaxException: false
```

截图：`.maoeh/acceptance/m2-repair/screenshots/01-sandbox-session.png` … `06-results-completed.png`。

---

## 3. 事件、任务、分支与关联 ID

修复后事实检查（`.maoeh/acceptance/m2-repair/facts.log`，10 项 true）：

- `brief-1.sourceSessionId = sandbox-session-20261114151226-3095`；
- 4 个任务共享 brief 的 `correlationId`，全部 `workflowInstanceId=instance-1`；
- 每个 `Task.Completed` 都有对应 `Workflow.StepCompleted.taskId`，无重复；
- `Workflow.ApprovalRequested` → `ApprovalGranted`（`grantedBy=["ceo-alex"]`）→ `InstanceCompleted`；
- Results 审批面板的 4 条任务与 `/api/tasks/task-1..4` 的标题/状态/result 一致。

F2 分支证据（unit）：

- 正常 `Task.Failed` → `failed_branch`；
- 暂停期间 `task.fail` → `failed_branch`；
- 暂停期间 `task.reject` → `rejected_branch`；
- 暂停期间 `task.cancel` → `task_cancelled` abort；
- 暂停期间 `task.submit` → completed，且只有 1 条 `StepCompleted`；重复 resume 被 `instance_terminal` 拒绝。

---

## 4. 并发/重复/越权/非法状态回归

`.maoeh/acceptance/m2-repair/negative.log`：

| 检查 | 结果 |
|---|---|
| 并发 `POST brief` | `[201, 409]`，只生成 1 份 |
| 重复提交 | `409 already_converted` |
| 审批阻塞时 `Resume` | `rejected / INVALID_STATE` |
| 工程师越权 `Approve` | `rejected / UNAUTHORIZED`，门仍 open |
| 人类 `Approve` | `accepted` |
| 重复 `Approve` | `rejected / INVALID_STATE` |
| 已完成再 `ConfirmStart` | `rejected / INVALID_STATE` |

---

## 5. 测试与门禁

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 53/53，exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm architecture:check` | 10 files / 55 tests，exit 0 |
| `turbo run build --force` | 33/33，0 cached，29.1s |
| `pnpm test` | **182 files / 1294 tests 全部通过**，exit 0，25.29s |
| `preview-runtime-http` 单跑 | 2/2 通过，1.52s，exit 0 |

全量测试包含 `/api/sandbox` 页面脚本测试、F2 分支测试、F3 来源测试；没有修改断言来掩盖失败。`preview-runtime-http` 在修复前验收中曾出现一次 61s 超时（环境/负载 flake），本次全量与单跑均通过，未改该测试。

日志：`.maoeh/acceptance/m2-repair/{typecheck,lint,architecture,build,full-test,preview-single}.log`。

---

## 6. 分支、HEAD、工作区与运行环境

- 修复提交：见本分支 `git log`（代码 + 测试 + 本报告）。
- 并行改动：19 个 M + 12 个未跟踪文件仍然存在，未被覆盖、回滚、清理；它们未进入本次修复提交。
- 修复前 HEAD：`7ab465f`；修复后 HEAD：本次修复提交（`git log -1`）。
- 运行环境：
  - 正式 3001 仍是 20:43 旧构建，5173 是代理到 3001 的新前端（版本错配，未重启）；
  - 修复验收使用 3210（最新 dist，启动约 23:10）+ 5180（最新 web dist），mock 模型，临时目录 `.maoeh/acceptance/state-repair`；
  - 验收结束已停止 3210/5180。

---

## 7. 剩余风险与未解决项

1. **mock 沙盘的发言仍是认知 JSON**：真实浏览器链路可跑通，但 brief 的目标/验收文本包含 JSON（评分 `scores=null`）。live 模式下为自然语言；本阶段不处理 mock 文案。
2. **F2 的语义变化是全局的**：只有 rejected 分支的定义，遇到真实 `Task.Failed` 不再借用 rejected 分支，会走 fallback（重试/abort）。这是 F2 要求的严格语义；需要在 live 运行中观察是否有依赖旧 fallback 的模板。
3. **取消理由保真**：`Task.Cancelled` 折叠未保存 reason，暂停恢复的 abort detail 是通用句；实例 reason 为 `task_cancelled`。本次未扩展该字段。
4. **无评分会话仍可确认占位验收标准**：F1 修复的是页面，不是验收质量；该问题留待后续。
5. **正式栈未重启**：新端点/新读模型需重启 API 后才会在 3001 生效；现场演示前必须处理。
6. **preview flake**：本次全量/单跑均通过，但历史记录说明它对并行负载敏感，不能保证每次全量都绿。

---

## 8. 验收结论

F1、F2、F3 均已修复并有失败→通过证据；真实浏览器全链路、并发/重复/越权/非法状态、暂停终态分支、事件关联和全量门禁全部通过。

本阶段停止，等待人工审查。
