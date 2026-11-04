# Dependency Graph — 依赖图与强制规则

> **地位**：包间依赖方向的唯一权威。逐包 Allow/Forbidden 清单见 `package-registry.md`。
> 规则全部来自既有架构（01-overview §1.2/§1.4、02-modules §2.3、AGENTS.md Architecture Rules、ADR），本文件只做整合，不新增规则。
> 状态：FROZEN（初版，2026-09-30）

---

## 1. Layer（沿用项目既有层级，不另立体系）

层级名称取自 `01-overview.md` §1.3 分层图与 `02-modules.md` §2.2 分组，不发明第二套。

| # | Layer | 确定性 | 包 |
| --- | --- | --- | --- |
| L6 | **Application（观测与交互层）** | — | `apps/kernel` `apps/api` `apps/projector` `apps/web` · `organization-control`（Control） |
| L5 | **Orchestration（编排层）** | 确定性 | `workflow-engine` `task-system` `decision-engine` `meeting-engine` `escalation-engine` `agent-communication` |
| L4 | **Runtime（运行时层）** | 确定性（执行体） | `agent-runtime` `runtime-state` `runtime-scheduler` |
| L3 | **Agent（Agent 层）** | 概率性（唯一含 Prompt） | `agent-definition` `agent-cognition` |
| L2 | **Organization/Domain（组织层 + 基础类型）** | 确定性、零 LLM、零 I/O | `organization-model` `identity-system` `permission-system` `authority-engine` `policy-engine` `shared-types` |
| L1 | **Infrastructure（基础设施层）** | 机制、无业务规则 | `event-system` `event-store` `persistence` `agent-memory` `agent-tools` `llm-gateway` `knowledge-system` `artifact-system` `audit-system` `observability` `config` |

> 层内无序；**层间依赖只能按下节方向单向**。
> `agent-memory`/`agent-tools`/`agent-communication` 名含 `agent-` 但不属于 L3 — 按本表归层。
> `organization-control` 是 `packages/*` 中唯一的 L6 包（ADR-013）：控制面必须同时驱动 L5 编排与 L4 Runtime，
> 任何 L5/L4 归属都会立即触发既有禁止边，故按 Application 归层；它仍然只允许**向下**依赖，且禁止依赖 `apps/*`（F1）。

---

## 2. Allowed Direction（允许的依赖方向）

```text
L6 Application
  └─→ L5 Orchestration
  └─→ L4 Runtime
  └─→ L3 Agent            （kernel 宿主装配；api 不得依赖 Agent 认知）
  └─→ L2 Organization/Domain
  └─→ L1 Infrastructure

L5 Orchestration
  └─→ L2 Organization/Domain
  └─→ L1 Infrastructure（仅 event-system、shared-types 之下的机制包）

L4 Runtime
  └─→ L3 Agent            （调用认知端口，不拥有 Prompt）
  └─→ L2 Organization/Domain
  └─→ L1 Infrastructure

L3 Agent
  └─→ L2 Organization/Domain
  └─→ L1 Infrastructure（agent-memory、llm-gateway、agent-tools、knowledge-system、artifact-system）

L2 Organization/Domain
  └─→ L2 内部（shared-types 为根；permission → authority 单向）
  └─→ （无 → L1 出口：Domain 保持零 I/O 纯函数）

L1 Infrastructure
  └─→ shared-types
  └─→ L1 内部按 registry（event-store → persistence；audit/observability → persistence/event-system）
```

逐包精确清单以 `package-registry.md` 的 **Allowed Dependencies** 为准；两文件冲突时先停下走 Architecture Change，不得择一。

**层间矩阵（→ = 允许，· = 禁止）：**

| from ↓ \ to | L6 | L5 | L4 | L3 | L2 | L1 |
| --- | --- | --- | --- | --- | --- | --- |
| **L6 Application** | · | → | → | →* | → | → |
| **L5 Orchestration** | · | · | · | · | → | →† |
| **L4 Runtime** | · | · | · | → | → | → |
| **L3 Agent** | · | · | · | · | → | → |
| **L2 Domain** | · | · | · | · | →‡ | · |
| **L1 Infrastructure** | · | · | · | · | · | →§ |

- \* `apps/api` 例外：禁止依赖 L3（API 不跑认知）。`apps/web` 例外中的例外：**禁止依赖一切 `@maoeh/*`**（仅 HTTP/WS 契约）。
- † Orchestration → Infrastructure 仅限 `event-system`（+ 经 shared-types）；**禁止 `persistence` 直连、禁止 `llm-gateway`**。
- ‡ Domain 仅允许 `shared-types` 及 Domain 内部。
- § Infrastructure 仅允许 `shared-types` 及 registry 许可的 L1 内部边。

---

## 3. Forbidden Direction（禁止的依赖 — 逐条附出处）

| # | 禁止 | 出处 |
| --- | --- | --- |
| F1 | `packages/*` → `apps/*`（任何层反向依赖应用） | 02-modules:242「任何层 ⇒ 不得 import apps/*」 |
| F2 | `apps/web` → 任何 `@maoeh/*` 后端包 | 02-modules:243「前后端契约化」 |
| F3 | Domain（L2）→ `agent-*` / `runtime-*` / `*-engine` | 02-modules:238「组织层永远不知道 AI 存在」 |
| F4 | Domain（L2）→ `persistence` / `event-*` / 任何 I/O | 02-modules:72「纯函数领域模型」 |
| F5 | `agent-definition` / `agent-cognition` → `persistence` / `event-system` / `event-store` | 02-modules:239「只能经由 Runtime 注入的端口」 |
| F6 | 除 `agent-cognition` 外任何包 → `llm-gateway` 之上的 Provider SDK | A4（01-overview:36）；`llm-gateway` 是唯一 Egress |
| F7 | `*-engine`（L5）→ `llm-gateway` | 02-modules:240「编排层零 LLM，防止判断被外包给模型」 |
| F8 | `agent-runtime` → Prompt 常量 / LLM Provider SDK / 自行调用 `authority-engine` 判定 | 05-runtime 分界线「Prompt 在哪」；审计 §5 |
| F9 | Agent ↔ Agent 直接 RPC（任何包暴露 `invoke(agentB)` / 持有另一 Agent 引用的方法） | A5（01-overview:37）；02-modules:382「Agent 上没有 sendTo(otherAgent)」 |
| F10 | `organization-model` / `permission-system` / `authority-engine` / `policy-engine` / `identity-system` 之间的环 | Domain 必须可纯函数属性测试（02-modules:76） |
| F11 | `event-system` → `persistence`（信封机制层保持零 I/O） | 02-modules:86「不懂事件语义、机制无业务」+本轮拆分裁定（package-registry §0） |
| F12 | `workflow-engine` / `decision-engine` / `meeting-engine` / `escalation-engine` / `task-system` → `agent-cognition` | F7 的同层延伸：编排层不得触碰 Prompt 层 |
| F13 | `observability` / `audit-system` → 影响主流程控制流的反向依赖 | 02-modules:91「不影响主流程控制流」 |

---

## 4. Cycle Rule

```text
Dependency cycle = forbidden（无例外、无豁免）
```

- 任何 `A → B → … → A` 均为架构违规，即使每条边单独合法。
- Domain 层（L2）额外要求：**层内也无环**（permission → authority 单向是显式设计）。
- 发现环 → 立即停止该功能开发，走 `ARCHITECTURE-BASELINE.md` §17 Architecture Change Process。

---

## 5. Enforcement Design（机器可验证 — 配置设计规格，本轮不落地配置）

> 现状：02-modules:234 要求的强制工具（ESLint `no-restricted-imports` + dependency-cruiser）**尚未安装**（审计 HIGH-4）。
> 本节定义配置的完整规格，M0 第一项工程任务即按此落地；落地前本节规则为**人工评审约束**。

### 5.1 dependency-cruiser（结构级，按 Layer 分组）

```text
规则组（对 .ts/.tsx 源码，排除 dist/、node_modules/）：

no-circular           : 全局启用（对应 Cycle Rule）
not-to-apps           : packages/** 不得 import apps/**（F1）
web-no-backend        : apps/web/** 不得 import 任何 @maoeh/**（F2）
domain-pure           : packages/{organization-model,identity-system,permission-system,
                         authority-engine,policy-engine,shared-types}/**
                        只得 import 同组与 @maoeh/shared-types（F3、F4、F10）
agent-no-io           : packages/{agent-definition,agent-cognition}/**
                        不得 import @maoeh/persistence|event-system|event-store（F5）
orchestration-no-llm  : packages/{workflow-engine,task-system,decision-engine,
                         meeting-engine,escalation-engine,agent-communication}/**
                        不得 import @maoeh/llm-gateway（F7、F12）
single-llm-egress     : 除 packages/llm-gateway/** 外，任何 **/src/** 不得出现
                         openai|anthropic|@google/generative-ai|ollama 等 SDK 依赖或 import（F6）
event-mechanism-pure  : packages/event-system/** 不得 import @maoeh/persistence（F11）
runtime-no-prompt     : packages/agent-runtime/** 不得 import agent-cognition 的 prompts/** 常量（F8）
control-plane-pure    : packages/organization-control/** 不得 import
                         @maoeh/llm-gateway | @maoeh/agent-cognition | @maoeh/agent-runtime | @maoeh/persistence
                         （ADR-013：控制面不是 Runtime、不是 Cognition、不得直连持久化）
no-agent-rpc          : 全局：Agent 类型定义文件不得出现「参数或字段类型为另一 Agent 实例」的方法签名（F9）
```

### 5.2 ESLint `no-restricted-imports`（语句级补充）

- `@maoeh/persistence` 的 import 仅允许出现在 registry 标注允许的包。
- `apps/web`：`no-restricted-imports` paths = `@maoeh/*`。
- 未来加入 Provider SDK 依赖时：`openai`、`@anthropic-ai/sdk` 等仅允许出现在 `packages/llm-gateway`。

### 5.3 测试级强制（架构测试）

- `tests/architecture/`（M0 建立）：跑 dependency-cruiser 作为 CI 任务；A4 测试 = 全仓 `import` 扫描断言；A5 测试 = Agent 类型结构断言。
- CI 顺序：`typecheck → lint → architecture → unit → integration`；任一失败即拒。

### 5.4 违规处置

任何 F1–F13 违规 = **架构回退**（01-overview §1.8），阻断合入；修复方向只有两种：改代码回归边界，或走 Architecture Change 修改本文件。
