# docs/architecture — 文档索引与权威级别

> **地位**：本文档集是架构的 Single Source of Truth。
> 总入口：`ARCHITECTURE-BASELINE.md`（冻结基线）→ `package-registry.md`（包命名与边界）→ `dependency-graph.md`（依赖方向）→ 各 Phase 文档（设计细节）。
> 冲突裁决顺序：**ARCHITECTURE-BASELINE > package-registry / dependency-graph > Phase 文档 > 代码**。
> 代码与基线冲突时，Architecture Baseline = authoritative，除非执行一次 Architecture Change（见 BASELINE §17）。

---

## 1. 文档清单

| Document | Purpose | Authority | Depends On | Status |
| --- | --- | --- | --- | --- |
| `ARCHITECTURE-BASELINE.md` | 冻结基线：17 节架构契约总纲 | **最高**（变更须走 ADR 流程） | 全部下表文档 | FROZEN |
| `package-registry.md` | 29+4 包的命名裁定、职责、公共 API、允许/禁止依赖 | 包命名与包边界的**唯一权威** | BASELINE、02/03 | FROZEN（v1.1 / ADR-013） |
| `dependency-graph.md` | 分层、允许/禁止方向、环禁令、强制配置设计 | 依赖方向的**唯一权威** | BASELINE、02 §2.3 | FROZEN（v1.1 / ADR-013） |
| `README.md`（本文件） | 文档索引、权威级别、废弃名对照 | 索引 | — | CURRENT |
| `01-overview.md` | 五公理、分层架构、CQRS 双通路、部署拓扑、反退化清单 | 分层与公理定义 | — | CURRENT |
| `02-modules.md` | 模块职责/边界/接口契约/测试策略 | **接口契约（§2.4）权威**；§2.1/§2.3 命名与规则已被 registry/dependency-graph 取代（见顶部勘误） | 01 | CURRENT（部分被取代） |
| `03-data-model.md` | 组织/关系/权限/记忆/事件/工作流数据模型 + SQL DDL | **数据模型与 DDL 的唯一权威** | 01、02 | CURRENT（含 SCHEMA GAP，见 BASELINE §15） |
| `04-agent-lifecycle.md` | 两层状态模型、六阶段装配流水线、封闭 Action Space、学习闭环 | Agent 生命周期权威 | 03 | CURRENT |
| `05-runtime.md` | 10 阶段认知循环、授权闸门、检查点恢复、调度唤醒、成本模型 | Runtime 行为权威 | 02、04 | CURRENT |
| `06-mvp-scope.md` | MVP 范围/不做的清单、8 周里程碑、12 条验收标准 | 范围权威 | 01–05 | CURRENT |
| `07-roadmap.md` | 未来扩展（组织演化、多公司、经济系统）与项目红线 | 非约束性规划 | 06 | CURRENT |
| `08-adr.md` | 14 条架构决策记录 + 复审触发条件 | 决策历史权威（ADR-001…014） | 各 Phase | CURRENT |
| `M1.0-organization-control-plane.md` | M1.0 控制面：复用裁定、最小新增、Command/Event/Audit/Query 契约、已知限制 | M1.0 实现契约（从属 BASELINE/registry/dependency-graph） | BASELINE、registry、dependency-graph、ADR-013 | CURRENT |
| `M1.4-collaborative-work-orchestration.md` | M1.4 协同工作编排：任务书 → CEO 拆解 → 按岗位派发；唯一人类工作入口；ADR-014 | M1.4 设计契约（从属 BASELINE §17；ADR-014 已接受，2026-10-05，实现按 §17 顺序） | BASELINE、04 §4.4、05、06、M1.0 | CURRENT |
| `M1.5-identity-company-ownership.md` | M1.5 身份与 AI 公司所有权：Founder 拥有 Organization、Organization 雇佣 Agents；建司流程、每公司独立事件日志、运行时切换与控制台 gate | M1.5 实现契约（从属 BASELINE / registry / dependency-graph / M1.0） | BASELINE、registry、dependency-graph、M1.0、03 §3.13 | CURRENT |
| `M1.6-position-authoring-capability-workflows.md` | M1.6 岗位作者化与能力工作流生成：`Agent.Create` 内联新建岗位（部门+职位名+能力标签）、能力词表与「永不按名字」的岗位解析、生成式工作流与重启再生、认知提示约定 | M1.6 实现契约（从属 BASELINE / registry / dependency-graph / M1.0、04 §4.10、03 §3.2.1） | BASELINE、registry、dependency-graph、M1.0、04、03 | CURRENT |
| `M1.7-llm-provider-config.md` | M1.7 LLM 真实模型接入与配置：环境变量契约、配置归属裁定、DeepSeek 三个必须显式处理的行为（thinking 吞 temperature / JSON 空返回归为 provider 失败 / 错误码映射）、重试的归属与预算·账本不变式、**能力上限不因换模型而变**的澄清 | M1.7 实现契约（从属 BASELINE §9 F6 / A4 / ADR-008、05 §5.5、02 §2.5） | BASELINE、registry、dependency-graph、05、08-ADR、M1.0 | CURRENT |
| `../research/research-brief.md` | 同类项目对照、记忆架构、持久化执行、多 Agent 失败模式研究（带引用） | 研究参考，非约束 | — | CURRENT |
| `../review/architecture-review.md` | 对抗性评审：4 阻断 / 14 重要 / 9 矛盾 / 12 遗漏 | 评审证据（其发现已并入基线） | 01–08 | CURRENT |
| `../review/revision-log.md` | 评审逐条处置 + 已知遗留清单 | 遗留项权威 | review | CURRENT |
| `../review/M1.6-capability-collaboration-report.md` | M1.6 后半段验收报告：动手前自检（三处真实缺口）、能力词表新增 frontend/backend、员工级 `expertise` 双路线匹配、专长的命令/事件/回放链路、四条验收逐条对照 | M1.6 half-two 验证记录（从属 M1.6 契约） | M1.6、BASELINE | CURRENT |
| `../review/startwork-visible-outcome-fix.md` | 「任务书 → 开始工作」无可见结果的可见性修复：结果块常驻按钮下方、命令失败显示真实原因、e2e probe 升级为验收门 | 前端交互验证记录（不含后端契约变更） | M1.4、M1.0 | CURRENT |
| `../review/role-agents-cannot-complete-tasks.md` | 根因诊断：「大多数岗位 Agent 完不成任务」——任务书绕过能力路由派到空坑（A）、空坑任务无人唤醒的静默死锁（B）、自由文本验收键被当作内容契约（C）；含真实事件日志证据与三条候选路线 | 诊断证据与待决设计（A 已修，B/C 路线待用户裁定） | M1.4、M1.6、registry、ADR-014 | CURRENT |

---

## 2. 废弃名称对照（Deprecated — 禁止再引用）

以下名称曾出现在过期的审计清单/早期草稿中，**仓库中从未存在对应文件**。引用它们视为文档错误。

| 废弃名称（不存在） | 现行对应 | 说明 |
| --- | --- | --- |
| `docs/architecture/03-package-boundaries.md` | `dependency-graph.md` + `package-registry.md` | 边界规则现拆为「方向」与「逐包清单」两份权威 |
| `docs/architecture/04-agent-runtime.md` | `05-runtime.md`（行为）+ `04-agent-lifecycle.md`（装配/生命周期） | 一份文档拆两份，均为既有文件 |
| `docs/architecture/05-event-model.md` | `03-data-model.md` §3.6（事件模型） | 事件模型从属于数据模型文档 |
| `docs/decisions/ADR/`（目录） | `08-adr.md` | ADR 为单文件 12 条，不设目录 |
| `docs/architecture/09/10/…` 新编号方案 | 无 — 不重编号 | 保留 01–08 编号，禁止移动既有文件 |

**旧包名对照**（完整裁定表见 `package-registry.md` §0）：

```text
shared → shared-types            org-model → organization-model
org-authz → permission-system + authority-engine
org-policy → policy-engine       event-bus → event-system + event-store
memory → agent-memory            tool-gateway → agent-tools
comm → agent-communication       agent-core → agent-definition
runtime-loop → agent-runtime
```

**全局换读裁定（覆盖全部历史文档）**：`03-data-model.md`、`04-agent-lifecycle.md`、`05-runtime.md`、`06-mvp-scope.md`、`07-roadmap.md`、`research-brief.md`、`review/*` 正文中出现的初版包名（`runtime-loop`、`tool-gateway`、`org-authz`、`event-bus`、`comm`、`memory`、`org-model`、`agent-core`、`org-policy`）**一律按上表 + registry §0 换读，历史文档不逐处改写**（评审文档含行号引用，改写会破坏证据链）。涉及**接口签名与依赖规则**的现役权威已迁移至 `02-modules.md` §2.4 / `package-registry.md` / `dependency-graph.md`。

---

## 3. 引用完整性规则

1. 任何文档改名/移动前：`grep -r "<old-name>"` 全仓扫描 → 更新所有引用 → 更新本索引 → 更新 README/AGENTS.md → 最后删除。
2. 新增架构文档必须在本索引登记（Document/Purpose/Authority/Dependencies/Status 五列齐全）。
3. Phase 文档与基线冲突时**不得静默择一**：提 Architecture Change（BASELINE §17）。
4. **行号引用基准**：`review/*` 与 `research-brief` 中的 `02:xxx` / `03:xxx` 等行号引用锚定 **2026-09-30 Reconciliation 之前**的文档版本（02-modules 本轮勘误与 §2.1/§2.3 同步使行号整体偏移）；语义结论仍有效，行号仅作历史定位，不随文档更新回改。
