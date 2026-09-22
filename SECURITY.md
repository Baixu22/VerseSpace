# 安全策略

## 报告漏洞

**仓库目前是私有的**，因此 GitHub 的 Private vulnerability reporting 不可用——2026-09-23 实测 `PUT /repos/Baixu22/VerseSpace/private-vulnerability-reporting` 返回 `404`，`security_and_analysis` 为空。当前可用的渠道只有：

- 开一个 issue，标题注明 `[security]`（私有仓库里只有维护者可见）；
- 或在任何已有 PR / issue 里直接 @Baixu22。

**仓库转公开前必须补上**：Settings → Code security 里开启 Private vulnerability reporting，并把本节的渠道换成 <https://github.com/Baixu22/VerseSpace/security/advisories/new>。公开仓库上用普通 issue 报告漏洞会让问题在修复前就可见。

请在报告里尽量给出：受影响的版本或提交、复现步骤、影响面，以及你判断的严重程度。这是个人维护的项目，没有 SLA；会尽力在合理时间内回复。

## 支持的版本

只维护**最新一个发行版**与 `main`。旧版本不回补补丁，请先升级再报告。

## 威胁模型

Workbench 是**本地优先**工具：账本存在项目内的 `.workbench/`（YAML + JSONL），本地面板由 `workbench ui` 提供。它的安全边界按「同一台机器上已经有其他进程在跑」来设计。

### 已经做到的

- **只绑回环。** `workbench ui` 的 HTTP 服务绑 `127.0.0.1`（`packages/workbench/src/ui/server.ts:103`），不监听外部网卡。
- **Host 校验防 DNS rebinding。** 每个请求先检查主机名是否属于 `127.0.0.1` / `localhost` / `::1`，否则一律 `403`（`server.ts:48-52`）。浏览器无法伪造 `Host`，所以外部页面不能借 rebinding 打到本地面板。
- **每个 `/api` 路由都要令牌。** 令牌是每次启动生成的随机 UUID，只通过 `GET /api/bootstrap` 交给同源前端；其余 `/api` 请求缺令牌或令牌不符一律 `401`，**GET 也不例外**（`server.ts:39,56-63`；断言见 `ui/server.test.ts:87-104`）。
- **不发任何 CORS 头。** 跨源读取正是被拒绝授予的能力，因此连 `Access-Control-Allow-Origin` 都不出现。

### 明确不在范围内

- **同机上的其他进程。** 任何能以你的身份运行的本地进程本来就能直接读写 `.workbench/`、`.claude/` 与项目文件，也能从回环地址取到 `/api/bootstrap` 的令牌。本地进程不是本项目的隔离边界——要防它得靠操作系统账户隔离。
- **把 `workbench ui` 暴露到公网。** 不要用反向代理、端口转发或隧道把面板端口暴露出去。没有 TLS、没有多用户、没有速率限制，令牌模型也是为单用户本机设计的。
- **`workbench` 管理的项目内容。** 账本记录的是读写足迹与前提证据，不保证被管理项目里第三方代码或依赖的安全性。
- **agent / CLI 车道自身的权限模型。** Workbench 监督外部 CLI（如 Claude Code、codex）并按声明记录足迹，但它不是这些 CLI 的沙箱；它们各自的权限与信任模型由各自项目负责。

## 已知的诚实边界

- **足迹覆盖有限，沉默不代表前提全部有效。** 读集只对可观测的车道（如 Claude CLI 工具足迹）成立；HTTP 纯文本 provider 可聊天但读集不可观测，不参与读集继承。不要把「账本没报警」读成「没有前提失效」。
- **面板写端点按 [ADR-0012](docs/decisions/0012-gui-write-endpoint-admission.md) 逐端点准入**，线程删除是唯一不可撤销操作。新增写端点必须先过该准入规则。
