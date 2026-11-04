# MAOEH — 长期项目记忆

## 架构铁律（改代码前必读）
- **五条公理**：组织先于任务 / Agent 是长期实体 / 一切状态变更是事件 / LLM 只能提议内核才能执行 / 员工之间不直接调用。
  唯一副作用入口是 `append(event)`；禁止直接改内存状态。
- 分层：Agent Layer（推理规划沟通）/ Runtime Layer（执行调度状态）/ Infrastructure Layer（存储事件工具）**不得互相污染**。
- 能力路由铁律：**能力 → 岗位，永不按岗位名字匹配**。`Position.capabilities` 是路由契约的唯一依据。
- 反退化检查清单见根 `README.md`；架构权威是 `docs/architecture/ARCHITECTURE-BASELINE.md`，
  文档索引与状态在 `docs/architecture/README.md`（新增文档必须登记）。

## 能力模型（M1.6 后半段定型）
- **两层能力，正交**：
  - `Position.capabilities` = 这个**坑**提供什么能力（路由契约，默认路线，含「空坑升迁到最近有人上级」）。
  - `Employee.expertise` = 这个**人**擅长什么（person-level 细粒度标签，如 `typescript`/`react`/`pytorch`）。
- 匹配是**双路线**：座席路线 + 专长路线。专长路线**只扩大候选场，不参与空坑升迁**（升迁=组织层级，专长=个人能力，混起来无法解释）。
- 评分：`matchedCapabilities 数量 × 10 + 部门匹配 5`，`available` 是硬门槛。**与路线无关**。
- `matchedCapabilities` 恒按**需求顺序**；`expertiseMatched` 单独记录靠专长覆盖的部分。
- 词表：`product_requirement / technical_design / implementation / frontend / backend / testing / marketing`。
  `CORE_CAPABILITIES` 是**写死的四项交付弧**（不含 frontend/backend/marketing），词表增长不得改变回退链。
- 种子组织：`agents/future-ai-lab/`（1 公司 / 5 部门 / 15 岗位 / 6 员工）。
  `engineer` 声明 implementation+frontend+backend；`frontend-engineer`/`backend-engineer` 各带专精。

## 坑位解析（org-graph · 2026-10-05 死锁修复后定型）
- **一个坑位可承载多条 employee 记录**：M1.3 re-hire 里辞退是**改状态**不是删记录（`Agent.Archive`），
  旧记录仍指向原坑位 → 同坑会出现「先 offboarded、后 active」。真实日志 `peter-ai-lab` 的 qa/cto/engineer 都如此。
- `OrgGraph.resolveByPosition(坑)` 必须**优先取可执行占坑者**，无则回退第一条。
  修复前「取第一条」会让离职前任遮蔽在岗者 → 工作流 `preflightStep` 拒入该步
  （`employee X has employment status offboarded`）→ `settleSubmitted` 回滚 → 该 stage 永远 active → 死锁。
  **契约早写在 `03-data-model.md` §3.2.1（「解析到当前在岗员工」），是代码违反契约，不是契约要改。**
- 雇佣状态判据**唯一实现**在 `EmployeeStatus` 旁：`NON_EXECUTABLE_EMPLOYMENT_STATUSES` /
  `isExecutableEmployment()`（`employee.ts`）。四处调用方（`task-system` / `workflow-engine` /
  `permission-system` / `org-graph`）必须引用它，**禁止再写副本**。`on_leave` 刻意不在其中
  （休假者仍占坑，只是不能接新活）。
- 坑位解析只回答「谁坐在这」；「他能不能接活」由调用方各按更严规则判（TaskService 留岗、WorkflowEngine 拒入）。

## 关键文件地图
| 关注点 | 文件 |
| --- | --- |
| 坑位解析 / 员工-岗位关系图 | `.../organization/org-graph.ts` |
| 能力词表 / 目标分析 | `packages/organization-model/src/capability/vocabulary.ts` |
| 能力 → 岗位解析（含升迁） | `.../capability/resolve-capabilities.ts` |
| 派生 profile（capabilities + expertise） | `.../capability/capability-profile.ts` |
| 能力 → 候选人匹配与排序 | `.../capability/match-candidates.ts` |
| 员工 / 岗位 / 组织实体 | `.../employee/employee.ts`、`.../position/position.ts` |
| 组织加载与归一化 | `.../loader/{schemas,load-organization}.ts` |
| 控制面命令 / 事件 / 校验 / 派发 | `packages/organization-control/src/{types,events,validation,service,query}.ts` |
| 运行期装配与回放 | `apps/kernel/src/simulation/simulation.ts`（`materializeAgent` / `projectAgentRoster`） |
| 控制台 | `apps/web/src/pages/{Agents,Tasks}.tsx`、`apps/web/src/derive.ts` |
| **交付塑形（按步骤能力出件）** | `apps/api/src/product-deliverables.ts`、`apps/api/src/game-deliverables.ts` |
| 交付页「整套交付」面板 | `apps/web/src/pages/Results.tsx`、`apps/web/src/results.ts`（`deliveredFiles` / `workflowStepTasks`） |

## 命令（本机注意）
- 仓库无 git 仓库（`git log` 报 not a repository），不要依赖 git 历史。
- 本机 Bash 工具 PATH 坏，须先 `export PATH="<PortableGit>/bin:<PortableGit>/usr/bin:/d/nvm4w/nodejs:$PATH"`。
- 用 `./node_modules/.bin/{vitest,turbo,eslint}` 直接跑，别用 `pnpm`（PATH/loader 不稳）。
  PowerShell 里 `.ps1` shim 因执行策略跑不了，直接 `node node_modules/.pnpm/vitest@*/node_modules/vitest/vitest.mjs run`。
- 常用：`vitest run`（全量）· `turbo run typecheck` · `turbo run build` · `eslint .`。
- 测试通过 vitest alias 直接读 `packages/*/src`，**不需要先 build**。
- 全量测试规模：112 文件 / 823 测试（2026-10-05）。

## 环境限制（2026-10-06 实测）
- **DSH 沙箱内跑不了 vitest**：esbuild 以管道 stdio 起子进程被拒（`spawn EPERM`，启动即失败）。
  可行的替代验证：`node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p apps/<app>/tsconfig.json`
  ＋ `node scripts/probe-*.mjs`（直接 import 构建产物 `dist/*.js`）。
  新增测试文件想单独类型检查：临时 `tsconfig.probe.json`（`moduleResolution: bundler` + `paths` 指向 `packages/*/src`），
  注意 `tests/helpers/simulation-fixtures.ts:201` 有**既有**的 `exactOptionalPropertyTypes` 报错，不是新引入的。
- 生产认知只有 **mock provider**（`createMockLlmProvider({ text: deterministicCognitionText })`），
  `llm-gateway` 里没有真实模型 provider —— 所有 Agent 的"思考"都是同一段确定性代码。

## 已知真实缺陷（2026-10-06 诊断，勿重复挖）
- 详见 `.workbuddy/memory/2026-10-06.md` 与 `docs/review/role-agents-cannot-complete-tasks.md`。
- **A 已修**：`deterministic-cognition.ts` 的 `WorkBriefed` 曾按「负载最低」自己选坑 → 选到空坑。
  现已改为 `requiredCapabilitiesFor(goal)` → `CreateProposal`（与 mandate 同一条能力路由器）。
- **B 未修**：派到空坑的任务静默卡死（`eligibility.ts:182` 不唤醒 + `DispatchWork` 是独立任务、绕过
  `workflow-engine.ts:511` 的空坑守卫）。**「派出去的活必须有能执行的人」应作为不变量守住。**
- **C 未修**：`Work.SubmitBrief.verificationKeys` 是自由文本，不能直接当 `requiredOutputKeys`
  （否则交付物只能是 `{句子: 句子}`、`artifacts: []`）。
- **教训**：验收测试全用 **lab 种子**（有 engineer），而真实产品用 **starter 公司**（只有 CEO）。
  组织形态不一致 → 缺陷藏了很久。新增端到端用例时**必须覆盖 starter 形态**。
- `ACTIONS` 里 `RecommendHire` / `ProduceArtifact` **未绑定** `PLAN_ACTION_BINDINGS` → 发出即 `unsupported_action`。

## 交付契约（2026-10-07 修复后定型，勿回退）
- **交付形状按「步骤声明的能力」决定，不按执行者座席标签**：`Task.capability`（来自 `WorkflowStep.capability`，
  随 `Task.Created`/`Task.Assigned` 事件流转）→ `apps/api/src/product-deliverables.ts` 的 `capabilityDelivery`。
  座席标签只在任务没有声明能力时兜底。**理由**：一个声明 implementation+frontend+backend 的坑吃掉三步时，
  按座席塑形会让三步交回同一份前端页（ss 的「交付成果只有前端」）。
- **同一 workflow 的 frontend/backend 是同一条需求生成的两半**：`productSpec` 用 `requiredCapabilitiesFor(requirement)`
  + `detectGame` + `backendLanguage` 得到产品形状，API 路径（`/api/health`、`/api/scores`）由两边独立生成也必然一致。
- **交付必须带字节**：`data.files[{path,language,content}]` 与 `artifacts` 同时给出，交付页（`/results/:taskId`）
  的「交付成果（整套）」面板逐文件列出并下载；`data.content`/`entrypoint` 仍是入口文件（向后兼容）。
- `implementation` 步骤：计划被拆分（含 frontend/backend）时交付 `run.py`+`README.md`（一条命令跑起来），
  未拆分时交付整页产品（旧行为）。
- 生成的服务**只用标准库**（Python `ThreadingHTTPServer`+`sqlite3`/WAL，或 Node `node:http`+JSON），
  默认 Python；需求点名 node/express 时出 Node 版。

## 运行期服务（本机开发）
- **API `:3001`**：`cd apps/api && node --watch dist/index.js`（先 build，dist 变了会自动重启）。
- **Web `:5173`**：`cd apps/web && node ../../node_modules/.pnpm/vite@6.4.3_@types+node@22.20.4_yaml@2.9.1/node_modules/vite/bin/vite.js`
  —— 别用 `node_modules/.bin/vite` shim，它在 MINGW 下算错 basedir。
- **真实状态在 `%LOCALAPPDATA%\maoeh`（不在仓库里）**：`companies.json` + `future-ai-lab/<companyId>/events.jsonl`。
  仓库里的 `.maoeh/` 是旧的，别当真相。API 启动会打印 `recovered N events, M employees`。
- **重启做法**：`taskkill /F /T /PID <pid>`（**单斜杠**），再用 Bash 工具的 `run_in_background` 起。
  `Start-Process` 起的子进程会被回收；Bash 里 `cmd /c start` 会被安全策略拦下。

## 工作方式提醒
- 并行发多个 Edit 时偶发「报告成功但未落盘」；关键改动后必须 Grep/Read 复核。
- 扩展种子 YAML 前先看 `tests/unit/organization-model/seed-org-snapshot.test.ts` 等对种子做了哪些断言。
