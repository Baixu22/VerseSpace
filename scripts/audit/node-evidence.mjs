#!/usr/bin/env node
/**
 * Classify `done` nodes that carry no evidence (TF-0279, semantics in ADR-0022).
 *
 * The 47 nodes are MVP-era skeletons. Their deliverables are mostly *still here*
 * and covered by a suite that has a valid reading — but "the module is green" is
 * NOT "this node's original acceptance was recomputed", so the generated evidence
 * says 间接 out loud and names the claim id.
 *
 * The mapping below IS the judgment: node → the claim whose subject covers its
 * deliverable, or why no claim does. Keeping it in the repo makes the
 * classification reviewable and re-runnable instead of a one-off edit spree.
 *
 * Usage:
 *   node scripts/audit/node-evidence.mjs            # human summary
 *   node scripts/audit/node-evidence.mjs --json     # machine output
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodes = JSON.parse(
	readFileSync(
		join(REPO, ".agent-workbench", "task-forest", "graph", "nodes.json"),
		"utf8",
	),
);
const claims = JSON.parse(
	readFileSync(join(REPO, "evidence", "claims.json"), "utf8"),
).claims;
const claimById = new Map(claims.map((c) => [c.id, c]));

/** node id → { verdict, claim?, path?, note } */
const MAPPING = {
	"TF-0001": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/**",
		note: "根目标：三个包都在，三套件各有有效读数",
	},
	"TF-0003": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/**",
		note: "工程骨架与新 CLI 包",
	},
	"TF-0004": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/blackboard/**",
		note: "类型契约与 Blackboard 数据层",
	},
	"TF-0005": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/automaton/**",
		note: "Automaton 纯函数状态机",
	},
	"TF-0006": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/contextgen/**",
		note: "ContextGen 上下文生成器",
	},
	"TF-0007": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/verifier/**",
		note: "Verifier 验证执行器",
	},
	"TF-0008": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/runtime/**",
		note: "Runtime 组合与基础 CLI",
	},
	"TF-0009": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/scheduler/**",
		note: "Scheduler 调度与派发",
	},
	"TF-0010": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/watcher/**",
		note: "Watcher 后台监听",
	},
	"TF-0020": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/package.json",
		note: "独立包落位",
	},
	"TF-0021": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/commands/**",
		note: "CLI 框架与命令树骨架",
	},
	"TF-0024": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/types/**",
		note: "全量类型与运行时 schema",
	},
	"TF-0025": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/commands/init.ts",
		note: ".workbench/ 布局与 init 落盘",
	},
	"TF-0026": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/fs/**",
		note: "原子写与 JSONL 追加",
	},
	"TF-0028": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/blackboard/**",
		note: "state 与 checkpoints 三区",
	},
	"TF-0029": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/test/fixtures.ts",
		note: "世界快照聚合与测试夹具",
	},
	"TF-0032": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/automaton/**",
		note: "checkpoint-machine",
	},
	"TF-0033": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/automaton/**",
		note: "workspot-machine",
	},
	"TF-0034": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/automaton/**",
		note: "evaluator 组合器与表驱动单测",
	},
	"TF-0035": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/contextgen/**",
		note: ".agent-context.md 模板渲染",
	},
	"TF-0036": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/contextgen/**",
		note: "generateAll 全工位刷新",
	},
	"TF-0037": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/verifier/**",
		note: "验证策略分发",
	},
	"TF-0038": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/supervisor/**",
		note: "受控子进程执行",
	},
	"TF-0040": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/commands/**",
		note: "goal / decision / interface 子树",
	},
	"TF-0041": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/commands/**",
		note: "ws 与 checkpoint 子树",
	},
	"TF-0042": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/commands/**",
		note: "sync / status / map / log",
	},
	"TF-0043": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/**",
		note: "MVP 端到端集成测试——套件本身就是它的交付物",
	},
	"TF-0044": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/scheduler/**",
		note: "scheduler.tick 与三种调度策略",
	},
	"TF-0045": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/scheduler/**",
		note: "dispatch 落地与 CLI 派发",
	},
	"TF-0046": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/watcher/**",
		note: "文件监听与防抖循环",
	},
	"TF-0047": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/watcher/**",
		note: "watch 进程生命周期",
	},
	"TF-0056": {
		verdict: "covered",
		claim: "claim-ui-suite",
		path: "apps/workbench-ui/**",
		note: "workbench ui 本地面板",
	},
	"TF-0065": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/fs/lockfile.ts",
		note: "runOnce 单写者保证（O_EXCL）",
	},
	"TF-0073": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/runtime/**",
		note: "里程碑 R2：陈旧前提检测",
	},
	"TF-0074": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/runtime/**",
		note: "谓词第 1 层：读集来源分级",
	},
	"TF-0078": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/runtime/**",
		note: "封印点阻塞写入",
	},
	"TF-0115": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/runtime/**",
		note: "精度缺口：仓库根部相对路径判 durable",
	},
	"TF-0116": {
		verdict: "covered",
		claim: "claim-workbench-suite",
		path: "packages/workbench/src/runtime/**",
		note: "前提高和循环接进 watcher 与 runtime",
	},

	// Evidence is a file or a command, not a registered reading — recorded as such.
	"TF-0002": {
		verdict: "file",
		note: "里程碑一的技术决策落在 docs/decisions/0001…0005，文件仍在（读文件即可复核）",
	},
	"TF-0013": {
		verdict: "file",
		note: "运行时 = Bun + TS：package.json 的 packageManager=bun@1.3.14，tsconfig 在各包内（读文件即可复核）",
	},
	"TF-0014": {
		verdict: "file",
		note: "包落位 = packages/workbench：目录与 package.json 的 name=@baixu22/workbench 仍在",
	},
	"TF-0015": {
		verdict: "file",
		note: "Helmor 存量处置：先冻结后退役，退役由 ADR-0014/0015 执行（GUI 已删），决策链完整",
	},
	"TF-0016": {
		verdict: "file",
		note: "基座策略 = 核心自研 + 组件级借库：三包结构与其依赖可读",
	},
	"TF-0017": {
		verdict: "local",
		note: "git 仓库与远端：git remote -v 可复核（jihulab 远端已随 ADR-0021 退役）",
	},
	"TF-0067": {
		verdict: "local",
		note: "自举：本仓库 .workbench/ 台账存在——machine-state，换机不可复算",
	},

	// Genuinely needs a human.
	"TF-0022": {
		verdict: "review",
		note: "biome 半边仍在且 lint exit 0；**CI 半边已随 ADR-0021 退役**——交付物一半不存在，需人决定拆节点还是标 deprecated",
	},
	"TF-0103": {
		verdict: "deprecated",
		note: "「修复 ci.yml 的 15 处 tab 缩进」：.gitlab-ci.yml 已随 ADR-0021 删除，交付物不存在",
	},
};

const empty = Object.values(nodes)
	.filter((n) => n.status === "done" && (n.evidence ?? []).length === 0)
	.sort((a, b) => a.id.localeCompare(b.id));

const rows = empty.map((node) => {
	const entry = MAPPING[node.id];
	if (!entry) return { id: node.id, verdict: "unmapped", evidence: null };
	const claim = entry.claim ? claimById.get(entry.claim) : undefined;
	if (entry.claim && !claim) {
		return {
			id: node.id,
			verdict: "unmapped",
			evidence: null,
			detail: `claim 不存在：${entry.claim}`,
		};
	}
	const evidence = (() => {
		switch (entry.verdict) {
			case "covered":
				return `2026-09-26 覆盖读数（TF-0279，语义见 ADR-0022）：${entry.claim} 的 subject 覆盖 ${entry.path}，该读数有效（evidence/readings/${entry.claim}.json）。**这是间接证据**——它证明交付物仍在且被测，不是本节点原始验收的直接复算。${entry.note}`;
			case "file":
				return `2026-09-26 文件证据（TF-0279，ADR-0022 §1）：${entry.note}。可复核方式是读文件，不是跑仪器。`;
			case "local":
				return `2026-09-26 本机观测（TF-0279，ADR-0022 §1）：${entry.note}。**本机状态，换机不可复算**，故只作观测。`;
			case "review":
				return `2026-09-26 待人工定性（TF-0279，ADR-0022 §2）：${entry.note}`;
			case "deprecated":
				return `2026-09-26 交付物已不存在（TF-0279，ADR-0022 §2）：${entry.note}`;
			default:
				return null;
		}
	})();
	return {
		id: node.id,
		verdict: entry.verdict,
		claim: entry.claim ?? null,
		evidence,
	};
});

const counts = {};
for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;

if (process.argv.includes("--json")) {
	process.stdout.write(
		`${JSON.stringify({ empty: empty.length, counts, rows }, null, 2)}\n`,
	);
} else {
	console.log(`evidence 为空的 done 节点：${empty.length}`);
	console.log(`分类：${JSON.stringify(counts)}`);
	for (const row of rows) {
		console.log(
			`  ${row.id}  ${row.verdict}${row.claim ? ` (${row.claim})` : ""}`,
		);
	}
	const unmapped = rows.filter((r) => r.verdict === "unmapped");
	if (unmapped.length > 0)
		console.log(`  ⚠ 未映射：${unmapped.map((r) => r.id).join(", ")}`);
}
