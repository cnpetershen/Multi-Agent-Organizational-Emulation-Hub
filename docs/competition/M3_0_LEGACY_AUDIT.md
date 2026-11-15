# M3.0 — 遗留任务与虚假交付核查

> **性质**：正式演示公司 `peter-ai-lab` 的只读审计记录（2026-11-15）。
> **实现**：`packages/organization-control/src/legacy-audit.ts`；读面 `GET /api/legacy-audit`。
> **配套**：协作事件协议见 [`../architecture/M3.1-collaboration-event-protocol.md`](../architecture/M3.1-collaboration-event-protocol.md)。

---

## 1. 结论

| 问题 | 结论 |
| --- | --- |
| task-41 是否假交付？ | **不是**。它从未交付，状态 `cancelled`；取消理由真实（被 `/api/sandbox` 会话引擎取代）。唯一缺陷是取消事实被写成 `sim=0`（时序倒置），审计如实报告，**不改写、不删除**。 |
| task-10 是否假交付？ | **不是**。`completed`，`technical_design_doc` 验收键存在，正文 4,813 字符，由 `ai-researcher-hire` 提交、`kernel-reactor` 确定性结算。 |
| 是否存在空交付？ | 活跃任务 **0 条**；历史记录 **1 条**（`task-48`，空 `data` 却 completed，后来被删除）——本轮补上「已删除记录仍审计」后可见。 |
| 是否存在状态不一致？ | 5 条活跃任务 + 7 条已删除任务存在「终态时间早于创建」的时序倒置（全部源于旧控制台把浏览器陈旧时钟写进命令）。 |
| 需要清理多少？ | **0 条**。当前没有停滞的开放任务、没有悬空交接、没有未结算提交；无可合法取消项，因此本轮不产生任何取消/删除。 |
| 是否删除了数据？ | **否**。本轮新增 0 条 `Task.Deleted`、0 次重写；所有结论都来自日志事实。 |

审计口径（本轮源码版本）：**38 个活跃任务 + 15 条已删除历史记录，13 条 finding，可修复（cancel）= 0**。

---

## 2. 环境与方法

| 项 | 值 |
| --- | --- |
| 公司 | `peter-ai-lab`（Peter AI Lab，7 名员工） |
| 日志 | `%LOCALAPPDATA%\maoeh\future-ai-lab\peter-ai-lab\events.jsonl`（核查时约 131,000 条事件，持续追加中） |
| 业务时钟 | `evaluatedAtSim = 130,235`（取快照时刻） |
| 正式栈 | `http://localhost:3001`，核查期间保持运行；**未发送停止/重启命令** |
| 方法 | 只读：`GET /api/legacy-audit`、`GET /api/tasks`、`GET /api/tasks/:id`，以及按 `taskId` 流式读取 `events.jsonl`。没有 POST、没有 control command、没有改文件 |
| 判据 | 任务折叠（`applyTaskEvent`）+ 日志证据 + 组织员工状态；`TaskService` 的合法迁移表（`ALLOWED_TASK_COMMANDS`）决定「能修什么」 |

审计函数是纯函数：不写事件、不改任务、不碰文件系统。HTTP 读面也只有 GET。

> 说明：3001 由仓库既有的 `turbo watch build dev` + `node --watch` 开发栈托管；本轮源码变更后，watcher 自动重建 `dist` 并重启了 API 子进程（本会话没有发送停止/重启命令）。当前 `GET /api/legacy-audit` 已返回本轮实现的结果：38 个活跃任务 + 15 条归档记录、13 条 finding、可修复 0。

---

## 3. 审计结果总览

| code | 活跃 | 已删除 | 合计 | 含义 |
| --- | ---: | ---: | ---: | --- |
| `chronology_violation` | 5 | 7 | 12 | 终态事实的时间早于任务创建 |
| `empty_delivery` | 0 | 1 | 1 | completed 但交付内容为空 |
| `unverified_delivery` | 0 | 0 | 0 | completed 但声明的验收键缺失 |
| `orphaned_submission` | 0 | — | 0 | submitted 且长期无人结算 |
| `stalled_open_task` | 0 | — | 0 | 开放任务长期无活动 |
| `dangling_handoff` | 0 | — | 0 | 交接等待已不可用的接收者 |
| **合计** | **5** | **8** | **13** | 可修复（cancel）**0** |

「已删除」不是另一份数据：它是同一条 append-only 日志上、被 `Task.Deleted` 移出活跃看板的记录。审计折叠到最后一次删除之前的状态，因此删除记录不能顺带删除对它的审计。

---

## 4. 时序倒置（12 条）

同一根因：旧控制台把**浏览器本地陈旧时钟**写进命令，导致取消/删除类终态被记成 `sim=0`。控制面在 M2.1 修复后已改用 kernel 时钟（`docs/competition/M2_1_LIVE_REPAIR.md`），但历史事实不会被改写。

| 任务 | 记录 | 终态事件 | 终态 sim | 创建 sim | 证据 |
| --- | --- | --- | ---: | ---: | --- |
| `task-15` QA verify tic-tac-toe deliverable | 活跃 | `Task.Cancelled` | 0 | 8516 | `evt-8771`, `evt-64026` |
| `task-35` Requirements spec … zhuanzhuanben | 活跃 | `Task.Cancelled` | 0 | 57487 | `evt-57994`, `evt-58308` |
| `task-36` Implement planning endpoint and SLA board | 活跃 | `Task.Cancelled` | 0 | 57487 | `evt-57996`, `evt-58309` |
| `task-37` QA verification of endpoint and SLA board | 活跃 | `Task.Cancelled` | 0 | 57487 | `evt-57998`, `evt-58311` |
| `task-41` 商业项目 "赛博沙盘" 模拟多角色对抗质询系统 | 活跃 | `Task.Cancelled` | 0 | 63048 | `evt-63628`, `evt-82457` |
| `task-1` 早期占位运行 | 已删除 | `Task.Deleted` | 0 | 328 | `evt-364`, `evt-56118` |
| `task-20`…`task-22` 画布演示清理 | 已删除 | `Task.Deleted` | 0 | 16492 | `evt-16820`… |
| `task-23` / `task-24` 画布演示清理 | 已删除 | `Task.Deleted` | 0 | 16511 | `evt-16859`, `evt-16861` |
| `task-49` 沙盘占位报告 | 已删除 | `Task.Deleted` | 0 | 64780 | `evt-65525`, `evt-65733` |

处理裁定：**报告，不重写**。日志是 append-only；「把 sim 改成正确值」等于伪造历史。真正的修复是写入方已修（kernel 时钟），未来事实不再倒置。

反例（说明规则确实在区分）：`task-34` 同样被控制台取消，但 `Task.Cancelled @ sim 56885 > created @ 56265`，因此**不**被报告。

---

## 5. 虚假交付核查

### 5.1 当前活跃看板：无

- `empty_delivery = 0`：所有 `completed` 任务都有非空 `data`。
- `unverified_delivery = 0`：声明了 `requiredOutputKeys` 的完成任务，验收键都存在且非空。
- 抽查：`task-8/9/10/11/14/16/17` 的交付键（`index.html`、`playable`、`scoreboard`、`turn_detect`、`win_check`、`draw_check`、`technical_design_doc`、`qa_verdict`）均有真实内容；工作流步骤任务（`task-2`…`task-7`、`task-25`…`task-33`、`task-38`…`task-47`）的 `data` 非空。

### 5.2 历史记录：1 条真实假交付（已删除，仍被审计）

`task-48`「sandbox placeholder report」：

- `Task.ProgressReported`（submitted）的 `result.data = {}`，只有一句 summary；
- `Task.Completed` 由 reactor 结算成功；
- 随后被 `Task.Deleted`（`sim=0`，理由 `placeholder sandbox report superseded by the runnable scenario runtime`）移出看板。

这正是「删除记录会顺带抹掉假交付证据」的风险。M3.0 的审计因此fold 到删除前一刻，报告 `empty_delivery`（`record: deleted`，`severity: warning`，`repair: none`）：记录已不在看板，但**事实仍在审计里**。

`task-49` / `task-50` 也是占位交付，但其 `index.html` 有非空文本，因此只报删除时序问题，不报空交付。按 M3 的规则，它们**不再被删除第二次**。

### 5.3 值得说明的边界案例

`task-15`：曾于 `sim=8942` 提交（`playable`、`qa_verdict`），但缺少 4 个声明验收键（`qa_report` 等），随后以「占用 QA 座位」为由取消。它**从未 completed**，因此不构成「完成声明」，不计入 `empty_delivery`；但它也不是一次达标的交付。这类「提交未达标后被取消」的记录，审计口径是：**不判假完成，保留提交证据**。

---

## 6. task-10 专项

| 项 | 值 |
| --- | --- |
| 标题 | Technical design for self-contained Snake game |
| 状态 | `completed` |
| 执行人 | `ai-researcher-hire`（AI Researcher 席位） |
| 相关性 | `live-multi-demo-1`（单机多 Agent 演示） |
| 时间线 | created `6832` → accepted/started `6833` → submitted `81483` → completed `81483`（`kernel-reactor`） |
| 交付 | `technical_design_doc`，4,813 字符，含 SVG 20×20、键盘、碰撞、暂停、计分、最高分等设计 |
| 验收 | `kind=deterministic`，`requiredOutputKeys=[technical_design_doc]`，键存在且非空 |
| 审计结论 | **干净**，无 finding，无需修复 |

说明：`6833 → 81483` 之间约 7.4 万 tick 的空档不是「卡死」：任务在 `started` 状态等待演示推进，期间没有 stall 触发（实时 tick 停/续由操作员控制）。审计按最后一次活动判断停滞，因此不会误报。

---

## 7. task-41 专项

| 项 | 值 |
| --- | --- |
| 标题 | 商业项目 "赛博沙盘" 模拟多角色对抗质询系统 |
| 状态 | `cancelled`（无 result、无 review、无 verification） |
| 执行人 | `engineer-hire`（Software Engineer） |
| 相关性 | `ui-1794639308251-1` |
| 时间线 | created/assigned/injected/delegation `63048` → accepted `63051` → **cancelled `sim=0`**（`evt-82585`） |
| 取消理由（原文） | `superseded by the real sandbox session engine at /api/sandbox (2026-11-14); closing the stale commercial-sandbox task, history kept` |
| 控制命令 | `Control.TaskCancelled`，`commandId = close-task-41-1794658598144` |
| 审计结论 | 不是假交付；唯一 finding 是 `chronology_violation`（取消 @ 0 < 创建 @ 63048），`repair: none` |

判断依据：

1. 该任务从未 `completed`，没有交付声明，因此不存在「用占位内容骗过验收」。
2. 取消是真实的业务动作：沙盘后来由 `/api/sandbox` 的真实会话引擎承担，旧商业任务应关闭；理由明确写了 `history kept`。
3. 缺陷只在时间戳：取消命令走了旧的控制台时钟，被记成 `sim=0`。状态本身（`cancelled`）是正确的，**不应恢复成 open**；恢复反而会制造一个无人认领的任务。
4. 因此本轮**不做任何变更**，只在审计中保留该事实与证据 id。

---

## 8. 状态一致性核查

| 检查 | 结果 |
| --- | --- |
| 开放任务（created/assigned/accepted/started/blocked） | 0 条 |
| `submitted` 未结算 | 0 条（`orphaned_submission = 0`） |
| 悬空交接（requested 且接收者不可用/超时） | 0 条 |
| 交接链状态与任务终态不一致 | 0 条（全部为 `completed`/`cancelled` 且无 open handoff） |
| `completed` 但无交付内容 | 活跃 0；历史 1（`task-48`） |
| 终态时间倒置 | 12（见 §4） |
| 已删除记录 | 15 条（全部有 `Task.Deleted` 理由与操作者；事件仍在日志） |

已删除记录不是 M3 产生的：它们来自此前的画布演示清理、招聘占位清理与 M2.4 的占位沙盘替换。M3 本轮新增删除 = **0**。

---

## 9. 清理逻辑：能修什么、不修什么

审计的 `repair` 只有两种取值，来自真实状态机：

| 情形 | repair | 依据 |
| --- | --- | --- |
| 停滞的独立任务（`created/assigned/accepted/started/blocked`，超过 45 tick） | `cancel` | `ALLOWED_TASK_COMMANDS` 允许 cancel；取消保留全部事件 |
| 停滞提交（`submitted`，非 review 类，独立任务） | `cancel` | submitted 允许 cancel，提交结果留在日志 |
| 悬空交接 | `cancel` | 取消会把交接结算为 `cancelled`，链仍完整 |
| 工作流步骤停滞 | `none` | 取消会中止整个 workflow instance（M2 语义），必须由人决定 |
| 已完成但空交付/缺验收键 | `none` | 没有 un-complete 迁移；重写即伪造 |
| 时序倒置 | `none` | append-only；只能修写入方 |
| 已删除记录 | `none` | 不在看板，无迁移可做；只保留审计 |

`legacyRepairPlan(report)` 把可取消项按任务聚合成命令（含证据摘要），但**不会自动执行**：执行必须走真实的 `TaskService.cancel`（或未来等价的控制命令），留下 `Task.Cancelled` 与操作者。本轮现场扫描的可修复项为 0，所以没有执行任何取消。

---

## 10. 审计记录与复现

| 证据 | 位置 |
| --- | --- |
| 实时读面 | `GET http://localhost:3001/api/legacy-audit` |
| 领域实现 | `packages/organization-control/src/legacy-audit.ts` |
| 单元测试 | `tests/unit/organization-control/legacy-audit.test.ts`（含「已删除记录仍审计」「合法取消保留历史」） |
| API 测试 | `tests/unit/api/m3-read-endpoints.test.ts` |
| 生产快照（本地） | `.maoeh/audit/m3-legacy/live-audit.json`、`task-details.json`、`chains.json` |
| 临时生产审计脚本 | `tests/tmp-production-audit.test.ts`（只读；输出到系统临时目录） |

复现方式：在正式环境只读执行 `GET /api/legacy-audit`；或在本地运行上述单元测试。任何写入型修复都必须单独授权并留下审计事件，不在本报告范围内。

---

## 11. 局限与后续

1. **旧时间戳不可修复**：12 条时序倒置会长期存在；产品文案不应把这类终态当作「可信业务结果」展示，审计页应标注。
2. **3001 的构建由 watcher 管理**：源码变更会被 `turbo watch build dev` 自动重建并触发 `node --watch` 重启；这是既有开发栈行为，不是手工重启。若演示期间不希望自动重启，应在演示前停止 watcher 而非依赖本轮约束。
3. **已删除任务的交付内容仍可读**：审计能看到，但产品交付包不应把已删除任务的交付当成公司成果。
4. **下一阶段**：M3.1 交接链会持续产生新的协作事实；建议把 `dangling_handoff` 与交接结算纳入日常运维观察，而不是等 M3.0 审计再发现。
