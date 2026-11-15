# M3 七阶段全链路总验收

> 验收时间：2026-11-15 13:35–13:36（Asia/Shanghai）
> 结论：**通过（PASS）**
> 范围：M3.1–M3.8 业务闭环 + M3.9 可观测性收尾；未开发 M4。

---

## 1. 验收环境

| 项 | 值 |
| --- | --- |
| 运行方式 | 独立 Node 进程，`node --env-file=.env` |
| 模型 | DeepSeek `deepseek-flash`（live） |
| 运行目录 | `.maoeh/audit/m3-e2e/2026-11-15T05-35-22.115Z/` |
| planningDir | 上述目录下 `planning/` |
| 事件日志 | 上述目录下 `events.jsonl`（持久化文件） |
| 事件日志大小 | 86,403 bytes |
| 首次 API 端口 | 34392 |
| 重启后 API 端口 | 40138 |
| 正式 3001 | 未启动/未停止/未写入；只读核验 |

独立目录中的 planning store 与事件日志均为本次新建，没有复用旧临时数据。

---

## 2. 七阶段实测结果

### 阶段 1：需求沙盘

| 项 | 值 |
| --- | --- |
| requirementId | `req-1` |
| 最终版本 | v3 confirmed |
| 确认人 | `ceo-alex` |
| 确认时间 | 2026-11-15T05:35:25.420Z |
| 事件 | `Document.RequirementAnalyzed` ×1、`Document.RequirementConfirmed` ×1 |
| Theater 阶段 | sandbox 2 |

**通过。**

### 阶段 2：智能体编排

| 项 | 值 |
| --- | --- |
| orchestrationId | `orch-1` |
| 版本/状态 | v1 ready |
| 节点数 | 4 |
| workflowInstanceId | `instance-1` |
| Theater 阶段 | orchestration 1 |

**通过。**

### 阶段 3：调整画布

| 项 | 值 |
| --- | --- |
| planId | `plan-1` |
| draft → confirmed | v1 → v2 |
| 状态 | confirmed |
| 确认人 | `ceo-alex` |
| 确认时间 | 2026-11-15T05:35:25.517Z |
| 节点/任务数 | 4 / 3 |
| Theater 阶段 | canvas 3 |

**通过。**

### 阶段 4：任务实施（真实 Agent）

| task | 负责人 | 状态 | 真实 artifacts |
| --- | --- | --- | --- |
| task-1 Technical Design | John | completed | technical_design |
| task-2 Implementation | Mike | completed | index.html |
| task-3 Testing | Peter | completed | index.html、qa_report |

| 项 | 值 |
| --- | --- |
| executionId | `exec-1` |
| plan | `plan-1` v2 |
| 审批前状态 | `awaiting_approval` |
| tasks | 3/3 completed |
| 汇总 artifacts | technical_design、index.html、qa_report |
| workflowInstanceId | `execution-plan-1-v2` |
| Theater 阶段 | implementation 28 |

真实 Agent 日志包含 AcceptTask / StartTask / ProgressReport；Task.result.data 含真实设计文档、可运行 HTML、QA 报告。

**通过。**

### 阶段 5：审批

| 项 | 值 |
| --- | --- |
| approvalId | `approval-1` |
| action | approve |
| decidedBy | `ceo-alex` |
| before | awaiting_approval / open / blocked |
| after | completed / granted / completed |
| 关联 taskIds | task-1、task-2、task-3 |
| 关联 artifacts | technical_design、index.html、qa_report |
| Theater 阶段 | approval 2 |

**通过。**

### 阶段 6：推广

| 项 | 值 |
| --- | --- |
| promotionId | `promotion-1` |
| draft → edited → confirmed | v1 → v2 → v3 |
| 状态 | confirmed |
| confirmedBy | `ceo-alex` |
| confirmedAt | 2026-11-15T05:35:59.801Z |
| 策略 provenance | live / deepseek / deepseek-flash |
| 渠道 | 内容工作台图文、短视频 |
| 材料 | 7 |
| 人工修改 | title、goal、coreMessages |
| 事件 | `Document.PromotionGenerated` ×1、`Document.PromotionConfirmed` ×1 |
| Theater 阶段 | promotion 2 |

**通过。**

### 阶段 7：发布

| 项 | 值 |
| --- | --- |
| publicationId | `publication-1` |
| 版本 | v2 published |
| promotion | promotion-1 v3 |
| execution | exec-1 |
| plan | plan-1 v2 |
| approval | approval-1 |
| requirement | req-1 v3 |
| confirmedBy / publishedBy | ceo-alex / ceo-alex |
| 本地页面 | `/api/publications/publication-1/page?v=2` |
| 页面 HTTP | 200 |
| 渠道结果 | local_page published；local_manifest published |
| Theater 阶段 | release 4 |

**通过（本地发布范围）。**

---

## 3. publication 反向追溯

从 `publication-1` v2 读取到：

```text
publicationId=publication-1, version=2, status=published
promotionId=promotion-1, promotionVersion=3
executionId=exec-1
planId=plan-1, planVersion=2
approvalId=approval-1
requirementId=req-1, requirementVersion=3
taskIds=[task-1,task-2,task-3]
artifacts=[technical_design,index.html,qa_report]
publicPath=/api/publications/publication-1/page?v=2
```

逐级读取：

| 阶段 | 读取结果 |
| --- | --- |
| requirement | req-1 v3 confirmed |
| orchestration | orch-1 v1 ready，workflowInstanceId=instance-1 |
| plan | plan-1 v2 confirmed，workflowInstanceId=instance-1 |
| execution | exec-1 completed，3/3 tasks，3 artifacts，`execution-plan-1-v2` |
| approval | approval-1 approve by ceo-alex，taskIds/artifacts 完整 |
| promotion | promotion-1 v3 confirmed，execution/plan/approval 完整 |
| publication | publication-1 v2 published，本地 URL 有效 |

**追溯通过。**

---

## 4. 持久化事件日志与重启恢复

### 4.1 事件日志

- 初次启动：`recovered 0 events, 6 employees`
- 重启：`recovered 64 events, 6 employees`
- 文件：`events.jsonl`，86,403 bytes
- planning store 与发布文件都在同一独立运行目录。

### 4.2 重启前后

| 项 | 重启前 | 重启后 |
| --- | --- | --- |
| execution status | completed | completed |
| tasks | 3 | 3 |
| completed | 3 | 3 |
| artifacts | 3 | 3 |
| approval | granted / ceo-alex | granted / ceo-alex |
| publication | published v2 | published v2 |
| page HTTP | 200 | 200 |

**关键结论：此前 `eventLogPath:null` 导致的 workflow instance 重启恢复问题，在持久化事件日志验收中已解决：workflow instance `execution-plan-1-v2` 重放后恢复，tasks/results/artifacts/approval 全部一致。**

---

## 5. Theater 七阶段

事件总数 43，latestSeq 64；阶段分布：

| 阶段 | 事件数 |
| --- | --- |
| sandbox | 2 |
| orchestration | 1 |
| canvas | 3 |
| implementation | 28 |
| approval | 2 |
| promotion | 2 |
| release | 4 |
| unclassified | 1 |

七阶段全部出现。唯一 unclassified 是 `Communication.ChannelOpened`（频道建立，不是业务阶段）。

新增真实事件：

```text
Document.RequirementAnalyzed    stage=sandbox
Document.RequirementConfirmed   stage=sandbox
Document.PromotionGenerated     stage=promotion
Document.PromotionConfirmed     stage=promotion
```

发布事件：

```text
Document.PublicationDrafted               stage=release
Document.PublicationConfirmed             stage=release
Document.PublicationPublished             stage=release
```

**没有伪造事件；没有伪造推广 Task/AgentMessage。**

---

## 6. 真实业务与自动化边界

| 类型 | 内容 |
| --- | --- |
| 真实业务演示 | 本次 e2e：全新需求、真实 DeepSeek Agent 3 任务、真实 artifacts、人工审批、live 策略、人工推广确认、本地发布、重启 |
| 自动化边界测试 | `observability-events.test.ts`（新事件/幂等/重启/阶段/追溯）、`publication-http.test.ts`（成功/部分/失败重试/幂等/Theater）、`publication-restart.test.ts`、M3.5–M3.8 集成测试 |
| 未做 | 外部社交平台真实发布；无授权、无凭证 |

自动化测试数字：

| 检查 | 结果 |
| --- | --- |
| 全量测试 | 220 文件 / 1481 测试通过 |
| 架构 | 11 文件 / 62 通过，dependency-cruiser 0 违规 |
| 类型检查 | 全 workspace 通过 |
| Lint | 通过 |
| 前端构建 | 通过 |

---

## 7. Git 核查

### 7.1 当前状态

- HEAD：`9e2d5bb`（merge `origin/main`）
- 分支：`feat/m2-workflow-closed-loop`
- 第一父提交：`fbc5f34 update status`
- 第二父提交：`f918fc4`（origin/main）
- merge 时间：2026-11-15 13:31:27 +08:00
- 更早外部提交：`fbc5f34`，父 `79b890b`，作者 `cnpetershen`，13:14:54，168 files，+33,912 / -197

`git reflog` 显示 `pull origin main: Merge made by the 'ort' strategy`；该 merge 不是本次 M3 验收脚本执行。

### 7.2 影响

- `fbc5f34` 包含 M3.3–M3.8 的源码、测试和报告；M3.8 报告和代码在提交内。
- `9e2d5bb` merge 让 `README.md` 删除 85 行；M3 报告与源码未受影响。
- 当前工作区 11 个已跟踪修改、5 个未跟踪文件，均为本轮 M3.9 改动；未执行 reset/checkout/clean/stash/commit。
- 此前 M3.8 完成时的 62 modified / 101 untracked 状态已被外部提交合并，不能按原计数恢复。
- 未发现第二条并行开发分支或冲突文件。

### 7.3 结论

HEAD 变化是**外部提交 + 外部 merge**，不是本次 M3 验收脚本产生；业务验收数据不受影响，但“保持原 HEAD”的保护要求未按字面满足，仅记录、不回滚。

---

## 8. 已知限制与剩余边界

1. 外部平台发布未接入：无连接器/授权/凭证；仅本地 `local_page` + `local_manifest`。
2. 本地发布由 MAOEH API 提供 URL，不是公网托管。
3. 单租户单 operator；无多级发布审批。
4. 事件 append 失败时没有事务型 outbox；与既有 M3.8 事件相同的原子性边界。
5. 一个 unclassified channel bookkeeping 事件不属于七阶段。
6. 未进入 M4；未提交、未清理、未重启正式 3001。

---

## 9. 最终结论

**通过（PASS）。**

七阶段真实业务链路已跑通：全新需求 → 编排 → 画布 → 真实 Agent 任务 → 人工审批 → 推广 → 本地发布；真实 Agent 执行、真实 artifacts、人工审批、真实本地页面、持久化事件日志、重启恢复和 publication 反向追溯均通过。

M3.9 补齐后，Theater 已能展示 sandbox / orchestration / canvas / implementation / approval / promotion / release 全部七阶段；此前 CONDITIONAL PASS 的 Theater 限制已消除。
