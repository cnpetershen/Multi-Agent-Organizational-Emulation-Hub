# MAOEH 今晚实时审计（TONIGHT_AUDIT）

- 审计时间：2026-11-14 18:40–20:15（Asia/Shanghai）
- 审计对象：当前工作区源码（未提交改动）+ 正在运行的 `peter-ai-lab` 公司事件日志 + 一次真实 DeepSeek 隔离实跑
- 原则：源码与真实运行数据优先；README 与历史报告只作为背景，不作为结论依据
- 真实数据位置：
  - 演示公司日志：`%LOCALAPPDATA%\maoeh\future-ai-lab\peter-ai-lab\events.jsonl`（审计前 79,557 条事件）
  - 隔离验证日志：`.maoeh/audit/collaboration/run-2026-11-14T11-40-38-681Z/events.jsonl`（最终代码复跑；`run-2026-11-14T11-06-04-819Z` 为同一链路首次成功）
  - 内容生成证据：`.maoeh/audit/content-studio/run-2026-11-14T11-21-01-751Z/`

> 结论先行：**通信模块本身是完整实现，缺的不是代码，而是"让它真实发生"的三处断点。** 今晚已定位并修复其中两处代码断点，并用真实 DeepSeek 跑通了完整的双 Agent 协作闭环；第三处（运行中的旧构建）已通过重启消除。

---

## 0. 结论速览

| 能力 | 审计前 | 今晚处理后 | 证据 |
| --- | --- | --- | --- |
| 7 个 Agent 定义/职责/权限 | 存在，但 6 个是运行时生成、画像全部相同 | 未改动（记录为不足） | 事件 `Control.AgentCreated` ×6 |
| 认知执行链 | 完整（wakeup → cognition → plan → executor → events → 状态回写） | 增加通信上下文与任务状态机视图 | `run-tick.ts` / `cycle.ts` / `prompts/cognition.ts` |
| Communication 进入运行时 | **未生效**：真实公司 0 条 `Communication.*` 事件 | **已生效**：公司频道已写入日志，隔离实跑真实收发 | `/api/communications`；隔离日志 |
| SendMessage 真实触发 | 只有测试里触发过 | **真实 DeepSeek 触发并完成闭环** | 隔离实跑 verdict 全 true |
| CollaborationRequested | 执行器支持，但动作空间未暴露、且被 `buildPlan` 拒绝 → 真实模型不可能选 | **已修复**：加入 `ACTIONS` + 提示词契约 + 单元测试；未做真实模型复跑 | `packages/shared-types/src/index.ts`；`collaboration-action-space.test.ts` |
| Workflow ↔ Communication 关联 | 有 correlationId，缺 causationId | 已补 causationId，形成可读因果链 | `plan-executor.ts` |
| 一鱼多吃 | 交付页面里是**硬编码模板** | **新增真实 LLM 四平台生成**（API + 页面 + 证据） | `/api/studio`，4 次真实调用 |
| 赛博沙盘 | 纯人工切角色 + localStorage 计分 | **已重建**：4 个真实 Agent 逐轮质询、transcript 来自事件日志、评分引用具体消息 | `/api/sandbox`；`sandbox-session.ts`；`.maoeh/audit/sandbox/` |
| 测试基线 | 163 文件 / 1213 测试，1 失败 | 新增 8 个测试（10+2+1+2+4+6+…见 §11） | `pnpm test` |

---

## 1. 七个 Agent 的真实定义、职责、权限与模型调用

### 1.1 定义来源：不是仓库里的 6 个 YAML

仓库种子 `agents/future-ai-lab/` 只有 6 份 agent 定义（`ceo-alex`、`cto-john`、`engineer-mike`、`marketing-jack`、`pm-bona`、`qa-peter`）。但演示公司 `peter-ai-lab` 是 **starter 公司**（建公司时只保留组织图根节点 = CEO），之后 6 个员工全部是运行时招聘产生的，定义来自 `Control.AgentCreated` 事件而不是 YAML。

真实事件日志里 6 条 `Control.AgentCreated`：

| 员工 | 岗位 | 认知画像 | 专长 | 职责条数 |
| --- | --- | --- | --- | --- |
| `agent-engineer-hire` | agent-engineer | exec-strategic | implementation | 1 |
| `ai-researcher-hire` | ai-researcher | exec-strategic | technical_design | 1 |
| `business-analyst-hire` | business-analyst | exec-strategic | product_requirement | 1 |
| `qa-hire` | qa | exec-strategic | testing | 1 |
| `engineer-hire` | engineer | exec-strategic | javascript / svg / single-file web apps | 2 |
| `marketing-manager-hire` | marketing-manager | exec-strategic | product marketing / GTM / campaign | 2 |

加上启动时就存在的 `ceo-alex`（种子定义，`exec-strategic`），**7 个 Agent 的认知画像全部是 `exec-strategic`**。

**这是一个真实不足，必须在汇报里讲清楚**：7 个 Agent 的"差异"目前只来自提示词里的 responsibilities / expertise 文本、岗位能力标签和权限；它们的推理风格、规划风格、决策框架、反思策略完全一致，且共用同一个模型 `deepseek-flash`。所谓"角色分工"是**组织学意义上的分工**，不是**认知意义上的异构**。

### 1.2 权限

- 默认 Agent 策略 `DEFAULT_AGENT_POLICY`（`apps/kernel/src/simulation/simulation.ts`）按 action × resource 授权；`SendMessage` 授权为 `channel:*`，`DispatchWork` 需要 org 域 authority ≥ 2，`ControlAgent` ≥ 3。
- 岗位 `authority_level` 与 `decision_domains` 来自种子 YAML；演示公司 7 个员工的岗位全部存在，但**除 CEO 外所有员工 `managerEmployeeId` 为 null 的比例很高**（`business-analyst-hire`、`qa-hire`、`engineer-hire` 都是 null），因为演示公司是 starter，组织图里 `reports_to` 的目标岗位当时无人。汇报时不要声称"完整汇报线"。
- 权限校验真实生效：日志中 `Control.CommandRejected` 9 条，说明拒绝路径不是摆设。

### 1.3 模型调用

- 配置：`.env` → `MAOEH_LLM_MODE=live`、`MAOEH_LLM_BASE_URL=https://api.deepseek.com`、`MAOEH_LLM_MODEL=deepseek-flash`、`MAOEH_LLM_THINKING=disabled`。
- `/api/llm` 返回 `{ "mode": "live", "provider": "deepseek", "model": "deepseek-flash" }`，是进程真实状态，不是报告。
- 每个认知周期通过 `LlmGateway` 调用一次（`cognition-executor.ts`），成功后计一次 `liveCallCount`。
- **不存在"每个 Agent 一个模型"**；也没有按岗位区分的模型路由。这是可讲的技术点（统一网关 + 单出口），也是可改进点（异构模型编队）。

---

## 2. Agent Runtime 的完整认知执行链

源码链路（全部为现状，非规划）：

```
Scheduler 到期 → runSimulationTick（apps/kernel/src/simulation/run-tick.ts）
  → 读 cursor 之后的新事件 → eligibleAgentsFor(event) 计算谁被唤醒
    （Task.Assigned / Task.Started / 审批 / Communication.MessageSent / CollaborationRequested）
  → runAgentCycle（packages/agent-runtime/src/cycle.ts）
    → 校验 turn 输入、去重（isProcessed）、employment/预算检查
    → 发 Runtime.CycleStarted（correlation/causation 指向唤醒事件）
    → runAgentCognition（cognition-adapter.ts）→ buildCognitionContext
      → buildCognitionPrompt（system + 状态 + 组织 + 通信 + 工作目录 + 输入事件 + JSON schema）
      → LlmGateway.generate → 解析 → cognitionOutputSchema 校验 → buildReasoning → buildPlan
    → 逐步执行 plan：KernelPlanExecutor（plan-executor.ts）
      → 每个动作映射到既有服务（tasks.* / workflow.* / communication.* / collaboration.* / agents.create）
      → 产生的领域事件进入事件日志
    → 发 Runtime.CycleFinished（outcome / failureCode）
    → replayAgentState 回写状态、标记已处理（失败可重试的动作除外）
```

关键事实：

- **不是"一次 LLM 调用 = 一个动作"**，而是一个周期内最多 8 步计划，逐步执行、遇错即停。
- 失败可重试白名单在 `cycle.ts` 的 `RETRYABLE_COGNITION_ERRORS`（含 `invalid_args`、`invalid_transition`、`provider_error` 等），重试次数受 scheduler 上限约束。
- 每次唤醒的 `Runtime.CycleStarted.causationId` = 唤醒事件 id，这是"谁导致了这个周期"的硬证据。

---

## 3. Communication 是否真正进入运行时

### 3.1 代码层：是，且比预期完整

- `createSimulation` 真实构造 `createCommunicationService`（`simulation.ts`），依赖真实的 `authz`、`identity`、`registry`、`companyId`。
- 计划执行器有 `SendMessage → communication.sendMessage`、`RequestCollaboration → collaboration.requestCollaboration` 两个绑定。
- 送达：`Communication.MessageSent` 由 `runCommunicationDelivery` 投影成交付记录；`eligibleAgentsFor` 会唤醒收件人。
- 通道：`Communication.ChannelOpened` 是事件，恢复时 `projectChannels` 重放。
- 页面：`/api/communications` 读 `Communication.` 前缀事件；`Communications.tsx` 渲染消息 / 通道 / 协作请求 / 事件流。

**所以"通信模块缺失"的旧判断是错的。**

### 3.2 运行时层：审计前是 0

演示公司事件日志共 79,557 条，`Communication.*` 事件数 = **0**。

根因不是一条，而是三条叠加：

1. **启动顺序（真实代码缺陷，已修）**
   `bootstrapCompanyChannel()` 在 `recover()` **之前**执行。starter 公司此时只有 CEO 一个员工，低于通道契约的最小成员数 2，函数静默返回；而 6 个同事是在 `recover()` 重放 `Control.AgentCreated` 时才回到组织里的。结果：公司永远没有频道。
   修复：改为 `recover()` → `bootstrapCompanyChannel()`（`apps/kernel/src/simulation/simulation.ts`）。
2. **提示词缺通道与契约（真实代码缺陷，已修）**
   `SendMessage` 需要 `channelId / recipientIds / body`，而 `CognitionContext` 里没有任何通道或消息信息，提示词里也只有一句动作名。真实模型不可能猜出一个能通过授权的 `channelId`。
3. **运行中的进程是旧构建（运维事实，已消除）**
   演示 API 进程启动于 17:19:48，而 kernel 新构建产物在 17:36 才生成；即使代码已修，进程里跑的仍是旧逻辑。

### 3.3 修复后的真实状态

重启后演示公司日志新增：

```
seq 78975  Communication.ChannelOpened  subject=company-peter-ai-lab
memberIds = [ceo-alex, agent-engineer-hire, ai-researcher-hire,
             business-analyst-hire, qa-hire, engineer-hire, marketing-manager-hire]
```

`GET /api/communications?limit=10` 返回该事件（真实 HTTP，非模拟）。至此"公司有频道、Agent 有可发送的 channelId"才成立。

---

## 4. 真实双 Agent 协作验证（隔离实例，不污染演示数据）

脚本：`scripts/verify-collaboration.mjs`
方式：起一个**独立 API 进程**（端口 3199，`MAOEH_EVENT_LOG` 指向本次运行的独立目录，ownership 走 memory），用真实 `.env` 配置调用真实 DeepSeek，然后通过真实 HTTP 注入任务并观察事件。

### 4.1 任务

`Organization.InjectTask` → 岗位 `cto`，目标：为登录页设计会话方案；**硬性要求先给 `engineer-mike` 发消息请教，收到回复后才能提交**。

### 4.2 实际发生（第二次运行，成功）

```
t0  Task.Created / Task.Assigned（cto-john）
t1  Runtime.CycleStarted cto-john      cause=evt-4（Task.Assigned）
    AcceptTask + SendMessage(request)  → Communication.MessageSent seq=8
t2  Runtime.CycleStarted engineer-mike cause=evt-7（上一条消息）
    SendMessage(response, 含具体方案)  → Communication.MessageSent seq=12
      causationId = evt-7  ← 回复明确"因"于提问
t3  Runtime.CycleStarted cto-john      cause=evt-11（工程师回复）
    StartTask + SubmitReport           → Task.ProgressReported / Task.Completed
```

`report.json` 的 verdict（脚本判定，不是人写死的）：

```json
{"twoAgentsExchanged":true,"requestThenAnswer":true,"answerCausedByRequest":true,
 "taskStarted":true,"taskClosed":true,"eventsPersisted":true}
```

- 两个 Agent：`cto-john`（架构侧）与 `engineer-mike`（实现侧）
- 两条消息同一 `correlationId`；回复的 `causationId` = 提问事件 id
- 任务从 `Task.Created → Assigned → Accepted → Started → ProgressReported → Completed` 全链路
- 最终交付摘要由 CTO 真实撰写（采纳了工程师给出的 Redis session / 12h 绝对过期 / 30min 空闲 / refresh 轮换等具体建议）
- 全程 20 条事件，独立日志可回放

### 4.3 两次独立复跑（同一脚本、同一隔离方式）

| 运行 | 消息数 | 任务 | verdict |
| --- | --- | --- | --- |
| 11:06:04 | 2（request → response） | completed | 6/6 true |
| 11:40:38（最终代码） | 2（request → response） | completed | 6/6 true |

第二次是在**加了 `RequestCollaboration` 动作空间与提示词契约之后**跑的，说明后续改动没有破坏这条链路；脚本可重复执行，每次都产生新的 eventId 与新的模型输出。

第一次运行（约 18:56，未列入上表）暴露了 `invalid_transition` 缺陷，重试 4 次后失败，任务停在 `accepted`；修复后才有了 11:06 的成功。

### 4.4 第一次运行：被任务状态机拒绝，然后被修好

第一次运行时，CTO 在 `accepted` 状态下直接 `SubmitReport`，被任务状态机以 `invalid_transition` 拒绝，重试 4 次（含一次 `malformed_output`）后失败，任务停在 `accepted`，工作流没有闭环。

修复方式不是放宽断言，而是把"这个状态现在允许哪些命令"由内核注入提示词：

- `task-system` 把状态机常量 `ALLOWED_TASK_COMMANDS` 放在状态定义旁并导出 `allowedTaskCommands(status)`；
- `run-tick.ts` 把它写进 `AssignedTaskView.allowedCommands`；
- 提示词按任务逐条渲染 `legal commands in this status: start, reject, cancel`，并说明"不在列表里的命令会被 `invalid_transition` 拒绝，先转移状态再提交"。

复跑即闭环。这条记录说明：**协作链路不是被"调通"的，是被真实跑失败后修出来的。**

---

## 5. Workflow 与 Communication 的事件关联

- 关联键：`correlationId` 全链路一致（任务 / 周期 / 消息），`causationId` 指向直接原因。
- 本次补强：消息发送原先只继承 correlation、`causationId` 为空；现在 `plan-executor.ts` 把 `context.causationId` 传入 `sendMessage`，回复能直接指回"它答复的那条消息事件"。
- 存在的语义缺口：`RequestCollaboration` 产生的记录是独立读模型，不与消息线程共享父子关系；页面上是两张表，不是一棵树。

---

## 6. 任务分配、动态调度、协商与失败恢复

- **分配**：`Organization.InjectTask` 支持按岗位路由（`positionId`）或按能力匹配（`requiredSkills`），并记录 `assignmentReason / matchedCapabilities`（task-41 就是这个路径的产物）。
- **动态调度**：scheduler 按事件唤醒，`maxAgentTurns / maxLlmCalls / maxEvents` 预算上限真实生效；`lastTickStatus=idle`、`queueDepth=0` 说明当前无积压。
- **协商**：`CollaborationService` 已实现、执行器已绑定、集成测试已覆盖，但审计时它**根本不可能被真实模型选中**：
  - `RequestCollaboration` 不在 `ACTIONS` 里，提示词从不列出它；
  - `buildPlan` 对不在 `ACTIONS` 的动作直接返回 `invalid_plan` —— 即使模型猜到了，也会在执行器之前被拒。
  真实日志里 `Communication.CollaborationRequested` = 0，是这条链路的唯一可能结果。
  今晚已修：加入 `ACTIONS`、在提示词中给出 `{toAgentId, taskId, purpose}` 契约与"何时用消息、何时用协作请求"的区分，并用单元测试锁定（`collaboration-action-space.test.ts`）。**尚未用真实模型复跑验证它真的会选**，这是下一步。
- **失败恢复**：可重试错误白名单 + scheduler 重试上限；`Control.CommandRejected` 9 条；本轮实跑中 4 次 `invalid_transition` 重试后由新提示词修复。**没有自动重分配（reassignment）策略**：`Control.TaskReassigned` 只有 1 条，且是人工控制命令。

---

## 7. 一鱼多吃的真实生成方式（审计结论：模板，不是 LLM）

### 7.1 交付物里的实现

任务 `task-32`（instance-12「自媒体 一鱼多吃 多模态内容一键生成看板」的 Implementation）交付的 `index.html` 中：

```js
function generateAssets(source, platforms){
  return platforms.map(p=>{
    const brief=source.trim().slice(0,60);
    if(p==="xiaohongshu")return {..., text:"【"+brief+"】\n\n3 个让你效率翻倍的小技巧：..."};
    if(p==="douyin")return {..., text:"口播（30 秒）：\n停！别再手动剪播客了。..."};
    if(p==="bilibili")return {..., text:"【脚本】AI 播客剪辑实测\n0:00 痛点..."};
    return {..., text:"标题：10 分钟剪完一期播客..."};
  });
}
```

四个平台的文案是**写死的字符串**，只把源素材前 60 字拼进去；页面没有任何模型调用（无 `fetch`，无 API key）。这正是审计原则里"不允许模板生成冒充 LLM 生成"所指的情况。`apps/api/src/scaffold-deliverables.ts` 的 content board 也是同类模板（`CONTENT_HINTS` 正则选家族）。

### 7.2 今晚新增的真实链路

- 服务：`apps/api/src/content-studio.ts` —— 一份源素材，**逐平台**构造系统提示 + 平台格式契约（小红书 200-350 字 emoji 要点；抖音 30 秒钩子分镜；B站 章节时间轴；公众号 3 个标题 + 400-600 字），调用**同一个 `LlmGateway`**，每个平台一次模型调用。
- API：`POST /api/content/generate`（400 参数错 / 502 模型失败 / 200 带 provenance）。
- 页面：`GET /api/studio`（`content-studio-page.ts`）—— 同源、免构建、无 API key；卡片可编辑、可审核、可导出 JSON/Markdown；顶部 provenance 明确显示 `LLM · deepseek / deepseek-flash · 4 次调用` 或 `模板 · mock`。
- 真实证据（`.maoeh/audit/content-studio/run-2026-11-14T11-21-01-751Z/response.json`）：
  - `provenance=live, provider=deepseek, model=deepseek-flash, calls=4`，耗时 23.6s
  - 四平台长度 443 / 341 / 468 / 821 字；两两 4-gram 最大重合度 0.098 / 0.098 / 0.071（确实是四种写法，不是同一段换皮）

### 7.3 仍未完成

- **真实图片生成：0 条链路**。当前 LLM 网关只有文本 provider，没有图像模型接入；不要在任何材料里声称"图片已生成"。
- 交付物里的旧模板页仍然存在（历史 `task-32` 记录不删），新的真实链路是**并列新增**，旧任务不会被追溯改写。

---

## 8. 赛博沙盘：从人工外壳到真实会话

### 8.1 审计时的事实（task-41 / task-44 / task-10）

| 任务 | 真实状态 | 事实 |
| --- | --- | --- |
| `task-41` 商业项目「赛博沙盘」模拟多角色对抗质询系统 | **accepted**（从未开始） | 独立派发给 `engineer-hire`，无 workflow 实例；`eventCount=3`；`createdAtSim=63048`，`completedAtSim=null`；停在此状态超过 1.3 万 sim tick |
| `task-44` Implementation（instance-14「赛博沙盘: 多角色对抗质询系统 workflow」step-3） | **completed** | 但 `result.data` 只有一个 `implementation_report` 文本（950 字），**没有可运行文件**；工作流把"写了报告"当成了"实现了产品" |
| `task-10` Technical design for self-contained Snake game | **started**（从未完成） | 派发给 `ai-researcher-hire`，`completedAtSim=null` |

补充事实：

- `instance-14` 工作流状态 `completed`，`task-46`（Marketing，CEO 执行）和 `task-47`（marketing-manager 执行）都已完成，但**没有任何沙盘运行时会话事件**。
- 唯一"能跑"的赛博沙盘是 `apps/web/public/sandbox.html`（已在 20:36 归档到 `docs/competition/legacy/sandbox-manual.html`，不再由 Web 提供）：4 个写死的角色（提案方/质询方/答辩方/评审），**必须人工逐条输入、人工点"下一位"**；评分是前端按"发言数 + 质询×2 + 答辩×2 + 裁决×3 + 关键词命中×2"算出来的字数分，不是模型评审；数据只存 localStorage。
- 结论：**审计当时，赛博沙盘是一个"演示外壳"，不是"多 Agent 对抗质询系统"。**

### 8.2 今晚重建的真实会话（已完成）

新增 `apps/api/src/sandbox-session.ts` + `/api/sandbox`：会话跑在**独立组装运行时 + 独立事件日志**（`<stateDir>/sandbox/events.jsonl`），不写入演示公司日志。

- **角色来自真实组织**：按岗位能力选座——`technical_design` 提案、`testing` 质询、`implementation` 答辩、根岗位评审。演示种子下实际选中 CTO John / QA Peter / Engineer Mike / CEO Alex，姓名、岗位、职责全部来自真实定义。
- **每条发言都是真实消息**：经 `CommunicationService.sendMessage` 授权与成员校验，写入 `Communication.MessageSent`，并真实投递（delivery 记录）。transcript 就是这些事件，不是另建的数组。
- **评分有依据**：评审 Agent 返回 JSON，每个维度带 `score + evidence + messageId`；解析器会校验 `messageId` 是否真的存在于本次会话，不存在的标为"未引用具体发言"，不假装有据。
- **可保存回看**：会话索引（`sessions.json`）+ 事件日志；`GET /api/sandbox/sessions` / `/:id` 从日志重建 transcript 与评分。

真实运行（`.maoeh/audit/sandbox/run-2026-11-14T11-50-50-260Z/`，真实 DeepSeek，`rounds=1`）：

| # | 角色 | Agent | 消息 | 内容要点 |
| --- | --- | --- | --- | --- |
| 1 | 提案方 | John (CTO) | `msg-1` | 主张定位为「面向高校的多 Agent 课程实验平台」，给出用户/机制/最不确定的假设 |
| 2 | 质询方 | Peter (QA) | `msg-2` | 指出最弱假设是"课程实验模板可拆成可复用任务"，要求证据 |
| 3 | 答辩方 | Mike (Engineer) | `msg-3` | 接受质疑、承认目前只是设计假设，给出验证门槛 |
| 4 | 评审 | Alex (CEO) | `msg-4` | `total=80`，4 个维度，**全部引用具体消息**（msg-1/2/3/3） |

- 4 次模型调用 / 10.6 秒；会话内 4 条真实消息，全部同一 `correlationId`
- 20:34 浏览器复跑（headless Edge，真实点击）：4 角色 / 4 条消息 / **78 分 / 4 条评分全部引用具体 messageId**，历史会话可回看；截图与 10 项判定见 `FINAL_STATUS.md` §1.2
- 会话日志：`Communication.ChannelOpened` ×2（公司频道 + 会话频道）、`Communication.MessageSent` ×4
- 演示公司日志：**仍只有 1 条** `Communication.ChannelOpened`，没有被会话污染（已核对）
- 页面 `http://localhost:3001/api/sandbox`：填议题 → 选回合 → 真实开跑 → transcript + 评分表 + 历史会话

**仍然存在的边界**：会话由编排器驱动轮次（不是内核 tick 唤醒），因为它需要固定发言顺序；同一时刻只跑一个会话；没有并发/队列；评分格式不合规时保留原文并标注"未解析"，不重试。

### 8.3 收尾：把两个"卡住的历史任务"真正结掉（20:14）

演示公司当时还有两个从未闭环的任务。处理方式都是产品自身的控制面命令，只追加事件、不删除历史：

| 任务 | 处理前 | 处理 | 处理方式与证据 |
| --- | --- | --- | --- |
| `task-10` Technical design for Snake | `started`（sim 6833 起未动） | **completed** | 根因：开始任务后的同一周期提交失败、之后再未被唤醒。用 `Agent.Instruct` 让其续做并提交（`ctrl-evt-129` → `Task.ProgressReported` → `Task.Completed`，sim 81483），产物含必需键 `technical_design_doc` |
| `task-41` 商业项目「赛博沙盘」 | `accepted`（sim 63048 起未动） | **cancelled** | 由 `/api/sandbox` 真实会话引擎取代；`Task.Cancel` 记录 `Task.Cancelled`（seq 82585，`from: accepted`，理由写明"superseded by the real sandbox session engine"）+ `Control.TaskCancelled`（seq 82586） |

处理后：38 个任务 = 32 completed + 6 cancelled，**未闭环 0**；两名 assignee 的 `currentTaskId` 均已释放。

顺带记录一个 UI 判断问题：`deliveryProjects` 按标题去重，保留"更完整"的项目；当同名的**已完成**项目存在时，一个**尚未开始**的同名项目会被隐藏（task-41 就是这样在项目页不可见的）。演示数据现在全部终结，该分支暂时不会触发，但逻辑上应改为"进行中优先"。本次未改动该 UI 逻辑。

---

## 9. API、事件查询与前端轮询

| 端点 | 现状 |
| --- | --- |
| `GET /api/snapshot` | 返回 `company/simulation/departments/positions/employees/agents/workflows/tasks/recentEvents/recentAudits`，并在 API 侧校验数组字段契约，违约返回 500 |
| `GET /api/communications?limit=N` | 读 `Communication.` 前缀的最近事件（新→旧） |
| `GET /api/events?prefix=&limit=&includeDeleted=` | 通用事件查询，默认隐藏 tick 标记与已删除工作 |
| `GET /api/tasks/:id` | 含提交结果（summary/data/artifacts） |
| `POST /api/command` | 控制面，幂等 commandId |
| `POST /api/content/generate`、`GET /api/studio` | 今晚新增（一鱼多吃） |
| `GET /api/sandbox`、`POST /api/sandbox/session`、`GET /api/sandbox/sessions[/:id]` | 今晚新增（赛博沙盘真实会话；独立运行时与日志） |

前端轮询：`apps/web/src/App.tsx` 的 `POLL_INTERVAL_MS = 2500`，所有页面通过 `useJson(..., refreshToken)` 复用同一轮询 token。**没有 SSE**，也没有必要为了今晚引入。

`Communications` 页面已经能展示：消息（时间/发送方/接收方/主题/正文）、频道（打开者/成员数/类型）、协作请求（发起/接收/任务/目的）、以及原始事件流。**它缺的是"任务交接 + 关键决策"这两个视图**（当前只有协作请求表，没有把任务状态变化与消息并排放在一条时间线上）。

---

## 10. 测试与构建基线

### 10.1 改动前

| 门禁 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 53/53 任务成功（含依赖包 build） |
| `pnpm lint` | ✅ exit 0 |
| `pnpm test`（全量 vitest） | ⚠️ 163 文件 / 1213 测试：1212 通过，1 失败 |
| 失败项 | `tests/integration/preview-runtime-http.test.ts` → `timed out waiting for the preview to start`（66s） |

### 10.2 改动后（最终）

| 门禁 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 53/53 |
| `pnpm lint` | ✅ exit 0 |
| `pnpm architecture:check` | ✅ 10 文件 / 55 测试；dependency-cruiser 全仓 0 违规 |
| `pnpm exec turbo run build --force` | ✅ 33/33 |
| `pnpm test`（最终全量） | ✅ **173 文件 / 1254 测试，全部通过（exit 0）**；前一次同代码全量为 1253/1254（已知预览 flake），失败项单跑 2/2 通过 |
| 已知 flaky | `preview-runtime-http` 在机器高负载的全量并行下超时（60s 窗口），单跑 1.5s 通过；两次全量之间同代码一绿一红，归因环境/负载，非本次改动 |

新增 10 个测试文件、41 个测试（1213 → 1254 正好对上）。另有两处**既有断言随本次行为变更而更新**，不是放宽：

- `tests/simulation/organization-loop.test.ts` 与 `tests/acceptance/runtime-baseline.test.ts` 原本断言 `recovery.eventCount === 1`（旧顺序把公司频道算进了"重放"）。新顺序下重放发生在组建之前，故改为 `0`，**同时新增**"频道确实存在且成员正确"的断言——总断言数增加。

### 10.3 过程中发现并修掉的一个自伤缺陷（值得记录）

给提示词加 `RequestCollaboration` 契约时，我最初写了一个示例 `{"toAgentId": "...", "taskId": "<one of your open tasks>", ...}`。确定性 mock 用正则 `"taskId":\s*"([^"]+)"` 从提示词里取任务 id，于是取到了占位符、而不是真实任务的 id，导致 26 个既有测试失败（`unknown_task`）。

这不是测试脆弱，而是"提示词里不要出现可被解析成真实值的占位符"这一约束此前没有被写下来。修复：契约改成散文描述、不放 JSON 占位符，并在新增测试里加了一条断言——`## Input event` 之前的提示词不得出现 `"taskId":`。**这类问题正是"只跑新增测试就宣布通过"会漏掉的。**

### 10.4 既有工程问题（不影响今晚，已登记）

- `tests/integration/preview-runtime-http.test.ts` 文件本身不是 UTF-8（GBK 编码），全量并行下会因真实子进程启动慢而超时；单跑 1.4s。建议单独分组或提高该文件超时，**不要改断言**。
- `turbo` 本地缓存曾把 `apps/api` 的旧 `dist` 判为命中（`pnpm build` 报 FULL TURBO 但产物缺新路由）。验证运行时行为前必须确认 `dist` 含新代码；必要时 `turbo run build --force`。

---

## 11. 今晚改动清单（可回滚）

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `packages/agent-cognition/src/context/cognition-context.ts` | 新增可选 `CommunicationView`、`AssignedTaskView.allowedCommands` | 纯增量，可选字段 |
| `packages/agent-cognition/src/context/build-context.ts` | 透传 `communication` | 透传 |
| `packages/agent-cognition/src/prompts/cognition.ts` | 新增 `## Communication` 段；任务状态附带合法命令；补"收到答复就提交、不要为致谢再发消息"规则 | 提示词变长，已用测试锁定关键约束 |
| `packages/agent-cognition/src/index.ts` | 导出新类型 | 公共 API 增量 |
| `packages/agent-runtime/src/{cognition-adapter,cycle}.ts` | 透传 `communication` | 透传 |
| `apps/kernel/src/simulation/communication-view.ts` | 新增：按成员过滤、最近 N 条、正文截断的只读投影 | 新文件，不改服务 |
| `apps/kernel/src/simulation/run-tick.ts` | 每周期构造通信视图 + 任务合法命令 | 只读现有服务 |
| `apps/kernel/src/simulation/simulation.ts` | **启动顺序**：先 `recover()` 再 `bootstrapCompanyChannel()` | 影响所有公司启动；已有 starter 回归测试 |
| `apps/kernel/src/simulation/plan-executor.ts` | 发送消息时传 `correlationId/causationId/traceId` | 只补因果字段 |
| `packages/task-system/src/{task-types,task-service,index}.ts` | 状态机常量迁到 `task-types` 并导出 `allowedTaskCommands` | 常量搬家，行为不变 |
| `packages/shared-types/src/index.ts` | `ACTIONS` 加入 `RequestCollaboration` | 动作空间扩大；`buildPlan` 不再拒绝它 |
| `apps/api/src/content-studio.ts` | 新增：真实多平台生成服务 | 新文件 |
| `apps/api/src/content-studio-page.ts` | 新增：一鱼多吃工作台页面 | 新文件 |
| `apps/api/src/sandbox-session.ts` | 新增：赛博沙盘会话引擎（独立运行时、真实消息、引用式评分） | 新文件；不写演示日志 |
| `apps/api/src/sandbox-page.ts` | 新增：赛博沙盘工作台页面 | 新文件 |
| `apps/api/src/composition.ts` | 暴露 `gateway` 供沙盘借用；新增沙盘独立运行时（`<stateDir>/sandbox`） | 惰性创建，失败回退内存 |
| `apps/api/src/{api-adapter,composition}.ts` | 新增 `/api/sandbox*` 路由与端口 | 新路由 |
| `apps/api/src/{api-adapter,composition}.ts` | 新增 `/api/studio`、`/api/content/generate` 与端口 | 新路由 |
| `scripts/verify-collaboration.mjs` | 新增：隔离环境真实协作验证 | 只读演示数据 |
| 新增测试 6 个文件 | 见 §11 | — |

**未触碰**：`CommunicationService`、事件存储、权限策略、种子数据、演示日志中的既有事件、任何密钥。

---

## 12. 当前最值得做的三个任务

按"收益 / 风险 / 今晚可完成性"排序：

### 今晚已完成：赛博沙盘重建为真实多 Agent 质询会话

- 已实现：`sandbox-session.ts` + `/api/sandbox`，4 个真实 Agent 逐轮发言，消息经真实服务落事件日志，评审给出引用式评分，会话可回看。
- 已验证：真实 DeepSeek 跑通 1 轮（4 条消息 / 10.6s / 评分 80，4 个维度全部引用具体消息）；6 个引擎测试 + 5 个 HTTP 契约测试通过。
- 仍需补强：多轮（≥3）压力验证、并发会话队列、评分不合规时的重试、浏览器端截图。

### 任务 A：协作剧场（Communications 页面）升级为"任务时间线"（最高性价比）

- 做法：在现有页面把 `Communication.MessageSent`、`Task.*`、`Workflow.*`、`Runtime.CycleStarted/Finished` 按 `correlationId` 聚合，一条时间线显示"谁把哪个任务交接给谁、关键决策是什么"，继续用 2.5s 轮询。
- 收益：让老师**在 UI 里直接看到**今晚验证的那条链路，而不是听口头描述。
- 风险：低（纯前端读模型组合），需要一个聚合函数 + 测试。
- 建议：明天第一优先，1-2 小时。

### 任务 B：收敛"实现类交付"的断言（质量型）

- 背景：`task-44` 只交了一份 `implementation_report` 就把「赛博沙盘 Implementation」标记完成，工作流随之完成，但没有任何可运行文件。执行器已有"实现类任务必须有文件或 artifact"的检查，但该检查依赖 `task.capability === 'implementation'`，而生成式工作流的步骤任务未必带这个字段。
- 做法：让工作流生成时把步骤 capability 写到任务上（或在执行器里用工作流步骤的 capability 兜底），并补一个"只有 implementation_report 的实现步骤不能完成"的集成测试。
- 收益：直接消灭"完成但没产品"这类最伤可信度的情况。
- 风险：中低，属于行为收紧，必须单独一轮全量回归。

### 任务 C：认知异构 + 沙盘增强（能力型）

- 认知异构：为 4 类角色设计不同画像与工具策略，让"多角色"在推理层面也成立（当前 7 个 Agent 画像全是 `exec-strategic`）。
- 沙盘增强：≥3 轮压力验证、会话并发队列、评分解析失败时的重试、把沙盘会话接进协作剧场时间线。
- 图片链路：接一条真实图像生成（当前只有文本 provider），否则一鱼多吃只能讲图文。

**实施建议**：A 立刻做（低风险、直接可见）；B 与 A 并行；C 是省赛前的主线，放到明天白天。

---

## 13. 未完成 / 未验证（必须如实说明）

**未完成**

- 图片生成链路（无图像模型）。
- 音频、视频生成。
- 协作剧场的"任务交接 / 关键决策"时间线视图。
- 沙盘增强：≥3 轮压力验证、并发会话队列、评分解析失败重试、把沙盘会话并入协作剧场。
- 认知异构：7 个 Agent 的认知画像仍然相同。
- 新 Agent 加入后的频道成员更新（当前只在启动/形成时确定；运行中再招人不会自动进频道——需要 `Channel.MembersChanged` 之类的补充事件，属于设计题，今晚没做）。

**未验证**

- 沙盘在浏览器中的实际渲染与交互（页面本身通过 HTTP 200 与契约测试验证，但没有真实浏览器截图）。
- 沙盘多轮（2-3 轮）真实模型运行的稳定性（只跑了 1 轮真实会话）。
- `RequestCollaboration` 由真实模型自主选择（动作空间与契约已修，但没做真实复跑）。
- 浏览器端 E2E（`tests/e2e/*.mjs`）与截图。
- 演示公司 `peter-ai-lab` 上的一次真实协作（为避免污染演示数据，故意只在隔离实例验证；频道已就绪，可由操作者亲自触发）。

---

## 14. 附录：证据索引与复现命令

隔离协作证据：

```
.maoeh/audit/collaboration/run-2026-11-14T11-40-38-681Z/   ← 最终代码复跑（2 条消息，任务完成）
.maoeh/audit/collaboration/run-2026-11-14T11-06-04-819Z/   ← 同一链路首次成功
  events.jsonl     真实事件（含 MessageSent、Task 全生命周期）
  report.json      机器判定 verdict + 消息正文 + 周期因果
  summary.md       人读摘要
  api.log          API 进程日志（含每次模型原始输出）
```

内容生成证据：

```
.maoeh/audit/content-studio/run-2026-11-14T11-21-01-751Z/
  request.json / response.json / summary.json
```

赛博沙盘证据：

```
.maoeh/audit/sandbox/run-2026-11-14T11-50-50-260Z/
  request.json / response.json / summary.json   真实 4 角色会话 + 引用式评分
%LOCALAPPDATA%\maoeh\sandbox\events.jsonl       会话的独立事件日志（4 条 MessageSent）
%LOCALAPPDATA%\maoeh\sandbox\sessions.json      会话索引（transcript 仍以日志为准）
```

复现：

```powershell
# 真实双 Agent 协作（隔离，不碰演示日志）
node scripts/verify-collaboration.mjs --port 3199 --timeout 240

# 一鱼多吃工作台
# 浏览器打开 http://localhost:3001/api/studio

# 赛博沙盘
# 浏览器打开 http://localhost:3001/api/sandbox
```
# 门禁
pnpm typecheck
pnpm lint
pnpm vitest run tests/architecture
pnpm test
```
