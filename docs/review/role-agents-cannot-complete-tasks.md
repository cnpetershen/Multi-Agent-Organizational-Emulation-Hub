# 根因诊断 · 「大多数岗位 Agent 完不成任务」

> 现象：控制台里**只有 CEO 在真正干活**，其他岗位的 Agent 从不执行；工作项停在"已分配"，
> 但界面显示"任务已创建 / 工作流已完成"，交付页里没有该任务产出的东西。
>
> 结论：**不是 Agent 能力不足，是能力路由被绕过 + 空坑任务无人被唤醒 + 验收键不可执行**。
> 三条根因相互独立、可分别复现，且都能在真实事件日志里看到终态。
>
> 本文只记录**查证过程与证据**，不含修复以外的设计决定。已实施的修复见 §5。

---

## 1. 证据来源

| 来源 | 内容 |
|---|---|
| `%LOCALAPPDATA%\maoeh\future-ai-lab\ss\events.jsonl` | 700 行真实事件日志（公司 `ss`，`seed: starter`，操作员 `user-test`） |
| `%LOCALAPPDATA%\maoeh\companies.json` | `ss` 与 `peter-ai-lab` 的 `seed` 均为 `starter` |
| `scripts/diagnose-events.mjs` | 事件日志任务生命周期汇总（本次新增，诊断工具） |
| `scripts/probe-seats.mjs` · `scripts/probe-routing.mjs` | 用构建产物实测规划/路由结果（本次新增，诊断工具） |

`ss` 公司的真实终态（`scripts/diagnose-events.mjs`）：

```
=== Task lifecycle (per task) ===
task-1 [COMPLETED] who=ceo-alex  title="Implementation"
task-2 [ASSIGNED]  who=agent-engineer  keys=["多用户在线运行"]
task-3 [ASSIGNED]  who=ai-engineer     keys=["多用户在线运行"]

=== per-employee ===
ceo-alex cycles=4 steps=0 assigned=1 started=1 submitted=0 failures=0
```

**18 个岗位、只有 1 个员工跑过认知循环。** `task-2` / `task-3` 永远停在 `assigned`。

---

## 2. 根因 A —— 任务书绕过能力路由，按"最闲的坑"派活，派到了空坑

### 事实

`task-2` / `task-3` 的 `Task.Created` 事件：

```
task-2  assignment: { kind: "position", positionId: "agent-engineer", assigneeEmployeeId: null }
task-3  assignment: { kind: "position", positionId: "ai-engineer",    assigneeEmployeeId: null }
```

两个坑**都没有人**（`starter` 种子只保留根岗位 CEO）。派活者却是 CEO 自己的规划步骤
`DispatchWork`，而规划里的坑位是这样选出来的——旧实现按「负载最低」排序取前两个：

`apps/api/src/deterministic-cognition.ts`（修复前）：`dispatchSeats()` 从
`## Work catalog` 的 **全部 15 个岗位**里取 `open tasks` 最小的两个，同分按 `positionId`
字典序。新建公司所有坑负载都是 0，于是**字母序最靠前的两个空坑**胜出。

用构建产物实测（`node scripts/probe-seats.mjs`）：

```
starter roster  : ceo-alex@ceo
positions       : 15
=== plan steps ===
DispatchWork {"positionId":"agent-engineer", ...}
DispatchWork {"positionId":"ai-engineer", ...}

dispatched seats => staffed? agent-engineer:VACANT, ai-engineer:VACANT
```

与真实日志的 `task-2` / `task-3` **逐字一致**。

### 为什么这是"违反契约"而不是"设计选择"

根 `README.md` §项目规则、`AGENTS.md`、以及 `packages/organization-model/src/capability/vocabulary.ts`
开头的模块注释都写着同一条铁律：

> 路由是 **capability → position，永不按岗位名字匹配**

而 `dispatchSeats()` 既不读能力、也不看坑里有没有人——它读的是**负载与字典序**。
`matchCapabilityCandidates()` / `resolveCapabilityAssignments()`（真正的路由器，含空坑升迁）
在仓库里已经存在且被 mandate 路径使用，**工作书路径从来没有调用它**。

---

## 3. 根因 B —— 派到空坑的任务，没有任何人被唤醒（静默死锁）

即使坑位解析出 `assigneeEmployeeId: null`，系统也没有任何补救：

| 环节 | 文件:行 | 行为 |
|---|---|---|
| 派发时 | `task-system/src/task-service.ts:580` | `assigneeEmployeeId = holder === null ? null : holder.id`（空坑 → `null`，**合法**） |
| 唤醒时 | `kernel/src/simulation/eligibility.ts:182` | `Task.Assigned` 分支：`if (assignee === null) return [];`（**不唤醒任何人**） |
| 工作流步进 | `workflow-engine/src/workflow-engine.ts:511` | `assigneeEmployeeId === null` → `invalid_definition` 报错、`settleSubmitted` 回滚 |
| 独立派发 | `plan-executor.ts` 的 `tasks.dispatch` | **不走** `workflow-engine`，所以连这条报错都没有 |

**关键差别**：工作流步进（`Workflow.StepEntered` 造任务）会因空坑**失败并回滚**，
所以问题立刻可见；而 `DispatchWork` 建的是**独立任务**（`workflowInstanceId: null`），
它一路顺利地把任务写成 `assigned`，只是**永远没有人拿到它**——没有任何事件、没有失败、
没有重试、没有告警。

这解释了用户看到的三种"看起来成功"：
- 控制台 `Start Work` → 结果块显示"任务已创建 + taskId"（前端确实是对的，任务真的建了）；
- `Tasks` 页能看到这两张卡片，状态 `assigned`；
- 交付页永远空 —— 因为没有人提交过结果。

---

## 4. 根因 C —— 「验收键」被当成内容契约，交付物结构上不可能合格

`Control.WorkBriefed` 的 `verificationKeys` 是**自由文本**，`task-2` 里是 `"多用户在线运行"`
（一句验收要求，不是字段名）。旧实现把它原样当作
`Task.verification.requiredOutputKeys` 传给 `DispatchWork`。

于是 `apps/api/src/deterministic-cognition.ts` 的交付塑形逻辑选择"按名字逐键作答"分支
（`requiredOutputKeys.length > 0`），产出：

```js
{ "多用户在线运行": "多用户在线运行: <目标文本>" }   // 纯散文，artifacts: []
```

**永远不会**产出 `content` / `entrypoint` / `.html`，因为那不是被要求的键。
判定侧只检查键**存在**（`workflow-engine/src/workflow-verification.ts:20`），
所以这条任务即使有人执行，也会"通过验收"却交出与游戏无关的一句话——
这正是用户上一次看到的"只有一系列步骤、游戏没写出来"的同族缺陷。

---

## 5. 已实施的修复：工作书改为走能力路由

**改动 1 处、文件 1 个**：`apps/api/src/deterministic-cognition.ts` 的
`Control.WorkBriefed` 分支，从「自选两个坑位 + `DispatchWork`」改为
「分析目标文本得到能力 + `CreateProposal` 交给内核路由器」。

```diff
- const seats = dispatchSeats(workCatalogSeats(request.prompt), positionId);
- steps: seats.map(seat => ({ action: 'DispatchWork', args: { positionId: seat.positionId, ... } }))
+ const needed = requiredCapabilitiesFor(briefGoal);
+ steps: [{ action: 'CreateProposal', args: { capabilities: [...needed], title, goal } }]
```

`dispatchSeats` / `workCatalogSeats` / `FALLBACK_DISPATCH_SEATS` 及 `CatalogSeat` 类型一并删除
（不再有人按负载选坑；`DispatchWork` 本身仍留在封闭 Action Space 里供直接规划使用）。

### 修复后的实测（`node scripts/probe-routing.mjs`）

```
=== brief plan ===
CreateProposal {"capabilities":["implementation","frontend","backend"],
                "title":"开发一个俄罗斯方块程序","goal":"前端Web SPA 后端用python，…"}

LAB (full roster): plan =
  implementation -> engineer (STAFFED, will execute)
  frontend       -> engineer (STAFFED, will execute)
  backend        -> engineer (STAFFED, will execute)

STARTER (CEO only): plan = NO WORKFLOW
  (no staffed seat declares any requested capability)
```

- **有人的公司**（`lab` 种子）：任务书现在落到真正能干的 `engineer-mike` 身上，
  并且经覆盖 `engineer-mike` 的验收测试
  `tests/acceptance/game-mandate-deliverable.test.ts` 验证（该测试一直用 lab 种子，所以此前掩盖了本缺陷）。
- **只有 CEO 的公司**：`resolveCapabilityAssignments` 返回空 → 不建工作流 → **不会再产生
  派到空坑、永远卡住的任务**。但也就**什么都不会被生产**（见 §6）。

---

## 6. 尚未修：只有 CEO 的公司结构上无法执行任何交付

修复后暴露出的**下一个真实问题**（与根因 B/C 同族，但属设计决定，未擅自改）：

`starter` 公司只有 CEO 一个员工，而所有交付能力（implementation / frontend / backend /
testing / …）都挂在**下级岗位**上。`resolveCapabilityAssignments` 在
「声明的坑全空 → 升迁到最近有人上级」时，被 `workflow-engine.startCapabilities` 传入的
`excludeSeatIds: [actorSeat]` 排除掉 CEO 自己 → 返回空 → 无工作流。

也就是说：**新公司不雇人就永远做不成任何交付**，而 `owned-organization.ts` 的注释明明写着

> Its other agents are hired at runtime through `Agent.Create` and come back from the
> company's own event log on replay.

`Agent.Create` 存在，但**认知层没有任何路径去调用它**（`ACTIONS` 里有 `RecommendHire`，
而 `plan-executor.ts` 的 `PLAN_ACTION_BINDINGS` **没有绑定它** → 发出即 `unsupported_action`，
与上次诊断过的 `ProduceArtifact` 完全同族的"空头支票"）。

三条可选路线（**需要用户决定**）：

| 路线 | 行为 | 代价 |
|---|---|---|
| **A. 空缺即招人**（推荐） | 管理者发现能力坑全空时 `RecommendHire` / `Agent.Create` 招一名员工进坑，由其执行 | `RecommendHire` 需绑定进 `PLAN_ACTION_BINDINGS`；新员工需事件化落盘（`Control.AgentCreated`）；招人应经审批闸门 |
| **B. 空坑升迁给管理者** | 放开 `excludeSeatIds`，坑全空时由管理者亲自执行 | 1 行改动即可恢复"能出东西"，但与管理层"只拆解不执行"的既有设计（W3）冲突 |
| **C. A + 审批链** | 先由管理者招人，招人本身走闸门 | 最贴组织仿真语义，工作量最大 |

---

## 7. 回归风险与测试影响

| 项 | 说明 |
|---|---|
| 修改的测试 | `tests/unit/api/deterministic-cognition.test.ts` 的「work brief decomposition」块：5 条断言旧契约（两个 `DispatchWork`、固定 2 个坑、`requiredOutputKeys`）的用例改为 4 条断言新契约（`CreateProposal`、能力来自目标文本、不需要 catalog、schema 有效） |
| 修改的测试 | `tests/integration/work-briefs-http.test.ts`：断言由「2 个坑 / `requiredOutputKeys` 等于任务书键」改为「能力弧 4 个坑 / 每条都有 `assigneeEmployeeId`」——**后者正是本次缺陷的守卫** |
| 新增测试 | `tests/integration/starter-company-brief.test.ts`（starter 形态，见下） |
| 新增测试夹具 | `tests/helpers/simulation-fixtures.ts` 新增 `definitionsForRosterOnly`：种子磁盘上有 6 名员工的定义，传入手工缩小的组织时必须同步收窄定义来源（`agent-definition` 对「定义了不存在的员工」是整批失败，加载后再过滤已经来不及） |
| 未受影响 | `tests/integration/work-brief-*.test.ts` 多数使用自带 `scriptedCognition`，不经过生产认知 |

### 7.1 先证伪后证实

新增的 `starter-company-brief.test.ts` **确实能抓住这个缺陷**：把生产代码临时改回旧行为后重跑，得到

```
AssertionError: a dispatched item with no assignee is work that will never be done:
  expected [ 'task-1@agent-engineer', …(1) ] to deeply equal []
Error: timed out waiting for the brief to be decomposed into its capability work items
```

即 `agent-engineer` / `ai-engineer` 两个空坑任务复现（与真实日志的 `task-2` / `task-3` 同形），
恢复修复后转绿。**这正是本缺陷长期未被发现的机制**：原有验收测试全部使用 `lab` 种子（有
`engineer-mike`），从未覆盖用户实际使用的 `starter` 形态。

## 8. 门禁结果

```
vitest run                 -> 126 files / 908 tests  全部通过
turbo run typecheck        -> 53/53 successful
turbo run build            -> 33/33 successful
eslint .                   -> 0 errors
```

（本机 DSH 沙箱默认禁止 esbuild 以管道 stdio 起子进程，`vitest`/`turbo`/`eslint` 需放宽沙箱执行；
`tsc` 与 `node scripts/probe-*.mjs` 在默认沙箱内即可运行。）

---

## 9. 路线 A（空缺即招人）的实现清单

用户已选定路线 A。动手前已核实**两个前提都是真的**，但**都不能直接用于 Agent**：

| 前提 | 现状 | 缺口 |
|---|---|---|
| 建岗 + 雇人是**原子命令** | `Agent.Create`（M1.6）支持「已有部门 + 打字输入新职位 + 能力标签」，落 `Control.AgentCreated`，可回放（`tests/integration/agent-create-restart.test.ts`、`position-authoring-http.test.ts` 覆盖） | 入口是**控制面命令**，只对**人类操作员**开放 |
| 新员工能被装配执行 | `materializeAgent` / `projectAgentRoster` 会为新员工生成 Agent 并参与调度 | 需要岗位能力标签与 `Employee.expertise` 由招聘决定，否则新坑仍然匹配不上 |

**两个必须打通的开关（当前都是关的）**：

1. `DEFAULT_AGENT_POLICY`（`apps/kernel/src/simulation/simulation.ts:79`）**没有** `ControlAgent` 授权
   → AI 员工（含 CEO）**无权**调用 `Agent.Create`。要么给管理岗加 `ControlAgent` 授权，
   要么让招聘走 `CONTROL_ACTION_BY_COMMAND` 之外的一条「内部 HR 命令」并由 `AuthzService` 判 L0–L5。
2. `RecommendHire` 在 `shared-types` 的 `ACTIONS` 里（`04-agent-lifecycle.md` 的封闭 Action Space），
   但 `apps/kernel/src/simulation/plan-executor.ts` 的 `PLAN_ACTION_BINDINGS` **没有绑定它** →
   发出即 `unsupported_action`（与 `ProduceArtifact` 同族的"空头支票"）。

**建议的最小实现顺序**（每步都能单独验收，且不破坏现有 908 条测试）：

| 步 | 内容 | 验收 |
|---|---|---|
| A1 | `PLAN_ACTION_BINDINGS` 绑定 `RecommendHire` → 新 binding 产出 `Control.AgentCreated`（经 `AuthzService` 判权限，不是直接写库） | 单测：无权限的岗位被拒（`NEEDS_APPROVAL`/`UNAUTHORIZED`），有权限的岗位产生 `Control.AgentCreated` |
| A2 | 给管理岗（`org` 域 authority ≥ 3，即 CEO/CTO）在 `DEFAULT_AGENT_POLICY` 中加 `ControlAgent`，资源限定为**自己子树内的岗位**；其余岗位仍然拒绝 | 单测：`engineer-mike` 招人必须被拒 |
| A3 | 认知层：`deterministicCognitionText` 在 `CreateProposal` 因「无有人坑」失败后，改为 `RecommendHire{capability}`；招到人后重新 `CreateProposal` | 集成用例：starter 公司提交任务书 → 先出 `Control.AgentCreated`，再出工作流实例，任务落在新员工身上 |
| A4 | 审批：招聘是**花钱/改组织结构**的动作，应经 `Workflow.ApprovalRequested` 闸门（根岗位批准）而非静默执行 | 用例：闸门未批时不得雇人 |
| A5 | 前端：Console 显示招聘事件与原因（"implementation 坑空缺 → 招入 X"） | `tests/e2e/` probe |

**本文件只登记路线，不代替实现。**

---

## 10. 反退化检查清单增补建议

- [ ] **无空坑任务** —— 任何 `Task.Assigned` 若解析不出可执行占坑者，必须在同一 tick 内被
      改派、升迁或显式阻塞（产生事件），不得静默停在 `assigned`
- [ ] **工作书与 mandate 同路** —— 两条入口必须走**同一个**能力路由器，不允许第二套"选坑"逻辑
- [ ] **验收键是字段名，不是句子** —— `requiredOutputKeys` 必须来自结构化契约，
      自由文本验收要求不得直接充当键名
- [ ] **验收测试覆盖真实公司形态** —— 至少一条端到端用例跑 `starter` 种子（只有 CEO），
      因为那是控制台**实际创建**的公司
- [ ] **Action Space 无空头支票** —— `ACTIONS` 里每个动作要么绑定进 `PLAN_ACTION_BINDINGS`，
      要么有测试断言它**没有**出现在提示词中

