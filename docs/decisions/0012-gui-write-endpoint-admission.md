# ADR-0012：GUI 写操作端点的准入决策

- 状态：已接受（2026-09-15）；2026-09-16 按生产入口订正。
- 收敛：ADR-0005 的「后续逐个评估」与「写操作端点未来需逐个设闸」。
- 森林节点：TF-0174，归属 TF-0138；已通过任务森林 CLI 完成正式复核，状态 done。
- 相关：ADR-0005、ADR-0010、[收尾扫描](https://github.com/Baixu22/VerseSpace/blob/799f89cd94ce774458e70c822bf116350d73fcb6/docs/closeout-scan-2026-09-15.md)、[本次复核](https://github.com/Baixu22/VerseSpace/blob/799f89cd94ce774458e70c822bf116350d73fcb6/docs/issue-9-closeout.md)。

## 决策

保留现有 GUI 写端点。所有端点使用同一个 Blackboard 和领域模块；已经有 CLI 的操作共用执行逻辑，会话交互中尚无 CLI 命令的部分明确列为 GUI 范围。不可恢复的会话删除必须由用户确认。

2026-09-16 核对发现，初版的「所有写端点都有 CLI 等价命令」「批处理 agent 可由聊天 cancel 取消」「所有写入都是追加事件」不符合源码。本文纠正这些描述，不为满足文字上的对称性新增一套 CLI，也不把事件日志称为所有状态的可逆备份。

四条准入判据：

1. 经过现有的回环地址、请求 hostname 校验、每次启动的随机令牌和同源限制。
2. 写入复用领域模块；记录实际副作用及已有并发约束，不把日志等同于撤销能力。
3. 永久删除必须在客户端获得明确确认。重新生成回复、发起模型调用等动作明确呈现其行为，不声称已经发生的修改或费用可以撤销。
4. 有 CLI 的操作保持同源；无 CLI 的会话手势在本文登记，不另建平行业务逻辑。

## 共同边界

`packages/workbench/src/ui/server.ts` 只绑定 `127.0.0.1`，拒绝不在回环白名单内的 hostname。除 `GET /api/bootstrap` 外，API 请求必须携带本次进程的 `x-workbench-token`。不发送跨域授权头；静态资源读取检查目录边界。

聊天配置响应通过 `publicChatConfig` 去除密钥，只返回是否已配置。恢复观测及聊天配置使用 schema 校验，其余端点按各自处理器检查必填字段。不能把这些检查概括成「所有请求都经过同一个严格 schema」。

## 路由清单

按 HTTP 方法和路径计数，共 **27 条**：只读 6 条、同步 1 条、其他写入 5 条、会话写入 15 条。下表中的 `:id` 前缀为 `/api/chat/threads/:id`。

只读端点保持开放：

| 方法与路径 | 用途 |
| --- | --- |
| GET /api/bootstrap | 同源握手，返回本次令牌 |
| GET /api/state | 黑板聚合状态及 reconcile 失败信息 |
| GET /api/config/chat | 脱敏聊天配置 |
| GET /api/chat/threads | 会话列表 |
| GET /api/chat/threads/:id | 会话详情 |
| GET /api/chat/threads/:id/evidence | 可追溯的文件证据 |

同步及其他写入均准入：

| 方法与路径 | 执行入口与约束 | 副作用及 CLI 关系 |
| --- | --- | --- |
| POST /api/sync | `runOnce`；运行锁忙时 409 | 推进当前状态、验证及调度；共用 `workbench sync`。这是状态推进，不是只读查询，也不承诺任意连续调用完全无副作用 |
| POST /api/dispatch | `dispatchGoal`；目标检查、WIP 准入、merge-guard 建议 | 派发任务，可能创建工位；共用 `workbench dispatch`。不宣称自动回滚整次派发 |
| POST /api/agent/run | `startAgent`；工位存在性、崩溃熔断和车道挂起检查 | 启动批处理并可能产生费用、修改文件；共用 `workbench agent run`。进程由 supervisor 管理，聊天 cancel 不控制这条通道 |
| POST /api/review | `reviewCheckpoint`；要求 cpId 和布尔 approve | 改变检查点评审状态；对应 `workbench checkpoint review`，不存在 `tribunal review` 命令 |
| POST /api/chat/feedback | 追加反馈事件 | GUI 中的用户反馈入口；不把脚本调用算作自然用户认可。当前无独立 CLI 镜像 |
| PATCH /api/config/chat | 配置 schema、`config.save`、脱敏响应 | 更新持久化配置；与 `workbench config set` 共用配置存储，但字段约束不同。配置文件不是追加式事件日志 |

会话写入均由 `ChatThreads` 执行；当前 CLI 没有对应的 chat 命令族：

| 方法与路径 | 实际行为与准入理由 |
| --- | --- |
| POST /api/chat/threads | 创建会话；允许无标题开始 |
| POST :id/messages | 发送消息并流式运行模型；运行中的轮次被拒，已有串行调度 |
| POST :id/cancel | 取消该聊天会话的进程；已发生的文件写入不随取消撤销 |
| POST :id/reload | 截断可重新生成的会话尾部并返回用户文本；重发不恢复旧助手输出 |
| POST :id/promote | 为无名会话晋升标题；已命名时保留原值 |
| POST :id/fork | 从指定锚点派生新会话；源会话内容保持不变 |
| POST :id/leave | 记录离开并生成恢复笔记 |
| POST :id/switch | 记录切换 |
| POST :id/restore | 校验并记录本轮恢复观测 |
| POST :id/resume-note/consume | 记录恢复笔记被消费 |
| POST :id/resume-note/dismiss | 记录恢复笔记被收起 |
| POST :id/resume-action | 校验并记录恢复动作 |
| PATCH :id/resume-note | 更新恢复笔记；可再次编辑 |
| PATCH :id | 更新标题、权限模式或归档标记；按处理器规则保存状态 |
| DELETE :id | 永久移除会话目录；前端确认后才发送 DELETE |

会话生命周期事件保持 `source=threads` 的观测语义，世界投影不折叠它们。线程元数据、转录和配置还包含普通文件写入；不能因为有观测事件就宣称全部状态只追加、全部可回放。

## 删除确认

`apps/workbench-ui/src/chat/store.ts` 的 `deleteThread` 先调用原生 `confirm`。取消时不发 DELETE，不清理本地会话；确认后才请求服务端删除。该闸保护 GUI 中的删除操作，不把 API 令牌或测试脚本当成人工确认。

不引入软删除、权限分级或第二套状态存储。删除确认的取消和确认路径已有回归测试。

## 后续复核

新增写端点时，登记 HTTP 方法、领域入口、副作用、并发约束和 CLI 关系，再核对上述四条判据。不要复用已经证伪的「存在接口即已完成」「有事件即可撤销」描述。

`server.test.ts`、聊天路由测试和 `apps/workbench-ui/src/chat/delete-confirm.test.ts` 验证相关行为。真实批处理验证另见 [issue #11](https://github.com/Baixu22/VerseSpace/blob/799f89cd94ce774458e70c822bf116350d73fcb6/docs/issue-11-closeout.md)，不能由路由准入记录替代。
