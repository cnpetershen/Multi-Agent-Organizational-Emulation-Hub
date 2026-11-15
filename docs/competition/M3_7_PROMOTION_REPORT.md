# M3.7 推广策略与推广方案管理 · 交付记录

> 日期：2026-11-15 · 基线 HEAD `79b890b`
> 架构契约：[`docs/architecture/M3.7-promotion.md`](../architecture/M3.7-promotion.md)
> 前序：M3.6 交付审批 / M3.5 任务实施 / M3.2 Theater

---

## 1. 审计结论

**复用：**

- M3.6 approved 交接（execution/plan/version/approval/artifacts/approver/time）；
- M3.6 review 的真实 execution、plan、Task.result；
- M3.5 execution/artifact 数据；
- 现有 LLM gateway（策略建议、live/mock provenance）；
- 真实组织能力（marketing→Jack，testing→Peter）；
- 现有 Results、导航、i18n、M3.1/M3.2 事件只读视图。

**补齐：**

1. approved → 推广方案派生；
2. 策略、受众、渠道、材料、贡献者、来源追踪；
3. draft/confirmed 追加式版本 + baseVersion 乐观锁；
4. 人工编辑、确认人/时间/摘要；
5. M3.8 confirmed 交接；
6. 推广工作台。

未新建第二套工作流引擎/事件总线/审批引擎。

---

## 2. 实际修改文件

| 文件 | 内容 |
| --- | --- |
| `apps/api/src/promotion-strategist.ts` | 结构化推广策略建议；live 模型 + 确定性 fallback；禁止编造事实的提示；空字段只按 approved evidence 补齐 |
| `apps/api/src/planning-types.ts` | `PromotionPlan`、channel/material/contributor/provenance、版本记录/摘要 |
| `apps/api/src/planning-store.ts` | promotions 追加式持久化、ID、查询 |
| `apps/api/src/planning-service.ts` | approved source 校验、create/update/confirm、版本锁、确认校验、M3.8 confirmed |
| `apps/api/src/api-adapter.ts` | `/api/promotions` 系列路由与错误映射 |
| `apps/web/src/promotion.ts` | 推广读模型 |
| `apps/web/src/pages/Promotion.tsx` | 推广工作台 |
| `apps/web/src/promotion.css` | 工作台样式 |
| `apps/web/src/App.tsx` / `control.ts` / locales | 「推广」导航、页面、中英文 |
| `tests/integration/promotion-http.test.ts` | 来源/拒绝/策略/provenance/版本/确认/handoff |
| `tests/unit/web/promotion.test.ts` | 读模型解析 |

---

## 3. 推广 API

```http
GET  /api/promotions
POST /api/promotions                 { executionId }
GET  /api/promotions/:id
PUT  /api/promotions/:id             { baseVersion, patch }
POST /api/promotions/:id/confirm     { baseVersion, note? }
GET  /api/promotions/:id/confirmed   # M3.8 only; confirmed versions only
```

来源约束：

- 只能从 M3.6 `action=approve` 的 execution 创建；
- execution 必须 completed（或 approval record 的 after 为 completed，兼容事件日志未持久化但审批事实已持久化的恢复）；
- pending / rejected / request_changes 返回 422 `promotion_invalid`。

---

## 4. 工作台

「推广」页面：

- 仅列出 M3.6 approved execution；
- 展示 plan/version、execution、approval、批准人、真实 artifacts 与内容预览；
- 推广目标、价值主张、受众、需求/痛点、核心信息、渠道及理由、时间安排、指标、风险可编辑；
- 材料卡片可编辑，标记 AI 草稿/人工修改；
- 保存派生新 draft；确认后显示 confirmedBy/At、版本、摘要；
- 版本历史不覆盖；
- 明确提示：确认只代表可交给发布阶段，不等于发布。

---

## 5. 真实 approved 来源（隔离 live）

隔离 API 3211，临时状态目录，真实 DeepSeek 审批数据：

| 项 | 值 |
| --- | --- |
| execution | `exec-1` |
| plan | `plan-1` v2 |
| approval | `approval-1` |
| approvedBy | `ceo-alex` |
| artifacts | `technical-design.md`、`index.html`、`qa_report` |
| source status | completed |

创建推广方案：

- 策略 mode `live`，provider `deepseek`，model `deepseek-flash`；
- 2 个渠道、7 份材料；
- 贡献者：market-jack（marketing）、qa-peter（testing），basis=capability；
- 材料只由 approved strategy + approved artifact 名单组装，不调用内容工作室编写营销叙事，避免编造用户反馈/市场数据/推广效果。

---

## 6. 人工编辑、确认与版本

隔离 live 操作：

1. v1 draft 创建；
2. 人工修改 title / goal / audience / coreMessages / one platform material；
3. 保存 v2 draft；`provenance.humanEdits` 记录 5 个字段；
4. 确认 v3：`confirmedBy=ceo-alex`，`confirmedAt` 有值，`confirmationNote` 记录“推广准备完成，不发布”；
5. `GET /api/promotions/promotion-1/confirmed` 返回 `promotionVersion=3`、execution/plan/approval、渠道、材料、summaryText、confirmedBy/At；
6. 没有 `publishedAt` / `publishedUrl`，没有外部发布调用。

证据：`.maoeh/audit/m37/live-acceptance.json`、`promotion-live-final.json`。

版本/锁测试：

- v1 编辑 → v2；旧 baseVersion 写 → 409；
- v1 原文仍保留；
- v2 确认 → v3；confirmed 版本不可直接覆盖；再编辑生成 v4 draft，confirmed 仍是 v3；
- 缺 audience 的 draft 确认 → 422 `promotion_invalid`；
- 未确认方案 `GET /confirmed` → 404；
- pending/rejected execution 创建推广 → 422。

---

## 7. Theater 与真实事件

- 推广策略/材料是**工具生成**，本轮没有创建 Agent 推广任务，因此没有 Task/Workflow 推广事件；
- 不伪造推广任务、员工提交、发布成功记录；
- 贡献者仅表示真实组织能力匹配，UI 明确说明；
- Theater 仍展示真实 M3.6 审批事件（ApprovalRequested/Granted/Denied）与现有组织事件；
- 现有 Theater 已具备 capability→promotion 映射：若未来 marketing 任务走 M3.5 执行链，事件会归入推广阶段。
- **已知边界**：验收要求的“Theater 展示真实推广任务事件”在本轮没有 Agent 任务可展示；这是主动选择不伪造事件的结果，报告中明确。

---

## 8. M3.8 交接

```http
GET /api/promotions/:id/confirmed
```

只返回 confirmed；含：

- promotionId / promotionVersion
- executionId / planId / planVersion / approvalId
- goal / valueProposition / audience / audienceNeeds / coreMessages
- channels / materials
- schedule / metrics / risks
- summaryText
- confirmedBy / confirmedAt

未确认方案 404；确认不等于发布，无 published 字段。

---

## 9. 测试与构建

| 检查 | 结果 |
| --- | --- |
| 全量测试 | 216 文件 / 1471 测试通过（`vitest run --maxWorkers=4`） |
| M3.7 专项 | 后端 5；web 读模型 3 |
| 架构 | 11 文件 / 62 通过；dependency-cruiser 0 违规 |
| 类型检查 | 全 workspace 通过 |
| Lint | 通过 |
| 前端构建 | 通过 |

> 注：最终全量数字以本轮收尾运行的日志为准；M3.7 新增测试文件为 promotion-http + web promotion。

---

## 10. Git 与保护

- HEAD 仍为 `79b890b`；未 commit/reset/clean/stash/删除文件。
- 未修改正式 3001 数据；3001 仅只读核验，plans/executions/approvals/promotions 为空。
- 未手动停止/重启正式 3001。
- 隔离端口 3211/5183 使用后关闭。
- 未执行任何外部发布。

---

## 11. 已知边界

1. 无 Agent 推广任务，因此没有推广 Task 事件；不伪造。
2. 材料为证据摘要式渠道版本，营销表现需人工补充；不编造市场数据。
3. 单租户单 operator；不做多级推广审批。
4. 确认 != 发布；本阶段禁止发布。
5. 推广方案存 planning store，事件日志仍保存 execution/approval 事实。
