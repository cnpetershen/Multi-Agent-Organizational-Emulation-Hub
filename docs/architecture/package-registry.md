# Package Registry — 包注册表（命名与边界的唯一权威）

> **地位**：Single Source of Truth for package naming & boundaries。
> 当任何其他文档（含 `02-modules.md` 历史章节）与本文冲突时，**以本文为准**。
> 变更须走 `ARCHITECTURE-BASELINE.md` §17 Architecture Change Process。
>
> 冻结日期：2026-09-30 · 状态：FROZEN（初版）

---

## §0 命名映射与裁定（Package Drift Resolution）

裁定方向：**代码侧 28 包命名为规范名（canonical）**，文档侧旧名废弃。
本轮不改任何目录名（Reconciliation 轮禁止新增/删除/重命名模块）。

| Current Package | Existing Architecture Name | Decision | Reason |
| --- | --- | --- | --- |
| `shared-types` | `shared`（02-modules §2.1） | KEEP（旧名废弃） | 职责一致（ID/Result/SimTime/Schema）；现名更明确表达其为类型包 |
| `organization-model` | `org-model` | KEEP（旧名废弃） | 职责一致：组织实体与关系纯函数领域模型（02-modules:72） |
| `permission-system` | `org-authz`（裁决半边） | KEEP（拆分保留） | `AuthzService.can/effective` 与决策权等级是两个变更频率不同的关注点；拆分见 §Authority 行 |
| `authority-engine` | `org-authz`（决策权半边） | KEEP（拆分保留） | L0–L5 按决策域取值（03-data-model §3.4.2），独立于 RBAC/ABAC 裁决，审计 §9 要求 `levelFor` 独立可查 |
| `policy-engine` | `org-policy` | KEEP（旧名废弃） | 职责一致：制度/预算/SLA/审批阈值（02-modules:74） |
| `event-system` | `event-bus`（信封+订阅半边） | KEEP（拆分保留） | 信封/事件类型注册/订阅匹配为纯机制，无 I/O；与持久化半边分离后可独立单测 |
| `event-store` | `event-bus`（append/outbox/replay 半边） | KEEP（拆分保留） | append/outbox/重放必须与 Postgres 事务耦合（Postgres-first, ADR）；分离后 event-system 保持零 persistence 依赖 |
| `persistence` | `persistence` | KEEP | 职责一致：Schema/迁移/仓储/事务/快照（02-modules:87） |
| `agent-memory` | `memory` | KEEP（旧名废弃） | 职责一致：记忆存储/检索/衰减/反思调度；**层归属仍为 Infrastructure**（见 §Layer 注） |
| `llm-gateway` | `llm-gateway` | KEEP | 职责一致：A4 唯一 LLM Egress（02-modules:89） |
| `agent-tools` | `tool-gateway` | KEEP（旧名废弃） | 职责一致：工具注册/授权闸门/沙箱（A4 物理实现点） |
| `observability` | `observability` | KEEP | 职责一致：Trace/指标/成本/llm_calls（02-modules:91） |
| `agent-definition` | `agent-core` | KEEP（旧名废弃） | 职责一致：8 层结构定义 + YAML 装配（02-modules:103） |
| `agent-cognition` | `agent-cognition` | KEEP | 职责一致：Prompt 唯一归属地（02-modules:104） |
| `agent-runtime` | `runtime-loop` | KEEP（旧名废弃） | 职责一致：10 阶段认知循环执行器（02-modules:148） |
| `runtime-state` | `runtime-state` | KEEP | 职责一致：状态机/检查点/单写者并发（02-modules:149） |
| `runtime-scheduler` | `runtime-scheduler` | KEEP | 职责一致：SimClock/唤醒队列/防饿死（02-modules:150） |
| `workflow-engine` | `workflow-engine` | KEEP | 职责一致：模板/实例/审批门/偏离请求（02-modules:162） |
| `decision-engine` | `decision-engine` | KEEP | 职责一致：提案/评议/加权计票/决策档案（02-modules:163） |
| `meeting-engine` | `meeting-engine` | KEEP | 职责一致：议程/发言权轮转/纪要编排（02-modules:164） |
| `agent-communication` | `comm` | KEEP（旧名废弃） | 职责一致：频道/消息/汇报/正式文书（02-modules:165） |
| `escalation-engine` | `escalation-engine` | KEEP | 职责一致：SLA 超时/冲突升级阶梯（02-modules:166） |
| `identity-system` | （无 — 文档未定义） | KEEP + **NEW DOCUMENTED** | 审计 §9 四分法要求 Identity 独立（Who are you）；A1 的 `ActorContext` 主体来源；字段依据 03-data-model §3.2.1 EMPLOYEE/AGENT_PROFILE，不凭空设计 |
| `task-system` | （无 — 文档未定义） | KEEP + **NEW DOCUMENTED** | 03-data-model §3.8.1「任务独立于流程的工作单元」有表无模块；Action 枚举中 7 个 Task 动作需要归属模块 |
| `knowledge-system` | （无 — 文档未定义） | KEEP + **NEW DOCUMENTED** | 03-data-model §3.7 `documents` 表（组织级知识，非个人记忆）需归属模块，与 agent-memory 物理隔离 |
| `artifact-system` | （无 — 文档未定义） | KEEP + **NEW DOCUMENTED** | Action 枚举 `ProduceArtifact`（02-modules:315）的产物登记与溯源需要归属模块 |
| `audit-system` | `observability` 内 `audit()`（02-modules:91） | KEEP + **NEW DOCUMENTED**（职责切分） | 审计 §14：Audit=谁做了什么/是否允许/结果；Observability=trace/metrics/cost。两语义不同，分开后各自可测 |
| `config` | （无 — 文档未定义） | KEEP + **NEW DOCUMENTED** | 工作区级配置（路径/环境/开关），无业务规则；避免各包散落常量 |

**统计**：KEEP 22（其中旧名废弃 9、拆分保留 4）· NEW DOCUMENTED 6 · RENAME 0 · MERGE 0 · REMOVE 0。

> **前缀警告**：`agent-memory` / `agent-tools` / `agent-communication` 名含 `agent-` 但层归属分别为 Infrastructure / Infrastructure / Orchestration。
> `02-modules.md` §2.3 的**前缀式依赖规则对这三个包失效**，一律以本注册表逐包 Allow/Forbidden 清单为准。

---

## §Registry — 逐包注册条目

状态词表：`SCAFFOLD` = 仅占位代码 · `PARTIAL` = 有部分契约代码 · `IMPLEMENTED` = 有实现与调用链。

### shared-types

- **Responsibility**：全系统基础类型：ID Brand、`Result<T,E>`、`SimTime`、`ActorContext`、`OrgEvent` 信封类型、Zod Schema 基元、错误码。零业务规则。
- **Public API**：`Brand<T,B>`、`Result<T,E>`（已存在，`src/index.ts:1-5`）；`ActorContext`、`OrgEvent<T>`、`SimTime`、ID 类型族（**契约规格**，见 02-modules §2.4，未实现）
- **Allowed Dependencies**：（无 — 允许依赖树的根）
- **Forbidden Dependencies**：一切 `@maoeh/*` 包；任何 I/O、任何业务规则
- **Layer**：Organization/Domain（基础）
- **Runtime Role**：全系统类型契约载体，无运行时行为
- **Status**：PARTIAL（2/8 关键契约类型）

### organization-model

- **Responsibility**：Company/Department/Position/Employee/Relationship/Goal 的**纯函数**领域逻辑；岗位-员工分离模型；汇报线闭包。
- **Public API**：`OrgGraph.getManagerOf(id)` / `getReports(id)` / `getPeers(id)` / `resolveByPosition(posId)`（02-modules:72）· **M1.6 能力**：`Position.capabilities?`、`capability/vocabulary.ts`（`CAPABILITY_VOCABULARY` / `analyzeCapabilities` / `requiredCapabilitiesFor` / `capabilityLabel`）、`capability/resolve-capabilities.ts`（`resolveCapabilityAssignments`）、`organization/runtime-position.ts`（`buildRuntimePosition`）（M1.6 §2–§4）
- **Allowed**：`shared-types`
- **Forbidden**：`agent-*`、`runtime-*`、`*-engine`、`permission-system`、`authority-engine`、`persistence`、`event-*`、`llm-gateway`、`apps/*`（组织层永远不知道 AI 存在，02-modules:238）
- **Layer**：Organization/Domain（确定性）
- **Runtime Role**：查询与不变量裁决（属性测试目标：汇报线无环、唯一上级）
- **Status**：SCAFFOLD

### identity-system

- **Responsibility**：Identity = **Who are you**。员工身份注册/解析（`employee_no` ↔ id）、在职状态派生、`ActorContext` 的主体构造（A1 的物理来源）、`OrgSnapshot` 中身份切片的装配输入。**不含**「你是什么岗位的人」（归 agent-definition）、「你能做什么」（归 permission-system）、「你有多大决策权」（归 authority-engine）。
- **Public API**（规格，未实现）：`Identity.register(employee): EmployeeIdentity` · `Identity.resolve(employeeId): EmployeeIdentity` · `Identity.actorContext(employeeId, correlationId): ActorContext`
- **Allowed**：`shared-types`、`organization-model`
- **Forbidden**：`persistence`（经 Runtime 注入端口）、`llm-gateway`、`agent-*`、`apps/*`、`*-engine`
- **Layer**：Organization/Domain（确定性）
- **Runtime Role**：A1 ActorContext 供给方
- **Status**：SCAFFOLD
- **依据**：01-overview A1；03-data-model §3.2.1 `EMPLOYEE`/`AGENT_PROFILE` 字段；审计 §9 四分法

### permission-system

- **Responsibility**：Permission = **What can you do**。有效权限计算（RBAC+ABAC）、命令裁决 `AuthzService.can()`、权限闭包与传递、停职即失效。
- **Public API**：`AuthzService.can(actor: ActorContext, action: Action, resource: ResourceRef, ctx?): AuthzDecision` · `AuthzService.effective(employeeId): PermissionSet`（02-modules:357-366，**签名含 ctx，禁止退化为 `can(actor, action)`**）
- **Allowed**：`shared-types`、`organization-model`、`authority-engine`（NEEDS_APPROVAL 判定需等级阈值）
- **Forbidden**：`persistence`、`event-*`、`llm-gateway`、`agent-*`、`apps/*`、执行命令本身（只裁决不执行，02-modules:73）
- **Layer**：Organization/Domain（确定性）
- **Runtime Role**：认知循环第 ⑦ 阶段 Authorize 的裁决核心
- **Status**：SCAFFOLD

### authority-engine

- **Responsibility**：Authority = **How much decision power**。L0–L5 按 `DecisionDomain` 取值；`POSITION.decision_domains`/`authority_level` 解析；决策权归属判定（org-authz 的决策权半边）。
- **Public API**：`AuthorityService.levelFor(employeeId, domain: DecisionDomain): AuthorityLevel`（审计 §9 强制签名）· `AuthorityService.domainsFor(employeeId)`
- **Allowed**：`shared-types`、`organization-model`
- **Forbidden**：`persistence`、`llm-gateway`、`agent-*`、`apps/*`、`permission-system`（方向禁止：permission → authority 单向）
- **Layer**：Organization/Domain（确定性）
- **Runtime Role**：AuthzDecision 的 `requiredAuthority` 供给；Decision Engine 计票权重输入
- **Status**：SCAFFOLD
- **依据**：03-data-model §3.4.2/§3.4.4；ADR（权限随岗位）

### policy-engine

- **Responsibility**：组织制度约束：预算上限、SLA、审批阈值、行为红线。`PolicyService.evaluate` 给出 Verdict。
- **Public API**：`PolicyService.evaluate(cmd, actor): PolicyVerdict` · `PolicyService.slaFor(kind): Duration`（02-modules:74）
- **Allowed**：`shared-types`、`organization-model`
- **Forbidden**：`llm-gateway`（零 LLM）、`persistence`、`agent-*`、`apps/*`、推理与文本生成
- **Layer**：Organization/Domain（确定性）
- **Runtime Role**：编排层各引擎的阈值/SLA 供给方
- **Status**：SCAFFOLD

### agent-definition

- **Responsibility**：Agent 的 8 层结构定义；从 `agents/**/*.yaml` 装配 `Agent` 实例；生命周期状态承载。**不做推理、不碰数据库**。
- **Public API**：`AgentFactory.build(employeeId, orgSnapshot): Agent` · `Agent { identity, role, cognition, memory, skills, tools, comm, decision, state }`（02-modules:103, 370-384；**Agent 上禁止出现指向另一 Agent 的方法**）
- **Allowed**：`shared-types`、`organization-model`、`identity-system`、`permission-system`、`authority-engine`
- **Forbidden**：`persistence`、`event-system`/`event-store`（只能经 Runtime 注入端口，02-modules:239）、`llm-gateway`、`agent-cognition` 的 Prompt 常量、`apps/*`
- **Layer**：Agent（概率系统的确定性装配侧）
- **Runtime Role**：每员工一个长生命周期实例（A2）
- **Status**：SCAFFOLD

### agent-cognition

- **Responsibility**：感知解读、记忆检索策略、推理、规划、沟通措辞、反思提示。**Prompt 的唯一归属地**。只产出结构化 `Perception/Judgement/Plan/Reflection`，永不直接产生副作用、永不自行判定权限。
- **Public API**：`Cognition.perceive(input): Perception` · `recall(p): RecallBundle` · `plan(p, r): Plan` · `reflect(result): Reflection`（02-modules:104）
- **Allowed**：`agent-definition`、`agent-memory`（记忆类型与端口）、`llm-gateway`（唯一 LLM 调用路径）、`shared-types`
- **Forbidden**：`persistence`、`event-system`/`event-store`、`permission-system` 裁决调用（权限判定归 Runtime 第 ⑦ 步）、LLM Provider SDK 直连、`apps/*`
- **Layer**：Agent（概率性 — 全系统唯一允许出现 Prompt 的包）
- **Runtime Role**：认知循环 ③④⑤⑥⑩ 的概率部分
- **Status**：SCAFFOLD

### agent-memory

- **Responsibility**：记忆**机制**：写入、向量检索、四因子打分、衰减、归档、反思任务调度与落库。**不决定「该记什么」**（归 Agent 策略）、**不自己调 LLM 生成反思文本**（由 agent-cognition 生成后交本包持久化）。
- **Public API**：`MemoryStore.write(record): MemoryId` · `recall(q): ScoredMemory[]` · `strengthen(id, δ)` · `scheduleReflection(scope)`（02-modules:88）
- **Allowed**：`persistence`、`shared-types`
- **Forbidden**：`llm-gateway`（02-modules:88 明令）、`agent-cognition`（依赖方向禁止）、`apps/*`、`*-engine`
- **Layer**：Infrastructure（注意：名含 `agent-` 但层为基础设施，前缀规则不适用）
- **Runtime Role**：认知循环 ④ Recall / ⑩ Reflect 的存储后端
- **Status**：SCAFFOLD

### agent-tools

- **Responsibility**：工具注册表、入参 Schema 校验、**授权闸门**（A4 物理实现点：LLM 的文本永远不直接成为副作用）、沙箱执行、幂等键。不实现具体工具。
- **Public API**：`ToolRegistry.register(def)` · `ToolGateway.invoke(actor: ActorContext, toolId, args): ToolResult`（02-modules:90）
- **Allowed**：`permission-system`、`observability`、`shared-types`
- **Forbidden**：`llm-gateway` 之外的任何 LLM 直连、绕过 `AuthzService.can` 的执行路径、`apps/*`、`agent-cognition`
- **Layer**：Infrastructure
- **Runtime Role**：认知循环 ⑧ Act 的执行闸门
- **Status**：SCAFFOLD

### agent-communication

- **Responsibility**：频道（私聊/群聊/公告）、消息、线程、@提及、已读回执、正式文书（汇报/提案/纪要）。**不做语义理解、不做路由决策、不自行决定可见性**（读权限由 AuthzService 裁决）。
- **Public API**：`Comm.send(actor, msg)` · `Comm.inbox(actor, opts)` · `Comm.readChannel(actor, channelId, opts)` · `Comm.openChannel(actor, kind, members)`（02-modules:165）
- **Allowed**：`organization-model`、`permission-system`、`event-system`、`shared-types`
- **Forbidden**：`llm-gateway`、`agent-cognition`、`agent-definition`（不持有 Agent 引用 — A5）、`apps/*`、直接投递到另一 Agent 实例
- **Layer**：Orchestration（名含 `agent-` 但层为编排）
- **Runtime Role**：Agent 间影响的唯一合法通道之一（A5）
- **Status**：SCAFFOLD

### runtime-state

- **Responsibility**：`AgentState` 状态机、检查点（每 Step 前落盘）、按 `employeeId` 的单写者并发控制、重启恢复。**不决定状态语义**（转移表由定义提供）。
- **Public API**：`StateStore.load(empId)` · `StateStore.commit(state, expectedVersion)` · `StateStore.checkpoint(cycleId, step)`（02-modules:149）
- **Allowed**：`persistence`、`shared-types`
- **Forbidden**：`agent-cognition` Prompt、`llm-gateway`、`*-engine`、`apps/*`
- **Layer**：Runtime
- **Runtime Role**：幂等恢复与并发安全的承载者
- **Status**：SCAFFOLD

### runtime-scheduler

- **Responsibility**：`SimClock` 前进、Agenda 生成、唤醒队列（EVENT/SCHEDULE/AGENDA/TURN/RETRY/MANUAL 三路+）、优先级与防饿死、并发闸、`pause/resume/seek`。**不决定「谁该被唤醒」的业务规则**（由订阅规则提供）。
- **Public API**：`Scheduler.tick()` · `enqueue(WakeRequest, priority)` · `pause()/resume()/seek(simTime)`（02-modules:150）
- **Allowed**：`persistence`、`event-system`、`shared-types`
- **Forbidden**：业务唤醒规则、`agent-cognition`、`llm-gateway`、`apps/*`
- **Layer**：Runtime
- **Runtime Role**：模拟时间与执行时机的唯一推进者
- **Status**：ACTIVE（M0.9：SimClock / Wakeup / Schedule / Budget 机制实现）

### agent-runtime

- **Responsibility**：执行一次认知循环（Cycle）的 10 阶段：Wake/Load/Perceive/Recall/Deliberate/Plan/**Authorize**/Act/Observe/Reflect；超时、预算护栏、卡死检测。**不含任何 Prompt、不做业务判断、不拥有 LLM Provider 调用、不自行裁决权限或 authority**（Authorize 阶段调用 `permission-system`，不是自己判断）。
- **Public API**：`AgentRuntime.runCycle(wake: WakeRequest): Promise<CycleResult>`（02-modules:388-406）
- **Allowed**：`agent-definition`、`agent-cognition`、`agent-memory`（端口）、`agent-tools`、`agent-communication`（端口）、`permission-system`、`organization-model`、`event-system`、`runtime-state`、`runtime-scheduler`、`shared-types`
- **Forbidden**：Prompt 定义/常量（归 agent-cognition）、LLM Provider SDK 与 `llm-gateway` 直调（LLM 经 agent-cognition 发起）、`persistence` 直连（经 runtime-state/端口）、`authority-engine` 自行判定（经 permission-system）、`apps/*` 反向依赖、Agent 间直接调用
- **Layer**：Runtime（执行体）— 名单中的 `agent-cognition` 依赖是「调用认知端口」，不是「拥有 Prompt」
- **Runtime Role**：05-runtime 认知循环的宿主进程逻辑
- **Status**：SCAFFOLD

### workflow-engine

- **Responsibility**：流程模板注册、实例创建、步骤推进、任务派发、审批门判定、SLA 计时、**偏离请求受理**（`requestDeviation`）。**不做内容质量判断、不生成文本、不硬编码具体流程**。
- **Public API**：`start(templateId, ctx)` · `advance(instId, ev)` · `gate(instId, stepId): GateVerdict` · `requestDeviation(instId, actor, req): Result<DeviationDecision>`（02-modules:410-423）· **M1.6**：`start(WorkflowStartInput{workflowId?|capabilities?})`（模板/能力双路径，返回 `Result<WorkflowOperation, WorkflowFailure>`）· `workflow-generation.ts`（`buildCapabilityPlan` / `generateWorkflowDefinition` / `regenerateWorkflowDefinition` / `generatedWorkflowId` / `CAPABILITY_PLAN_CONTEXT_KEY` / `capabilityPlanContext`）（M1.6 §5–§7；启动签名以 M1.6 §6 为准，02-modules §2.4 为早期伪码）· **实例删除**：`delete(input): Result<WorkflowOperation, WorkflowFailure>`（`outcome: 'deleted'`；先整实例 `RejectStep` + **逐任务 `RejectTask` 全量预授权**再动手，级联 `Task.Deleted` → `Workflow.InstanceDeleted`，折回 `null` 自检通过后才丢实例记录——预授权保证权限拒绝不会落在级联半途）与事件常量 `WORKFLOW_INSTANCE_DELETED`（payload `taskIds[]` + `reason`）
- **Allowed**：`organization-model`、`permission-system`、`authority-engine`、`policy-engine`、`task-system`、`event-system`、`shared-types`
- **Forbidden**：`llm-gateway`（编排层零 LLM，02-modules:240）、`agent-cognition`、`persistence` 直连（实例状态经事件流物化；若 M0 需直写实例表，须先走 Architecture Change 修订本表）、`apps/*`
- **Layer**：Orchestration（确定性）
- **Runtime Role**：流程骨架的推进者；判断永远归 Agent/人类
- **Status**：SCAFFOLD

### task-system

- **Responsibility**：任务实体生命周期（独立于流程的工作单元）：创建/指派/接受/开始/进度/完成/阻塞；任务与岗位的 `resolveByPosition` 派发解析。
- **Public API**（已实现，规格底稿仍见 02-modules:311）：`createTaskService(options): TaskService`（`create` / `assign` / `accept` / `start` / `report` / `submit` / `block` / `unblock` / `complete` / `reject` / `fail` / `cancel` / `review` / **`delete`**）· `createInMemoryTaskStore` · fold `applyTaskEvent` / `applyTaskEvents` · 事件常量与 Schema 族（`TASK_CREATED` … `TASK_COMPLETED`，含 **`TASK_DELETED`** / `TaskDeletedPayload`）· 类型 `TaskDeleteOperation`；任务动作仍对齐 Action 枚举 `AcceptTask/RejectTask/StartTask/ProgressReport/CompleteTask/BlockTask/DeferTask` · **投影删除**：`delete(ReasonTaskInput)`（非状态迁移：任何状态可删、必填 `reason` + `RejectTask` 权限、流折回 `null` 后记录离开 store；事件事实保留在 log 上，重启回放重建为空）· **M1.4 派发（ADR-014，待实现）**：`dispatch()`（原子 create + assign；A1–A6 闸门：`DispatchWork` 授权 / 汇报子树范围 / 不得越级 / 单份任务书配额 8 / 验收必填 / 同任务书去重）
- **Allowed**：`shared-types`、`organization-model`、`permission-system`、`event-system`
- **Forbidden**：`llm-gateway`、`agent-cognition`、`apps/*`、绕过事件的直接状态写（A3）
- **Layer**：Orchestration（确定性）
- **Runtime Role**：TaskCreated/TaskCompleted 事件的产源模块
- **Status**：SCAFFOLD
- **依据**：03-data-model §3.8.1 `tasks` 表；Action 枚举

### decision-engine

- **Responsibility**：提案生命周期、评议征询、按权限加权计票、决策档案（ADR 式不可变）、执行追踪、否决链（supersession）。**不替 Agent 生成观点、不做技术判断**。
- **Public API**：`propose(p)` · `requestReview(id, roles)` · `castVote(id, actor, vote)` · `finalize(id): DecisionRecord`（02-modules:163）
- **Allowed**：`permission-system`、`authority-engine`、`policy-engine`、`event-system`、`shared-types`
- **Forbidden**：`llm-gateway`、`agent-cognition`、`apps/*`、`persistence` 直连
- **Layer**：Orchestration（确定性）
- **Runtime Role**：VoteWeight = f(Permission, Authority) 的纯计算
- **Status**：SCAFFOLD

### meeting-engine

- **Responsibility**：议程、参与者、发言权轮转、轮次上限、终止检测、纪要生成**编排**。**不生成发言内容**（那是 Agent 的）。
- **Public API**：`open(cfg): MeetingId` · `grantTurn(id): EmployeeId | null` · `close(id): Minutes`（02-modules:164）
- **Allowed**：`agent-communication`、`event-system`、`shared-types`
- **Forbidden**：`llm-gateway`、`agent-cognition`、`apps/*`、`persistence` 直连
- **Layer**：Orchestration（确定性）
- **Runtime Role**：TURN 唤醒的发起方
- **Status**：SCAFFOLD

### escalation-engine

- **Responsibility**：无响应检测、冲突识别、升级阶梯（Agent → 主管 → C-level → 人类）、超时熔断、重复升级去重。**不裁决对错、不替主管做决定**。
- **Public API**：`watch(subject, sla)` · `raise(issue, from, to, reason)` · `ladder(empId): EmployeeId[]`（02-modules:166）
- **Allowed**：`organization-model`、`policy-engine`、`event-system`、`shared-types`
- **Forbidden**：`llm-gateway`、`agent-cognition`、`apps/*`、`persistence` 直连
- **Layer**：Orchestration（确定性）
- **Runtime Role**：SLA 超时 → 升级事件的产源
- **Status**：SCAFFOLD

### event-system

- **Responsibility**：事件信封（`OrgEvent` 与 `org_events` 一一对应）、事件类型注册表（Taxonomy 校验）、订阅匹配、消费组语义。**不懂事件语义、不含业务分支、零 I/O**。
- **Public API**：`OrgEvent<T>` 类型 · `EventRegistry.register(type, schema)` · `subscribe(pattern, handler, opts): Subscription`（02-modules:86 的纯机制半边）
- **Allowed**：`shared-types`
- **Forbidden**：`persistence`（保持零 I/O）、`llm-gateway`、`agent-*`、`*-engine`、`apps/*`
- **Layer**：Infrastructure（纯机制）
- **Runtime Role**：A3/A5 的类型与路由载体
- **Status**：SCAFFOLD

### event-store

- **Responsibility**：`append(events, tx)` 事务性追加、Outbox 投递、`replay(from, to, filter)`、消费位点、幂等（processed_events）。**不解释事件语义**。
- **Public API**：`append(events, tx): Promise<Seq>` · `replay(from, to, filter): AsyncIterable<OrgEvent>` · Outbox dispatch（02-modules:86 持久化半边）
- **Allowed**：`shared-types`、`event-system`、`persistence`
- **Forbidden**：`llm-gateway`、业务分支、`agent-*`、`*-engine`、`apps/*`
- **Layer**：Infrastructure（Persistence 方向）
- **Runtime Role**：A3 唯一状态变更入口 + 可回放真相源
- **Status**：SCAFFOLD

### llm-gateway

- **Responsibility**：**A4 唯一 LLM Egress**。多提供商路由、重试、结构化输出强制、Token 预算、语义缓存、成本记账；**不接受无主体的调用**（必须 `ActorContext`）；不含业务 Prompt；不决定用哪个模型（调用方声明 `tier`）。
- **Public API**：`LlmGateway.invoke(actor: ActorContext, req: LlmRequest): LlmResponse` · `estimate(req)`（02-modules:89）
- **Allowed**：`shared-types`、`observability`、`config`、**LLM Provider SDK（全仓库唯一豁免）**
- **Forbidden**：`agent-definition`/`agent-cognition` 反向依赖、`*-engine`、`organization-model` 等 Domain 包、无 `ActorContext` 的公开入口、`apps/*`
- **Layer**：Infrastructure
- **Runtime Role**：认知循环 ③⑤⑥⑩ 的模型通道（由 agent-cognition 发起）
- **Status**：SCAFFOLD

### knowledge-system

- **Responsibility**：组织级知识与文档（`documents` 表）：登记、检索、版本、**读权限委托 `permission-system` 裁决**。与 `agent-memory`（个人记忆机制）物理隔离。
- **Public API**（规格，未实现）：`DocumentStore.put(doc, actor)` · `get(docId, actor)` · `search(query, actor)`（依据 03-data-model §3.7 `documents` 表字段）
- **Allowed**：`shared-types`、`permission-system`、`persistence`
- **Forbidden**：`llm-gateway`（不做内容生成）、`agent-cognition`、`apps/*`、自行判定可见性
- **Layer**：Infrastructure
- **Runtime Role**：`ReadDocument` Action 的后端
- **Status**：SCAFFOLD

### artifact-system

- **Responsibility**：可交付物登记：产物元数据、与任务/流程步骤/产出事件的溯源链接（`ProduceArtifact`）、类型与校验状态。
- **Public API**（规格，未实现）：`ArtifactStore.put(meta, actor)` · `get(artifactId)` · `provenanceOf(artifactId): Ref[]`（依据 Action `ProduceArtifact` 与 02-modules:315）
- **Allowed**：`shared-types`、`event-system`、`persistence`、`permission-system`
- **Forbidden**：`llm-gateway`、`agent-cognition`、`apps/*`
- **Layer**：Infrastructure
- **Runtime Role**：Act 阶段产物的登记处
- **Status**：SCAFFOLD

### organization-control

- **Responsibility**：Organization Control Plane（M1.0）。把人类的 **观察 / 控制 / 干预 / 检查 / 审计** 统一为带主体、带理由、带幂等键、带乐观版本的 `ControlCommand`，并驱动**既有**领域机制完成任务。**不做**：新 Runtime、新 Cognition、新 Workflow/Task 状态机、新 Permission/Authority、直接修改 `AgentState`/`WorkflowState`/`TaskState`、直连 `llm-gateway`、绕过 `event-store` 写库。控制面自己**永远不是** Cognition Layer。
- **Public API**：`createControlService(options): ControlPlane`（`execute(command)` / `hydrate(events)` / `query` / `state()`）· `createControlQuery(options): ControlQuery`（`getOrganizationSnapshot` `getSimulationState` `getDepartments` `getEmployees` `getAgents` `getAgent` `getAgentRuntimeState` `getAgentActivity` `getWorkflows` `getWorkflow` `getTasks` `getTask` `getRecentEvents` `getEventStream` `getAuditTrail` `getRecentAudits` `getControlState`）· `createControlAuthorizer(options): ControlAuthorizer` · `registerControlEvents(registry)` · `ControlSimulationPort`（仿真注入端口，由 composition root 实现；M1.3 增补 `createAgent` / `archiveAgent`）· `ControlCommand` / `ControlOutcome` / `ControlFailure` / `ControlErrorCode` · 观察模型类型族 · **M1.3 生命周期**：`Agent.Create` / `Agent.Archive` 命令、`Control.AgentCreated` / `Control.AgentArchived` 事件（常量 `AGENT_CREATED` / `AGENT_ARCHIVED`）、`AgentLifecycleStatus`（`active` / `archived`，见 `agent-lifecycle.ts`）· **M1.4 交付读模型（纯读侧）**：`TaskView.result`（`TaskResultView`：`summary` / `data` / `artifacts`），经 `GET /api/tasks/:id` 暴露给控制台（M1.4 设计契约已由 ADR-014 确认接受、文档状态 CURRENT；写侧 `DispatchWork` / `Work.SubmitBrief` 仍待实现）· **M1.4 任务书（ADR-014，待实现）**：命令 `Work.SubmitBrief`、事件 `Control.WorkBriefed`（`Control` 聚合纯加法，payload 常量 `CONTROL_WORK_BRIEFED`）、任务书读模型（按 `correlationId` 分组：任务书 → 拆解 → 各项状态）· **M1.6 内联建岗**：`AgentCreateCommand.newPosition`（`NewPositionSpec{departmentId,title,capabilities?,reportsToPositionId?}`）、`AgentMaterialization.createdPosition`、`AgentLifecycleFailureCode` += `unknown_department` / `duplicate_position`、`Control.AgentCreated` payload 可选 `position` 描述符、`PositionSummary.capabilities`（设计见 `M1.6-position-authoring-capability-workflows.md` §4）· **投影删除命令**：`Workflow.Delete` / `Task.Delete`（`CONTROL_COMMAND_TYPES` 增项；`reason` 必填、复用既有权限 `RejectStep` / `RejectTask`、action 仍聚合在 `ControlWorkflow` / `ControlTask`、域 `ops`），事件 `Control.WorkflowDeleted`（`CONTROL_WORKFLOW_DELETED`）/ `Control.TaskDeleted`（`CONTROL_TASK_DELETED`）及 payload Schema（`controlWorkflowDeletedPayloadSchema` / `controlTaskDeletedPayloadSchema`）；**`Task.Delete` 打在工作流拥有的任务上会级联删除整只工作流实例**（级联在 `workflow-engine` 完成）；删除只动投影，`Task.Deleted` / `Workflow.InstanceDeleted` / 控制面审计事实全部保留在事件流上
- **Allowed Dependencies**：`shared-types`、`organization-model`、`identity-system`、`permission-system`、`authority-engine`、`task-system`、`workflow-engine`、`event-system`、`event-store`、`audit-system`、`runtime-scheduler`、`runtime-state`、`observability`
- **Forbidden Dependencies**：`llm-gateway`（F6/F7）、`agent-cognition`（F12）、`agent-runtime`（避免成为第二套 Runtime）、`persistence` 直连（经 event-store / audit 端口）、`apps/*`（F1）、任何 LLM Provider SDK
- **Layer**：Application（L6 · Control）
- **Runtime Role**：人 → 组织的唯一正式入口；控制命令的校验/授权/签发/审计宿主
- **Status**：ACTIVE（M1.0：Command/Authorization/Query/Simulation·Agent·Workflow·Task Control/Audit；M1.3：`Agent.Create` / `Agent.Archive` 生命周期命令 + `Control.AgentCreated` / `Control.AgentArchived`；M1.6：`newPosition` 内联建岗 + 失败码 `unknown_department` / `duplicate_position`）
- **依据**：`ARCHITECTURE-BASELINE.md` §17 Architecture Change Process → ADR-013；设计契约见 `M1.0-organization-control-plane.md`

### audit-system

- **Responsibility**：Audit = **谁做了什么、是否允许、结果是什么**。结构化审计日志（actor/action/target/verdict/trace 指针），不可篡改追加。
- **Public API**：`createAuditService(options?): AuditService`（`record` / `find` / `trail` / `recent` / `forCorrelation` / `query`）· `createInMemoryAuditStore(options?)`（`append` / `byCommandId` / `byTarget` / `byCorrelationId` / `all` / `query` / `size`）· `AuditRecord` / `AuditAction` / `AuditTarget` / `AuditVerdict` / `AuditQuery` / `AuditStore`
- **Allowed**：`shared-types`、`event-system`、`persistence`
- **Forbidden**：影响主流程控制流（02-modules:91）、`llm-gateway`、`apps/*`
- **Layer**：Infrastructure（Observability 方向）
- **Runtime Role**：每条 AuthzDecision / 副作用的审计落点
- **Status**：ACTIVE（M1.0：结构化审计记录 + 内存 store + commandId 幂等查询；控制面经 `AuditPort` 适配器接入）

### observability

- **Responsibility**：Trace 树、指标、延迟、**Token 用量与成本**、`llm_calls` 表（**真相源**，ADR）；OTel 仅作采集层。与 `audit-system` 分离：本包回答「花了多少、多慢、调了什么模型」，audit 回答「允不允许、谁的责任」。
- **Public API**：`traceCycle(ctx)` · `recordLlmCall(...)` · 成本聚合查询（02-modules:91）
- **Allowed**：`shared-types`、`persistence`、`event-system`
- **Forbidden**：影响控制流、`llm-gateway` 反向持有、`apps/*` 之外的业务依赖
- **Layer**：Infrastructure（Observability 方向）
- **Runtime Role**：CycleResult.cost 的记录者
- **Status**：SCAFFOLD

### persistence

- **Responsibility**：表结构、迁移执行、仓储基类、`withTx` 事务边界、乐观锁、快照。**不含任何领域规则**。（注：事件日志语义归 `event-store`，本包只提供 `EventStore` 所需的事务与存储原语。）
- **Public API**：`withTx(fn)` · `SnapshotStore.save/load` · 迁移执行入口（02-modules:87）
- **Allowed**：`shared-types`、`config`
- **Forbidden**：领域规则、`llm-gateway`、`agent-*`、`*-engine`、`apps/*`
- **Layer**：Infrastructure（Persistence）
- **Runtime Role**：全系统唯一 DB 连接持有者
- **Status**：SCAFFOLD（database/migrations 5 文件 0 字节）

### config

- **Responsibility**：工作区级配置：路径（agents/、workflows/）、环境变量解析、功能开关。无业务规则。
- **Public API**（规格，未实现）：`loadConfig(): WorkspaceConfig`
- **Allowed**：`shared-types`
- **Forbidden**：一切业务逻辑、`llm-gateway`、`apps/*`
- **Layer**：Infrastructure
- **Runtime Role**：启动期装配
- **Status**：SCAFFOLD

### apps/kernel

- **Responsibility**：调度进程：Scheduler + Worker Pool + Reactors（02-modules:40）。认知循环的宿主。
- **Allowed**：`agent-runtime`、`runtime-scheduler`、`runtime-state`、`agent-*`、`workflow-engine`、`task-system`、`organization-control`、`event-system`、`event-store`、`audit-system`、`persistence`、Domain 包、`llm-gateway`（仅经 agent-cognition 路径）
- **Forbidden**：直接 LLM Provider 调用、其他 `apps/*`
- **Layer**：Application
- **Status**：ACTIVE（M0.9 Simulation：`System.SimClockTicked` 驱动的 tick 循环 + Reactors + 恢复）

### apps/api

- **Responsibility**：命令入口（写侧）+ 查询 API（02-modules:41）。人类命令、WebSocket 事件流出口。
- **Allowed**：`*-engine`、`task-system`、`organization-control`、Domain 包、`event-system`/`event-store`、`audit-system`、`persistence`、`permission-system`
- **Forbidden**：`agent-cognition`（API 不跑认知）、`llm-gateway` 直调、其他 `apps/*`
- **Layer**：Application
- **Status**：SCAFFOLD

### apps/projector

- **Responsibility**：事件 → 读模型投影（02-modules:42）。**读侧永远不能写领域状态**（01-overview §1.4 规则 1）。
- **Allowed**：`event-system`、`event-store`、`persistence`（读模型表写入）、`shared-types`
- **Forbidden**：领域状态写、`*-engine`、`agent-*`、`llm-gateway`、其他 `apps/*`
- **Layer**：Application
- **Status**：SCAFFOLD

### apps/web

- **Responsibility**：人类观测控制台（React + Vite）：组织图、收件箱、决策档案、时间线。
- **Allowed**：**（无 `@maoeh/*` 依赖 — 仅走 HTTP/WS 契约，02-modules:243）**
- **Forbidden**：一切后端包、数据库、任何 `@maoeh/*` import
- **Layer**：Application（Observation & Interaction）
- **Status**：SCAFFOLD（React 占位页）

---

## 统计

| 项 | 数量 |
| --- | --- |
| 注册包总数 | 29（packages）+ 4（apps） |
| 有实现调用链 | 6（shared-types 部分 · runtime-scheduler · audit-system · knowledge-system · artifact-system · organization-control · apps/kernel） |
| PARTIAL | 1（shared-types） |
| SCAFFOLD | 25 |
| 层分布 | Domain 6 · Agent 2 · Runtime 3 · Orchestration 6 · Infrastructure 11 · Application 5（`organization-control` 于 ADR-013 加入） |

> **ADR-013 变更摘要**：新增 `packages/organization-control`（M1.0 Organization Control Plane），层归属 Application（L6 · Control）。
> 该层归属使控制面可以同时驱动 L5 编排（task/workflow）、L4 Runtime（scheduler）与 L1 事件/审计，
> 而无需成为第二套 Runtime，也无需放宽任何既有禁止边。
