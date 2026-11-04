# ARCHITECTURE-BASELINE — 架构冻结基线

> **地位**：本文件是 MAOEH 的 Architecture Baseline —— 架构、包、依赖、数据模型、测试契约的**唯一冻结事实来源**。
> 代码与本文冲突时，**以本文为准**；修改本文必须走 §17 Architecture Change Process（先 ADR，后文档，最后代码）。
>
> 版本：v1.1 · 冻结日期：2026-10-01 · 前置：Architecture Implementation Audit（2026-09-30）+ Reconciliation Report + **M1.0 Architecture Change（ADR-013）**
> 下游细化权威：包边界 → `package-registry.md`；依赖方向 → `dependency-graph.md`；文档索引 → `README.md`。

---

## 1. System Overview

MAOEH 是以「组织」为第一性抽象的事件驱动仿真内核：维护一家虚拟公司的组织实体、权限体系与长期记忆，驱动一群长期存在的 AI 员工工作、沟通、协作、决策，并把全过程暴露为可回放的事件流。

**五条公理（硬约束，出处 01-overview §1.2）：**

| # | 公理 | Baseline 裁定 |
| --- | --- | --- |
| A1 | 组织先于任务 | 任何副作用必须携带 `ActorContext`（employeeId + positionId + authorityByDomain + correlationId）；无主体操作被内核拒绝 |
| A2 | Agent 是长期实体 | Agent 独立于任务的生命周期与持久状态；无任务时仍能描述每名员工此刻状态 |
| A3 | 一切组织状态变更都是事件 | 唯一入口 `event-store.append(event)`；不存在业务路径直接 UPDATE 组织表；可回放即可解释 |
| A4 | LLM 只能提议，内核才能执行 | `llm-gateway` 是唯一 LLM Egress（§9）；LLM 输出 = 结构化 Intent；权限/状态机/审批 100% 确定性裁决 |
| A5 | 员工之间不直接调用 | 无 Agent RPC；通信 = 消息事件，协作 = 工作流事件，影响 = 订阅 + 唤醒（§10） |

**结构**：CQRS + Event Sourcing（命令下行、事件上行，01-overview §1.4）；读侧永不写领域状态，写侧永不读投影。
**反退化试金石**：清空全部 Task 后，系统仍是一家活着的公司（组织架构、上下级、权限、记忆、关系、议程、日报俱在）。

---

## 2. Package Registry

- **权威文件**：`package-registry.md`（29 packages + 4 apps，逐包 8 字段）。
- **裁定**：28 包命名为规范名；`02-modules.md` §2.1 的 9 个旧名废弃；`org-authz` 拆为 permission/authority，`event-bus` 拆为 event-system/event-store；6 个未定义包（identity/task/knowledge/artifact/audit/config）首次成文。
- **M1.0（ADR-013）**：新增第 29 个包 `organization-control`（Organization Control Plane），层归属 Application（L6 · Control）。
- **层归属**（禁止凭前缀推断）：Domain 6 · Agent 2 · Runtime 3 · Orchestration 6 · Infrastructure 11 · **Application 5**（4 apps + `organization-control`）。
- **状态**：`shared-types` PARTIAL；`runtime-scheduler` / `organization-control` / `audit-system` / `apps/kernel` ACTIVE；其余 SCAFFOLD。

---

## 3. Dependency Rules

- **权威文件**：`dependency-graph.md`（六层、允许矩阵、F1–F13 禁令、环禁令、强制配置设计）。
- **四条不可协商底线**：
  1. `packages/*` 永不依赖 `apps/*`（F1）
  2. Domain 层零 I/O、零 LLM、零 `agent-*` 引用（F3/F4）
  3. 除 `agent-cognition` 经 `llm-gateway` 外，全仓无 LLM Provider 依赖（F6）
  4. 依赖环 = 立即阻断（Cycle Rule）
- **强制**：dependency-cruiser + ESLint 规格已定稿于 `dependency-graph.md` §5；配置文件落地为 M0 首项任务；落地前为人工评审约束（遗留 HIGH-4）。

---

## 4. Agent Runtime Boundary

**拥有**（`agent-runtime` + `runtime-state` + `runtime-scheduler`）：
10 阶段认知循环执行（Wake → Load → Perceive → Recall → Deliberate → Plan → **Authorize** → Act → Observe → Reflect）、超时/预算护栏/卡死检测、检查点与幂等恢复、SimClock 与唤醒调度。

**绝不拥有**（对应审计 §5 禁有项）：

| 禁有项 | 归属 |
| --- | --- |
| Prompt 定义与常量 | `agent-cognition`（全系统唯一 Prompt 归属地） |
| LLM Provider 调用 / SDK | `agent-cognition` → `llm-gateway`（runtime 不直连 gateway） |
| 权限判定（能不能做） | `permission-system.can()`（runtime 的 Authorize 阶段**调用**它，不自行判断） |
| 决策权等级（多大权限） | `authority-engine.levelFor()` |
| 持久化直连 | `runtime-state` / 注入端口 |

**分界线判据**（02-modules:152）：Runtime 可以读/校验/执行 `Plan`，但不知道任何一句 Prompt 内容。
`WakeRequest` / `CycleResult` / `Plan` / `Step` / `Action` 类型契约见 02-modules §2.4，为编码起点。

---

## 5. Organization Model

- 岗位（Position）与员工（Employee）**必须分离**：坑与人的分离支撑离岗不断流、按岗位派发（`resolveByPosition`）、一岗多人、代理机制（03-data-model §3.2.1）。
- `organization-model` = **纯函数**领域模型：不落库、不产事件、不调 LLM；属性测试保证「汇报线无环、每人唯一上级、部门树连通、getManagerOf/getReports 互逆」。
- 决策权挂岗位不挂人（`POSITION.authority_level`、`POSITION.decision_domains`）；`EMPLOYEE.kind ∈ {agent, human}` — 人类是内建组织成员，非外挂。
- 关系模型全双时态（`valid_from/valid_to` + `recorded_at/superseded_at`），7 类关系边（03-data-model §3.3）。

---

## 6. Identity / Permission / Authority

四分法（审计 §9，冻结为契约）：

```text
Identity         = Who are you?            → identity-system（员工身份、ActorContext 构造）
Agent Definition = What kind of employee?  → agent-definition（8 层档案、YAML 装配）
Permission       = What can you do?        → permission-system（RBAC+ABAC 裁决）
Authority        = How much decision power → authority-engine（L0–L5 按决策域）
```

**签名契约（禁止退化）：**

```ts
AuthzService.can(actor: ActorContext, action: Action, resource: ResourceRef, ctx?): AuthzDecision;
AuthorityService.levelFor(employeeId: EmployeeId, domain: DecisionDomain): AuthorityLevel;
```

- `can(actor, action)` 这类丢失 context 的签名 = 违规（除非未来 ADR 明确豁免）。
- `AuthzDecision` 三态：`allow` / `NEEDS_APPROVAL(escalateTo)` / `NO_PERMISSION|OUT_OF_SCOPE`。
- 权限随岗位、停职即失效；`effective()` 由权限闭包收敛计算，非档案声明。
- **Action Space 登记（M1.4 · ADR-014）**：`shared-types` 的 `ACTIONS` 追加 **`DispatchWork`**（42 → 43，纯加法），对应权限点 **`work.dispatch`** + 目标岗位所在决策域等级 + 汇报子树范围；入参只含 `positionId`（永不含 `employeeId`），授权 / 范围 / 不得越级 / 配额 / 验收 / 去重闸门全部在 `TaskService.dispatch()` 领域内部执行（fail-closed）。

---

## 6a. Organization Control Plane（M1.0 · ADR-013）

人类操作者对这家 AI 公司的**唯一**正式入口。控制面**不是**第二套 Runtime，**不是** Cognition，**不是**新的 Workflow/Task Engine。

```text
Human Operator（Employee kind:'human'，占据真实 Position）
    ↓  ControlCommand（commandId / actor / target / payload / reason / correlationId / expectedVersion / createdAtSim）
Validation → Identity → Permission → Authority
    ↓  既有领域操作（TaskService / WorkflowEngine / Scheduler / EventStore）
Domain Event（`Control.*` 为过去式事实）
    ↓  event-store.append（唯一写入口）
Audit（commandId 关联：谁 / 做了什么 / 对谁 / 为什么 / 何时 / 结果）
    ↓
Observation（只读读模型，不调 LLM）
```

**硬约束**：

| # | 约束 |
| --- | --- |
| C1 | 控制面**不得**直接修改 `AgentState` / `WorkflowState` / `TaskState` / `SimulationState` |
| C2 | 控制面**不得**直接调用 LLM，**不得** import `llm-gateway` / `agent-cognition` / `agent-runtime` |
| C3 | 控制面**不得**绕过 `permission-system` / `authority-engine`（不存在 `if (operator.isAdmin)` 分支） |
| C4 | 控制面**不得**绕过 `event-store` 直接写数据库 |
| C5 | Command ≠ Event：`Simulation.Pause` 是命令，`Control.SimulationPaused` 是事件 |
| C6 | `commandId` 为幂等键；`expectedVersion` 不匹配返回 `STALE_VERSION`，**不得** last-write-wins |
| C7 | `Type` 命名遵循 Taxonomy：新增 `Control` 聚合；`ACTIONS` 追加 5 个控制动作（纯加法） |
| C8 | `seek` 只对齐时钟，**不**修改历史 EventStore；不支持的后向 seek 返回 `UNSUPPORTED`，**不伪造回滚** |
| C9 | Agent 生命周期状态 ≠ Simulation 状态：暂停一个 Agent **不得**暂停整个 Simulation |
| C10 | Audit 是审计日志，**不是**第二个 EventStore（§14 职责切分不变） |
| C11 | 人类对「工作」只有一个写入口：`Work.SubmitBrief`（任务书）；不存在人类直接把任务派给某个 agent 的一等公民路径（ADR-014） |

**机器可验证**：dependency-cruiser `control-plane-pure`（C2）+ `tests/architecture/control-boundaries.test.ts`（C1–C4、C10 的静态断言）。

---

## 7. Event Model

```text
Event Schema（类型注册表）
  ↓
Event Envelope（OrgEvent：seq/eventId/type/version/occurredAtSim/occurredAtWall/
                actorKind/actorId/subjectType/subjectId/payload/
                causationId/correlationId/traceId）   ← 类型权威：02-modules §2.4 + 03 §3.6
  ↓
event-system（信封 + 订阅匹配，零 I/O）
  ↓
event-store（append(tx) / outbox / replay / 消费位点，唯一写入口）
  ↓
projector（读模型） / kernel Reactors（唤醒） / observability / web 流
```

**契约**：
- 事件 **immutable**：append-only，无 UPDATE/DELETE 业务路径（A3）。
- 类型必须来自事件注册表（Taxonomy，03-data-model §3.6.2）。
- `causationId`（直接原因）+ `correlationId`（业务链）→ 任何 Agent 行为可回溯到最初触发事件。
- Outbox 与业务写同事务（Postgres-first）；`replay(from, to)` 必须重建出与当前一致的读模型。
- 业务模块**不得绕过 `event-system` 直接触碰事件表**；`event-store` 只运载语义、不解释语义。

---

## 8. Memory Model（含 Anti-Poisoning 强制约束）

**结构**：短期记忆（Redis TTL 工作记忆）与长期记忆分离；长期记忆分表：`mem_episodes`（原始经历）/ `mem_facts`（LLM 概括事实）/ `mem_reflections` / `mem_procedural`（ADR 物理隔离）。
**机制归属**：存储/检索/打分（recency × importance × relevance × affinity）/衰减/反思调度 = `agent-memory`；「记什么」= Agent 策略；反思文本生成 = `agent-cognition`。
**可追溯**：每条长期记忆必须能回答「我在哪条事件上学到的」（`source_event_id` / `citedMemoryIds`）。

**⚠ Anti-Poisoning 规则（冻结为强制架构约束）：**

```text
Organization-level shared fact
  + owner_employee_id IS NULL
  + corroborated sources < 2
  = REJECT（写入被拒）
```

- **Schema requirement**：`mem_facts.corroborated_by uuid[] NOT NULL DEFAULT '{}'`；
  数据库触发器条件必须为 `COALESCE(array_length(NEW.corroborated_by, 1), 0) < 2`（**禁止** `array_length(...) IS NULL` 写法 — 后者放行单来源，见 review R2-1）；`source_count` 与 `array_length(corroborated_by,1)` 由 CHECK 保持一致；`confirmed_by_human = true` 为人工豁免通道。
- **Test requirement**（5 条边界用例，缺一不可）：

| owner | sources | human | 期望 |
| --- | --- | --- | --- |
| 有 | 0 | false | 允许（个人事实） |
| 有 | 1 | false | 允许（个人事实） |
| **无** | **0** | false | **拒绝** |
| **无** | **1** | false | **拒绝（★ mandatory boundary case，必须有失败断言）** |
| **无** | **2** | false | **允许** |

- 规则出处：03-data-model §3.5.1（`03:561-575`）、`04:306`、review R2-1；**当前 migration 为空 → 该约束尚无执行载体（遗留 HIGH）**。

---

## 9. LLM Gateway Rule（A4）

```text
任何 package（经 agent-cognition）
        ↓  必须携带 ActorContext
   llm-gateway（唯一 Egress：路由/重试/结构化输出/Token 预算/语义缓存/成本记账）
        ↓
   LLM Provider（openai / anthropic / deepseek / …）
```

- **禁止**：`agent-runtime`、`*-engine`、Domain 包、`apps/*` 出现任何 Provider SDK import 或 HTTP 直连（F6）。
- **禁止无主体调用**：`invoke(actor: ActorContext, req)` 签名不可省略 actor；无 actor = 拒绝。
- **唯一豁免包**：`llm-gateway` 自身的 `providers/`。
- **机器可验证**：依赖扫描（dependency-cruiser `single-llm-egress` 规则）+ 测试断言（`tests/architecture/`）；审计已验证当前全仓 Provider SDK 零命中。
- LLM 调用必须落 `llm_calls` 表（真相源，ADR-008），成本进 `CycleResult.cost`。

---

## 10. Agent Communication Rule（A5）

```text
Agent A
   ↓ 产出事件/消息（无直接引用）
event-system / agent-communication（频道 · 汇报 · 提案 · 纪要）
   ↓ 订阅 + 唤醒
Agent B
```

- **禁止**：`Agent` 类型上存在指向另一 `Agent` 的方法（`sendTo(other)`/`call(...)`）；任何包持有 Agent 实例引用并对它直接调用（F9）。
- 通信原语归 `agent-communication`（频道/消息/文书），**可见性由 `permission-system` 裁决**，通信包不自行决定；语义理解归 `agent-cognition`，通信包不做路由判断。
- 协作流程归 `workflow-engine`（骨架），影响传播归事件订阅 —— 耦合只允许发生在事件契约上。
- **机器可验证**：Agent 类型结构断言测试（`tests/architecture/`）+ 依赖规则 `no-agent-rpc`。

---

## 11. Persistence Boundary

- `persistence` = 全系统**唯一 DB 连接持有者**：Schema/迁移/仓储基类/`withTx` 事务边界/乐观锁/快照；**不含领域规则**（02-modules:87）。
- 事件日志语义（append/outbox/replay）归 `event-store`，事务原语来自 `persistence`。
- 禁止访问方：Domain 层全部（F4）、`agent-definition`/`agent-cognition`（F5，经 Runtime 端口）、L5 编排引擎直连（实例状态经事件流物化；确需直写时先走 Architecture Change）。
- Postgres-first：事件/组织/记忆/队列/向量同库同事务，无分布式事务（ADR）。

---

## 12. Runtime State

- 归属 `runtime-state`：`AgentState` 两层状态模型、**每 Step 前落检查点**、按 `employeeId` 的单写者并发控制（乐观版本号 `commit(state, expectedVersion)`）、重启恢复。
- 幂等 = 检查点 + 幂等键（Authorize 后由 Runtime 填充 `Step.idempotencyKey`），不用「重跑节点」（ADR）。
- 禁止：scheduler 逻辑混入、状态语义（转移表）硬编码在 store 内。
- 测试：并发提交仅一个胜出、版本冲突返回可重试错误、检查点后恢复无副作用泄漏（02-modules §2.5）。

---

## 13. Scheduler

- 归属 `runtime-scheduler`：`SimClock`（分钟精度 `SimTime`）、Agenda 生成、唤醒队列（6 种 reason：EVENT/SCHEDULE/AGENDA/TURN/RETRY/MANUAL）、优先级 0–9 与防饿死、并发闸、`pause/resume/seek(simTime)`。
- **业务规则禁入**：「谁该被唤醒」由订阅规则（05-runtime §5.6.3）提供，Scheduler 只管何时/以何优先级跑。
- 模拟时间可回放、可快进 — 重放模式（Replay Mode）依赖 SimClock 而非墙钟。

---

## 14. Observability

**两包职责切分（审计 §14 冻结）：**

```text
audit-system    = 谁做了什么、是否允许、结果是什么（actor/action/target/verdict，不可篡改追加）
observability   = trace / metrics / latency / token usage / cost / llm_calls
```

- `llm_calls` 表是 LLM 成本与调用的**真相源**；OTel 仅作采集层（ADR-008）。
- 两包均**不得影响主流程控制流**（02-modules:91）。
- 每个 `AuthzDecision`、每个副作用必须能落到 audit；每个 Cycle 必须产出 `CycleResult.cost`。
- 现状：两包均 SCAFFOLD，`llm_calls` DDL 在 `03-data-model.md` §3.9，未物化。

---

## 15. Database Schema Contract

**契约**：`03-data-model.md` = DDL 的唯一权威（41 条 `CREATE TABLE`）；`database/migrations/` = 执行载体；`persistence` = 运行时入口。DDL 只能从文档物化，**禁止凭空设计字段**。

**SCHEMA GAP（已裁定，待 Architecture Change 消除）：**

| # | 缺口 | 详情 |
| --- | --- | --- |
| G1 | 9 张核心组织表**有 ER 字段定义、无 SQL DDL** | `COMPANY / DEPARTMENT / POSITION / EMPLOYEE / EMPLOYMENT_RECORD / ROLE_ASSIGNMENT / AGENT_PROFILE`（03 §3.2.1, `03:38-123`）与 `RELATIONSHIP / RELATIONSHIP_EVENT`（03 §3.3, `03:231-254`）字段完备，但文档无 `CREATE TABLE` → 无法物化 |
| G2 | migrations 全空 | `001–005` 共 5 文件均 0 字节；41 条已有 DDL 一条未落地 |
| G3 | 无迁移执行工具 | 无 knex/drizzle/prisma 等依赖；环境无 psql/docker（审计 UNVERIFIED 项） |

**消除顺序（后续轮次）**：G1 补文档 DDL（字段一律取自现有 ER，不新增设计）→ G2 物化进 5 个 migration → G3 选型走 ADR → 执行验证。

---

## 16. Testing Contract

来源：02-modules §2.5 + 审计 §17 + 本基线 §8。**测试是架构的执行载体，缺测试 = 约束未生效。**

| 类别 | 内容 | 状态 |
| --- | --- | --- |
| 属性测试 | org-model 汇报线不变量；权限闭包收敛（fast-check） | 未建 |
| 边界测试 | **Memory 5 边界用例（§8，含「无 owner + 1 来源必须失败」）** | 未建 |
| 架构测试 | dependency-cruiser（F1–F13 + 环）；A4 import 扫描；A5 类型断言 | 未建（规格见 dependency-graph §5） |
| 权限测试 | `can()` 拒绝路径全覆盖、越权必拒、停职失效 | 未建 |
| 事件测试 | append 有序、outbox 恰好一次、重放与实况一致 | 未建 |
| Runtime 测试 | 检查点恢复、预算超限即停、单写者并发 | 未建 |
| 契约测试 | 每个 `agents/*.yaml` 可装配、8 层必填校验 | 未建 |
| 仿真测试 | `FakeLlm` + 固定 seed 跑 30 模拟日，断言组织不变量与零越权 | 未建 |
| E2E | 人类审批提案后组织状态与时间线一致 | 未建 |

**CI 顺序**：`typecheck → lint → architecture → unit → integration`；`FakeLlm` 为 CI 基石，真实模型仅 `tests/simulation-live/` 且默认不进 CI（02-modules:446）。
**现状**：0 测试文件；`pnpm typecheck`/`pnpm lint` 脚本不存在（遗留）。

---

## 17. Architecture Change Process

```text
Architecture Change（提案，任何层级）
        ↓
ADR 写入 08-adr.md（含理由 / 备选方案 / 复审触发条件）
        ↓
更新 ARCHITECTURE-BASELINE.md（受影响章节）
        ↓
更新 package-registry.md（包增删改、边界改）
        ↓
更新 dependency-graph.md（层/方向/禁令改）
        ↓
更新 Phase 文档与 docs/architecture/README.md 索引
        ↓
更新实现代码（与文档同批或紧随其后）
        ↓
Architecture Audit（按审计清单全量复检）
        ↓
重新 FROZEN（版本号 +1）
```

**禁令**：
1. **Code changes first, documentation later = 违规**，阻断合入。
2. 未经 ADR 不得新增/删除/重命名包，不得增删依赖边，不得修改 §6/§9/§10 的签名契约。
3. 审计发现文档与代码冲突时：**报告冲突，不自行择一**（两错取其轻也不行）——先走本流程裁定。
4. 每次 Milestone 结束跑 01-overview §1.8 反退化清单，任一失败 = 架构回退，回滚或补 ADR。

---

## 附：本轮冻结时的已知遗留（与 Audit 对照）

| 审计项 | 冻结时状态 |
| --- | --- |
| CRITICAL-1 全模块未实现 | 未消除（本轮禁实现）→ M0 主线 |
| CRITICAL-2 migration 空 + G1 schema gap | 转为 §15 SCHEMA GAP（G1/G2/G3）明确列出 |
| CRITICAL-3 垂直切片不可执行 | 未消除 → M0 验收项 |
| HIGH-1 文档路径漂移 | **已消除**（README §2 废弃名对照 + 索引重建） |
| HIGH-2 包命名漂移 | **已消除**（package-registry §0 裁定 28 包） |
| HIGH-3 记忆安全规则无执行载体 | 规则已冻结为 §8 架构约束 + schema/test requirement；执行载体仍缺 |
| HIGH-4 边界强制工具缺失 | 规格已定稿（dependency-graph §5），配置落地 = M0 首项 |
