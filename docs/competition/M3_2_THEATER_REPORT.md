# M3.2 协作剧场 · 交付与验收记录

> 日期：2026-11-15 · 基线：`feat/m2-workflow-closed-loop`（HEAD `79b890b`）
> 架构契约：[`docs/architecture/M3.2-collaboration-theater.md`](../architecture/M3.2-collaboration-theater.md)
> 前序：M3.1 协作协议 / M3.0 遗留核查

---

## 1. 交付内容

| 能力 | 实现 |
| --- | --- |
| 真实员工舞台 | 姓名、职位、部门、当前任务、空闲/暂停、最近行动高亮（来自 `snapshot` + 真实事件） |
| 实时协作 | `GET /api/theater/stream?cursor=<seq>` SSE，直接读公司事件日志；断线按 seq 续传、按 seq 去重 |
| 消息动态 | 发送者 → 接收者、正文、`MessageProcessed` 处理结果（已处理/失败/等待接收方） |
| 任务交接 | 一条交接链合并为一张卡：双方、任务标题、状态（请求/接受/拒绝/结算）、原因、结果 |
| 协作时间线 | 真实事件按时间倒序；只展示可读协作事实，过滤时钟与 Runtime 遥测 |
| 历史回放 | 按 `correlationId` 载入真实会话；播放/暂停/单步/倍速；只读，不重执行 |
| 运行控制 | 暂停/继续调用真实 `Simulation.Pause/Resume`；Running/Paused 读 `snapshot.simulation.paused` |
| 七阶段兼容 | 需求沙盘 / 智能体编排 / 调整画布 / 任务实施 / 审批 / 推广 / 发布 + 未归类；只按事件类型或能力证明归类 |
| 中英切换 | `theater.*` 全量 locale；切换后阶段、卡片、回放全部跟随 |

### 关键文件

- `packages/organization-control/src/collaboration/theater.ts` — 七阶段裁定、`TheaterStageTracker`、逐事件投影
- `packages/organization-control/src/query.ts` — `getTheaterHistory()`、`getEventPage()`
- `apps/api/src/theater-stream.ts` — SSE 游标/心跳/断线/公司切换/错误校验
- `apps/api/src/composition.ts` — SSE 路由在缓冲适配器之前直写 Node response
- `apps/web/src/theater.ts` — 客户端读模型（去重、消息/交接合并、会话分组、可见性）
- `apps/web/src/useTheaterStream.ts` — EventSource + 游标续传 + 重连
- `apps/web/src/pages/Theater.tsx` + `theater.css` — 协作剧场页面
- `docs/architecture/M3.2-collaboration-theater.md`

---

## 2. 真实环境验收（只读）

浏览器：真实 Edge headless，打开 `http://127.0.0.1:5173`，当前公司 `peter-ai-lab`。

| 项 | 观察 |
| --- | --- |
| 页面 | 渲染成功，标题「公司此刻如何协作」 |
| 员工 | 7 名真实 AI 员工，含职位/部门/当前工作 |
| 实时状态 | 徽标「实时」（SSE hello 已到达）；运行状态「运行中」与 `/api/simulation.paused=false` 一致 |
| 七阶段 | 全部动态 127；需求沙盘 13；智能体编排 2；调整画布 2；任务实施 89；审批 9；推广 10；发布 0；尚未进入业务阶段 2 |
| 协作卡片 | 127 张可见事件卡片（任务完成/取消/提交、任务书、暂停/恢复等） |
| 回放 | 点击「工作会话」→ 载入 2 条真实事件，进度 2/2，卡片与原始事件一致 |
| 中英切换 | `How the company is working, right now`；阶段 `All activity`；回放 `Work session` |
| Console error | 0 |

截图（本机 `.maoeh`，不提交）：`.maoeh/audit/theater-ui/theater.png`、`theater-replay.png`、`summary.json`。

> 说明：浏览器加载需要当前公司会话，页面调用了既有的 `/api/ownership/session` 确认当前公司（同一 `peter-ai-lab`），因此 `companies.json` 的 mtime 变化；**没有**创建/修改任何任务、消息、审批或公司事件。验收期间没有点击暂停/继续按钮（避免改动正式演示状态）。

---

## 3. 自动化验证

| 类别 | 结果 |
| --- | --- |
| 全量测试 | **201 文件 / 1401 测试全部通过**（33s；安静系统下运行） |
| M3.2 专项 | 阶段 7 + SSE 帧/游标 5 + 客户端读模型 12 + API 读端点 6 + SSE 集成 1 = 31 |
| 架构测试 | 11 文件 / 62 测试通过；dependency-cruiser 全仓 0 违规 |
| 类型检查 | 全 workspace `tsc --noEmit` 通过 |
| Lint | ESLint 全仓通过 |
| 前端构建 | `pnpm --filter @maoeh/web build` 通过（625 KB JS / 157 KB CSS） |

集成测试 `tests/integration/theater-stream-http.test.ts` 覆盖：

1. history 返回真实事件 + `latestSeq`，且不含 System/Runtime 遥测；
2. SSE 返回 `text/event-stream` 与 hello 游标；
3. `POST /api/command` 真实 Pause → `/api/simulation.paused=true`；Resume → SSE 收到 `Control.SimulationResumed`，状态回到 false；
4. 断开后以最后 `seq` 重连，只收到新事件，`id` 无重复；
5. 会话回放的事件与实时事件逐字段一致（seq/eventId/type/stage）；
6. 跨公司读 409、非法游标 400。

---

## 4. 运行环境保护

- HEAD 仍为 `79b890b`；**未提交、未 reset/clean/stash、未删除任何文件**。
- 所有既有未提交修改与未跟踪文件保留。
- 3001 未收到任何停止/重启命令；它由既有 `turbo watch build dev` + `node --watch` 托管，源码变更后 watcher 自动重建并重启了 API 子进程（本会话观察到最后一次为 10:56:53）。演示前若需冻结构建，应先停止 watcher。
- 正式公司事件日志没有任何由本轮产生的业务事件；SSE/回放/页面读取均为只读。

---

## 5. 遗留问题

1. `preview-runtime-http` 在**全量并发**下偶发超时（本轮一次 4 失败是系统高负载造成的连环超时；安静环境全量 1401/1401 通过，该用例单独运行也通过）。属于既有测试的时序脆弱，不是 M3.2 代码路径。
2. SSE 每次连接做一次全量扫描取 `latestSeq`/prime；13 万事件规模可用，更大规模需 latest-seq 索引或分页。
3. 历史回放按 `limit` 截断（200/300），超长会话尚未分页。
4. 七阶段依赖 capability 与事件类型证据；旧任务无 capability 时默认任务实施，未归类桶保留给消息/操作控制等无阶段事实。
5. 无登录（本机单租户设计）；SSE 只做公司作用域校验。
6. 本阶段不开发需求沙盘/智能体编排/调整画布/推广/发布的产品模块，只提供阶段关联能力。
