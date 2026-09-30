# 剩余短板 GitHub 跟踪索引（2026-10-01）

按用户要求建立，用于接续 9 月 30 日短板调查与多轮修复。以下 issue 的标题、正文、标签、开放状态及总表引用均已从 GitHub 回读核实。

| Issue | 内容 |
| --- | --- |
| [#49](https://github.com/Baixu22/VerseSpace/issues/49) | [tracking] 2026-10-01 短板修复、重验交接与验收收口总表 |
| [#50](https://github.com/Baixu22/VerseSpace/issues/50) | [workbench][P1] 补齐验证范围、实际用例集合与非代码输入证据 |
| [#51](https://github.com/Baixu22/VerseSpace/issues/51) | [workbench][P2] 建立单产物依赖与重验闭环，覆盖 applied/done 后失效 |
| [#52](https://github.com/Baixu22/VerseSpace/issues/52) | [workbench][P2] 区分观察工位、当前工位与目标主线基线的交接身份 |
| [#53](https://github.com/Baixu22/VerseSpace/issues/53) | [workbench][P2] 将 repaired 行为指标细分为版本观察、修改与验证证据 |
| [#54](https://github.com/Baixu22/VerseSpace/issues/54) | [workbench][P2] 明确读取版本强度并分诊大文件与跨版本范围盲区 |
| [#55](https://github.com/Baixu22/VerseSpace/issues/55) | [workbench][P2] 测量长期 JSONL 与多版本读集成本，再决定增量投影 |
| [#56](https://github.com/Baixu22/VerseSpace/issues/56) | [validation][P2] 收口 GLM 默认预算完整 live 结果与真实通道一致性验收 |
| [#57](https://github.com/Baixu22/VerseSpace/issues/57) | [handoff][P1] 收口本地修复：受测版本、注册读数、构建与发行边界对齐 |

依赖主链：#50 → #51 → #52；#53 依赖验证与产物证据。#57 单独收口已完成的本地修复，不要求先完成全部增强。

复用并追加进度说明：[#31](https://github.com/Baixu22/VerseSpace/issues/31)、[#45](https://github.com/Baixu22/VerseSpace/issues/45)、[#46](https://github.com/Baixu22/VerseSpace/issues/46)、[#47](https://github.com/Baixu22/VerseSpace/issues/47)、[#48](https://github.com/Baixu22/VerseSpace/issues/48)。#31 标题已纠正为 seal 已接线但真实 stale 写保护/原生写足迹仍待验收；没有关闭任何 issue。

issue 中区分本地已实现、仍未实现、实验未验收和交付未落库。新增能力保留 ADR 范围与验收要求，未重开真人研究、非 Windows 执行或 CI。

此次只建立远端跟踪并保存本索引，没有修改产品源码、任务森林或凭据，也没有重新跑代码/模型测试。源码工作区仍未提交，issue 保存计划与读数摘要，不等于代码已经备份到远端。
