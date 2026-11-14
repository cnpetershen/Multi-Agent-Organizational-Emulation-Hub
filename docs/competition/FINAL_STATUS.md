# MAOEH 最终状态（FINAL_STATUS）

- 核实时间：2026-11-14 20:20–21:00（Asia/Shanghai）
- 核实方式：最新源码 + 运行中的进程 + 真实浏览器（headless Edge + CDP）+ 真实 DeepSeek 调用 + 全量门禁
- 原则：只写有证据的结论；旧入口与新产品分开陈述；真实不足保留

---

## 0. 结论速览

| 核实项 | 结论 | 证据 |
| --- | --- | --- |
| 新 API 工作台完成四角色 AI 质询 | ✅ 是（浏览器实跑，4 角色 / 4 条消息 / 评分 78 / 4 条评分全部引用具体消息） | `.maoeh/audit/browser/run-2026-11-14T12-33-58-538Z/` |
| Results 页链接到新工作台 | ✅ 是（iframe 与“全屏打开”均指向 `/api/sandbox`，页面内无旧链接） | 同上 `report.json.checks.results` |
| 旧 `sandbox.html` 是否仍被访问 | ⚠️ 已从 Web 应用移除并归档；归档后 `/sandbox.html` 只返回 SPA 外壳，不再返回旧页面 | `docs/competition/legacy/sandbox-manual.html` |
| 一鱼多吃四平台均为真实 LLM | ✅ 是（4 次调用，`LLM · deepseek-flash`，四平台文案不同） | 同上 `checks.studio` + `.maoeh/audit/content-studio/...` |
| 生成结果可编辑/审核/导出 | ✅ 浏览器内完成编辑、通过审核（1/4）、导出 JSON（含编辑与审核状态） | 同上 `checks.studio` |
| 图片/音频/视频 | ❌ 未实现（只有文本 provider） | 见 §6 |
| 真实双 Agent 协作 | ✅ 两次独立运行，因果链完整，任务闭环 | §3 |
| 全量测试 | ⚠️ 见 §2（真实数字与退出码，不粉饰） | `.maoeh/logs/test-final*.log` |
| 构建 | ✅ `turbo run build --force` 33/33，dist 含新路由 | §2.1 |

---

## 1. 赛博沙盘核实

### 1.1 新入口是真实会话，不是旧页面改名

- 入口：`http://localhost:3001/api/sandbox`（经控制台代理时 `http://localhost:5173/api/sandbox`）。
- 实现：`apps/api/src/sandbox-session.ts` + `sandbox-page.ts`，跑在**独立组装运行时 + 独立事件日志**（`%LOCALAPPDATA%\maoeh\sandbox\events.jsonl`），不写入演示公司日志。
- 角色来自真实组织：提案方 CTO John、质询方 QA Peter、答辩方 Engineer Mike、评审 CEO Alex；姓名、岗位、职责来自真实定义。
- 每条发言经 `CommunicationService` 授权、成员校验、写入 `Communication.MessageSent` 并真实投递；transcript 就是这些事件。
- 评审返回 JSON，每个维度带 `evidence` 与 `messageId`；解析器校验该 id 必须存在于本次会话，否则标注“未引用具体发言”。

### 1.2 浏览器完整操作（headless Edge + CDP，真实点击）

证据目录：`.maoeh/audit/browser/run-2026-11-14T12-33-58-538Z/`

| 步骤 | 结果 |
| --- | --- |
| 从 Foundry 门禁进入 **Peter AI Lab**（按公司名选择，不点第一个） | ✅ 进入后公司名校验为 Peter AI Lab |
| 打开 `/results/task-44` | iframe `src=/api/sandbox`，链接 `href=/api/sandbox`，旧链接 0 个；iframe 内 title 为“赛博沙盘 · 多角色对抗质询”，且 `#start` 存在 |
| 打开 `/api/sandbox`，填议题、回合=1、点“开始对抗质询” | ✅ 4 条消息后状态显示“会话完成” |
| 读取 transcript / 评分 | 4 角色：提案方 John、质询方 Peter、答辩方 Mike、评审 Alex；评分 **78/100**；**4/4 条评分均引用具体 `msg-1/2/3/3`**；provenance 显示 `LLM · deepseek / deepseek-flash` |
| 点历史会话回看 | ✅ 重新渲染 4 条消息、评分 78 |
| 截图 | `01-results-sandbox-panel.png`、`02-sandbox-session.png`、`03-sandbox-history.png` |

浏览器判定（`report.json.verdict`，10 项全 true）：

```
resultsPointsToNewWorkbench, sandboxHasFourRoles, sandboxHasFourTurns,
sandboxScoredWithCitations, sandboxHistoryReopens, studioGeneratedFour,
studioIsLiveLlm, studioEditAndApprove, studioExportContainsEdit, legacyNotLinked
```

### 1.3 旧入口的处置（明确区分）

- 旧页面 `apps/web/public/sandbox.html` 是**人工逐条输入、人工切角色、前端按消息数与关键词计分**的演示外壳，**不是** AI 多角色质询。
- 已归档到 `docs/competition/legacy/sandbox-manual.html`，并在同目录 `README.md` 写明“仅为历史存证，不是产品、不再由 Web 提供”。
- 已从 `apps/web/public/` 删除；重新构建后 `apps/web/dist/sandbox.html` **不存在**。
- 归档后访问 `/sandbox.html` 返回 623 字节的 SPA 外壳，**不含**旧页面标记 `maoeh-cyber-sandbox-v1`。
- Results 页已不再引用旧页面（`checks.results.legacyLinks === 0`）。
- **无法证明“用户过去是否手动访问过旧页面”**：仓库没有该静态文件的访问日志。能证明的是“应用内已无入口、旧页面不再被提供”。

---

## 2. 构建与测试核实

### 2.1 构建

```powershell
pnpm exec turbo run build --force
# Tasks: 33 successful, 33 total（0 cached）
```

dist 路由核对（`apps/api/dist/api-adapter.js`）：

```
POST /content/generate
GET  /api/studio
POST /sandbox/session
GET  /sandbox/sessions
GET  /sandbox/sessions/:id
```

`apps/api/dist/sandbox-session.js`、`sandbox-page.js` 均存在（20:37:44 重建）。

### 2.2 全量测试（真实日志，未改断言）

| 运行 | 文件 | 测试 | 通过 | 失败 | 退出码 |
| --- | --- | --- | --- | --- | --- |
| 最终全量 #1（20:38） | 173 | 1254 | 1253 | 1 | **1** |
| 失败项单独复跑（20:40） | 1 | 2 | 2 | 0 | **0** |
| 最终全量 #2（20:41） | 173 | 1254 | **1254** | 0 | **0** |

同一份代码、同一份断言，两次全量之间没有改任何东西：一次撞上已知的预览子进程超时，一次全绿，失败项单独复跑也通过。这正说明它是环境/负载敏感的 flake，而不是代码缺陷被掩盖。

失败项固定为 `tests/integration/preview-runtime-http.test.ts`：全量并行时真实预览子进程在 60s 内未启动（`timed out waiting for the preview to start`）；单独复跑 **2/2 通过，1.5s**。归因：**环境/负载敏感**，不是本次改动引入（该文件自审计基线起即如此；19:56 的一次全量运行为全绿 1254/1254）。

日志：

```
.maoeh/logs/test-final.log            最终全量 #1
.maoeh/logs/test-preview-rerun.log    失败项单独复跑
.maoeh/logs/test-final-2.log          最终全量 #2
```

其它门禁：

```
pnpm typecheck            exit 0（53/53）
pnpm lint                 exit 0
pnpm architecture:check   exit 0（10 文件 / 55 测试；depcruise 0 违规）
```

> 未修改、未删除任何断言来制造绿色。全绿的那次（19:56）与失败的这次（20:38）跑的是同一份断言。

---

## 3. 真实 Agent 协作核实

两次独立隔离运行（不同时间、不同事件日志、每次重新调用真实 DeepSeek）：

| 运行 | verdict | 任务 | 消息 |
| --- | --- | --- | --- |
| `run-2026-11-14T11-06-04-819Z` | 6/6 true | task-1 completed | cto-john → engineer-mike（request）、engineer-mike → cto-john（response） |
| `run-2026-11-14T11-40-38-681Z` | 6/6 true | task-1 completed | 同上 |

因果链（两次结构一致）：

```
msg1 (cto → mike, request)      causationId = evt-4  (Task.Assigned)
msg2 (mike → cto, response)     causationId = evt-7  (msg1 的事件)
cto cycle 3 (采纳并提交)          causationId = evt-11 (msg2 的事件)
correlationId：两次各自全程一致
任务生命周期：Created → Assigned → Accepted → Started → ProgressReported → Completed
```

隔离性核对：

- 演示公司日志 `peter-ai-lab/events.jsonl` 中 `Communication.*` 事件 **仍为 1 条**（公司频道开通），会话消息全部在各自隔离日志里。
- 沙盘会话在 `%LOCALAPPDATA%\maoeh\sandbox\events.jsonl`，与演示公司日志分离。

---

## 4. 一鱼多吃核实

### 4.1 四平台真实 LLM

浏览器运行（20:34）：`provenance = LLM · deepseek / deepseek-flash · 4 次调用`，4 张卡片：

| 平台 | 长度（历史证据） | 浏览器实跑 |
| --- | --- | --- |
| 小红书 | 443 字 | 播客剪辑痛点 + emoji 要点 |
| 抖音 | 341 字 | 前 3 秒钩子 + 分镜 |
| B站 | 468 字 | 章节时间轴（0:00 起） |
| 公众号 | 821 字 | 3 个备选标题 + 正文小标题 |

两两 4-gram 最大重合度 0.098 / 0.098 / 0.071（历史证据 `.maoeh/audit/content-studio/run-2026-11-14T11-21-01-751Z/`）。

### 4.2 编辑 / 审核 / 导出（浏览器内完成）

- 编辑：向第一张卡片追加“（人工补充：已按运营要求加上合规提示。）”并触发 `input`；
- 审核：点“通过审核”，状态变为 `已审核 1 / 4`，卡片出现“已审核”徽章；
- 导出：点“导出 JSON”，导出的 4 个 asset 中第 1 条 `approved=true`，文本包含刚追加的编辑；`provenance=live`。
- 导出方式：headless 下载策略未落盘，脚本通过拦截 `URL.createObjectURL` 的 Blob 文本取得同一份导出内容（`exportedVia=blob`）；页面导出代码路径真实执行，未伪造。

### 4.3 未实现

**图片、音频、视频生成均未实现**。当前 LLM 网关只有文本 provider，没有图像/语音/视频模型接入；页面与文档不得声称已生成图片。

---

## 5. 数据边界与副作用披露

| 事项 | 事实 |
| --- | --- |
| 演示公司日志 | 只追加：`Communication.ChannelOpened` ×1（修复）、task-10 恢复事件、task-41 结项事件；**无删除、无改写** |
| 浏览器首次尝试误切公司 | Foundry 第一个公司是 `Future AI Lab`（lab 种子），脚本误点后把运行时切走约 5 分钟；期间只向 `future-ai-lab/events.jsonl` 追加 **456 条 `System.SimClockTicked`** 空转标记（无任务/消息/工作流）；已切回 `peter-ai-lab` 并核验（7 名员工） |
| 沙盘会话 | 成功 2 次（各 4 条消息），另有 1 次失败尝试留下的空频道 `sandbox-20261114122659-3012`（0 条消息、无索引） |
| 密钥 | 未出现在终端、日志、文档；已扫描 `sk-` 模式为 0 |

---

## 6. 真实不足与未验证（保留）

**未实现**

- 图片 / 音频 / 视频生成。
- 协作剧场“任务交接 + 关键决策”时间线视图。
- 沙盘：并发会话队列、评分解析失败重试、失败会话的显式记录（失败尝试会留下空频道且不出现在历史列表）。
- 认知异构：7 个 Agent 的认知画像仍全部是 `exec-strategic`。
- 新员工加入后的频道成员自动更新（需要 `Channel.MembersChanged` 类事件）。
- 项目页去重逻辑：同名的“已完成”项目会隐藏一个“尚未开始”的同名项目（当前演示数据已全部终结，不会触发）。

**未验证**

- 沙盘多轮（2–3 轮）真实运行的稳定性（本轮只跑了 1 轮真实会话，两次）。
- `RequestCollaboration` 由真实模型自主选择（动作空间与契约已修，未做真实复跑）。
- 旧 `sandbox.html` 的历史人工访问情况（无访问日志，无法证明或证伪）。
- 浏览器 E2E 覆盖面：只验证了 Foundry → Results → 两个工作台，未跑全站 e2e。

---

## 7. 证据索引

```
docs/competition/TONIGHT_AUDIT.md                       审计（含全部源码/运行证据）
docs/competition/FINAL_STATUS.md                        本文
docs/competition/TEACHER_BRIEFING.md                    汇报材料（最新）
docs/competition/legacy/sandbox-manual.html             旧人工沙盘页（归档，不再提供）
docs/competition/legacy/README.md                       归档说明

.maoeh/audit/browser/run-2026-11-14T12-33-58-538Z/
  report.json                                           浏览器 10 项判定 + 全部读数
  screenshots/01-results-sandbox-panel.png              Results 页嵌入新工作台
  screenshots/02-sandbox-session.png                    四角色会话 + 引用式评分
  screenshots/03-sandbox-history.png                    历史会话回看
  screenshots/04-content-studio.png                     一鱼多吃生成/审核
  content-assets.json                                   导出的内容资产（含编辑与审核）

.maoeh/audit/collaboration/run-2026-11-14T11-06-04-819Z/
.maoeh/audit/collaboration/run-2026-11-14T11-40-38-681Z/
.maoeh/audit/content-studio/run-2026-11-14T11-21-01-751Z/
.maoeh/audit/sandbox/run-2026-11-14T11-50-50-260Z/

.maoeh/logs/test-final.log / test-final-2.log / test-preview-rerun.log
.maoeh/logs/typecheck-final.log / lint-final.log / architecture-final.log
```

回滚点：`git tag checkpoint-2026-11-14-night`（详见 §8）。

---

## 8. 回滚点与可运行版本

- 代码回滚点：分支 `checkpoint/2026-11-14-night`，标签 `checkpoint-2026-11-14-night`（该标签指向的提交即本文件所在的可运行状态）。
- 提交内容：当前可运行状态的源码、docs、scripts、测试；**不含** `.env`、`.maoeh/`（运行状态）、`.tmp-*`（临时抓取）、`deliverables/`（已交付数据）。
- 运行中的可运行版本（20:49 重启后核验）：
  - API：`http://localhost:3001`，公司 **Peter AI Lab**，7 名员工，已恢复 83,696 条事件
  - `/api/llm`：`mode=live, provider=deepseek, model=deepseek-flash`
  - `/api/communications`：1 条（公司频道），无会话污染
  - `/api/studio`、`/api/sandbox`：200；`/api/sandbox/sessions`：2 条历史会话
  - 控制台：`http://localhost:5173`
- 恢复旧行为：`git checkout checkpoint-2026-11-14-night`（或从该提交重开分支）；旧人工沙盘页仍保存在 `docs/competition/legacy/sandbox-manual.html`。
