# M3.8 正式发布与业务闭环 · 交付记录

> 日期：2026-11-15 · 基线 HEAD `79b890b`
> 架构契约：[`docs/architecture/M3.8-publication.md`](../architecture/M3.8-publication.md)
> 前序：M3.7 推广 / M3.6 审批 / M3.5 任务实施

---

## 1. 审计结论

**已有：**

- M3.7 confirmed promotion 完整交接；
- 真实 HTML 生成、文件写入与本地 HTTP 托管能力；
- EventStore / Theater / 组织能力；
- M3.5 真实 TaskSystem、M3.6 真实审批链。

**实际可用发布渠道：**

- `local_page`：真实本地正式页面，由 API 提供 URL；
- `local_manifest`：真实本地 manifest；
- `external_wechat`：**不可用**，无连接器/授权/凭证，只记录 `unavailable`。

**没有：**

- 外部社交平台 API/OAuth/发布结果查询；
- 公网托管/CDN。

因此本轮不伪造外部发布，完成真实本地发布闭环。

---

## 2. 实际修改文件

| 文件 | 内容 |
| --- | --- |
| `apps/api/src/publication-events.ts` | 真实 `Document.Publication*` 事件注册与创建 |
| `apps/api/src/planning-types.ts` | PublicationRecord/Version/Attempt/ChannelResult 类型 |
| `apps/api/src/planning-store.ts` | publications 持久化 |
| `apps/api/src/planning-service.ts` | 来源校验、发布版本、preflight、确认、执行、幂等/重试、页面读取、事件 |
| `apps/api/src/api-adapter.ts` | `/api/publications` 系列路由、HTML 页面路由、错误映射 |
| `apps/api/src/composition.ts` | 隔离 publicationDir |
| `packages/organization-control/src/collaboration/theater.ts` | Document publication 事件归类 release |
| `apps/web/src/publication.ts` | 发布读模型 |
| `apps/web/src/pages/Publication.tsx` | 发布工作台 |
| `apps/web/src/publication.css` | 样式 |
| `apps/web/src/theater.ts` / `pages/Theater.tsx` / locales | Theater PublicationCard、发布阶段文案 |
| `apps/web/src/App.tsx` / `control.ts` / locales | 「发布」导航与页面 |
| `tests/integration/publication-http.test.ts` | 来源、确认、成功、幂等、部分失败、失败重试、Theater |
| `tests/integration/publication-restart.test.ts` | 重启一致性 |
| `tests/unit/web/publication.test.ts` | 发布读模型 |

---

## 3. 发布工作台

导航「发布 / Publication」：

- 只列出 M3.7 confirmed promotion；
- 展示 promotion/version、execution、plan、approval、requirement、来源 artifacts/taskIds；
- 最终标题/正文/附件编辑；
- 渠道：本地页面、本地清单、外部渠道（不可用提示）；
- 服务端 preflight 检查；
- 独立内容版本保存；
- 两次人工操作：确认发布 → 执行本地发布；
- 发布结果 URL、渠道结果、失败原因、attempt 历史；
- 已发布/部分成功/失败状态；
- 明确标注这是本地 MAOEH 发布，不是外部平台。

---

## 4. 最终内容版本与确认

- 创建 publication v1 draft，内容来自 confirmed promotion；
- 人工编辑标题/正文/附件/渠道 → 新独立版本；
- `baseVersion` 乐观锁；
- 确认需要 `{confirm:true}`；只允许 draft；
- 确认后 `ready`，记录 confirmedBy/At；
- 执行发布需要再次 `{confirm:true}`；
- 打开/保存/preflight 都不会发布；
- 不修改 M3.7 promotion。

---

## 5. 真实发布过程与证据

隔离 API 3211、临时 planning 目录、真实 confirmed promotion（来自 M3.6 approved `exec-1` / M3.7 live）。

| 项 | 值 |
| --- | --- |
| publication | `publication-1` |
| 初始 | v1 draft |
| 最终 | **v3 published** |
| promotion | `promotion-1` v3 confirmed |
| execution | `exec-1` |
| plan | `plan-1` v2 |
| approval | `approval-1` |
| requirement | `req-1` v3 |
| source artifacts | technical-design.md、index.html、qa_report |
| taskIds | task-1、task-2、task-3 |
| confirmedBy | ceo-alex |
| publishedBy | ceo-alex |
| 本地页面 | `/api/publications/publication-1/page?v=3` |
| 页面 HTTP | 200，约 1845 bytes |

真实写入：

```text
<temp planning>/publications/publications/publication-1/v3/index.html
<temp planning>/publications/publications/publication-1/v3/manifest.json
```

页面由 API 返回 `text/html`，内容含 `LOCAL PUBLICATION` 与正式标题。证据：

- `.maoeh/audit/m38/live-acceptance.json`
- `.maoeh/audit/m38/live-acceptance-published.json`
- `.maoeh/audit/m38/published-page.html`

### 部分渠道

v2 曾选择 `local_page + external_wechat`：

- local_page：published，真实 URL；
- external_wechat：unavailable，无 URL，错误为 no external connector / credentials；
- publication status `partial`。

随后 v3 改为 local_page + local_manifest，得到完整 `published`，v2 历史保留。

---

## 6. 幂等、失败、重试与重启

| 场景 | 结果 |
| --- | --- |
| 已 published 重复 publish | 返回原记录，`idempotent:true`，attempt 不增加 |
| 同进程并发 | in-flight 拒绝 |
| 外部渠道 | unavailable，不伪造成功 |
| 本地写入失败 | 真实 failed，错误保存 |
| 安全重试 | 新内容版本重新确认后发布成功；历史失败 attempt 保留 |
| 重启 | publication 记录、状态、URL、页面文件保持一致 |
| 后续 draft | 已发布页面仍可读取（取最新 published/partial 版本） |

---

## 7. Theater

真实事件：

- `Document.PublicationDrafted`
- `Document.PublicationConfirmed`
- `Document.PublicationPublished`
- `Document.PublicationPartiallyPublished`
- `Document.PublicationFailed`

live 校验：

```text
Document.PublicationDrafted stage=release basis=event-type
Document.PublicationConfirmed stage=release basis=event-type
Document.PublicationPartiallyPublished stage=release basis=event-type
Document.PublicationPublished stage=release basis=event-type
```

Theater 增加真实 PublicationCard；不承担发布逻辑。

---

## 8. 七阶段闭环

从 `publication-1` 可回溯：

1. requirement `req-1` v3 confirmed；
2. orchestration `orch-1` v1 ready；
3. plan `plan-1` v2 confirmed；
4. execution `exec-1`，approval 记录 task-1/2/3 与 3 个 artifacts、after completed；
5. approval `approval-1` approve by ceo-alex；
6. promotion `promotion-1` v3 confirmed；
7. publication `publication-1` v3 published。

`publication` 自身保存 requirement/plan/approval/promotion 版本、taskIds、sourceArtifacts、确认人/时间、发布结果与 URL。

说明：live 隔离运行使用 `eventLogPath:null`，重启后 M3.5 execution view 的 workflow instance 不可重建，显示 `not_started`；但 approval 记录保存了真实 taskIds、artifacts 与 after=completed，publication 从 approval/promotion 追溯。完整任务视图/重启由带持久事件日志的集成测试覆盖。

---

## 9. 测试与构建

| 检查 | 结果 |
| --- | --- |
| 全量测试 | **219 文件 / 1480 测试通过** |
| M3.8 专项 | 后端 publication 5；restart 1；web 读模型 3 |
| 架构 | 11 文件 / 62 通过；dependency-cruiser 0 违规 |
| 类型检查 | 全 workspace 通过 |
| Lint | 通过 |
| 前端构建 | 通过 |

覆盖：来源校验、未确认拒绝、内容版本、人工确认、成功、幂等、外部不可用、部分成功、失败重试、重启、Theater、七阶段字段追溯。

---

## 10. Git 与服务保护

- HEAD 仍为 `79b890b`；
- 未 commit/reset/clean/stash/删除文件；
- 保留全部已跟踪修改与未跟踪文件；
- 未修改正式 3001 数据；3001 只读核验，plans/executions/approvals/promotions/publications 为空；
- 未手动停止/重启正式 3001；
- 隔离 3211/5183 验证后关闭；
- 未使用外部账号发布任何内容。

---

## 11. 未完成事项与边界

1. 无外部平台授权，未接入外部发布；`external_wechat` 只记录 unavailable。
2. 本地页面由 MAOEH API 提供，不是公网托管。
3. 无自动发布；确认与执行均为人工动作。
4. 单租户单 operator。
5. live 隔离数据使用 `eventLogPath:null`，M3.5 execution view 重启后无法重建 workflow 实例；审批记录/发布记录仍保留真实 taskIds/artifacts/after；完整重启一致性由持久事件日志集成测试覆盖。
6. 本阶段完成后停止，不进入 M4。
