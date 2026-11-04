# MAOEH 架构设计文档集 · 对抗性评审报告

> **评审快照：2026-10-01 11:19（本地）** — 报告中所有行号均已用 ripgrep 逐条核对到该快照的真实行号。
>
> **⚠️ 关于"移动靶"的说明（请先读这一段）**：本次评审进行期间，待评审文档正在被并发修改。`03-data-model.md` 在我开始阅读时为 1005 行，评审结束时为 1435 行；`tasks` / `meetings` / `skill_definitions` / `employee_skills` 四张表、`3.2.2 目标（Goal）`、`3.11 枚举字典`、`Runtime.PresenceChanged`、`decision_supersessions`、`on_reject` 策略、以及 `org_events` / `messages` / `processed_events` 三处约束修复，**都在我评审窗口内被补入**。
>
> 因此本报告：**只对快照时刻仍然存在的问题给出缺陷判定**；已被修掉的条目归入文末「评审期间已修复」，用于对齐进度而非计分。这也意味着**缺陷总量不代表文档质量**——恰恰相反，本轮共 11 处实质问题在原位被修复，而下面仅剩 1 处阻断级、4 处重要级问题。
>
> 另一条工具性提醒：本会话的 `read` 工具在长中文文档上存在**丢空行导致的行号漂移**（同一份文件 `read` 报 1005 行、真实 1005 个换行即 1006 行，但小节行号整体偏移可达 +2）。本报告全部引用以 ripgrep 行为准；若与 `read` 显示不符，请以本报告为准。

---

## 结论摘要

**总体结论：架构方向明确达标，文档质量显著高于同类项目；作为"可直接开工的权威契约"，仅剩 1 处会静默失效的安全缺陷和 4 处一致性缺口。**

8 条验收中，定位类（第 1、7 条）与产出结构类（第 5 条）**通过**；其余 5 条**部分通过**——扣分点已从"设计缺失"收敛为"同一事实在两处写法不一致"。`AGENTS.md` 五组规则中，Core Principles 与 Workflow Rules **通过**，Architecture / Memory / Coding 三组**部分通过**。

### 最严重的三个问题

#### 1. `mem_facts` 的"抗记忆投毒"触发器存在 off-by-one，实际只需 **1 个来源**即可通过（阻断）

`03:561-571`（当前快照）：

```sql
IF NEW.owner_employee_id IS NULL
   AND array_length(NEW.corroborated_by, 1) IS NULL     -- ← 只对空数组成立
   AND NOT NEW.confirmed_by_human THEN
  RAISE EXCEPTION '组织级事实需 >=2 来源或人工确认 (mem_facts.id=%)', NEW.id;
```

`array_length(x, 1) IS NULL` 仅在**空数组或 NULL** 时为真；当 `corroborated_by` 恰好含 **1 个** uuid 时，`array_length` 返回 `1`，条件为假，触发器**放行**。

而 `03:560` 的注释、`03:546` 的字段注释、`04:306`（Phase 4）与 `research-brief:375` 都明确要求"**需 2 个以上来源**"。后果是：任何单个 Agent 只要把自己的 uuid 写进 `corroborated_by`，就能改写组织级共享事实——**ADR-007 整篇论证的核心安全属性（原始经历与 LLM 概括隔离、可检测 embellishment）在这条路径上失效，且症状是静默的**（不报错，只是组织记忆被污染）。

这是全文档集中**唯一一处"把安全属性写成代码时产生的逻辑错误"**，也是唯一建议在开编码前必须修掉的缺陷。

**修复**：`AND COALESCE(array_length(NEW.corroborated_by, 1), 0) < 2`。
**补测**：在 `02` 的 `memory` 测试行加入用例「**单来源**的 `owner_employee_id IS NULL` 事实写入必须被数据库拒绝」——注意若只测"空数组"该 bug 不会被发现，这是它危险的原因。

#### 2. `AuthzService.can` 的签名在三处不一致，最权威的一处（Phase 3）是新的，另两处是旧的（重要）

- `03:436-437`（新）：`can(actor, action, resource, ctx?: { domain?, requiredRoles?, amount? })` — 已正确引入域与角色维度；
- `02:358`（旧）：`can(actor: ActorContext, action: Action, resource: ResourceRef): AuthzDecision;` — **无 ctx**；
- `08:107`（ADR-003 正文，旧）：`AuthzService.can(actor, action, resource)` — **无 ctx**。

`02:247` 明确声明"这些签名是编码阶段的起点，**直接照抄即可开工**"，`08` 是 ADR 正本。按这两处照抄，就会实现一个**没有域维度的权限裁决**——而 `03:302` 的 `decision_rights.domain`、`03:81`/`03:172` 的 `POSITION.decision_domains`、`03:406` 的 `roleOf(actor) = ANY(ctx.requiredRoles)` 全部依赖该维度。CTO 的 `{engineering: L3, finance: L0}`（`03:172`）将退化为一个标量。

**修复**：把 `02:358` 与 `08:107` 同步为 `03:436` 的签名；并在 `03:388` 的算法节保留资源路径 → 决策域的映射表作为该参数的唯一来源。

#### 3. 读侧权限模型仍是空白：`channels.visibility` 没有对应的权限点（重要）

`03:706`（旧快照行号，当前为通信模型节内）定义了 `channels.visibility: members | department | company | private`，`03:455` 的补注也承认"没有权限的观察者只有 `*.read` 权限"——但**全文档集中不存在 `channel.read` / `message.read` 这类动作定义**（已全库检索确认），`02` 的 `comm` 接口（`send / inbox / openChannel`）也不接收 `ActorContext`。

后果：**私聊与部门频道的读权限没有任何机制保证**。任何 Agent 只要能构造出对 `Comm.inbox` 的调用，就能读到不属于它的会话。这与项目反复强调的"权限 100% 由确定性代码裁决"（`README:172`）不一致，也是 `07:147`（信息政治）、`07:109`（跨公司只见公开行为）等扩展方向的地基。

**修复**：补 `channel.read` / `message.read` 动作与频道路径的 `ResourceRef` 形式（如 `company:fal/chan:<id>`），把 `visibility` 判定写进 `can()`；`Comm.inbox(actor, opts)` 增带 `ActorContext`。

---

## 逐条验收对照表

### A. 用户原始需求的 8 条验收点

| # | 验收点 | 判定 | 证据（行号已核对至快照） | 说明 |
|---|--------|------|------------------------|------|
| 1 | 定位：虚拟组织，不是 chatbot / 单 Agent / task pipeline / prompt chain / 工作流工具 | **通过** | `README:3-5`、`README:48-52`；`01:10-23`；`07:337-353`（六条项目红线）；`08:128`（ADR-003 复审触发条件写"无"）；`06:195`（无任务存活测试） | "把任务全部删掉，剩下的还是一家活着的公司"这一试金石 + 无任务存活验收 + 六条永不做红线，构成**可判定**的反退化定义，而非口号。 |
| 2 | 每员工拥有 Identity/Role/Responsibility/Goal/Skill/Memory/Personality/Relationship/Permission/Decision Authority | **通过** | 8 层结构 `02:108-140`；档案 `04:104-153`；`AGENT_PROFILE` `03:113-122`；**Goal `03:136`（3.2.2 目标，本轮新增）**；**Skill `03:600-624`（skill_definitions + employee_skills）**；权限 `03:278-462` | 十项全部有数据模型。Goal 与 Skill 是评审窗口内补齐的，此前只有 README 表格与 YAML 字段名。Personality 的 `personality "大五/风格向量"` + `risk_appetite` 已可存储，但"如何翻译进 Prompt"仍只有一句话（`04:158`），属实现细节而非契约缺口。 |
| 3 | 能工作/沟通/汇报/协作/决策/解决冲突/积累经验/推动组织发展 | **部分通过** | 工作 `04:202-237`；任务 `03:916-978`；沟通 `03:805-912`；会议 `03:863-902`；决策 `03:1071-1120`；经验 `04:239-313`；演化 `04:317-373` | **"解决冲突"仍是八项能力中最弱的一环**：只有 `CONFLICTS_WITH` 关系边枚举（`03:236`），冲突的**检测规则、调解流程、裁决归属、阈值**全部推到 Phase 7（`07:137-150`）且 `06` 不做清单未含此项；`escalation-engine` 声称的"冲突识别"无判定标准。其余七项均有完整数据模型与事件支撑。 |
| 4 | 8 个设计域全覆盖 | **部分通过** | ①`03:24-223` ②`02:99-140`+`04` ③`05:22-87` ④`03:464-716` ⑤`03:805-912` ⑥`03:914-1250` ⑦`03:1071-1120` ⑧`03:718-803`+`05:362-381` | 八域均有实质内容。**⑥ 已补齐**（`tasks` 表 `03:923` + 权威任务状态机 `03:958-978`；`meetings` / `meeting_participants` / `meeting_turns` `03:863-902`）。唯一仍薄的是 **⑦ 的 Discussion 环节**：只有事件名 `Decision.DiscussionOpened`（`03:799`），没有承载讨论的实体，与 `messages` 的关系未定义。 |
| 5 | Phase 1–7 顺序与内容完整 | **通过** | `01`~`07` + `08` ADR + `research-brief`；`01:307`（导航表） | 顺序正确、主题对应（整体架构图 / 核心模块拆分 / 数据模型 / Agent 生命周期 / Runtime 流程 / MVP 范围 / 未来扩展）。含 14+ mermaid 图、完整 SQL DDL、TypeScript 契约、YAML 流程模板与带引用的研究简报，完成度属专业水准。 |
| 6 | 工程可实现性优先 / MVP 可做 / 开源友好 | **部分通过** | 不做清单 `06:43-58`；技术栈 `06:111-129`；里程碑 `06:132-174`；工作量 `06:252-268`；`06:270-271`（可压缩项） | 选型克制（PG-first、不引 Kafka/Neo4j/独立向量库/图数据库）是正确判断，`06:270` 还主动给出可压缩项。扣分：70–87 人日（单人 8 周）对应 20 个 package + 30+ 张表 + 三个引擎 + 控制台 + 30 天仿真套件，**置信度仍偏低**；且 `Plan` / `Step` / `Action` 枚举 / `OrgSnapshot` 四类关键契约仍未定义，会额外吃掉 M2 的 3–5 人日。 |
| 7 | 不退化成普通 Agent Workflow | **通过** | `README:226-238`；`01:290-303`；`04:168-172`；`05:460-487`；`04:435-438`；`03:1232-1242`（`on_reject`） | 反退化是制度性的：无 Agent 间 RPC + 确定性授权闸门 + 流程偏离 + 拒绝收敛策略 + 组织性升级 + 30 天仿真断言。`on_reject` 的补入尤其关键——它让"Agent 可以拒绝派活"与"流程不会静默卡死"同时成立。 |
| 8 | 模块职责边界明确、可用于后续开发 | **部分通过** | 依赖方向硬规则 `02:234-243`；边界速查 `02:369-381`；每层"绝不负责"列 `02:67-172`；**`03:1358` 枚举字典（本轮新增）** | 边界表是优质资产，枚举字典补上了"同一状态三处写法"的根因。仍扣分：声明与签名不一致（见结论摘要问题 2 与 C1/C2）、读侧权限无落点（问题 3）。 |

### B. `AGENTS.md` 五组规则

| 规则组 | 判定 | 证据 | 说明 |
|--------|------|------|------|
| **Core Principles**（Organization First / Agent Independence / Event Driven / Human Observation） | **通过** | 公理 A1–A5 `01:31-37`；`ActorContext` `03:426-433`；无匿名 LLM 检查项 `01:297`；人类同为组织成员 `03:133` 与 `03:450-456` | "人类必须占据一个 Position（如 `board_observer`，L5），因此走与其他员工**完全相同**的 `effective()` / `can()` 路径，不占岗位的人类只是没有权限的观察者"——这段规则（`03:450-456`）比多数项目的 HITL 外挂式建模彻底得多，且**不需要特例分支**。 |
| **Architecture Rules**（Agent / Runtime / Infrastructure 三层不得混用） | **部分通过** | 分层 `01:44-131`；硬规则 `02:234-243`；`05:197`（presence 唯一写入者标注） | 规则优秀且用 `dependency-cruiser` + ESLint 机械强制。仍有两处张力未消解：① `memory` 依赖 `llm-gateway` 并承担"反思任务的**执行**"（`02:88`），与 `02:104` 把"反思提示"归给 `agent-cognition` 冲突，而 `02:27` 声明 Prompt 唯一归属 `agent-cognition`；② Authorize 的落点在 `02:93-95`（`tool-gateway` 是"物理实现点"）与 `05:64`（第 ⑦ 步归 `Runtime`）两处并存，双闸门无分工说明。 |
| **Workflow Rules**（重要流程即 workflow，不得藏进 prompt） | **通过** | 模板即数据 `03:1174-1243`；偏离请求表（工作流节的 `workflow_deviations`）；`requestDeviation` `02:415`；验收第 6 条 `06:200` | 落实得最扎实的一组：`sod: not_author_of`、`escalation`、`on_reject`、`required_level` 全是引擎硬约束，`03:1245-1247` 明确点出"这些不是 Prompt 里的一句话"。扣分：模板 YAML 的 `sod` 写法与 `sod_rules` 表结构（`03:371-378`）仍无映射说明，两套 SOD 表达法并存。 |
| **Memory Rules**（短期/长期分离、更新显式可追溯） | **通过（条件）** | 分层 `03:464-502`；`mem_write_log` `03:626-649`；写入策略 `03:686-716`；`05:204-223`（reflection accumulator） | 本轮已修掉全部三处硬伤：`source_kind` 三分来源 + 条件 CHECK、`mem_facts` 唯一部分索引、reflection 累加器落入 `AgentState` 并明确"**不允许触发两次**"（`05:223`）。**唯一残留是 `mem_facts` 触发器的 off-by-one（结论摘要问题 1）**——修掉它这一组即为完全通过。 |
| **Coding Rules / Testing Rules**（清晰模块、强类型、显式接口；五类核心测试） | **部分通过** | 测试策略表 `02:344-365`（五类要求逐条映射）；`FakeLlm` `02:363-365`；30 天仿真 `02:361`；枚举字典 `03:1358` | 测试策略与 `AGENTS.md` 五类要求逐条对应，`FakeLlm` + 固定种子 + 重放一致性属性测试是正确且关键的工程决策。扣分："**强类型 / 显式接口**"仍差最后一段——`Plan` / `Step` / `Perception` / `Judgement` / 22 个 `Action` 的 TS 枚举 / `OrgSnapshot` 在全文档集中**没有一处定义**（`05:54-67` 以散文描述）。ADR-011（`08:429`）还要求 CI 检查"枚举中的每个动作都有对应权限点"，而**检查对象不存在**。 |

---

## 发现的缺陷

严重度：**阻断** = 编码无法开始或声明的安全属性不可能成立；**重要** = 可局部绕开但会造成返工、歧义或安全缺口；**次要** = 一致性与可读性问题。

### 阻断级

#### B1. `mem_facts` 抗投毒触发器 off-by-one，单来源即可通过

- **问题**：条件写成了 `array_length(NEW.corroborated_by, 1) IS NULL`，只对空数组成立。
- **证据**：`03:561-571`（触发器全文）；`03:560` 注释"必须多来源或人工确认"；`03:546` `corroborated_by -- 确认过该事实的员工`；`04:306`"需 **2 个以上**来源或人工确认"；`research-brief:375`"反思产出必须携带 `citedMemoryIds`……原始事实 / LLM 概括的物理区分与证据指针是防止组织记忆被虚构污染的唯一可行手段"。
- **为什么是问题**：这是把安全属性写成代码时的典型逻辑错误，且**危险在于它静默**：单元测试若只构造"空数组"就会通过，而真实攻击路径（单个 Agent 自证）畅通。`07:347` 禁止"隐藏状态"，但被污染的组织级事实恰恰是一种隐藏状态。
- **修复**：`AND COALESCE(array_length(NEW.corroborated_by,1),0) < 2`；补 CHECK 保证 `source_count = array_length(corroborated_by,1)`；在 `02` 的 `memory` 测试行加入「**单来源**组织级事实必须被拒」用例。

### 重要级

#### I1. `AuthzService.can` 三处签名不一致（见结论摘要问题 2）

- **证据**：`03:436-437`（新，含 `ctx`）vs `02:358`（旧，无 `ctx`）vs `08:107`（旧，无 `ctx`）。
- **为什么是问题**：`02:247` 声明签名为"可以照抄开工"的起点，`08` 是 ADR 正本。照抄旧签名会实现一个没有域维度的权限裁决，使 `decision_domains` 与 `required_roles` 形同装饰。
- **修复**：同步 `02:358` 与 `08:107` 到 `03:436`；`02:73` 的接口摘要列也需同步（当前仍写 `can(actor, action, resource)`）。

#### I2. 读侧权限模型空白：`channels.visibility` 无对应权限点（见结论摘要问题 3）

- **证据**：`channels.visibility` 定义在通信模型节（`03:805-912` 区间）；`03:455` 提到"`*.read` 权限"；全库检索确认**不存在** `channel.read` / `message.read` 动作定义；`02` 的 `comm` 接口不接收 `ActorContext`。
- **为什么是问题**：私聊（`kind: dm`）与部门频道的读边界完全靠约定。`07:147` 的信息不对称建模、`07:109` 的"跨公司只见公开行为"、`07:145` 的联盟检测都以"谁能看到什么"为前提。
- **修复**：补 `channel.read` / `message.read` 动作 + 频道路径 `ResourceRef`；把 `visibility` 判定写进 `can()`；`Comm.inbox(actor, opts)` 增带 `ActorContext`。

#### I3. 一轮认知循环内 4 次 LLM 调用是否并行，无任何说明

- **证据**：`05:22-87`（10 阶段，其中 Perceive / Deliberate / Plan / Reflect 为 LLM 阶段）；`05:640` "P50 < 8s｜含 **3–4 次** LLM 调用"；`05:332` `maxLlmCalls: number; // 默认 6`。既未说明阶段间是串行还是可并行，也未说明 4 个 LLM 阶段与"3–4 次"的口径差异（④Recall 的 query 改写是"可选"，`05:61`）。
- **为什么是问题**：这直接决定 P50/P95 延迟目标（`05:640-641`）是否可达，也决定 `maxLlmCalls` 的语义是"并发上限"还是"累计上限"。实现者会各自选择，导致压测结果无法比较。
- **修复**：在 `05:5.2` 明确"阶段间串行；同一阶段内的多步（如多路 recall query 改写）可并行"，并给出 `maxLlmCalls` 是"本循环累计调用数上限"的定义。

#### I4. `workflow_templates.definition` 的 Schema 与 `workflow_steps` 的列不对齐

- **证据**：模板 YAML 使用 `outputs` / `requires` / `can_parallel_with` / `sod` / `sla` / `escalation` / `on_reject`（`03:1174-1243`）；`03:980-1010` 区间的 `workflow_steps` 只有 `outcome`，无 `outputs` 列；`05:474` 声称"模板声明 `outputs` 与 `verification`"，而模板 YAML 中**没有 `verification`**（`tasks` 表已有 `verification` 列 `03:946`，模板未同步）。
- **为什么是问题**：`outputs` / `verification` 是 `05:472` 声称的"验证完整性"防线的输入（对应 MAST FM-3.2）。模板声明了产出物却无处校验，等于防线只有一半。
- **修复**：给出 `definition` 的 JSON Schema / Zod 类型；明确产出物的归属（建议：`tasks.verification` 为权威，模板 `outputs` / `verification` 作为派生任务的默认值来源），并让 `workflow_steps` 增 `outputs jsonb` 或在文档中说明"步骤产出物一律由 `tasks.outputs` 承载"。

### 次要级

#### S1. `02:73` 的接口摘要列仍用旧签名

- 证据：`02:73` `AuthzService.can(actor, action, resource): AuthzDecision` + `AuthorityService.decide(empId, domain): AuthorityLevel`。后者在 `03:438` 已改名为 `levelFor(employeeId, domain)`。
- 建议：模块总表是读者第一眼看到的东西，与 `03` 同步。

#### S2. `08:107` 的 ADR 正文与 `03` 的算法不一致

- 证据：`08:107` 写 `can(actor, action, resource)`；`03:388-462` 的算法含 `ctx.requiredRoles`（`03:406`）与域等级（`03:393`）。
- 建议：ADR 是决策正本，至少加一句"签名以 Phase 3 §3.4.4 为准"。

#### S3. `04:132` 的 `reflection_trigger_importance` 与 `05:204` 的 accumulator 存在双重真相

- 证据：`04:132` YAML `reflection_trigger_importance: 150`（per-employee 配置）；`05:204` `reflection: { accumulator, lastReflectedAtSim, episodesSinceReflect }`（运行时状态）；`03:686-716` 写入策略表写"累计 importance ≥ **150**"。
- 建议：明确"阈值来自档案配置（可 per-employee 覆盖），accumulator 是运行时状态"，并说明 `episodesSinceReflect` 与"每模拟日强制反思"（`05:219`）的关系——目前两者都可能导致反思，需说明去重规则。

#### S4. `mem_procedural` 与 `employee_skills` 的计数字段重复

- 证据：`mem_procedural(success_count, failure_count, last_used_sim)` 与 `employee_skills(success_count, failure_count, last_used_sim, proficiency)` 四个字段语义重复，无一致性约束。
- 建议：二选一持有计数（推荐 `employee_skills` 持有，`mem_procedural` 只留 `playbook`），否则"技能成长曲线"会有两个可能不一致的数据源。

#### S5. 三张自检清单仍是纯 checkbox，无判定方式

- 证据：`03:1426` 起的自检清单、`04:400-411`、`05:572-583` 共约 27 条，除 `01:290-303`（有"通过标准"列）外**均无判定方法或责任人**；`01:292` 说"由架构负责人逐条核对"，但 `06:176-185` 的里程碑验收未引用这些清单。
- 建议：合并进 `06:6` 的验收表，或为每条补"自动化测试用例名 / 手工检查步骤"。`research-brief:392-393` 自己指出："检查项只有在自动化时才真正约束架构"。

#### S6. 工作量估算与范围仍不自洽

- 证据：`06:252-268` 合计 70–87 人日 ≈ 8 周（单人全职），对应 20 个 package、30+ 张表、工作流/决策/会议三个引擎、Web 控制台、30 天仿真套件、重放一致性属性测试；`06:268` 声称"2 人可压至 5–6 周"。
- 建议：把 8 周目标定义为"**架构可跑通 + 黄金路径可演示**"而非"12 条验收全绿"；`06:270` 的可压缩项（控制台只读时间线、会议引擎与流程偏离后置）建议直接写进 MVP 范围表。

---

## 内部矛盾与不一致

按"是否会导致两处代码不一致"排序。**注意：本轮已消解 6 条（见文末），下表为快照时刻仍存在的。**

| # | 矛盾点 | 位置 A | 位置 B | 冲突内容 | 建议权威方 |
|---|--------|--------|--------|---------|-----------|
| C1 | **`runCycle` 的所有权与调用方向** | `05` §5.5 执行模型图中的 `AgentRuntime.runCycle()`；`02:148`"`runtime-loop` 执行一次认知循环的 10 个阶段" | `04:415-438` `AgentPorts.runCycle()`，并声明"Runtime 调用 Agent，而不是 Agent 自己跑循环" | 二者对"谁是循环的执行者"表述相反。按 `04` 实现，循环代码落在 `agent-core`/`agent-cognition`，则 `02:148` 与 `01:281` 的分层边界表述失效。这是**唯一一处直接冲击"三层不得混用"验收的实质矛盾**。 | 以 `05` 为准：`runtime-loop` 拥有循环骨架与 Authorize/Act；`agent-core` 只提供 `perceive / recall / deliberate / plan / reflect` 五个纯步骤端口。 |
| C2 | **Authorize 闸门落在哪** | `02:93-95`"`tool-gateway` 是 A4 公理的物理实现点"；`01:104` 图中 `TOOL -->|授权检查 (A4)| AUTHZ` | `05:64` 第 ⑦ 步 `Authorize` 归 `Runtime(确定性)` | 双闸门并存但无分工说明。只实现后者 → `05:39`"越权步骤改写为 Escalate/RequestApproval"无落点；只实现前者 → 工具级最小权限失效。 | 明确两级：**Plan 级（`runtime-loop`）** 与 **调用级（`tool-gateway`）**，并在 `02:2.2` 与 `05:5.2` 互相引用。 |
| C3 | **反思的 LLM 调用由谁发起** | `02:88` `memory` 负责"反思任务的**执行**"，且依赖 `llm-gateway` | `02:104` `agent-cognition` 负责"反思提示"；`02:27` Prompt 唯一归属 `agent-cognition`；`05:67` 第 ⑩ 阶段 `Agent(LLM) + Memory(机制)` | 若 `memory` 自行调 LLM 生成反思，Prompt 归属与 `01:136`"只有 Agent 层会调用 LLM"同时被打破。 | 以 `05` 为准：`memory` 只做反思的**调度与持久化**；`02:88` 措辞改为"反思任务的调度与落库"。 |
| C4 | **`muted` 与"不能选择性忽略"冲突** | `channel_members.muted boolean`（通信模型节） | `05:469`"唤醒时把未处理的 @提及与派活**强制**加入 `Perception`，不能选择性忽略" | `muted` 正是"选择性忽略"的载体。若 muted 阻止 Perception 注入，MAST FM-2.5 防线失效；若不阻止，则该字段语义不明。 | 补一句"`muted` 仅影响通知优先级与 UI，不阻止 `Perception` 注入"，或删除该字段。 |
| C5 | **`02:73` 的接口摘要与 `03` 不一致** | `02:73` `can(actor, action, resource)` / `AuthorityService.decide(empId, domain)` | `03:436-438` `can(actor, action, resource, ctx)` / `levelFor(employeeId, domain)` | 方法名与参数均不同（见 S1）。 | 以 `03` 为准同步 `02:73`。 |
| C6 | **`08:107` 与 `03:388-462` 不一致** | `08:107` `can(actor, action, resource)` | `03:406` `ctx.requiredRoles`、`03:393` 域等级 | ADR 正文落后于数据模型（见 S2）。 | 以 `03` 为准，或加"以 Phase 3 为准"的指引。 |
| C7 | **关系表名与字段名** | `03:225-276` 区间 `RELATIONSHIP` / `RELATIONSHIP_EVENT`，字段 `valid_from / valid_to / recorded_at / superseded_at` | `08:451`（ADR-012）`relationship_edges(from, to, kind, strength, trust, sentiment, valid_from, valid_to, confidence, source_event_id)` | 表名不同（`RELATIONSHIP` vs `relationship_edges`），字段集不同（ADR 多 `confidence`，`03` 多 `interaction_count`）。另：`03` 说 `COLLABORATOR` / `TRUSTS` 由"记忆系统"写入，但 `02:88` 的 `memory` 职责中无"写关系边"。 | 以 `03` 为准更新 ADR-012，并明确"谁有权写哪类关系边"。 |
| C8 | **`mem_write_log` 的枚举列无 CHECK** | `03:626-649`：`written_by` / `policy` / `source_kind` 三列均为 `text` + 注释枚举 | 同表已有 `mem_write_log_traceable` 条件 CHECK 的先例（`03:644-647`） | 注释写了合法值，但约束未加，非法值可写入。 | 为三列补 CHECK 或改用 PG enum（照 `source_kind` 的写法扩展）。 |
| C9 | **`employees.status` 与生命周期状态机的状态集** | `EMPLOYEE.status` 定义（`03:89-90` 区间）为 `onboarding / active / on_leave / offboarded` | `04:23-36` 状态机引入 `Defined / Suspended / Transferred`，并在 `04:57-63` 为它们定义权限语义；`04:61`"`Suspended` 不可被唤醒"、`05:336` 准入闸门检查"雇佣状态为 `Active`" | 数据模型无法表达状态机中的三个状态。`03:1358` 的枚举字典本轮已建立，但这两处状态集是否已对齐需复核。 | 把 `suspended` / `transferred` 补进枚举，或在文档中明确 `Transferred` 是瞬时事件而非状态。 |

---

## 工程可行性风险

### 1. 真实编码时会踩的坑

| # | 坑 | 证据 | 后果 | 规避 |
|---|----|------|------|------|
| R1 | **触发器 off-by-one** | `03:561-571` | 组织级记忆可被单 Agent 污染，且测试容易"假通过" | 见 B1；测试必须覆盖"恰好 1 个来源" |
| R2 | **`recency` 的分钟/小时单位** | 检索评分公式节写 `Δt = now_sim - occurred_at_sim`，单位为"模拟小时"；而 `occurred_at_sim` 列注释为**分钟**（`03:624` 区间） | 漏除 60 → 30 天内记忆全部归档失效；多除 60 → 遗忘机制永不触发。**两种都不报错，只表现为"Agent 变傻"** | 在列注释与公式两处都写明 `Δt_hours = (now_sim - occurred_at_sim) / 60`，并补测试"1 模拟小时后 recency ≈ 0.995" |
| R3 | **HNSW 近似索引 + `archived_at IS NULL` 过滤** | `mem_episodes` 的 `USING hnsw` 索引 + 保留策略表"`archived_at IS NOT NULL` 的行迁冷表"（`03:1344` 区间） | HNSW 为近似索引，等值过滤会造成候选不足导致召回塌陷；迁冷表还需重建索引 | 明确检索路径（热表走索引 + 冷表独立索引），并在 §3.10 补"归档 = 定期 DROP/重建索引"的策略 |
| R4 | **"审批挂起 3 天"的恢复唤醒源没有默认订阅** | `05` §5.4.2 声称恢复不重放任何 LLM 调用；`05:325-343` 三路唤醒源；`05:362-381` 的 `subscription_rules` 示例中**没有** `Workflow.ApprovalGranted` 的接收者规则 | 挂起释放 Worker 可行，但"审批到达"没有默认唤醒路径，需每个门手工配订阅，遗漏即静默卡死 | 补"状态恢复订阅"的自动生成逻辑（`AgentState.suspendedAt.awaitingEventType` → 订阅），并在 §5.6.2 图中画出"挂起队列 → 条件满足 → 重新入队" |
| R5 | **`tool_invocations.idempotency_key UNIQUE` 与重放** | `tool_invocations` 全局唯一约束（`03:1265-1310` 区间）+ `05` §5.7.2"重放时外部工具调用被拦截、返回历史结果" | 重放写库会撞唯一约束；不写则重放无审计记录 | 明确"重放不写 `tool_invocations`，只写 `replayed:true` 的投影"，或唯一键改为 `(idempotency_key, branch_id)` |
| R6 | **`effective()` 闭包成本 vs 每步调用**（**已缓解，仅需复核落地**） | `03:388-462` 算法（roles ∪ grants ∪ delegations − revocations，逐条 pattern + ABAC + SoD）；`05:64` 对 Plan 的**每一步**调用 `can()`；`05:359` 单 Agent 每日至多 40 cycle | 单 Agent 每日可达数百次权限闭包计算，每次含递归模式匹配 | ✅ 已解决：`05:280` 新增 §5.4.4「权限快照缓存（避免 O(步数 × 权限闭包)）」，`05:205` 的 `AgentState` 带按 cycle 缓存的权限快照。仅需在 §5.4.4 内明确该快照是**非持久领域状态**（避免被误当作可回放的领域事实） |
| R7 | **会议引擎与 presence 的双写互锁** | `05:279` 会议发言由 `meeting-engine` 用发言权令牌串行化；`04:192` `InMeeting` 由会议引擎独占 | 会议引擎要唤醒 N 个 Agent 并等待，presence 由 scheduler 管理；不原子设置会出现"开会期间被派活" | 明确 `InMeeting` 只能通过 `Runtime.PresenceChanged` 获取（`05:197` 已声明唯一写入者），设置/释放为原子命令 |
| R8 | **`correlationId` 类型与传播规则** | `03:432` `correlationId: CorrelationId`（branded）vs `08` 与 `02` 中的旧写法；`05` §5.2 的"自调度下一轮"（`RF -.-> Self-schedule --> W`） | 自调度产生的新循环如何继承 correlation 不明（开新链还是续链？）——这决定因果树的形态与 `01:188`"任何 Agent 行为都能追溯到最初触发它的那一条事件"是否成立 | 在 `WakeRequest` 增加 `correlationId?` 并明确"自调度开新因果链，但保留 `originCorrelationId` 便于归组" |

### 2. 过度设计

| # | 项 | 证据 | 判断 |
|---|----|------|------|
| O1 | **`subscription_rules` 四类订阅者 + `filter jsonb`** | `05:362-381` 支持 `employee / position / department / role` + `event_pattern` + `filter` | MVP 只有 6 员工、1 条流程。建议先实现 `employee` 与 `position` + 少量固定 pattern，`department` / `role` / `filter` 留到 v0.2——文档已设"每员工每日 ≤40 cycles"硬闸，说明唤醒量不依赖订阅表达力 |
| O2 | **四层循环护栏** | `05` §5.7（Schema 失败 ≤3 重试 → 降级 `NO_OP` → 熔断 15 分钟 → 重复计划检测） | 建议 MVP 只做"≤3 重试 + 熔断"；"重复计划检测"依赖尚未定义的 `Plan` 签名规范化，后置到 M3 |
| O3 | **代理的事实冗余** | `delegations` 表 + `ActorContext.onBehalfOf` + `tasks.acting_employee_id` + `approval_decisions.on_behalf_of` | 四处存储同一事实且无一致性约束。`03:431` 已把 `onBehalfOf` 标注为"仅命令入口的瞬时字段，不落库"（好），建议同样明确其余三者的权威关系：`delegations` 为授权事实，`acting_employee_id` 为执行事实 |
| O4 | **模型分级路由** | `05` §5.9"C-level 岗位全局上一档" | 6 人 MVP 阶段价值低于"先把 `llm_calls` 记对"。建议 M2 只做记录 + 硬预算，分级路由等看到真实成本曲线后再上 |
| O5 | **七类关系边** | `03:236`（`REPORTS_TO / DOTTED_TO / PEER / MENTOR / COLLABORATOR / TRUSTS / CONFLICTS_WITH`） | `PEER` 已声明"派生不存储"（好）；`MENTOR` 在 MVP 无任何行为依赖（`04:225` 的 `RecommendHire` 属 M5+），建议延后 |

### 3. 被低估的工作量：四类关键契约仍缺失

- **`OrgSnapshot`**：`02:103` `AgentFactory.build(employeeId, orgSnapshot)`、`04:423` `build(employeeId, snapshot: OrgSnapshot)` —— 全文档集**无一处定义**。它是 Agent 装配的输入契约（需含组织架构、汇报线、权限、关系边、技能、种子记忆），属 M2 关键路径。
- **`Plan` / `Step` / `Perception` / `Judgement`**：`05:54-67` 以散文描述（如 `Perception{ intent, urgency, refs, openQuestions }`）。`02:247` 承诺"直接照抄即可开工"，但这四类无 TS 定义。
- **22 个 `Action` 的枚举**：`04:206-235` 的表格是权威描述，但无 TS `enum`/`union`。ADR-011（`08:417`）称其为"闭集"，`08:429` 要求 CI 检查每个动作都有权限点——**检查对象不存在**。
- **`workflow_templates.definition` 的 Schema**：见 I4。

---

## 遗漏项

### 用户要求但文档仍缺失或过浅

| # | 要求 | 现状 | 缺什么 |
|---|------|------|--------|
| M1 | **冲突的检测与调解** | 仅 `CONFLICTS_WITH` 关系边（`03:236`）；`02:166` 声称 `escalation-engine` 负责"冲突识别" | 检测规则（阈值？对立次数？）、调解流程、裁决归属、`Relationship.ConflictResolved` 的触发条件。这属于验收点 3 明确列举的"解决冲突"能力 |
| M2 | **Decision 的 Discussion 环节** | 仅事件名 `Decision.DiscussionOpened`（`03:799`）；`02:163` 提到"评议征询" | 讨论用什么承载（`messages`？`documents`？新表？）、讨论与 `proposal_reviews` 的边界、讨论如何终止、事件 payload |
| M3 | **表决权重与法定人数的计法** | `votes.weight -- 由权限等级推导`；`decision_rights.quorum` | 具体公式（`weight = f(level, domain, stakes)`？）、`quorum` 按人头还是按权重和、`requires_ceo` 与 `quorum` 的优先关系。需要 2 个手算样例作为表驱动测试 |
| M4 | **Personality 的生效路径** | `AGENT_PROFILE.personality "大五/风格向量"` + `risk_appetite` | 大五如何映射进 Prompt（`04:158` 只说"会被翻译成提示词"）；`04:308` 的"±2% / 总偏移 ≤±20%"作用于哪些字段、存在哪里 |
| M5 | **消息 → 记忆的写入路径** | 写入策略表"收到消息且被 @ → 1 条 conversation episode，importance ≥ 3" | 与 `rm_inbox` 的关系；`messages.importance` 可空时的默认值；群聊是否逐条产生记忆（成本敏感） |
| M6 | **事件注册表 / Schema 版本治理** | `03` §3.6.2 承诺"只能新增字段 + 提升 version"；枚举字典（`03:1358`）已建立 | 事件注册表（`type → payload schema → 引入版本 → 消费者`）与 CI 校验；`08` 说"事件 Schema 演进需要纪律"但无承载物 |
| M7 | **人类观察者的可见范围** | `01:53` Board Observer；`03:450-456` 已定义其权限路径 | 人类能看到哪些频道、哪些记忆？`07:347` 禁止"隐藏状态"，但 `system_brief`、`mem_reflections` 都是私有内容；"观察者可见范围"仍缺。`05` §5.7.2 重放模式下人类能否触发命令也未定义 |
| M8 | **验收标准的判定工具** | `06:189-207` 12 条 | 第 3 条"静态检查"、第 5 条"属性测试"、第 12 条"新增 YAML 不改 TS"均未说明用什么工具判定。`06:247` 提到 `dependency-cruiser`，但"新增 YAML 不改 TS"需要装配契约测试 + 快照方案 |

### 已满足、明确记录以免重复评审

以下经逐条核对**确认已充分覆盖**，无需修补：

- **反退化定位（验收点 1 / 7）**：`README:48-52` + `01:17-23` + `06:195` + `07:337-353` 四处一致且可判定 ✓
- **无匿名 LLM**：`01:297` + `06:198` + `02:27` + `02:89`（本轮已把 `ActorContext` 设为 `invoke` 首参并加"❌ 不接受无主体的调用"）✓
- **无 Agent 间 RPC**：`02` 在 `Agent` 类型上显式注释禁止 + `01:299` 检查项 + "发送即事件" ✓
- **工作流不得藏进 prompt**：`03:1245-1247` 用 `sod` / `escalation` / `on_reject` / `required_level` 四个引擎硬约束正面回应 ✓
- **记忆更新显式可追溯**：`mem_write_log` + `source_kind` 条件 CHECK + `01:302` 检查项 + `04:309` 学习溯源 ✓
- **MAST 失败模式防线映射**：`05:458-487` 14 个模式逐条对应，且有 `research-brief:353-366` 的独立引用来源 ✓
- **审批挂起 + 不可逆副作用后置**：ADR-006 + `05` §5.4.2 恢复算法 + `research-brief:368-371` 三方一致，并明确对比 LangGraph `interrupt()` 的重放陷阱 ✓
- **`submitted ≠ completed`**：任务状态机用状态分离结构性防住 MAST FM-3.1 / FM-3.2，并明确"Agent 无法自己宣布任务完成" ✓
- **`tasks` 与 `workflow_steps` 的一对多分离**：理由论证清楚（一个开发步骤派两人 → 两条任务；流程外任务无实例），同时解决两种语义 ✓
- **人类权限路径**：`03:450-456` 用"人类必须占岗位、走同一套 `effective()`/`can()`、无特例分支"解决，比外挂式 HITL 更彻底 ✓
- **成本 = 人力成本的组织语义**：`05` §5.9 映射表 + `07:154-167` 深化路径，技术指标到组织概念的正确翻译 ✓

### 评审期间已修复（不计入本次缺陷）

评审窗口（约 11:04–11:19）内被并发修复并经我复核确认的条目：

| 原问题 | 修复证据 |
|--------|---------|
| `tasks` 表完全缺失 | 新增 `tasks` 表 + §3.8.1「任务——独立于流程的工作单元」+ 权威任务状态机 |
| 会议无数据模型 | 新增 `meetings` / `meeting_participants` / `meeting_turns`（含 `speak_count`、`skipped` 合法沉默） |
| `Skill` / `proficiency` 无持久化载体 | 新增 `skill_definitions` + `employee_skills`（含 `source_event_id` 溯源与"找最擅长的人"索引） |
| **Goal 无数据模型** | 新增 §3.2.2 目标（Goal） |
| `AuthzService.can` 无域维度 | `03:430` `authorityByDomain` + `03:436` `ctx.domain` + `03:438` `levelFor` |
| `required_roles` 不参与判定 | `03:406` `roleOf(actor) = ANY(ctx.requiredRoles)` + `03:1041` 注释指向 §3.4.4 |
| 人类无法通过授权闸门 | `03:450-456` 人类必须占 `Position`，走同一套权限路径 |
| `PresenceState` 无事件可投影 | `03:797` 事件分类新增 `Runtime.PresenceChanged`；`03:1256` / `03:1314-1327` 声明其为唯一来源并解释代价 |
| `processed_events` 幂等键吞掉多接收者 | `03:773-777` 新增 `consumer_key`，主键改为 `(consumer_group, event_id, consumer_key)` |
| `decisions` 不可变规则与 `superseded_by` 矛盾、未拦 DELETE | `03:1152` `decision_supersessions` + `03:1169-1170` 同时拦 UPDATE 与 DELETE |
| `org_events` 分区键不在主键（建表即失败） | `03:741` `PRIMARY KEY (company_id, occurred_at_wall, seq)` |
| `messages` 分区与主键冲突 | 保留策略表改为"MVP 不分区；若需分区则主键须为 `(id, sim_time)`" |
| `decay_score` 量纲错误导致遗忘成死代码 | 归一化为 `(importance/10) · 0.995^Δt` 并显式记录原问题 |
| `mem_write_log.source_event_id NOT NULL` 与 Seeding 冲突 | `source_kind` 三分来源 + `mem_write_log_traceable` 条件 CHECK |
| `reflection` 累加器无存储位置 | `05:204` 落入 `AgentState`，`05:214-223` 定义原子语义并明确"不允许触发两次" |
| 拒绝派活无收敛规则 | `03:1233-1242` `on_reject`（`max_retries` / `reassign_strategy` / `escalate_to` / `escalation_sla`） |
| 反事实分叉承诺超出能力 | `05:479` 已明确列为「写侧 · Phase 7（v1.0）」 |
| `LlmGateway.invoke` 无 `ActorContext` | `02:89` 改为 `invoke(actor: ActorContext, req: LlmRequest)` |
| 状态枚举散落三处 | 新增 §3.11 枚举字典（权威定义） |

---

## 附：建议的收尾顺序

缺陷总量已收敛到 1 阻断 + 4 重要 + 6 次要。建议：

1. **立刻修 B1**（`mem_facts` 触发器 off-by-one + 补"单来源必须被拒"的测试用例）。这是唯一一处"静默失效的安全属性"，其余都是可读性/一致性问题。
2. **签名三处对齐**（I1：`02:358`、`02:73`、`08:107` → `03:436`）。
3. **补读侧权限点**（I2：`channel.read` / `message.read` + `Comm.inbox(actor, ...)`）。
4. **补四类缺失类型**（`OrgSnapshot` / `Plan` / `Step` / `Action` 枚举 / `definition` Schema）——这是 M2 能否按期开工的决定因素。
5. **补三个实现细节定义**（I3 并行性、I4 模板与步骤列对齐、R2 单位、R4 恢复订阅）。
6. **同步 `90` 处旧行号引用**（本轮文档大幅增补后，跨文档的 `Phase X §Y` 与行号引用需要全面复核一遍）。

第 1–3 项是一小时内可完成的一致性修补；第 4 项建议在 M0 期间完成，否则 M2 的"认知循环"会因为没有 `Plan` 的强类型而退化成自由文本解析——那正是本项目最想避免的东西。
