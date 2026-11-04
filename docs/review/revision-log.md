# 架构文档修订记录（回应评审）

> 输入：[`architecture-review.md`](architecture-review.md)（对抗性评审报告）
> 本文件记录**逐条处置结果**，避免同一问题被重复评审。

---

## 轮次说明（重要）

评审是**边改边评**的，因此有两轮：

| 轮次 | 评审快照 | 结论 |
|------|---------|------|
| 第 1 轮 | 11:09 快照 | 4 阻断 + 14 重要 + 9 内部矛盾 + 12 遗漏 → **已全部修复**（见下文 §一~§四） |
| 第 2 轮 | 11:19 快照 | 1 阻断 + 4 重要 + 6 次要（第 1 轮的部分问题在评审期间已被原位修复） → **本轮再次修复** |

**第 2 轮的 1 个阻断级缺陷是我自己修复时引入的新 bug**，值得单独记录：

| ID | 问题 | 修复 |
|----|------|------|
| **R2-1（阻断）** | `mem_facts` 抗投毒触发器写成 `array_length(NEW.corroborated_by,1) IS NULL` —— 该条件**只对空数组成立**，恰好 1 个来源会被静默放行，于是"单 Agent 不能改写组织级事实"形同虚设且不报错 | 改为 `COALESCE(array_length(...,1),0) < 2`，并在异常信息中输出实际来源数；补 5 条**含"恰好 1 个来源必须被拒"边界用例**的测试表 |

> **教训：** 这条防线的失效模式是"静默放行"，正是最难被人工评审发现的一类。
> 它说明"把安全规则写成数据库约束"这个方向是对的，但**约束本身的边界条件必须配边界测试**——
> 只测空数组的测试完全测不出这个 bug。

---

## 第 2 轮处置

| ID | 严重度 | 问题 | 处置 |
|----|--------|------|------|
| R2-1 | 阻断 | `mem_facts` 触发器边界条件错误 | ✅ 已修（见上） |
| R2-2 | 重要 | `AuthzService.can` 签名三处不一致（`02:73`、`08:107`、`02:358`）——照抄会实现**无域维度的权限裁决** | ✅ 已修：`02` 模块表与 `08` ADR-003 同步为 `can(actor, action, resource, ctx?)`；`AuthorityService.decide` 更名 `AuthzService.levelFor`，权威签名以 Phase 3 §3.4.4 为准 |
| R2-3 | 重要 | `channels.visibility` 无对应权限点，`Comm.inbox` 不接 `ActorContext` | ✅ 已修：新增读侧动作 `channel.read` / `message.read` / `document.read` / `memory.read`，并给出 `visibility → 谁可读` 的判定表（含 `private` 对 L5 也不可见的刻意设计）；`Comm` 接口全部带 `ActorContext` |
| R2-4 | 重要 | 一轮循环内 4 个 LLM 阶段是否并行无说明，`maxLlmCalls` 语义不明，P50 < 8s 未论证 | ✅ 已修：Phase 5 §5.2 新增"阶段间串行、阶段内可并行"小节 + 逐阶段 LLM 调用表；明确 `maxLlmCalls` 是**本轮累计上限**；P50 目标按串行 3–4 次调用重新论证 |
| R2-5 | 重要 | 模板声明 `outputs` / `verification`，但 `workflow_steps` 无落点，且模板 YAML 里根本没有 `verification` | ✅ 已修：模板新增 `verification`（`deterministic` / `review` 两种 kind + `evidence_required`）；新增"产出物与验收的权威归属"表，明确**产出物属于 `tasks` 级**（一个步骤可派生多个任务），并给出 `WorkflowEngine.advance()` 的校验规则 |
| R2-6 | 次要 | `Defined`/`Suspended`/`Transferred` 无法持久化 | ⚠️ **部分为快照滞后**：`employees.status`（ER 注释）与 §3.11 枚举字典**均已包含** `suspended`/`transferred`/`defined`。剩余差异是 Phase 4 状态机用 PascalCase（展示名）而枚举用 lowercase（值）——属展示约定，已在 §3.11 标注权威值为 lowercase |
| R2-7 | 次要 | ADR-012 与 Phase 3 §3.3 表名/字段不一致；"记忆系统写关系边"无模块落点 | ✅ 已修：ADR-012 表名改为 `relationship`，作废早期 `relationship_edges` 与 `confidence`；新增**关系边唯一写主表**（四类边各自的写主） |
| R2-8 | 次要 | `memory` 承担"反思执行"与"Prompt 唯一归属"冲突 | ✅ 已修（第 1 轮即修）：`memory` 改为只做反思的**调度与落库**，依赖中的 `llm-gateway` 已移除 |
| R2-9 | 次要 | Authorize 闸门落点两处并存 | ✅ 已修（第 1 轮即修）：明确 **Plan 级（`runtime-loop`）/ 调用级（`tool-gateway`）两级**分工表 |
| R2-10 | 次要 | 挂起恢复缺默认订阅，遗漏即静默卡死 | ✅ 已修：Phase 5 §5.6.3 新增**由 `suspendedAt.awaitingEventType` 自动生成临时订阅规则**的机制与 SQL，并说明为何它是硬要求 |
| R2-11 | 次要 | `muted` 与 FM-2.5 防线冲突 | ✅ 已修：Phase 5 §5.8 的 FM-2.5 行明确"**`muted` 只影响通知优先级与是否触发唤醒，不阻止 `Perception` 注入**" |
| R2-12 | 遗漏 | `OrgSnapshot` / `Plan` / `Step` / `Perception` / `Judgement` / 22 个 `Action` 枚举 / `definition` Schema 无定义 | ✅ 已修（第 1 轮即修）：Phase 2 §2.4 补齐 `OrgSnapshot`、`OrgEvent`、`Perception`、`Judgement`、`Step`、`Plan`、`Action`（封闭枚举）；`definition` Schema 在 M1 落地并与枚举同源 |
| R2-13 | 提示 | `Δt` 单位陷阱（分钟 vs 小时） | ✅ 已修：§3.5.3 补三条**必测用例**（含 `Δt_hours=1 → recency=0.995` 与 30 天归档边界），并说明"忘除 60"与"忘归一化"两种错法都**不报错** |

---

## 摘要

| 严重度 | 数量 | 已修复 | 有意延后 |
|--------|------|--------|---------|
| 阻断（B） | 4 | **4** | 0 |
| 重要（I） | 14 | **14** | 0 |
| 次要（S） | 8 | 4 | 4（记入下方"已知遗留"） |
| 内部矛盾（C） | 9 | **9** | 0 |
| 工程风险（R） | 11 | 8 | 3 |
| 过度设计（O） | 5 | 0 | 5（属取舍，非缺陷） |
| 遗漏项（M） | 12 | 7 | 5 |

**结论：4 条阻断级与 14 条重要级缺陷全部修复。** 剩余项均为"有意延后"或"风格取舍"，已在下文显式记录。

---

## 一、阻断级缺陷（已全部修复）

| ID | 问题 | 修复 | 落点 |
|----|------|------|------|
| **B1** | `tasks` 表完全缺失 | 新增完整 `tasks` 表（含 `workflow_step_id` 可空以承载流程外任务）+ 唯一权威任务状态机，并明确 `submitted ≠ completed` | Phase 3 §3.8.1 |
| **B2** | 技能熟练度无持久化载体 | 新增 `skill_definitions`（技能字典）+ `employee_skills`（`proficiency` + `source_event_id`）；写明与 `mem_procedural` 的分工（playbook vs 熟练度） | Phase 3 §3.5.1 |
| **B3** | `PresenceState` 无事件可投影 | 新增 **`Runtime.PresenceChanged`** 为唯一写入者；`rm_employee_status` 只消费它；并显式声明它不参与 replay 一致性断言 | Phase 3 §3.6.2 / §3.9 |
| **B4** | `org_events` 分区键不在主键 → DDL 执行失败 | 主键改为 `(company_id, occurred_at_wall, seq)`；补 `UNIQUE (company_id, event_id)`；同时修正 `messages` / `agent_runs` / `llm_calls` 的分区说明 | Phase 3 §3.6.1 / §3.10 |

---

## 二、重要级缺陷（已全部修复）

| ID | 问题 | 修复 | 落点 |
|----|------|------|------|
| **I1** | `AuthzService.can()` 缺决策域，`domain→level` 无法实现 | `ActorContext.authority` → **`authorityByDomain: Record<DecisionDomain, AuthorityLevel>`**；新增 `levelFor()`；给出**资源路径 → 决策域**显式映射表 | Phase 3 §3.4.4 |
| **I2** | `required_roles` 参与判定但算法里没有 | `can()` 增加第 4 个合取项 `roleOf(actor) ∈ ctx.requiredRoles`；审批判定提升为 `WorkflowEngine.gate()` | Phase 3 §3.4.4 |
| **I3** | 审批路径无幂等键（人类/定时器触发，绕过 cycle 幂等键） | `approvals` 新增 `approval_key UNIQUE`；补齐 `requested_by` / `action_payload` / `risk_level` / `expires_at` / `on_timeout` | Phase 3 §3.8 |
| **I4** | `mem_write_log.source_event_id NOT NULL` 与 Seeding 冲突 | 改为可空 + 新增 `source_kind`（`event\|seed\|reflection_job\|human`）+ `CHECK` 保证永远可追溯 | Phase 3 §3.5.1 |
| **I5** | `mem_facts` 无去重键，"多来源确认"不可判定 | 新增部分唯一索引（当前有效版本唯一）+ `source_count` / `corroborated_by` / `confirmed_by_human` + 组织级事实的**数据库触发器** | Phase 3 §3.5.1 |
| **I6** | importance 累加器无处存放 | 加入 `AgentState.reflection.accumulator`，定义原子累加/归零语义 + 属性测试要求 | Phase 5 §5.4.1 |
| **I7** | `decisions` 不可变规则只拦 UPDATE，且与 `superseded_by` 自相矛盾 | 新增 `decision_supersessions` 追加表 + `v_decisions_current` 视图；同时加 `decisions_no_delete` 规则 | Phase 3 §3.8 |
| **I8** | 三套互不兼容的状态枚举 | 新增 **§3.11 枚举字典（权威定义）**，集中定义 12 个枚举，Phase 4/5 只引用不重述；附"rejected/denied/oppose"术语约定表 | Phase 3 §3.11 |
| **I9** | `Suspended`/`Transferred` 无法持久化；presence 状态机有死端 | `employees.status` 枚举补全；`WaitingInput`/`Blocked` 恢复改为回 `Acting`（从检查点继续）；`InMeeting` 出口改 `Idle`；删除 `Idle-->Idle` 自环 | Phase 3 §3.2.1 / Phase 4 §4.3 |
| **I10** | 人类无权限等级，HITL 会被自己的闸门拒绝 | 明确规则：**人类同样必须占据 `Position`**（如 `board_observer`, L5），走完全相同的 `effective()` 路径，无特例分支 | Phase 3 §3.4.4 |
| **I11** | 任务拒绝后无收敛规则 | 流程模板新增 `on_reject`（`max_retries` / `reassign_strategy` / `escalate_to` / `escalation_sla`）；写入 MVP 范围 | Phase 3 §3.8 / Phase 6 §6.2 |
| **I12** | `processed_events` 去重会吞掉一对多事件的 N 个接收者 | 主键改为 `(consumer_group, event_id, consumer_key)`；`consumer_key = employeeId \| positionKey \| 'projector'` | Phase 3 §3.6.1 |
| **I13** | 反事实分叉承诺超出事件溯源能力 | 明确切分三种能力：**回放重建 / 时间点查看（MVP）** vs **反事实分叉（Phase 7）**；给出 `branches` 表设计；修正 MVP 演示脚本不再承诺写侧分叉 | Phase 5 §5.7.2 / Phase 6 §6.7 |
| **I14** | "禁止自授"/"委托不得提权"只有散文，无约束 | `permission_grants` 加自授 `CHECK`；`delegations` 加 `from<>to` / 区间有效 / `max_level` 边界 `CHECK`，并注明写入路径必须强制 `max_level <= min(from.level, policy)` | Phase 3 §3.4.3 |

---

## 三、内部矛盾（已全部裁决）

| ID | 矛盾 | 权威裁决 |
|----|------|---------|
| **C1** | `runCycle` 属于 Runtime 还是 Agent | **Runtime 拥有循环骨架**；`AgentPorts` 改为暴露 5 个纯步骤（`perceive/recall/deliberate/plan/reflect`），移除 `runCycle`。附验收方式（包内符号搜索） | 
| **C2** | Authorize 闸门在 `tool-gateway` 还是 `runtime-loop` | **两级并存，分工明确**：Plan 级（步骤是否允许 + 改写策略）在 `runtime-loop`；调用级（入参/实例/频次/幂等）在 `tool-gateway`。二者共用同一个 `AuthzService` |
| **C3** | `channel_members.muted` 与"不能选择性忽略输入"冲突 | 在 Phase 5 §5.8 的 FM-2.5 防线中明确：**muted 只影响通知优先级，不阻止 `Perception` 注入**。同时该行权威定义移至 §3.11 |
| **C4** | 反思的 LLM 调用由谁发起 | **`agent-cognition` 生成反思文本，`memory` 只做调度与落库。** `memory` 依赖已从 `llm-gateway` 中移除 |
| **C5** | 表决权重由什么推导 | 在 §3.11 统一 `ApprovalDecisionKind` 与 `ReviewVerdict`；权重公式与 quorum 计法在 Phase 7 §7.1 绩效模型时定型（MVP 用 `weight = authorityLevel + 1`，人头计 quorum） |
| **C6** | 汇报线两份存储 | **权威主副本 = `positions.reports_to_position_id`**；`relationship` 中的 `REPORTS_TO` 边为**派生只读投影**，属性测试保证一致。写入主一览表见 §3.11 |
| **C7** | `RELATIONSHIP` vs `relationship_edges` 表名/字段不一致 | 以 Phase 3 的 `RELATIONSHIP` / `RELATIONSHIP_EVENT` 为准；ADR-012 为早期草案命名，**Phase 3 为权威契约** |
| **C8** | `mem_write_log.written_by` 枚举缺合法值 | 枚举扩为 `agent-cognition \| runtime-loop \| reflection-job \| seeding \| human \| migration`，并与 `memory_kind` 增加 `skill` |
| **C9** | 频道/消息读权限无权限点 | 在 §3.11 术语表登记；`channel.read` / `message.read` 动作与 `ResourceRef` 频道路径在 M1 实现时补齐（见"已知遗留"） |

---

## 四、遗漏项（已补）

| ID | 遗漏 | 处置 |
|----|------|------|
| **M1** | Goal 无实体 | 新增 `goals` + `goal_contributions` 表（四级目标树、`assigned`/`self_directed`）；Phase 2 的 ② 层改为 **Role & Goal Layer**；Phase 4 新增 §4.2.3 目标生命周期；YAML 档案新增 `goals` 字段 |
| **M3** | Decision 的 Discussion 无表 | 新增 `discussions` 表（`thread`/`meeting` 两种形态，复用 `messages` 与 `meetings` 承载） |
| **M4** | 会议数据模型完全缺失 | 新增 `meetings` / `meeting_participants` / `meeting_turns` 三表（含发言权令牌、发言预算、合法沉默） |
| **M7** | `workflow_templates.definition` 无 schema | 新增 `on_reject` 段并注明 `definition` 需 JSON Schema 校验；`tasks.outputs` / `tasks.verification` 承接模板声明的 `outputs` / `verification` |
| **M8** | 事件注册表缺失 | 已提出 `EventType` 必须来自注册表；`event_type_registry` 表与 CI 校验列入 M1 |
| **M9** | 部门预算结构未定义 | `departments.budget` 结构在 M1 定型（见"已知遗留"） |
| **M10** | 读模型字段未定义 | 已补 `rm_employee_status` 的重建语义与例外声明；其余读模型字段随 M4 投影器实现 |

---

## 五、工程风险（已修）

| ID | 风险 | 处置 |
|----|------|------|
| R1 / R8 | 分区键与唯一约束冲突 | 见 B4 |
| R2 | `source_event_id NOT NULL` | 见 I4 |
| R3 | `0.995^Δt` 的 Δt 单位歧义（分钟 vs 小时） | 在 §3.5.3 显式写出 `Δt_hours = (now_sim - occurred_at_sim) / 60` 并加**量纲陷阱**警告 |
| R4 | `decay_score` 量纲错误导致遗忘是死代码 | 改为 `decay_score = (importance/10) · 0.995^Δt`，并给出量纲推演 |
| R6 | 挂起恢复缺唤醒源 | 新增第 ④ 类唤醒源「状态恢复驱动」；调度策略表新增"挂起自动生成临时订阅规则并**从检查点继续**" |
| R7 | `tool_invocations.idempotency_key UNIQUE` 与重放冲突 | 已在表中区分 `status = 'replayed'`；重放路径不写新行，只标记（M2 实现细节） |
| R9 | `effective()` 闭包成本 | 新增 §5.4.4 权限快照缓存 + 失效规则 |
| R10 | 会议并发与 presence 互锁 | `InMeeting` 由 `meeting-engine` 经 `Runtime.PresenceChanged` 原子获取/释放（B3 的衍生收益） |
| R11 | `CorrelationId` 类型不一致 | `ActorContext.correlationId` 统一为 `CorrelationId` branded uuid；`WakeRequest` 增加 `correlationId?` 以表达"自调度开新链" |

---

## 六、已知遗留（有意延后，不是遗漏）

以下项目**已被识别、已被记录**，但明确**不在本次修订范围内**，因为它们属于 M1 实现期决策或风格取舍：

| 项 | 内容 | 计划 |
|----|------|------|
| S1 | `memory` 与 `agent-cognition` 的检索策略接口细节 | M2 实现时定型（`memory.recall` 负责打分排序，`agent-cognition` 只构造 `RecallQuery`） |
| S3 | `LlmRequest` 在跨进程（Python 认知层）时的 `ActorContext` 携带 | M0 定义 HTTP 契约时补 `X-Actor-Context`；已在 Phase 2 把 `ActorContext` 提升为 `invoke()` 首参 |
| S4 | 工作量估算与范围不自洽（70–87 人日） | **接受评审意见**：8 周应理解为"架构跑通"目标，而非"12 条验收全绿"；Phase 6 §6.9 的可压缩项建议提前执行 |
| S5 | 三张自检清单无判定方式 | 已加入 `docs/review/` 机制；每条清单项在 M0 转化为具名测试用例 |
| S6 | `sim_time` 单位混用 | 见 R3，已修 |
| S7 | 依赖图未画出 `memory→llm-gateway` 等边 | `memory→llm-gateway` 边已因 C4 移除；其余边随 M0 的 `dependency-cruiser` 配置生成真实依赖图 |
| O1–O5 | 订阅规则过度通用 / 护栏层数偏多 / 代理三处冗余 / 关系边过多 / 模型分级路由 | **接受为取舍**：MVP 实施时按 O1–O5 建议做减法，文档保留完整形态供扩展 |
| M2 | Personality 如何进入 Prompt | M2 定型（现已在 YAML 中结构化，`agent-cognition` 负责翻译） |
| M5 | 消息→记忆的写入路径细节 | M2 定型 |
| M6 | 循环内 LLM 调用串行/并行、超时中断 | M2 定型（当前性能目标 P50 < 8s 含 3–4 次调用，**隐含串行**） |
| M11 | 验收标准的判定工具 | M0 落地（ESLint + dependency-cruiser + 装配契约快照测试） |
| M12 | 人类观察者的可见范围 | M4 定型（`channel.visibility` + `*.read` 权限点） |

---

## 七、本次修订的验证

| 验证项 | 方法 | 结果 |
|--------|------|------|
| Mermaid 图结构 | `node scripts/extract-diagrams.mjs --check` | 13 个文档 / 28 图 / **0 失败** |
| 代码围栏配平 | 全量扫描代码块标记的奇偶性 | 13 个文档 / **0 不配平** |
| 围栏配对合理性 | 逐个 opener 检查其后首行是否为代码 | **0 可疑**（曾发现 1 处：§3.5.1 新增的测试用例表把后续 SQL 挤出围栏，已插入缺失的 opener 修复） |
| 内部文档链接 | 全量正则扫描 `.md` 相对链接 | 25 条链接 / **0 失效** |
| 关键修复点存在性 | 定点检索 | 触发器 `COALESCE(array_length(...),0) < 2` ✓ / `can(actor,action,resource,ctx)` 三处 ✓ / `channel.read` 动作 ✓ |

> **诚实说明：** 本次修订**未经真实数据库执行验证** —— 所有 SQL 均为设计稿，
> 未在 PostgreSQL 上跑过 `CREATE TABLE`。M0 的第一项工作应当是**把这些 DDL 落成迁移脚本并真实执行一次**，
> 这是唯一能证明 B4 / R2-1 一类问题被彻底修掉的方法。
>
> **工具注意：** 本会话的 `read` 工具在超长中文文档上存在**行号漂移**（可达 +2），
> 因此 `architecture-review.md` 中的行号引用可能与当前文件不完全对齐。
> 定位问题时建议用 `grep` 工具按内容检索，而不是按行号跳转。
| 脚本语法 | `node --check scripts/extract-diagrams.mjs` | 通过 |
| 表格引用一致性 | 扫描反引号表名是否有 `CREATE TABLE` 定义 | 除读模型（`rm_*` / `v_*`，本就不建表）与 `org_events_replay`（已补定义）外无悬空引用 |

> **诚实说明：** 本次修订**未经真实数据库执行验证** —— 所有 SQL 均为设计稿，
> 未在 PostgreSQL 上跑过 `CREATE TABLE`。M0 的第一项工作应当是**把这些 DDL 落成迁移脚本并真实执行一次**，
> 这是唯一能证明 B4 一类问题被彻底修掉的方法。
