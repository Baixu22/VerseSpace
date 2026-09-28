# 2026-09-28 README、验证范围与发行收尾

## 结论

本轮是工程研究原型的文档与发行准备，不是产品效益验收。候选版本为 0.4.1，未推 tag、未创建 Release。GitHub CLI 未登录（exit 4），公开 API 返回 404，不能独立确认现有 Release 资产。远端 Git 成功列出到 workbench-v0.4.0 的 tag，无 workbench-v0.4.1。

## 文档核对与修正

- 当前 App.tsx 挂载 WorkbenchShell 聊天界面。首页原先把 CLI 的目标 DAG、工位、checkpoint 等说成现行面板页面，已改成真实分工。
- 足迹需要工具捕获或显式登记；不承诺自动观测所有人类读取、编辑器或 Git 操作。
- 接口注册表实际为 blackboard/interfaces/registry/*.yaml，旧 registry.yaml 首次访问时迁移。
- 安装增加 SHA256 比对、Git/已有提交前置条件、各 CLI 登录和 HTTP 服务依赖，解释本地账本不等于模型离线。
- 编排示例明确 Bash 语法、真实契约文件与 goal-id 占位；不再伪装为可整段粘贴的五分钟教程。
- 发布命令统一从仓库根执行，避免 cd 到包目录后找不到根 scripts；发布说明不再无条件宣称新发行物已经通过完整测试。

## 永久关闭范围

[ADR-0024](../decisions/0024-retire-external-validation.md) 记录维护者决定：非 Windows 实机测试及真人自然使用研究永久关闭，不再等待 WSL/重启/志愿者；四平台交叉编译继续保留，Windows 自动浏览器及 Codex 实验仍可运行。关闭不等于通过，相关节点继续 deprecated。旧报告与实验判据保留为历史。

任务森林提案 TFP-0468a982bd 已按本轮明确授权应用；TF-0237、TF-0251、TF-0265、TF-0267 追加范围决定，保留旧证据。validate exit 0，50 条偏差、未结 0 条。

## 本轮实际测量

本轮源代码基线为 842b3c5，加本轮文档与发行说明改动；没有修改生产业务逻辑。所有测试在 Windows x64 / Bun 1.3.14 执行。原始日志留在本机，未上传。

| 检查 | 实测结果 |
| --- | --- |
| lint | exit 0，659 files |
| typecheck | exit 0，三个包 |
| Workbench 首轮 | exit 1：1026 pass / 2 fail，159 files，266.93s |
| 首轮失败专项复跑 | exit 0：23 pass / 0 fail，覆盖 sessions-record 与 UI server |
| Workbench 完整复跑 | exit 0：1028 pass / 0 fail，159 files，152.48s |
| UI suite | exit 0：68 pass，18 files；出现一条 act 环境警告 |
| context-rot suite | exit 0：69 pass / 0 fail，6 files |
| Windows Chromium E2E | exit 0：14 pass / 0 fail / 0 skip，38.9s |
| doctor | exit 0，118 条架构断言，0 stale；8 条生成物不计入 |
| 四平台 build:all | 产物生成完成；保留 Vite 大于 500 kB chunk 警告 |
| test:build --native dist/workbench-windows-x64.exe | exit 0，native / JS 两种形态的五项检查均 true |
| 上传面门禁 | exit 0，348 条相对链接，0 断链，0 违规 |
| tag dry-run（改动前干净基线） | exit 0，本地/远端均无 0.4.1 tag |
| publish --dry-run | exit 0，四二进制、三许可文件、SHA256SUMS 齐全 |
| Codex own-fresh | exit 2，measured=false，真实读取回合失败；隔离 profile 缺验证密钥且未登录 |

Codex CLI 实际版本为 0.158.0-alpha.2.1。未能建立 fresh 对照，不继续把 stale 结果或假 app-server 单测当真实写保护。现存 fileChange 写足迹/归因缺口和 experimental 限制保持。通用第三方模型 test:live 本轮未运行。

首轮验证入口经 Node child_process 启动：继承环境缺 SystemRoot/SystemDrive/PATHEXT，stdin 管道保持打开。补齐 Windows 环境并关闭 stdin 后，原两项失败专项通过；完整复跑单独记录。浏览器首次也因缺少 PATHEXT 无法启动 bun.exe，修正后真实 Chromium 全部通过。产生的 Windows 缓存移入本机 scratch，不入库。

## 发行候选与剩余条件

当前 dist 为本轮构建的候选，不能称为已发布。SHA256SUMS 内容：

```text
cab4fd36940dd2f214aa50ae378a992abaa476d5721d79c342f94c1cb0c99c31  workbench-windows-x64.exe
66332ca43d5c4b7c869162bd2c92eed8ec1b4ae9f06116c1bcd2726dd96ebcbe  workbench-linux-x64
95c4538df4d768470f471e479b157d7c328b8999a161c4d211f021ce7a2edd88  workbench-macos-arm64
4d935be124beee57b611ccb6936472b51dcb0af5b8e40a2ed86d93f207fbe981  workbench-macos-x64
```

完成发布仍需要 GitHub 身份可用、最终干净提交及相应有效读数。发布脚本从仓库根运行，按先 tag 到 origin、再 build:all、再 publish 的现行顺序执行；本轮构建是发布前准备。正式发布必须重建对应 tag 的资产并确认校验和，不能拿旧资产冒充新提交。不得把尚未发布记为 TF-0266 done。

声明账本的旧读数会因本轮文件变化报 stale；必须在最终提交上通过记录器真实执行后刷新。未刷新前 check:claims 不算通过。

## 同轮补记：认证恢复与远端范围关闭

初始认证失败是执行入口遗漏 APPDATA/LOCALAPPDATA 导致 gh 无法找到已有配置。补齐标准 Windows 环境后 gh auth status exit 0，原账号登录有效；未修改凭据。gh release list 实测最新 Release 为 workbench-v0.4.0（2026-09-22），与 tag 核查相符。上文「身份不可用」这一阻塞已解除。

issue #32 已按维护者永久关闭要求以 not planned 关闭；issue #33 追加范围决定，移除非 Windows 冒烟待办，保留发行核对。真实 Codex 实验使用的独立 WB_VERIFY_LLM_KEY 仍缺失，不能从 GitHub 登录推导模型服务可用。

## 同轮补记：提交上的可复跑证据

50085d3 上通过记录器 --run 重取 Workbench（1028 pass / 0 fail，147.41s）、typecheck、lint、doctor、上传面、11/11 premise benchmark 和四平台 build:all + Windows native/JS 两形态检查，仪器均 exit 0。UI 68 项、context-rot 69 项及浏览器 14 项为本轮另行实际执行，原登记读数的被测路径未变化。最后的声明和落库状态以 check:claims / check-forest-landing 输出为准。

## 同轮补记：正式发行授权

维护者已明确确认「现在发布 0.4.1」。CHANGELOG 版本日期更新为 2026-09-28，移除尚未公开发行标签。按最终提交重取失效读数后，推 main/tag、重新构建并上传；实际发布 URL、tag 提交和 SHA256 由后续发布记录确认，本段只记录授权。

## 同轮补记：发布前 reload 夹具竞态

48d9230 上记录器重跑 Workbench 实得 1027 pass / 1 fail（reload 路由 EPIPE），记录器返回 2 拒绝写入；不是通过。检查发现 server.test.ts 的假 CLI 在接收任何输入之前便输出 assistant/result，与注释及真实 CLI 的请求响应语义不符。现改用标准库 readline 按输入行发出响应，关闭输入后退出，未修改生产 supervisor。单文件 14/14 通过；最终全套由记录器再次实跑，保留失败日志在本机。
