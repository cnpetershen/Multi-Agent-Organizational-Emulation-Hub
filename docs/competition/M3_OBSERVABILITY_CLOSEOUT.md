# M3.9 可观测性收尾 · 专项报告

> 日期：2026-11-15
> 范围：需求沙盘 / 推广的 Theater 事件补齐 + Git 只读核查
> 结论：**Theater 七阶段限制已消除；专项通过**。外部提交仅记录，不处理。

---

## 1. Git 只读核查

### 1.1 当前状态

| 项 | 值 |
| --- | --- |
| HEAD | `9e2d5bb`（merge origin/main） |
| 分支 | `feat/m2-workflow-closed-loop` |
| 第一父提交 | `fbc5f34 update status` |
| 第二父提交 | `f918fc4`（origin/main） |
| merge 时间 | 2026-11-15 13:31:27 +08:00 |
| 更早外部提交 | `fbc5f34`，父 `79b890b`，作者 `cnpetershen`，13:14:54，168 files，+33,912 / -197 |

`git reflog` 显示 `HEAD@{0}: pull origin main: Merge made by the 'ort' strategy`；这是外部 Git 操作，不是本轮验收脚本产生。

### 1.2 影响

- `fbc5f34` 包含 M3.1–M3.8 的源码、测试和报告；M3.8 报告与代码在提交内。
- `9e2d5bb` merge 让 `README.md` 删除 85 行（merge 统计）；M3 报告与源码未受影响。
- 本次 `M3_END_TO_END_ACCEPTANCE.md` 在提交后创建，当前为 untracked。
- 当前工作区 11 个已跟踪修改、5 个未跟踪文件，均为本轮 M3.9 改动；没有执行 reset/clean/checkout/stash/commit。
- 此前“62 个已跟踪修改、101 个未跟踪文件”的状态已被外部提交合并，原计数不再成立。
- 未发现第二分支冲突文件；HEAD 是当前分支的 merge commit。

### 1.3 结论

`fbc5f34` 是外部 `update status` 提交；随后 `9e2d5bb` 是外部 `pull origin main` merge。两者都不是本次 M3 验收脚本产生；业务验收数据不受影响，但“保持原 HEAD”的保护要求未按字面满足，仅记录、不回滚。

---

## 2. 事件设计

### 2.1 协议兼容

既有 `EVENT_AGGREGATES` 固定 14 个，并由 `tests/unit/event-system/event-contract.test.ts` 钉住。新增 `Requirement` / `Promotion` 聚合会破坏既有协议断言。因此复用已登记的 `Document` 聚合：

- `Document.RequirementAnalyzed`
- `Document.RequirementConfirmed`
- `Document.PromotionGenerated`
- `Document.PromotionConfirmed`

这是**加法式事件类型**，不新增聚合、不新建总线。

### 2.2 触发位置与 payload

| 事件 | 触发 | 关键 payload |
| --- | --- | --- |
| RequirementAnalyzed | `analyze` 成功保存 requirement v1 后 | requirementId/version/title/sourceKind/analysisMode/inferredFieldCount/analyzedAt |
| RequirementConfirmed | `confirmRequirement` 保存新 confirmed 版本后 | requirementId/version/title/confirmedBy/At/inferredAcknowledged |
| PromotionGenerated | `createPromotion` 新建 v1 落库后 | promotionId/version/title/executionId/planId/version/approvalId/generatedAt/provenanceMode/materialCount/channelCount |
| PromotionConfirmed | `confirmPromotion` 保存新 confirmed 版本后 | promotionId/version/title/executionId/plan/approval/confirmedBy/At/humanEdits |

actor 走 `OrgEvent.actorKind='human' / actorId`；时间走 `occurredAtSim/Wall` 与 payload wall-clock。事件只在业务状态成功落库后写入。

### 2.3 幂等

- 需求已 confirmed 且无 answers：服务端直接返回现有版本，不写 confirmed。
- 同一 execution 已有 promotion：直接返回，不写 generated。
- 已 confirmed promotion 再次确认：抛 `version_conflict`，不写第二条。
- 每次真正新增版本才写一条事件；EventStore 事件 id 唯一约束仍为最后防线。
- 无历史补造、无 backfill 脚本。

### 2.4 真实性与隐私

- `analysisMode` 明确 AI/确定性/沙盘，不把模型文本写成用户陈述。
- `inferredAcknowledged` 记录 inferred 是否被人工确认。
- Document.PromotionGenerated 不声称 Jack/Peter 执行；Document.PromotionConfirmed 记录 humanEdits。
- Theater 卡片只显示标题/版本/状态，不渲染内部 ID。
- 无伪造 Task/AgentMessage/推广任务。

---

## 3. 实现位置

- `apps/api/src/observability-events.ts`
- `apps/api/src/planning-service.ts`（analyze/confirmRequirement/createPromotion/confirmPromotion）
- `packages/organization-control/src/collaboration/theater.ts`
- `apps/web/src/theater.ts` / `pages/Theater.tsx` / locales
- `tests/integration/observability-events.test.ts`

---

## 4. Theater 七阶段结果

真实 DeepSeek 全链路（持久化 event log）：

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

新增事件各 1 条：

```text
Document.RequirementAnalyzed    sandbox
Document.RequirementConfirmed   sandbox
Document.PromotionGenerated     promotion
Document.PromotionConfirmed     promotion
```

唯一 unclassified 是 `Communication.ChannelOpened`，不是业务阶段。

**七阶段全部展示；此前 CONDITIONAL PASS 的 Theater 限制已消除。**

---

## 5. 重启与追溯

- event log：86,403 bytes；重启 `recovered 64 events`。
- 重启前后 execution completed、3 tasks、3 artifacts、approval granted、publication page 200。
- 新事件在重启后仍在，stage 分类不变。
- publication 仍可反向追溯 requirement → orchestration → plan → execution → approval → promotion → publication。

---

## 6. 测试

| 检查 | 结果 |
| --- | --- |
| 全量测试 | 220 文件 / 1481 测试通过 |
| M3.9 专项 | 1 个集成用例，覆盖事件/幂等/重启/阶段/既有事件/发布追溯 |
| 架构 | 62 通过；dependency-cruiser 0 违规 |
| 类型检查 / Lint / 前端构建 | 通过 |

---

## 7. 仍然存在的边界

1. 事件在业务 store 保存后追加；append 失败没有事务型 outbox（和既有 M3.8 事件一致）。
2. 一个 unclassified channel bookkeeping 事件不属于七阶段。
3. 外部平台发布仍未接入；本地页面有效。
4. Git 外部提交 `fbc5f34` 与 staged README 修改仅记录，未处理；未回滚。
5. 未进入 M4。
