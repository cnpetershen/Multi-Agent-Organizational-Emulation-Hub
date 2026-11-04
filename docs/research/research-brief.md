# MAOEH 参考研究简报

> 面向 **Multi-Agent Organizational Emulation Hub (MAOEH)** 的外部参考研究汇编。
> 定位：一个以「组织」为第一性抽象的 **AI 科技公司组织仿真平台**，NPC 是长期存在的 AI 岗位员工 Agent。
> 本文档只服务一个目的：**为 MAOEH 的架构决策提供可追溯的外部证据**，不重复 `docs/architecture/` 的既有设计。
> 引用纪律：第 7 节所有 URL 均由本次研究通过 `web_search` / `web_fetch` 实际访问或经检索索引确认存在；**未核实的链接与论文编号一律不写**，末节附「诚实披露」。

---

## 0. 摘要

1. 同类系统中，**没有任何开源项目同时具备「组织实体 + 权限体系 + 长期记忆 + 可回放事件流」四要素**：Generative Agents / AI Town / AgentSociety / OASIS / Concordia 证明了「大规模社会仿真可行」，MetaGPT / ChatDev / CrewAI / AutoGen / Magentic-One 证明了「角色化任务协作可行」，但两者都把 Agent 当作**任务的参与者**而非**组织的长期成员**——这正是 MAOEH 的空白位与立论点。
2. 记忆架构有一条可直接复用的工程基线：Generative Agents 的 `score = α·recency + α·importance + α·relevance`（α 全为 1）+ `0.995^Δt` 指数衰减 + importance 累加超阈值（150）触发 reflection；Zep/Graphiti 则给出**双时态关系边**（`t_valid` / `t_invalid` 与 `t'_created` / `t'_expired`）与**边失效（edge invalidation）**的工业级参照。
3. 持久化执行不必一开始就上 Temporal：**Postgres-first + 事务性 outbox + Postgres 作业队列（pg-boss / River）+ 自研确定性编排器**足以覆盖 MVP，且与 MAOEH 的 A3（一切状态变更都是事件）天然同构；升级到 Temporal / Restate 的触发条件应被写成**显式量化阈值**而非感觉。
4. 多 Agent 系统最大的风险不是「模型不够强」而是**系统设计问题**：MAST 用 1642 条 trace 归纳出 14 个失败模式、3 大类，7 个 SOTA 框架失败率 41%–86.7%，并证明用 MAST 指导的结构性改动（而非只改 prompt）能带来可测收益（ChatDev **+9.4%**）。
5. 可观测性的成败取决于一个细节：**LangGraph 的 `interrupt()` 在恢复时会让整个节点从头重跑**，因此「人工审批」必须做成**幂等**操作，而 MAOEH 的审批门必须落在内核（确定性代码）而不是 LLM 节点里——这一点同时被 LangGraph 官方文档与 A4 公理印证。

---

## 1. 同类开源项目对照

### 1.1 对照总表

| 项目 | 是什么 | 架构范式 | 证明了什么可行 | 对本项目缺失什么 | 链接 |
|------|--------|----------|----------------|------------------|------|
| **Generative Agents (Smallville)** | 25 个 LLM agent 在一个 Sims 式小镇生活两天的仿真；论文即架构说明书 | 记忆流（memory stream）+ 检索 + reflection + 递归 planning；**无组织概念**，agent 之间是平权社交 | LLM agent 能维持长期一致性，并自发产生信息扩散 / 关系记忆 / 协同（情人节派对）等**涌现社会行为**；消融实验证明 observation / planning / reflection 三者均关键 | 没有公司 / 部门 / 岗位 / 汇报线 / 权限；没有事件溯源；没有人工审批；agent 是「居民」而不是有 KPI 与交付物的「员工」 | [arXiv:2304.03442](https://arxiv.org/abs/2304.03442) · [HTML](https://arxiv.org/html/2304.03442v1) · [ar5iv](https://ar5iv.labs.arxiv.org/html/2304.03442) |
| **generative_agents（官方代码）** | 上述论文的官方可运行实现（reverie 后端 + 沙盒前端） | 单进程 + 本地文件式记忆；认知模块拆分为 retrieve / reflect / plan 等 | 论文架构**可被复现与二次开发**；「记忆流 + 反思」是可落地的工程结构而非纯概念 | 单机文件存储、无并发控制、无权限、无可观测性，**不能作为多员工长期运行的载体** | [github.com/joonspk-research/generative_agents](https://github.com/joonspk-research/generative_agents) |
| **AI Town (a16z)** | MIT 许可的「可部署的 AI 小镇」starter kit，角色在其中生活、聊天、社交 | 游戏引擎（前端渲染）+ 无服务器后端（Convex）+ 独立的 agent 运行进程；**架构分层清晰** | 「仿真世界」与「agent 推理」**可以是两个独立进程**，通过状态存储解耦——这正是 MAOEH 把 Runtime 与 Agent 分开的同类证据 | 无组织模型、无权限、无事件溯源、无审批；偏 demo 而非平台 | [github.com/a16z-infra/ai-town](https://github.com/a16z-infra/ai-town) |
| **AgentSociety** | 大规模 LLM 驱动生成式 agent 的社会仿真平台（含城市、经济、社会网络） | 并行化仿真框架 + 真实环境接入 + 大规模 agent 编排；面向社会科学实验 | **十万级 agent 的社会仿真在工程上可行**；「仿真内核 + 环境适配器」的分离是可持续的架构 | 研究对象是「社会」而非「公司」；无岗位 / 汇报线 / 决策权 / 审批；不可作为组织仿真内核 | [arXiv:2502.08691](https://arxiv.org/abs/2502.08691) · [文档](https://agentsociety.readthedocs.io/en/latest/) |
| **OASIS** | 面向社交媒体的、可扩展到**一百万 agent** 的社交互动仿真器 | 分布式 agent 模拟 + 推荐系统 + 社交图；强调规模与平台机制 | 「平台机制（推荐 / 关注 / 传播）」可以独立于 agent 智能体建模——对应 MAOEH 里「制度 / 流程 / 权限」应独立于 LLM | 无组织层级、无权限域、无审批与决策档案；社交 ≠ 组织 | [arXiv:2411.11581](https://arxiv.org/abs/2411.11581) · [github.com/camel-ai/oasis](https://github.com/camel-ai/oasis) |
| **MetaGPT** | 把「软件公司 SOP」编码进多 agent 框架：产品经理 / 架构师 / 工程师等角色按标准流程产出文档与代码 | **SOP-as-prompt**：预定义角色 + 预定义流程 + 结构化中间产物 | 把**组织分工与流程知识编码进框架**能显著提升复杂任务完成度；结构化产物比自由对话更可靠 | SOP 是**写死的**，不是可演进的制度；无真实权限裁决；Agent 不长期存在；没有事件溯源与组织状态 | [arXiv:2308.00352](https://arxiv.org/abs/2308.00352) · [github.com/FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) |
| **ChatDev** | 「虚拟软件公司」：CEO / CTO / 程序员 / 评审 / 测试等角色通过对话协作完成软件开发 | **聊天链（chat chain）**：阶段化流水线 + 双 agent 对话 | **角色化的公司隐喻**在演示层面极具说服力；是可被第三方系统性评审（含被 MAST 标注）的成熟基线 | 流程固定、角色无持久身份、无权限与升级路径；**被 MAST 实证出大量角色违背与验证缺失**（见 §4） | [arXiv:2307.07924](https://arxiv.org/abs/2307.07924) |
| **CrewAI** | 生产向的多 agent 编排框架：Crews（角色自治协作）与 Flows（确定性流程）双范式 | 「角色 + 任务 + 工具」声明式装配；Crews 走自治，Flows 走确定性编排 | 业界已在实践中把**自治协作**与**确定性流程**拆成两套 API——与 MAOEH「编排层确定性 / Agent 层概率性」的分离一致 | 没有组织实体、没有权限体系、没有员工长期记忆与任期；本质仍是 task pipeline | [docs.crewai.com](https://docs.crewai.com/) |
| **AutoGen / AG2** | 微软的多 agent 对话框架，把 agent 交互抽象为可编程的对话模式 | **Conversable agent + 群聊（group chat）**；以消息传递驱动协作 | 多 agent 对话编排的通用抽象（agent / 消息 / 执行器分离）可复用 | 无组织模型、无权限、无长期身份；Cognition 明确批评其多 agent 架构是「错误的构建方式」（见 §4.3） | [arXiv:2308.08155](https://arxiv.org/abs/2308.08155) · [github.com/microsoft/autogen](https://github.com/microsoft/autogen) |
| **Magentic-One** | 通用多 agent 系统：Orchestrator 带领 WebSurfer / FileSurfer / Coder / ComputerTerminal 等专职 agent | **Orchestrator–workers + 任务账本（task ledger / progress ledger）** | 「用显式账本管理进度与再规划」是抑制无限循环与漂移的有效机制，可直接借鉴到 `workflow-engine` + `runtime-loop` | 面向单次任务而非长期组织；无权限 / 审批 / 组织记忆；同样被 MAST 标注出失败模式 | [arXiv:2411.04468](https://arxiv.org/abs/2411.04468) |
| **LangGraph** | 有状态 agent 编排库：图 + 检查点 + 中断 + 时间旅行 | **图执行 + checkpointer 持久化 + `interrupt()` 人工介入 + time travel** | 「图状态持久化 + 显式中断点 + 可回溯时间线」的工程形态被验证；是「可回放时间线」最接近的现成实现 | 它是**编排库不是组织内核**：没有组织实体 / 权限 / 岗位；且其中断语义有陷阱（节点重跑，见 §5.4） | [Interrupts 文档](https://docs.langchain.com/oss/python/langgraph/interrupts) |
| **Concordia (DeepMind)** | 用于**生成式社会仿真**的库：提供「游戏母版 + 生成式 agent + 可组合的交互组件」 | 组件化：GenerativeAgent / 记忆组件 / 场景（Game Master）三者可自由组装 | 「把 agent 的认知组件做成可插拔模块」比单体 prompt 更可持续；对 MAOEH 的 `agent-cognition` 组件化有直接参考价值 | 定位于学术仿真组件库，无组织 / 权限 / 多租户 / 生产化运行时 | [arXiv:2312.03664](https://arxiv.org/abs/2312.03664) · [github.com/google-deepmind/concordia](https://github.com/google-deepmind/concordia) |
| **Voyager** | Minecraft 中的开放式具身 agent：自动课程 + 可增长技能库 + 迭代提示 | **技能库（skill library）+ 自动课程（automatic curriculum）** | 「**把经验沉淀为可复用、可检索的代码化技能**」优于把一切塞进上下文——直接支撑 MAOEH 的 `Skill` 层与程序性记忆 | 单 agent、单环境；没有组织协作、权限与审计诉求 | [arXiv:2305.16291](https://arxiv.org/abs/2305.16291) |
| **TheAgentCompany** | 把 agent 放进一个**虚拟软件公司**（含 GitLab / OwnCloud 等真实工具）执行真实职务任务的 benchmark | 真实企业工具栈 + 任务评分；**不是架构，而是标尺** | 「用真实公司工具链评估 agent 的职务胜任力」已被确立为评测范式，说明「AI 员工」话题已具备可测量性 | 它是评测基准，**不提供任何组织内核**：无岗位持久状态、无权限模型、无事件溯源 | [arXiv:2412.14161](https://arxiv.org/abs/2412.14161) |
| **TinyTroupe (Microsoft)** | LLM 驱动的**多 agent 人格仿真工具包**：用于头脑风暴、市场调研等「模拟人群」场景 | persona 定义 + 仿真环境 + 可插拔的「世界」；强调 persona 与真实人物的区分 | 「persona 是**可声明、可复用、可组合**的数据而非代码」——与 MAOEH 把 `agents/*.yaml` 当数据的设计同源 | 无组织 / 权限 / 事件溯源；persona 是访谈对象而非承担职责的员工 | [arXiv:2507.09788](https://arxiv.org/abs/2507.09788) · [github.com/microsoft/TinyTroupe](https://github.com/microsoft/TinyTroupe) |

### 1.2 结论性判断

1. **「虚拟公司」这一隐喻已被多次验证，但从未被工程化为组织内核。** ChatDev / MetaGPT / TheAgentCompany 都用了公司隐喻，但公司在其内部表现为**一组角色与流程模板**，而不是**有权限体系、有任期、有制度、有关系网、有记忆的实体集合**。MAOEH 的差异化不在于「又一个多 agent 框架」，而在于**把公司本身建模为第一性对象**。
2. **仿真派（Smallville / AgentSociety / OASIS / Concordia）与协作派（MetaGPT / ChatDev / CrewAI / AutoGen）之间缺少桥梁。** 前者有「社会涌现」但无「职责与权限」，后者有「职责」但是任务级、一次性、无组织状态。MAOEH 处在两派交集，必须同时借鉴：**仿真派的记忆与涌现机制 + 协作派的角色与流程纪律**。
3. **值得直接抄的三个架构模式**：
   - AI Town 的「**仿真世界进程 ⟂ agent 推理进程**」分离 → 对应 `apps/kernel` 与 `apps/projector` 的物理分离；
   - Magentic-One 的「**任务账本 / 进度账本**」→ 对应 `workflow-engine` 的 `InstanceId` + `advance()` 状态机；
   - Voyager 的「**技能库**」→ 对应 `SkillSet` + 程序性记忆，把成功做法沉淀为可复用的确定性工具，而不是每次重新推理。
4. **尚未发现成熟的「AI 员工平台」型开源项目。** 现有工作要么是社会学仿真（无职责与权限），要么是任务级协作框架（无长期身份），要么是评测基准（无内核）。**这意味着 MAOEH 没有可直接 fork 的先例，也意味着它的架构决策必须自己承担举证责任**——这正是本简报存在的理由。

---

## 2. Agent 记忆架构

### 2.1 短期 / 长期与五类记忆

| 层次 | 内容 | 典型载体 | MAOEH 落点 |
|------|------|----------|-----------|
| **工作记忆（短期）** | 当前认知循环的感知、检索结果、当前 Plan 片段 | 进程内 / Redis，带 TTL | `runtime-state` + Redis |
| **情景记忆 episodic** | 「我（在某时刻）经历了什么」——带时间戳的具体事件 | 事件流 + 向量索引 | `memory` + `org_events` |
| **语义记忆 semantic** | 「我知道什么」——从情景中提炼的事实、概念与关联 | 向量库 + 关系图 | `memory` + `Relationship Graph` |
| **程序记忆 procedural** | 「我怎么做」——可复用的流程、技能、成功套路 | 代码化技能 + 模板 | `Skill Layer` + `tool-gateway` |
| **社会记忆（本项目特有）** | 「我和谁是什么关系」——对特定对象的信任、印象、交往史 | 双时态关系边（见 §2.5） | `Relationship Graph` |

> Zep 的论文明确把「原始 episode 子图 + 派生的语义实体子图」的双重存储类比为心理学中**情景记忆 vs 语义记忆**的区分，并以此作为其知识图三层结构（episode / semantic entity / community）的设计依据。这为「情景 + 语义分开存」提供了直接的理论与工程依据。
> 记忆机制的系统性综述见 [A Survey on the Memory Mechanism of Large Language Model based Agents](https://arxiv.org/abs/2404.13501)。

**持久化的判别准则**：能改变未来行为的才值得进长期记忆。MAOEH 的可检验标准是架构文档 §1.8 第 7 条——**每条长期记忆都能回答「我在哪条事件上学到的」**，因此记忆记录必须携带 `source_event_id`。

### 2.2 Generative Agents 的检索打分（可直接复用的基线）

以下为**原文核实值**（来源：`https://ar5iv.labs.arxiv.org/html/2304.03442`，§4.1 Memory and Retrieval；并与 `https://arxiv.org/html/2304.03442v1` 交叉确认）：

**记忆流的数据结构**：原文定义为「a list of memory objects, where each object contains a natural language description, a creation timestamp, and a **most recent access timestamp**」——即 **描述 + 创建时间 + 最近访问时间**三件套。注意 `most recent access timestamp` 是 recency 衰减的基准，因此**每次检索命中都要回写访问时间**。

**三个分项**：

| 分项 | 原文定义与实现 | 关键参数 |
|------|----------------|----------|
| **Recency（新近性）** | 「we treat recency as an exponential decay function over the number of sandbox game hours since the memory was last retrieved」 | **衰减因子 = 0.995**（即 `recency = 0.995 ^ Δt`，Δt 单位为小时） |
| **Importance（重要性）** | 直接让 LLM 输出 1–10 的整数评分，在记忆**创建时**生成一次 | 原文 prompt：*"On the scale of 1 to 10, where 1 is purely mundane (e.g., brushing teeth, making bed) and 10 is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory."* 原文示例：`cleaning up the room` → 2，`asking your crush out on a date` → 8 |
| **Relevance（相关性）** | 「we calculate relevance as **the cosine similarity** between the memory's embedding vector and the query memory's embedding vector」 | 用 LLM 生成文本描述的 embedding 向量 |

**聚合公式**（原文核实）：

```
score = α_recency · recency + α_importance · importance + α_relevance · relevance
其中：recency / importance / relevance 先用 min-max 归一化到 [0,1]，且 α_recency = α_importance = α_relevance = 1
```

原文表述：*"To calculate the final retrieval score, we normalize the recency, relevance, and importance scores to the range of [0,1] using min-max scaling. The retrieval function scores all memories as a weighted combination of the three elements."* 取 Top-K 填满上下文窗口。

### 2.3 反思（reflection）的触发与结构

原文核实要点，**这是一个可直接照抄的机制**：

- **触发条件**：「we generate reflections when **the sum of the importance scores** for the latest events perceived by the agents **exceeds a threshold (150 in our implementation)**」；实际效果是「our agents reflected roughly **two or three times a day**」。
- **反思什么**：用记忆流中**最近 100 条记录**提示 LLM 生成「3 个最显著的高层问题」（`what are 3 most salient high-level questions we can answer about the subjects in the statements?`），再以这些问题作为查询去做检索。
- **产出形式**：让 LLM 抽取 **5 条高层洞察**，并要求**引用证据编号**（格式形如 `insight (because of 1, 5, 3)`），随后解析并连同**被引用的记忆对象指针**一起写回记忆流。
- **反思树**：反思可以以反思为输入，于是形成**树结构**——叶子是基础观察，越往上越抽象。

> **⚠️ 一条被原始论文自己指出的风险**：论文在评估部分报告「the most common errors arose when the agent failed to retrieve relevant memories, **fabricated embellishments to the agent's memory**, or inherited overly formal speech or behavior from the language model」。也就是说，**LLM 生成的高层概括会虚构润色**。对 MAOEH 而言这是致命的（组织事实必须可信），因此：
> 1. **原始观察与 LLM 概括必须物理可区分**（分表或强制 `kind` 字段），且检索结果向 LLM 明示二者来源与可信层级；
> 2. **反思必须携带 `citedMemoryIds`**，使其虚构性可被机器检查（无据可依的反思即为可疑）；
> 3. 语义记忆 / 反思应当**可丢弃、可重生成**，而情景记忆（来自事件）**不可修改**。

**规划的分层粒度**（原文核实）：日计划 → 5–8 个粗块 → **小时级**分解 → **5–15 分钟级**分解。MAOEH 的 `SimClock` 为分钟精度，与此粒度兼容。

### 2.4 向量库选型

| 方案 | 性质（已核实的官方定位） | 优势 | 代价 | 官方链接 |
|------|--------------------------|------|------|----------|
| **pgvector** | "Open-source vector similarity search for Postgres" | 与事件流 / 组织表**同一事务**；单一备份与恢复路径；无额外运维组件；SQL 过滤与向量检索可组合 | 超大规模（亿级向量）下扩展性弱于专用库 | [github.com/pgvector/pgvector](https://github.com/pgvector/pgvector) |
| **Qdrant** | "an AI-native vector search and a semantic search engine"；具备 indexing / quantization / filtering / hybrid queries | 过滤与混合检索能力强，自托管成熟 | 引入独立组件与数据同步问题 | [qdrant.tech/documentation](https://qdrant.tech/documentation/) · [github.com/qdrant/qdrant](https://github.com/qdrant/qdrant/releases) |
| **Chroma** | "Search infrastructure for AI" | 上手最快，适合原型与本地开发 | 生产级扩展与运维成熟度相对弱 | [github.com/chroma-core/chroma](https://github.com/chroma-core/chroma) |
| **LanceDB** | "Developer-friendly OSS embedded retrieval library for multimodal AI" | **嵌入式**（无服务进程），列式格式，适合作为进程内检索层 | 嵌入式形态与「多 worker 共享记忆」的集群语义不天然匹配 | [github.com/lancedb/lancedb](https://github.com/lancedb/lancedb) · [docs.lancedb.com](https://docs.lancedb.com/faq/faq-oss.md) |

**MVP 建议：Postgres + pgvector 单库到底。** 理由：(1) MAOEH 的 A3 要求「事件是唯一真相源」，记忆必须与事件在**同一事务**中落库，跨库会立刻引入一致性缺口；(2) 组织仿真的向量规模（员工数 × 记忆条数）远未到专用向量库的必要门槛；(3) 演进路径清晰——`MemoryStore` 是端口，将来可把检索实现替换为 Qdrant 而不动 `agent-cognition`。**只有在出现「检索 P95 成为瓶颈」或「向量规模超过单库承载」的实测证据时才引入独立向量库。**

### 2.5 关系记忆：Mem0 与 Zep/Graphiti

**Mem0**（[arXiv:2504.19413](https://arxiv.org/abs/2504.19413)，已核实摘要原文）：
- 定位：可扩展的记忆中心架构，从对话中动态**抽取、合并、检索**显著信息；另有**图记忆**变体。
- 已核实的量化结论：在 LOCOMO benchmark 上「Mem0 achieves **26% relative improvements** in the LLM-as-a-Judge metric over OpenAI」；图记忆版本「achieves around **2% higher** overall score than the base configuration」；相对 full-context 方案「Mem0 attains a **91% lower p95 latency** and saves **more than 90% token cost**」。
- 对本项目的意义：**「抽取式记忆 + 合并去重」比「无脑追加」更省 token**；但 Mem0 的记忆是**面向对话的**，不区分「组织事实」与「人际印象」。

**Zep / Graphiti**（[arXiv:2501.13956](https://arxiv.org/abs/2501.13956)、[arXiv HTML](https://arxiv.org/html/2501.13956v1)、[github.com/getzep/graphiti](https://github.com/getzep/graphiti)，均已核实）：
- **这是本简报中最重要的一条参考。** 原文定义了**双时态（bi-temporal）模型**：「timeline `T` represents the chronological ordering of events, and timeline `T'` represents the transactional order of Zep's data ingestion」——即**业务时间**与**入库时间**两条时间轴。
- 边上存**四个时间戳**（原文核实）：「the system tracks four timestamps: `t'_created` and `t'_expired ∈ T'` monitor when facts are created or invalidated in the system, while `t_valid` and `t_invalid ∈ T` track the temporal range during which facts held true. These temporal data points are stored on **edges** alongside other fact information.」
- **边失效（edge invalidation）机制**（原文核实）：「When the system identifies **temporally overlapping contradictions**, it invalidates the affected edges by **setting their `t_invalid` to the `t_valid` of the invalidating edge**. Following the transactional timeline `T'`, Graphiti consistently **prioritizes new information** when determining edge invalidation.」——**不删除、不覆盖，只把旧边标记为失效**，从而同时保留「当前状态」与「关系演化史」。
- **非丢失（non-lossy）**：知识图以非丢失方式增量更新，「maintaining a **timeline of facts and relationships, including their periods of validity**」。
- 检索链路：`f(α) = χ(ρ(φ(α)))`，即 **搜索（余弦语义 + Okapi BM25 全文 + 图 BFS）→ 重排（RRF / MMR / episode-mentions / node-distance / cross-encoder）→ 组装成上下文**；组装出的上下文模板形如 `FACT (Date range: from - to)`——**每次检索都把事实的有效期一并交给 LLM**。
- 已核实的量化结果：DMR **94.8% vs MemGPT 93.4%**；LongMemEval 上 gpt-4o-mini **+15.2%**、gpt-4o **+18.5%**，同时延迟从 **31.3s → 3.20s**、平均上下文从 **115k → 1.6k tokens**。

> **对 MAOEH 的判断**：不要在 MVP 里自建图数据库。但**双时态字段必须从第一天就加**——关系边（汇报线变更、信任变化、协作史）加 `valid_at` / `invalid_at`（模拟时间轴）与 `created_at` / `expired_at`（入库时间轴）。原因：组织仿真里「谁在什么时候向谁汇报」是一个**会随时间变化**的事实，而「回放历史」是 A3 的硬要求；若首版用「直接 UPDATE 关系行」的写法，将来要补双时态就等于重写关系模型（见 §6 结论 2）。

---

## 3. 持久化执行与事件驱动工作流

### 3.1 对比总表

| 方案 | agent 状态持久性 | 人工审批 (HITL) 支持 | 事件总线语义 | 自托管友好度 | MVP 复杂度 | 链接 |
|------|------------------|----------------------|--------------|--------------|-----------|------|
| **Temporal** | **最强**：完整持久化 workflow execution history，崩溃后按历史**重放（replay）**恢复到原位置；「代码即工作流」+ 确定性重放约束 | 强：通过 **signal / update / query** 与 workflow 交互，等待外部输入是原生语义 | 自身即任务 / 状态总线，不以「事件订阅」为中心 | 需部署 server + 持久库 + 可选搜索与 UI，**运维面显著**；重放要求业务代码确定性，学习曲线陡 | **高** | [docs.temporal.io](https://docs.temporal.io/) |
| **Restate** | 强：以**日志（journal）+ 持久化 promise** 恢复单次调用到中断点；虚拟对象（Virtual Object）原生支持「有状态实体」 | 强：durable promise 天然表达「等活动结果」 | 面向 RPC / 有状态实体的调用语义，非通用事件总线 | 单体二进制、概念较少，自托管相对轻 | 中 | [docs.restate.dev](https://docs.restate.dev/foundations/services) · [github.com/restatedev/restate](https://github.com/restatedev/restate) · 注意 **LICENSE 为 Business Source License 1.1**（[LICENSE](https://github.com/restatedev/restate/blob/76acff9c2400e915a73deea6ed39abc4ab5df702/LICENSE)） |
| **Inngest** | 强：以 **step** 为单位的持久化执行，每步结果被记录，失败可从 step 续跑 | 强：以「等待事件」表达人工审批（`step.waitForEvent` 一类原语） | 事件驱动，函数由事件触发 | 服务端开源、可自托管；生产级自托管的支持边界需以其官方文档为准 | 中 | [github.com/inngest/inngest](https://github.com/inngest/inngest) |
| **BullMQ** | 弱：持久化的是**作业与队列**，不是 agent 的推理状态 | 弱：需自己拼装「等待」语义（延迟作业 / 轮询） | Redis 队列语义，非事件日志 | 极轻（一个 Redis） | **低** | [docs.bullmq.io](https://docs.bullmq.io/) · [github.com/taskforcesh/bullmq](https://github.com/taskforcesh/bullmq) |
| **River** | 中：Go 作业队列，作业状态与重试持久化在 **Postgres** | 弱（同上，需自建） | Postgres 表 + 通知，非流式总线 | **极轻**：复用现有 Postgres，无新组件 | 低（但**要求 Go**） | [riverqueue.com/docs/transactional-enqueueing](https://riverqueue.com/docs/transactional-enqueueing) · [github.com/riverqueue/river](https://github.com/riverqueue/river) |
| **pg-boss** | 中：Node.js 的 Postgres 作业队列，「Queueing jobs in Postgres from Node.js like a boss」 | 弱（需自建审批表 + 作业） | Postgres 表；与 outbox 同库 | **极轻**：与 pgvector / 事件表同一 Postgres | **低** | [github.com/timgit/pg-boss](https://github.com/timgit/pg-boss) |
| **NATS JetStream** | 弱：持久化**消息**，不持久化 agent 逻辑状态 | 弱 | **强**：持久化流 + durable consumer + KV/Object Store，at-least-once / exactly-once 语义可配 | 轻：单二进制；但需要额外运维一个消息系统 | 中 | [github.com/nats-io/nats-server](https://github.com/nats-io/nats-server) · [JetStream 概念](https://nats-io.github.io/nats.net/documentation/jetstream/intro.html) |
| **Kafka** | 弱：同上 | 弱 | **最强**：分区追加日志、消费组、保留 / 压缩、exactly-once 语义 | 重：集群 + 运维 + 概念负担；MVP 明显过度 | **最高** | [kafka.apache.org/documentation](https://kafka.apache.org/documentation/) |
| **LangGraph checkpointer + interrupt** | 中：以 `thread_id` 为游标的**图状态检查点**，官方建议生产用**持久化 checkpointer**（数据库）而非内存版 | **强且原生**：`interrupt()` + `Command(resume=...)` 就是审批流原语；支持时间旅行与重放 | 无（它是编排库，不是总线） | 轻（库） | 低 | [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) |
| **Postgres 原生（outbox + `SKIP LOCKED` 作业表）** | 中：状态由**你自己的事件流**定义，持久性 = 事务性 | 由你自己实现（必然要做，见 §5.4） | 中：outbox + 轮询 / 通知；语义完全由你掌控 | **最轻**：零新增组件，与组织表同库同事务 | **最低** | 复用 `persistence` + `event-bus` 现有设计 |

### 3.2 选型结论

**MVP 采用「Postgres 原生 + pg-boss/River」这一行，而不是 Temporal/Restate。** 三条理由：

1. **语义同构**：MAOEH 的 A3 已规定「一切组织状态变更都是事件，唯一入口是 `append(event)`」。这意味着**事件日志本身就是工作流状态的载体**——再引入一个外部的「执行历史存储」会造成**双真相源**：Temporal 的 workflow history 与 `org_events` 谁说了算？在组织仿真里这个问题的答案必须是后者。
2. **事务性 outbox 已经解决投递问题**：`append()` 与业务写入在同一 Postgres 事务内完成，作业入队也放在同一事务（pg-boss 与 River 的核心能力即「事务内入队」），于是「状态变更」与「后续动作」之间不存在丢事件窗口。
3. **审批的幂等性本来就该由内核保证**（§5.4），而内核是确定性代码；把审批做成外部队列里的一个作业，比塞进 LLM 节点的图执行里**更容易保证幂等**。

**演进路径与触发条件见 §6 结论 4。**

### 3.3 消息总线的演进位置

架构文档已预留「Postgres outbox + 进程内 dispatcher → Redis Streams / NATS JetStream Consumer Group」的路径。**保留这一路径但不要在 MVP 实现。** NATS JetStream 是比 Kafka 更合适的第一顺位升级目标（单二进制、轻运维、durable consumer 语义足够），Kafka 只在「需要长期保留的事件日志作为跨系统数据资产」时才值得付出运维成本。

---

## 4. 多 Agent 系统失败模式

### 4.1 MAST：14 个失败模式、3 大类（核心引用）

来源：**Why Do Multi-Agent LLM Systems Fail?**（[arXiv:2503.13657](https://arxiv.org/abs/2503.13657)，全文 HTML [v3](https://arxiv.org/html/2503.13657v3)，代码 [github.com/multi-agent-systems-failure-taxonomy/MAST](https://github.com/multi-agent-systems-failure-taxonomy/MAST)）——均已实际核实。

**已核实的规模与可信度指标**：
- MAST-Data：**1642 条**带标注的执行 trace，覆盖 **7 个**流行的多 agent 框架、4 个模型家族；每条 trace 平均超过 15,000 行文本。
- 分类法构建：对 150+ 条 trace 做扎根理论（Grounded Theory）分析，6 位专家标注者参与；三位标注者独立迭代标注 15 条 trace，达到**标注者间一致性 κ = 0.88**。
- 可扩展标注：LLM-as-a-Judge（o1）与人类专家一致度 **κ = 0.77**，并在两个未见过的 MAS 与 benchmark 上验证 **κ = 0.79**。
- **7 个 SOTA 开源 MAS 的失败率为 41% – 86.7%。**
- 覆盖系统包括：ChatDev、MetaGPT、HyperAgent、AppWorld、AG2 (MathChat)、Magentic-One、OpenManus；任务涵盖 coding / math / general agent；benchmark 包括 ProgramDev、SWE-Bench Lite、Test-C、GSM-Plus、GAIA、OlympiadBench、MMLU。

**14 个失败模式全表**（模式名与编号逐条取自该论文正文与附录的失败模式示例索引，均已在抓取内容中核实）：

| 类别 | 编号 | 失败模式 | 含义要点 |
|------|------|----------|----------|
| **FC1 系统设计问题**<br/>(System Design Issues) | FM-1.1 | **Disobey task specification** | 不遵守任务规范 |
| | FM-1.2 | **Disobey role specification** | 不遵守角色规范（越界 / 抢占他人职责） |
| | FM-1.3 | **Step repetition** | 步骤重复（原地打转） |
| | FM-1.4 | **Loss of conversation history** | 对话历史丢失（上下文断裂） |
| | FM-1.5 | **Unaware of stopping conditions** | 不知道何时该停 |
| **FC2 Agent 间失配**<br/>(Inter-Agent Misalignment) | FM-2.1 | **Conversation reset** | 对话被重置（上下文意外清空） |
| | FM-2.2 | **Fail to ask for clarification** | 该问清楚却不问（该升级却不升级） |
| | FM-2.3 | **Task derailment** | 任务跑偏 |
| | FM-2.4 | **Information withholding** | 信息隐瞒 / 不共享 |
| | FM-2.5 | **Ignored other agent's input** | 忽略其他 agent 的输入 |
| | FM-2.6 | **Reasoning-action mismatch** | 推理与行动不一致（说的和做的不一样） |
| **FC3 任务验证**<br/>(Task Verification) | FM-3.1 | **Premature termination** | 过早终止（未做完就收工） |
| | FM-3.2 | **No or incomplete verification** | 没有验证或验证不完整 |
| | FM-3.3 | **Incorrect verification** | 验证本身是错的 |

**MAST 作为工程工具的实证收益**（原文核实）：
- 论文给出的实例：「the CPO agent in ChatDev can exhibit 'Failure Mode 1.2 - Disobey Role Specification' by terminating conversation without the CEO agent's consensus. We demonstrate that a straightforward system workflow adjustment ensuring the CEO had the final say contributed to a **+9.4% increase** in overall task success rate.」
- 论文的总体立场：「failures identified by MAST often stem from **system design issues**, not just LLM limitations or simple prompt following, and require more than superficial fixes, thereby highlighting the need for **structural MAS redesigns**.」
- 论文也明确指出，用 MAST 指导的干预有效，但「achieving robust MAS reliability often requires more than isolated fixes」。
- 论文以 `pip install agentdash` 形式发布了 MAST Python 库，可**直接作为 CI 中的失败模式检测器**。

### 4.2 其他失败维度

| 失败维度 | 说明 | 依据 |
|----------|------|------|
| **错误复利（compounding errors）** | 一步失败会把 agent 推向完全不同的轨迹：「One step failing can cause agents to explore entirely different trajectories, leading to unpredictable outcomes」 | Anthropic 多 agent 研究系统工程复盘（[链接](https://www.anthropic.com/engineering/multi-agent-research-system)） |
| **协调开销随规模爆炸** | 「a rapid growth in coordination complexity」；早期版本出现过「为简单查询生成 50 个子 agent」「无止境地搜索不存在的来源」「互相用过多更新干扰对方」 | 同上 |
| **成本与延迟爆炸** | 已核实：「agents typically use about **4× more tokens** than chat interactions, and multi-agent systems use about **15× more tokens** than chats」 | 同上 |
| **性能方差主要来自 token 用量** | 已核实：在 BrowseComp 上「token usage by itself explains **80% of the variance**」，加上工具调用次数与模型选择共解释 **95%** | 同上 |
| **无限循环 / 不收敛** | 对应 FM-1.3 Step repetition + FM-1.5 Unaware of stopping conditions；工程对策是**显式轮次上限与停止条件**（Anthropic 明确建议「stopping conditions (such as a maximum number of iterations)」） | MAST + Anthropic |
| **角色漂移** | 对应 FM-1.2 Disobey role specification；MAST 已给出「用工作流结构调整强制角色权限」的有效案例 | MAST |
| **同步执行的瓶颈** | 已核实：Anthropic 的 lead agent 目前同步执行子 agent，「the entire system can be blocked while waiting for a single subagent to finish searching」 | Anthropic |
| **部署期状态破坏** | 已核实：agent 是「highly stateful webs of prompts, tools, and execution logic」，因此采用 **rainbow deployments** 逐步切流以避免打断运行中的 agent | Anthropic |

### 4.3 「默认单 agent + 确定性脚手架」的工程观点

**Anthropic — Building effective agents**（[链接](https://www.anthropic.com/engineering/building-effective-agents)，已核实原文）：
- 核心诊断：「Consistently, the most successful implementations use **simple, composable patterns rather than complex frameworks**.」
- 关键建议原文：「When building applications with LLMs, we recommend **finding the simplest solution possible, and only increasing complexity when needed**. This might mean not building agentic systems at all.」
- 架构区分（对 MAOEH 极其重要）：「**Workflows** are systems where LLMs and tools are orchestrated through **predefined code paths**. **Agents** are systems where LLMs **dynamically direct their own processes** and tool usage.」
- 五种可复用 workflow 模式：**Prompt chaining / Routing / Parallelization（sectioning + voting）/ Orchestrator-workers / Evaluator-optimizer**；以及「augmented LLM」作为最基础构件。
- 三条实施原则：「Maintain **simplicity** in your agent's design」「Prioritize **transparency** by explicitly showing the agent's planning steps」「Carefully craft your agent-computer interface (ACI) through thorough tool **documentation and testing**」。
- 风险提示原文：「The autonomous nature of agents means higher costs, and **the potential for compounding errors**. We recommend extensive testing in sandboxed environments, along with the appropriate **guardrails**.」
- 对框架的警告：「they often create extra layers of abstraction that can obscure the underlying prompts and responses, making them harder to debug. They can also make it tempting to add complexity when a simpler setup would suffice.」

> **对 MAOEH 的直接含义**：本项目**不是**「用 LLM 动态决定一切」，而是「**确定性组织内核 + 概率性员工认知**」。这正是 Anthropic 意义上「workflow 骨架承载 agent」的严肃形态——架构文档 §1.3 的蓝色区（组织层与编排层）**零 LLM、可 100% 单测**，只有 Agent 层是概率性的。**A4 公理（LLM 只能提议，内核才能执行）就是把这条建议制度化的产物。**

**Cognition — Don't Build Multi-Agents**（[链接](https://cognition.com/blog/dont-build-multi-agents)，已核实原文）：
- 两条核心原则（原文）：
  - **Principle 1**：「**Share context, and share full agent traces, not just individual messages**」
  - **Principle 2**：「**Actions carry implicit decisions, and conflicting decisions carry bad results**」
- 立场原文：「Principles 1 & 2 are so critical, and so rarely worth violating, that you should **by default rule out any agent architectures that don't abide by them**.」
- 对多 agent 的判断原文：「it is evident that in 2025, running multiple agents in collaboration only results in **fragile systems**. The decision-making ends up being **too dispersed** and context isn't able to be shared thoroughly enough between the agents.」
- 对具体框架的点名批评：该文认为 OpenAI 的 swarm 与 Microsoft 的 autogen「actively push concepts which I believe to be the wrong way of building agents. Namely, using multi-agent architectures」。
- 作者推荐的最简可行形态是**单线程线性 agent**（共享连续上下文），并指出真正长任务的难点在**上下文压缩**。

> **MAOEH 必须正面回应这个批评，而不能绕开。** 关键区别在于：Cognition 批评的是「**为了并行而把决策权分散到多个 agent**」；MAOEH 的设计不是把**一个任务**拆给多个 agent，而是**多个长期存在的员工各自持有受权限约束的信息与职责**——「上下文不共享」是**被建模的现实**（CTO 本来就不该看到全部员工薪资）。因此 MAOEH 的成立条件是把「上下文不共享」变成**显式的、受权限约束的、可审计的事件**，而不是依赖 agent 之间的自由对话去补全上下文：
> - **A5（员工之间不直接调用，通信 = 消息事件）** 是对 Principle 1 的正面制度回应：所有跨员工的信息流动都是**可回放的事件**，因此「决策依据」永远可重建，不存在只有某个 agent 知道的隐含决策。
> - **A4（LLM 只提议）** 是对 Principle 2 的正面制度回应：决策冲突不在 agent 之间靠对话消解，而交给**确定性内核 + 决策引擎 + 升级阶梯**判定。
> - 必须警惕的反模式：**让两个 Agent 通过自由对话「商量出一个方案」然后直接执行**——这同时违反 Principle 1、2 与本文的 A4/A5。

### 4.4 缓解措施映射表

| 失败模式 / 风险 | MAOEH 缓解措施 | 落点模块 |
|------------------|----------------|----------|
| FM-1.2 角色违背 | LLM 输出为 `Intent`，副作用必须过 `AuthzService.can()`；`tool-gateway` 白名单按岗位下发 | `org-authz` + `tool-gateway` + `agent-core` |
| FM-1.4 历史丢失 | 记忆与事件同库同事务；每条记忆带 `source_event_id`；`comm` 提供收件箱而非易失上下文 | `memory` + `event-bus` + `comm` |
| FM-1.5 不知何时停 | 每轮 `CycleBudget`（token / 时长 / 调用数）；会议 `MeetingEngine` 轮次上限；SLA 超时熔断 | `runtime-loop` + `meeting-engine` + `escalation-engine` |
| FM-2.2 该问不问 | `requestDeviation` + 升级阶梯（Agent → 主管 → C-level → 人类）；无响应检测 | `escalation-engine` + `workflow-engine` |
| FM-2.6 推理与行动不一致 | A4：LLM 只产结构化 `Intent`；内核裁决并落事件；`agent_runs` 存推理过程可审计 | `agent-cognition` → `tool-gateway` → `event-bus` |
| FM-3.2 验证缺失 | 审批门 + 决策档案（ADR 式）+ 仿真测试断言「零越权事件」「组织不变量」 | `decision-engine` + `workflow-engine` + `tests/simulation` |
| FM-2.4 信息隐瞒 | `comm` 的正式文书（汇报 / 提案 / 纪要）为**必须落事件**的一等公民；信息流动可投影成时间线 | `comm` + `projector` |
| FM-3.1 过早终止 | 流程模板显式定义退出条件；`WorkflowEngine.advance` 对未满足前置条件的完成请求返回冲突 | `workflow-engine` |
| 成本与延迟爆炸 | `llm-gateway` 的 tier 路由 + token 预算 + 语义缓存；每轮 `CycleResult.cost` 记账 | `llm-gateway` + `observability` |
| 协调开销爆炸 | 员工之间无 RPC（A5），耦合只在事件契约上；并发单元按 `employeeId` 分区避免争抢 | `event-bus` + `runtime-scheduler` |
| 部署期状态破坏 | 事件溯源使读模型可重建；新版本通过「重放 + 影子投影」验证后再切换（rainbow 思路） | `projector` + `EventStore` |

---

## 5. 可观测性与可审计性

### 5.1 Append-only 事件日志与事件溯源

MAOEH 已把事件溯源定为架构主干（架构文档 §1.4）。**这里要强调的不是「用事件溯源」，而是「用事件溯源换取审计能力」**：
- 事件携带 `causation_id`（直接原因）与 `correlation_id`（同一条业务链），因此**任何 Agent 行为都能被追溯到最初触发它的那一条事件**——这是「可解释性」的工程实现而非事后文档。
- 事件是唯一真相源 → 所有读模型可从 `org_events` 完整重建 → **可回放时间线**天然成立，无需另建审计库。
- 外部概念对应：Martin Fowler 的 Event Sourcing 条目是这一模式的经典定义来源（[martinfowler.com/eaaDev/EventSourcing.html](https://martinfowler.com/eaaDev/EventSourcing.html)）；事务性 outbox 是「事件与业务写入原子化」的标准解法（[microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)）。

### 5.2 ADR 式决策记录

`decision-engine` 要求产出「决策档案（ADR 式）」。ADR 的标准形态为 **Title / Status / Context / Decision / Consequences**，且**一旦接受即不可变**（需要改变时写新 ADR 取代旧的），这与架构文档中「决策档案不可变」的要求一致。参考：[adr.github.io](https://adr.github.io/)。

> **MAOEH 的 ADR 有两条特殊约束**：(1) 决策档案由**组织投票**产生，因此必须记录**表决明细与权重**（谁投了什么、权重多少）；(2) 决策档案必须携带 `correlation_id` 指向触发它的提案事件，使「提案 → 评议 → 表决 → 执行」构成一条可一键跳转的事件链（对应架构文档 §1.8 第 8 条）。

### 5.3 追踪：OpenTelemetry GenAI 语义约定

- OTel 为生成式 AI 定义了专门的语义约定，入口页为 [opentelemetry.io/docs/specs/semconv/gen-ai/](https://opentelemetry.io/docs/specs/semconv/gen-ai/)；本次抓取该 URL 返回的页面标题为 **"Moved: Generative AI semantic conventions"**，即该章节已迁移。
- 现有属性位于属性注册表的 **Gen AI** 分组：[opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)（页面标题 "Gen AI"；该文档标注的语义约定版本为 **1.44.0**）。属性命名空间为 **`gen_ai.*`**。
- **对 MAOEH 的用法**：`llm-gateway` 与 `observability` 应直接把 `gen_ai.*` 属性打在 span 上（模型、token 用量、操作名等），**而不是自定义一套私有指标名**。理由是：(a) 自托管追踪后端（Phoenix / Langfuse）**原生按 OTel 语义解析**，用私有命名会让工具链失效；(b) 该规范仍在演进，因此**必须在 `observability` 模块内做一层薄适配**，把上游变更隔离在一处，避免污染业务代码。

### 5.4 ⚠️ LangGraph `interrupt` 的「恢复时整节点重跑」陷阱

**这是本节最重要的一条，必须在架构评审中显式记录。** 以下均为 LangGraph 官方文档原文（[docs.langchain.com/oss/python/langgraph/interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)，已核实）：

1. **重跑语义（原文）**：「When execution resumes (after you provide the requested input), the runtime **restarts the entire node from the beginning** — it does not resume from the exact line where `interrupt` was called. This means **any code that ran before the `interrupt` will execute again**.」
   另一处原文：「The node **restarts from the beginning of the node** where the `interrupt` was called when resumed, so **any code before the `interrupt` runs again**.」
2. **副作用必须幂等（原文小节标题）**：「**Side effects called before `interrupt` must be idempotent**」；文档明确警告：在 `interrupt` 之前写数据库「will be re-run multiple times when the node is resumed, potentially overwriting the initial update or **creating duplicate records**」。推荐做法是「Place side effects **after** `interrupt` calls」或「Separate side effects into separate nodes」。
3. **循环陷阱（原文警告）**：「**Avoid `while True` + `interrupt()` loops inside a single node.** Because the node re-runs from the beginning on every resume, a loop that calls `interrupt()` multiple times causes each resume to replay all previous iterations: the first resume replays 1 iteration, the second replays 2, and so on. The result is **exponential re-execution** of any code inside the loop body.」
4. **多次中断是按下标匹配的（原文）**：「For each interrupt encountered, LangGraph checks if a matching value exists in the task's resume list. **Matching is strictly index-based**, so the order of interrupt calls within the node is important.」因此不可条件式跳过 `interrupt`。
5. **子图同样受影响（原文）**：「the parent graph will resume execution from the **beginning of the node** where the subgraph was invoked and the `interrupt` was triggered. Similarly, the **subgraph will also resume from the beginning of the node** where `interrupt` was called.」
6. 静态断点（`interrupt_before` / `interrupt_after`）**不推荐用于 HITL**（原文 Note：「Static interrupts are **not recommended** for human-in-the-loop workflows.」），它们只适合调试。

> **对 MAOEH 的三条硬性要求**：
> 1. **审批判定必须在内核（确定性代码）中完成，且必须幂等。** 具体形式：审批门的唯一副作用是「在事务内向 `org_events` 追加一条 `ApprovalGranted` / `ApprovalRejected` 事件，并带上 `approvalId` 作为幂等键」；重复执行同一次恢复不得产生第二条事件（`UNIQUE(approvalId)` 或等价约束）。这与架构文档「决策档案不可变」以及「无越权副作用」的检查项一致。
> 2. **绝不把「不可逆副作用」放在等待人工输入之前的代码路径里。** 所有不可逆动作（发布、付款、对外通知）必须排在审批事件落库**之后**。
> 3. **如果借鉴图式的中断语义，必须在 `runtime-state` 的检查点设计里显式声明「恢复粒度为整个 Cycle 而非 Cycle 内的某一步」**，并要求 Cycle 内所有可重跑步骤幂等（这是架构文档 `runtime-loop` 测试策略「检查点后可恢复；无副作用泄漏」的精确含义）。

### 5.5 自托管追踪后端

| 工具 | 定位 | 自托管情况（已核实的官方页面） | 链接 |
|------|------|-------------------------------|------|
| **Langfuse** | 开源 LLM 工程平台：追踪、评估、提示管理 | 官方定位为 "**Open source** agent evals & observability: Trace, evaluate, and improve LLM applications with **one open platform**"；提供自托管部署 | [github.com/langfuse/langfuse](https://github.com/langfuse/langfuse) · [langfuse.com/docs](https://langfuse.com/docs) |
| **Arize Phoenix** | AI 可观测性与评估；**OpenTelemetry 原生** | 开源、可本地 / 自托管运行；有专门的自托管许可说明页 | [github.com/Arize-ai/phoenix](https://github.com/Arize-ai/phoenix) · [自托管许可](https://arize.com/docs/phoenix/self-hosting/license) |
| **LangSmith** | LangChain 官方追踪与评估平台 | 官方提供**自托管**部署文档（含 Terraform 部署路径），属企业级自托管选项而非纯社区开源 | [自托管文档](https://docs.langchain.com/langsmith/self-hosted) · [Terraform 部署](https://docs.langchain.com/langsmith/self-host-terraform) |

**建议**：MVP 阶段把追踪做成**可替换的后端**——业务代码只产出 OTel span，后端选 Phoenix（OTel 原生、启动成本最低）或 Langfuse（评估与提示管理一体化）。**不要**在任何业务模块里直接 import 某个追踪 SDK。

### 5.6 可回放时间线的四个必要构件

1. **全局有序的 append-only 日志**（`org_events`，`seq` 单调递增）。
2. **可重建的投影**（`replay(from_seq)` 能重建与当前一致的读模型——架构文档 §1.8 第 5 条，用属性测试保证）。
3. **因果链**：`causation_id` / `correlation_id`，使任意组织状态可一键跳到导致它的事件链。
4. **推理过程单独存证**（`agent_runs`）：人类看到的永远是事件流的投影，但 Agent 的推理过程可审计、**不进入读模型**——这既满足「透明」（Anthropic 三条原则之二），又避免把内部思想暴露为组织事实。
5. **LLM 请求 / 响应也必须持久化**：否则重放会得到不同结果，「可回放」将退化为「重新执行」。这是把「可回放」从口号变成测试用例的前提条件。

---

## 6. 对本项目的 10 条可执行结论

**结论 1 — 检索打分用「四因子加权」，第一天就把参数写成可配置常量，不要硬编码。**
- **做什么**：`MemoryStore.recall()` 的打分公式为 `score = α_r·recency + α_i·importance + α_rel·relevance + α_aff·affinity`。前三项照抄 Generative Agents：三项先 min-max 归一化到 [0,1]，初始 `α_r = α_i = α_rel = 1`，`recency = decay ^ Δt`，`decay` 初值 **0.995**，Δt 以**模拟小时**为单位。第四项 `affinity`（对相关员工 / 部门的关系亲近度）是本项目的自有扩展，**初始权重设为 0.5 并单独开关**，以便做消融。
- **为什么**：0.995 与 α=1 是**已发表的、有消融实验支撑的**默认值，直接采用可省掉从零调参；而 MAOEH 的组织语义要求「我更愿意响应与我关系近的同事」，这是原论文没有的维度，必须以**独立、可关闭的因子**加入，否则无法判断是记忆机制还是关系机制在起作用。
- **落到哪个模块**：`packages/memory`（打分与衰减）、`packages/agent-cognition`（检索策略与查询构造）、`packages/shared`（参数常量）。对应测试：`memory` 的「检索排序符合 recency / importance / relevance / affinity」「衰减单调」。

**结论 2 — 关系边必须是双时态，且用「失效」代替「覆盖」。**
- **做什么**：所有关系边（汇报线、协作线、信任度）以及「组织事实」类记录，统一带四列：`valid_at` / `invalid_at`（**模拟时间**轴）与 `created_at` / `expired_at`（**入库时间**轴）。关系变更 = 追加新边 + 把旧边的 `invalid_at` 置为**新边的 `valid_at`**；**永不 UPDATE、永不 DELETE**。查询默认只取 `invalid_at IS NULL` 的边，历史查询则按 `valid_at <= t < invalid_at` 取。
- **为什么**：Zep/Graphiti 的论文明确以「业务时间轴 T + 事务时间轴 T'」定义双时态，并把失效规则写成「把被失效边的 `t_invalid` 设为失效边的 `t_valid`」且「**优先采信新信息**」，同时强调该图是 **non-lossy** 的（「maintaining a timeline of facts and relationships, including their periods of validity」）。MAOEH 的 A3 要求「可回放 → 可解释」、§1.8 第 8 条要求「任意组织状态可一键跳到导致它的事件链」——如果关系行被就地覆盖，**历史汇报线的重建将永久不可能**，而这恰恰是组织仿真最有价值的观测对象。
- **落到哪个模块**：`packages/org-model`（关系数据结构与不变量的纯函数）、`packages/persistence`（表结构与查询）、`packages/event-bus`（变更事件）、`apps/projector`（当前视图 vs 历史视图）。对应测试：`org-model` 的属性测试「任意时刻的汇报线无环」「每个员工在任一时刻恰好一个直属上级」。

**结论 3 — Postgres-first：事务性 outbox + 同库作业队列（pg-boss 或 River），不引入独立消息系统。**
- **做什么**：`event-bus.append(events, tx)` 在**调用方事务内**写入 `org_events` 与 `outbox` 两张表；dispatcher 从 outbox 读取并投递给同一进程内的 Reactor / Projector / Observer / Streamer；需要**异步重试**的工作（反思任务、向量化、外部工具调用轮询、SLA 定时器）用 Postgres 作业队列承载——Node.js 侧用 **pg-boss**，Go 侧用 **River**。MVP 不引入 Redis Streams / NATS / Kafka。
- **为什么**：(1) 事务性 outbox 保证「状态变更」与「后续动作」之间**不存在丢事件窗口**，这是 A3「事件是唯一真相源」的必要配套；(2) pg-boss 与 River 都是「在 Postgres 里排队」，与已有 `persistence` 复用同一连接池、同一备份、同一事务边界，**新增运维组件数为 0**；(3) 独立消息系统（NATS / Kafka）解决的是「跨系统高吞吐」问题，而 MVP 的全部消费者都在同一进程内，此时它是纯负债。架构文档已预留「Redis Streams / NATS JetStream Consumer Group」升级路径，**保留但不在 MVP 实现**。
- **落到哪个模块**：`packages/event-bus`（outbox + dispatcher）、`packages/persistence`（表结构与事务封装）、`apps/kernel`（Reactor 消费组与作业 worker）。对应测试：`event-bus` 的「追加有序」「outbox 恰好一次投递」「消费幂等」「重放与实况一致」。

**结论 4 — 升级到 Temporal / Restate 的触发条件必须是可观测的量化阈值，写进 ADR 并挂上监控。**
- **做什么**：在 `docs/architecture/08-adr.md` 记录一条 ADR：**维持自研确定性编排器**，并写明以下**任一条件成立**即启动升级评估（写入 `apps/kernel` 的告警规则）：
  - **T1 跨进程恢复需求**：出现「kernel 进程崩溃后必须从某次 Cycle 的中途（而非 Cycle 边界）精确恢复」的真实需求，且自研检查点被证明无法满足；或一次崩溃导致的重复副作用修复成本超过一次性迁移成本。
  - **T2 长时间挂起的工作流数量**：同时处于「等待人工审批 / 等待外部事件」状态且挂起时长 > 24 小时的 workflow 实例**持续超过 1,000 个**，自研定时器与状态表成为运维负担。
  - **T3 编排逻辑复杂度**：单个流程模板的状态数 > 50，或出现「模板之间互相触发」的跨模板编排需求（此时手写状态机的变更成本已高于引入引擎）。
  - **T4 多节点竞争**：`employeeId` 分区扩展到多容器后，出现无法用 Postgres 乐观锁 + `SKIP LOCKED` 解决的调度 / 归属争抢。
- **为什么**：(1) Temporal 会持久化完整的 execution history 并靠**重放**恢复，这会立刻产生「**谁是真真相源**」的两难——Temporal 的 history 还是 `org_events`？对组织仿真而言答案只能是后者，因此**引入引擎之前必须先解决这个语义冲突**（可行方案：把引擎降级为纯调度器，不承载领域状态）。(2) **Restate 的 LICENSE 是 Business Source License 1.1**（已核实），对开源项目的许可兼容性必须提前评估，不能事后补。(3) 没有量化触发条件，团队会在情绪化争论中浪费时间，或过早引入一个把架构带偏的重量级依赖。
- **落到哪个模块**：`apps/kernel`、`packages/runtime-state`、`packages/workflow-engine`；决策记录在 `docs/architecture/08-adr.md`（**本简报不修改该目录，仅在结论中提出建议**）。

**结论 5 — MAST 中与本项目最相关的 6 个失败模式，逐一配置防线。**
- **做什么**：把下列 6 个模式作为**架构验收项**，每条都有对应的自动化检测（MAST 官方库 `pip install agentdash` 可用于离线标注 trace，仿真测试可用于在线断言）：

| # | 失败模式 | 防线（做什么） | 模块 |
|---|----------|----------------|------|
| 1 | **FM-1.2 Disobey role specification**（角色漂移） | LLM 输出只能是 `Intent`；任何副作用必须过 `AuthzService.can(actor, action, resource)`；工具白名单按 `positionId` 下发；拒绝路径必须有单测 | `org-authz` + `tool-gateway` + `agent-core` |
| 2 | **FM-1.4 Loss of conversation history**（记忆断裂） | 记忆与事件同事务落库；每条记忆带 `source_event_id`；`comm` 以收件箱 + 线程为上下文载体而非易失的对话窗口 | `memory` + `event-bus` + `comm` |
| 3 | **FM-1.5 Unaware of stopping conditions**（不知何时停） | 每轮 `CycleBudget`（token / 调用数 / 时长）硬上限 + 卡死检测；会议 `MeetingEngine` 轮次上限与强制收敛；SLA 超时熔断 | `runtime-loop` + `meeting-engine` + `escalation-engine` |
| 4 | **FM-2.2 Fail to ask for clarification**（该升级不升级） | `WorkflowEngine.requestDeviation()` + 升级阶梯（Agent → 主管 → C-level → 人类）+ 无响应检测；「不知道」必须是合法且被记录的输出 | `escalation-engine` + `workflow-engine` |
| 5 | **FM-2.6 Reasoning-action mismatch**（说做不一） | 结构化 Intent 强制校验；`agent_runs` 保存推理过程供审计；内核裁决结果与 Intent 的差异必须落事件（不得静默丢弃） | `agent-cognition` + `tool-gateway` + `event-bus` |
| 6 | **FM-3.2 No or incomplete verification**（验证缺失） | 审批门 + 决策档案（ADR 式，含表决明细）+ 仿真测试断言「30 个模拟日零越权事件、组织不变量成立」 | `decision-engine` + `workflow-engine` + `tests/simulation` |

- **为什么**：MAST 是在 **1642 条真实 trace、7 个 SOTA 框架**上归纳出的分类法（κ=0.88），并证明「失败主因是系统设计而非模型能力」。这 6 条是对 MAOEH「组织 + 长期记忆 + 权限 + 审批」这一组合最具杀伤力的模式：角色漂移会摧毁权限体系，记忆断裂会摧毁长期员工设定，不知何时停会摧毁成本模型，该升级不升级会摧毁组织层级的意义，说做不一违反 A4，验证缺失会让整个「可解释」承诺落空。相比之下 FM-1.1（不遵守任务规范）、FM-1.3（步骤重复）、FM-2.1（对话重置）、FM-2.3（任务跑偏）、FM-2.4（信息隐瞒）、FM-2.5（忽略输入）、FM-3.1（过早终止）、FM-3.3（验证错误）在本项目中优先级次之，但仍应在基线仿真中统计其发生率作为回归指标。
- **落到哪个模块**：全项目；由 `tests/simulation` 与 CI 中的 MAST 标注共同把关。

**结论 6 — 人工审批必须幂等，且不可逆副作用必须排在审批之后。**
- **做什么**：(1) 每个审批请求生成全局唯一 `approvalId` 作为**幂等键**；审批结果以「追加事件」的方式落库，并施加 `UNIQUE(approvalId)` 或等价的数据库约束，使重复恢复 / 重复投递**不可能产生第二条决定事件**。(2) 审批门内部**不得**包含任何不可逆副作用；发布、付款、对外通知等动作一律排在审批事件**之后**。(3) 一次 Cycle 内的所有步骤按「可重跑幂等」设计，并在检查点契约中显式声明**恢复粒度 = 整个 Cycle**。另建议审批实体至少包含 `requested_by, action_payload, risk_level, approver_role, decision, decided_by, reason, decided_at, expires_at`，且**审批超时的默认行为必须是「拒绝」或「升级」，绝不默认通过**。
- **为什么**：LangGraph 官方文档已明确「the runtime **restarts the entire node from the beginning** — it does not resume from the exact line where `interrupt` was called」，且专设一节「**Side effects called before `interrupt` must be idempotent**」，并警告非幂等写入会在恢复时「creating duplicate records」；还警告 `while True` + `interrupt()` 会导致「**exponential re-execution**」。任何借鉴图式中断语义（或自行实现「挂起—恢复」）的设计都会继承这个风险：**审批是组织仿真中最容易出不可逆错误的地方**（批准一次预算、发布一个版本），因此幂等不是优化项而是正确性前提。这也正是把审批放在内核（确定性代码）而不是 LLM 节点里的另一个理由。
- **落到哪个模块**：`packages/workflow-engine`（审批门与幂等键）、`packages/event-bus`（原子追加与唯一约束）、`packages/persistence`（约束与迁移）、`apps/api`（人类审批命令入口）。对应测试：`workflow-engine` 的「审批门配额正确」+ 新增「同一 `approvalId` 重复提交仅产生一条事件」的并发测试。

**结论 7 — 记忆必须分层实现，且「反思」要有触发计数器与证据指针，并强制区分「观察到的事实」与「LLM 的概括」。**
- **做什么**：`memory` 模块区分五类记忆：工作记忆（Redis + TTL，属 `runtime-state`）、情景记忆（事件派生，带时间戳与 `source_event_id`）、语义记忆（向量库中的事实与概括）、程序记忆（代码化技能，注册进 `tool-gateway` 的技能表）、社会记忆（双时态关系边）。反思机制照抄 Generative Agents：按 `employeeId` 维护 `importanceAccumulator`，**累加值超过阈值即触发反思**（阈值初值参考 **150**，但必须按本项目「模拟时间 vs 真实 token」重新标定）；反思产出必须携带 `citedMemoryIds`，形成反思树。**并且**：情景记忆（观察）与语义记忆 / 反思（LLM 生成）**必须在存储层可区分且不可互相覆写**——前者不可修改，后者可丢弃、可重生成；检索结果必须向 LLM 明示二者的来源与可信层级。
- **为什么**：(1) Zep 的双重存储（episode 子图 + 语义实体子图）明确以心理学的情景 / 语义记忆区分作为设计依据，说明「分开存」不是随意切分；(2) Generative Agents 的消融实验证明 reflection 是关键贡献项（论文原文："each of these components is critical"），而其触发机制（importance 累加超阈值）是**无需额外 LLM 调用即可实现的低成本门槛**——若无此门槛，反思要么太频繁（成本爆炸）要么永不发生（长期记忆无法抽象化）；(3) **Generative Agents 自己报告的最常见错误之一就是 "fabricated embellishments to the agent's memory"**，即 LLM 的高层概括会虚构润色。对 MAOEH 而言组织事实必须可信，所以「原始事实 / LLM 概括」的物理区分与 `citedMemoryIds` 的证据指针不是洁癖，而是**防止组织记忆被虚构污染的唯一可行手段**。
- **落到哪个模块**：`packages/memory`、`packages/agent-cognition`（反思提示）、`packages/tool-gateway`（程序记忆的技能注册）、`packages/persistence`（向量与图存储）。

**结论 8 — 用「确定性脚手架 + 概率性员工」正面回应「不要建多 agent」的批评，并把它写成 ADR。**
- **做什么**：在 ADR 中明确记录本项目的架构立场：组织层与编排层**零 LLM、100% 可单测**（对应 Anthropic「predefined code paths」的 workflow）；只有 Agent 层是概率性的；跨员工耦合只允许发生在事件契约上。同时把 Cognition 的两条原则转写成**可检验的架构约束**：
  - 对应 Principle 1「Share context, and share full agent traces」→ **A5**：员工之间无 RPC，一切通信即事件；因此任何决策的依据都可由事件重建，不存在「只有某个 agent 知道的隐含决策」。
  - 对应 Principle 2「Actions carry implicit decisions」→ **A4**：LLM 只产 `Intent`，冲突不靠 agent 对话消解，而由内核 + 决策引擎 + 升级阶梯裁决。
  - 额外把「**确定性代码 : LLM 调用**」的比例作为公开的架构健康度指标（例如在 README 中展示），使「多 Agent 是例外而非常态」这一原则可被外部检验。
- **为什么**：Cognition 明确主张「**by default rule out any agent architectures that don't abide by**」这两条原则，并断言 2025 年「running multiple agents in collaboration only results in fragile systems」。**这个批评必须被正面回答而不是回避**——否则项目在评审中会被一句话否定。回答的核心是区分两种多 agent：(a)「为一个任务并行拆分决策权」（Cognition 反对的，也确实脆弱）；(b)「多个长期员工各自持有受权限约束的信息与职责」（MAOEH 要做的，上下文不共享是**被建模的现实**而非缺陷）。同时 Anthropic 的「find the simplest solution possible, and only increase complexity when needed」提醒我们：**不要为了「多 agent」而多 agent**——如果某个能力可以用确定性代码或单次 LLM 调用完成，就不该引入一个 Agent。
- **落到哪个模块**：`docs/architecture/08-adr.md`（记录）、`packages/event-bus` 与 `packages/org-authz`（约束的物理实现点）、CI 的 `dependency-cruiser` / `no-restricted-imports` 规则（机械保证）。

**结论 9 — 可观测性走 OTel `gen_ai.*` 语义 + 可替换后端，成本按 Cycle 记账并与公司预算打通。**
- **做什么**：(1) 所有 LLM 调用与工具调用产出 OTel span，属性使用 **`gen_ai.*` 命名空间**，不自造私有指标名；(2) 追踪后端抽象为可替换实现，MVP 首选 Phoenix（OTel 原生、启动最轻）或 Langfuse（开源、含评估与提示管理）；(3) `llm-gateway` 对每次调用记录 `tokensIn / tokensOut / usd / ms`，并把汇总写入 `CycleResult.cost`；(4) 采集三组组织级指标：**每员工每模拟日的 token 成本、每类流程的完成率与平均 Cycle 数、越权拒绝次数**；(5) **在自己库里保存规范化副本**——上游语义约定仍在演进，字段会变，不能把历史追溯能力绑定在外部工具的 schema 上。
- **为什么**：OTel 的 GenAI 语义约定已从 `/gen-ai/` 迁移（抓取该 URL 时返回 "Moved: Generative AI semantic conventions"），现存属性位于属性注册表的 Gen AI 分组，规范版本 **1.44.0**——**规范仍在演进**，故必须在 `observability` 内做一层薄适配以隔离变更；与此同时，Phoenix 与 Langfuse 均按 OTel 语义解析，用私有命名会让工具链直接失效。成本指标的必要性由 Anthropic 的数据支撑：多 agent 系统「use about **15× more tokens** than chats」，且 token 用量单独解释了性能方差的 **80%**——对 MAOEH 而言，**成本与「公司预算」本就是同一个业务概念**（`org-policy` 有预算上限），因此成本指标不是纯运维数据，它应当是组织可观测性的一等公民；超限时应转为**审批事件**而非静默失败。
- **落到哪个模块**：`packages/observability`、`packages/llm-gateway`、`packages/org-policy`（预算与 SLA）、`apps/kernel`（指标暴露）。

**结论 10 — 把「可回放」做成可执行的验收测试，而不是一句设计口号。**
- **做什么**：(1) **每次 LLM 请求 / 响应必须持久化**（否则重放会得到不同结果，可回放将退化为重新执行）；(2) 实现 `replay(fromSeq, toSeq)` 并写**属性测试**：从 `0` 重放到当前 `seq`，重建出的读模型必须与实时投影**逐字段一致**；(3) 写因果链测试：随机抽取任意一条 Agent 产出的事件，必须能沿 `causation_id` 回溯到一条人类命令或调度触发；(4) 写**零越权仿真测试**：用 `FakeLlm` + 固定随机种子跑 **30 个模拟日**，断言组织不变量成立且越权事件数为 0；(5) 所有外部副作用经 Gateway 包裹，并在**重放模式下被拦截**；(6) 用 MAST 失败模式对仿真 trace 做离线标注，作为**回归指标**纳入 CI（出现新失败模式或某模式占比上升即告警）。
- **为什么**：架构文档 §1.8 已把「可回放」「无越权副作用」「无匿名 LLM」「记忆可追溯」列为反退化检查项，但**检查项只有在自动化时才真正约束架构**——否则会在第一个 deadline 前被静默放弃。此外，Anthropic 的工程复盘指出 agent 系统「minor system failures can be catastrophic」「we can't just restart from the beginning」，而 MAST 的贡献之一是证明**结构性改动可被测量**（ChatDev +9.4%）；两者共同说明：**可回放 + 可归因 + 可回归**才是长期可维护性的来源。这也是 `FakeLlm` 被列为「本项目可测试性基石」的原因——没有确定性假模型，30 个模拟日的仿真测试不可能进 CI。
- **落到哪个模块**：`tests/replay`、`tests/simulation`、`packages/event-bus`（`replay`）、`packages/runtime-state`（检查点设计）、`apps/projector`（投影一致性）、CI 流水线。

---

## 7. 引用清单

以下 URL 均经本次研究通过 `web_fetch` 实际抓取（标注 **[F]**）或经 `web_search` 检索索引确认存在（标注 **[S]**）。**未列出的 URL 与论文编号一律未被本项目核实，不得引用。**

**生成式 agent 与社会仿真**

1. [F] https://arxiv.org/abs/2304.03442 — *Generative Agents: Interactive Simulacra of Human Behavior*（Park et al.）
2. [F] https://arxiv.org/html/2304.03442v1 — 同上，arXiv 全文 HTML（v1）
3. [F] https://ar5iv.labs.arxiv.org/html/2304.03442 — 同上，ar5iv 全文（§4.1 检索公式、§4.2 reflection 阈值的核实来源）
4. [F] https://github.com/joonspk-research/generative_agents — 官方实现仓库（该 URL 出现在已抓取的论文正文中）
5. [S] https://github.com/a16z-infra/ai-town — *AI Town*，MIT 许可的可部署 AI 小镇 starter kit
6. [S] https://arxiv.org/abs/2502.08691 — *AgentSociety: Large-Scale Simulation of LLM-Driven Generative Agents Advances Understanding of Human Behaviors and Society*
7. [S] https://agentsociety.readthedocs.io/en/latest/ — AgentSociety 官方文档
8. [S] https://arxiv.org/abs/2411.11581 — *OASIS: Open Agent Social Interaction Simulations with One Million Agents*
9. [S] https://github.com/camel-ai/oasis — OASIS 仓库
10. [S] https://arxiv.org/abs/2312.03664 — *Generative agent-based modeling with actions grounded in physical, social, or digital space using Concordia*
11. [S] https://github.com/google-deepmind/concordia — *A library for generative social simulation*
12. [S] https://arxiv.org/abs/2305.16291 — *Voyager: An Open-Ended Embodied Agent with Large Language Models*
13. [S] https://arxiv.org/abs/2507.09788 — *TinyTroupe: An LLM-powered Multiagent Persona Simulation Toolkit*
14. [S] https://github.com/microsoft/TinyTroupe — TinyTroupe 仓库

**多 agent 协作框架与虚拟公司**

15. [S] https://arxiv.org/abs/2308.00352 — *MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework*
16. [F] https://github.com/FoundationAgents/MetaGPT — MetaGPT 仓库（该 URL 出现在已抓取的 Cognition 博文中）
17. [S] https://arxiv.org/abs/2307.07924 — *ChatDev: Communicative Agents for Software Development*
18. [S] https://docs.crewai.com/ — CrewAI 官方文档
19. [S] https://arxiv.org/abs/2308.08155 — *AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation*
20. [F] https://github.com/microsoft/autogen — AutoGen 仓库（该 URL 出现在已抓取的 Cognition 博文中）
21. [S] https://arxiv.org/abs/2411.04468 — *Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks*
22. [S] https://arxiv.org/abs/2412.14161 — *TheAgentCompany: Benchmarking LLM Agents on Consequential Real World Tasks*
23. [F] https://docs.langchain.com/oss/python/langgraph/interrupts — LangGraph *Interrupts* 官方文档（§5.4 全部引文来源）

**记忆架构**

24. [F] https://arxiv.org/abs/2504.19413 — *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*
25. [F] https://arxiv.org/abs/2501.13956 — *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*
26. [F] https://arxiv.org/html/2501.13956v1 — 同上，全文 HTML（双时态模型、四时间戳、边失效机制的核实来源）
27. [F] https://github.com/getzep/graphiti — Graphiti 仓库（页面标题："Build Real-Time Knowledge Graphs for AI Agents"）
28. [S] https://arxiv.org/abs/2404.13501 — *A Survey on the Memory Mechanism of Large Language Model based Agents*
29. [F] https://github.com/pgvector/pgvector — *Open-source vector similarity search for Postgres*
30. [F] https://qdrant.tech/documentation/ — Qdrant 官方文档；[F] https://github.com/qdrant/qdrant/releases（由该文档页链接确认仓库地址）
31. [F] https://github.com/chroma-core/chroma — *Search infrastructure for AI*
32. [F] https://github.com/lancedb/lancedb — *Developer-friendly OSS embedded retrieval library for multimodal AI*；[S] https://docs.lancedb.com/faq/faq-oss.md

**持久化执行与消息系统**

33. [S] https://docs.temporal.io/ — Temporal 官方文档
34. [S] https://docs.restate.dev/foundations/services — Restate 官方文档
35. [S] https://github.com/restatedev/restate — Restate 仓库
36. [S] https://github.com/restatedev/restate/blob/76acff9c2400e915a73deea6ed39abc4ab5df702/LICENSE — 许可证核实来源（**Business Source License 1.1**）
37. [S] https://github.com/inngest/inngest — Inngest 仓库
38. [S] https://docs.bullmq.io/ — BullMQ 官方文档；[S] https://github.com/taskforcesh/bullmq
39. [S] https://riverqueue.com/docs/transactional-enqueueing — River「事务内入队」文档；[S] https://github.com/riverqueue/river
40. [S] https://github.com/timgit/pg-boss — *Queueing jobs in Postgres from Node.js like a boss*
41. [F] https://github.com/nats-io/nats-server — *High-Performance server for NATS.io*；[S] https://nats-io.github.io/nats.net/documentation/jetstream/intro.html（JetStream 概念）
42. [F] https://kafka.apache.org/documentation/ — Apache Kafka 官方文档
43. [S] https://microservices.io/patterns/data/transactional-outbox.html — 事务性 outbox 模式

**失败模式与工程观点**

44. [F] https://arxiv.org/abs/2503.13657 — *Why Do Multi-Agent LLM Systems Fail?*（MAST）
45. [F] https://arxiv.org/html/2503.13657v3 — 同上，全文 HTML（14 个失败模式、κ=0.88、41%–86.7% 失败率、+9.4% 干预收益的核实来源）
46. [F] https://github.com/multi-agent-systems-failure-taxonomy/MAST — MAST 代码与数据仓库
47. [F] https://www.anthropic.com/engineering/building-effective-agents — Anthropic，*Building effective agents*
48. [F] https://cognition.com/blog/dont-build-multi-agents — Cognition，*Don't Build Multi-Agents*
49. [F] https://www.anthropic.com/engineering/multi-agent-research-system — Anthropic，*How we built our multi-agent research system*

**可观测性与可审计性**

50. [F] https://opentelemetry.io/docs/specs/semconv/gen-ai/ — OTel GenAI 语义约定入口（抓取时返回 "Moved"，已迁移）
51. [F] https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/ — OTel 属性注册表 **Gen AI** 分组（`gen_ai.*`；语义约定版本 1.44.0）
52. [F] https://github.com/langfuse/langfuse — *Open source agent evals & observability*；[S] https://langfuse.com/docs
53. [F] https://github.com/Arize-ai/phoenix — *AI Observability & Evaluation*；[F] https://arize.com/docs/phoenix/self-hosting/license
54. [S] https://docs.langchain.com/langsmith/self-hosted — LangSmith 自托管文档；[S] https://docs.langchain.com/langsmith/self-host-terraform
55. [S] https://adr.github.io/ — Architecture Decision Records 社区入口
56. [S] https://martinfowler.com/eaaDev/EventSourcing.html — Martin Fowler，*Event Sourcing*

---

## 附录：核实说明与诚实披露

1. **本文件仅新增 `docs/research/research-brief.md`，未修改 `docs/architecture/` 或仓库中任何其他文件。**
2. 本环境下 `raw.githubusercontent.com` 不可直接抓取，且部分站点（`langfuse.com/self-hosting`、`cognition.ai`、部分 GitHub 仓库根页面的 README 正文）返回 `fetch failed` 或仅返回页面导航骨架。此类情况一律改用可访问的等价来源（arXiv 全文 HTML、ar5iv、官方文档页、含描述信息的页面标题、该页面内链接到的仓库地址）完成核实，**没有以猜测代替核实**。
3. **第 5.3 节关于 OTel `gen_ai.*` 的陈述限于「命名空间与所属注册表分组」**；具体属性名与枚举值未逐条核实，落地前须以官方页面为准。
4. **第 3.1 节中仅 Restate 的许可证（Business Source License 1.1）经过核实**；Temporal / Inngest / NATS / Kafka / BullMQ / pg-boss / River 的许可条款与生产支持边界未逐条核实，须以各自官方文档为准。
5. 第 1 节表格中的架构描述，其来源为对应论文摘要 / 官方文档页与前述已核实页面的描述性文字；**未逐条阅读源码**，属于「架构范式级」判断而非实现细节断言。
6. 引用计数（机器统计）：第 7 节共 **56 条编号引用**，其中 **[F] 实际抓取核实 27 条**、**[S] 检索索引确认 29 条**；全文共出现 **84 个去重 URL**（含正文内联引用）。全部 URL 见第 7 节。
