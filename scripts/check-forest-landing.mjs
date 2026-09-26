#!/usr/bin/env node
/**
 * Forest landing gate — the reproducible, default-branch-aware half of
 * `check-landing` (P1).
 *
 * Two problems this replaces:
 *
 * 1. The authoritative task-forest CLI lives OUTSIDE this repo
 *    (`C:\Users\27933\.workbuddy\skills\task-forest\scripts\task_forest.py`), so
 *    `validate` / `check-landing` could not be re-run by anyone else. Only the
 *    derived data (`.agent-workbench/task-forest/`) ships with the project.
 * 2. `check-landing` compared done-node timestamps against **HEAD**, so code
 *    that existed only on an unmerged branch read as landed. That is exactly
 *    the 2026-09-23 stage-3 gap recorded as `TFD-0dab4149f2`: the forest said
 *    done, `check-landing` exited 0, and `main` had none of the code.
 *
 * This script re-implements the landing half with no dependencies and against
 * the DEFAULT BRANCH, not HEAD:
 *
 *   1. no uncommitted changes to tracked files;
 *   2. HEAD carries nothing that is not on the default branch;
 *   3. no unmerged branch carries CODE that is not on the default branch
 *      (a branch holding only `.agent-workbench/` or `docs/` bookkeeping is
 *      reported as a note — it cannot be a landing gap for code);
 *   4. a `done` node's evidence, when it names a real commit, must be reachable
 *      from the default branch (`git merge-base --is-ancestor`).
 *
 * Rule 4 used to compare `updated_at` against the HEAD commit's time. That was
 * wrong in both directions: the forest is untracked, so applying any proposal
 * updates `updated_at` without producing a commit — every apply read as drift
 * (`TFD-6b47ba440e`) — while code that existed only on an unmerged branch read
 * as landed (`TFD-0dab4149f2`). Timestamps are gone; reachability is measured.
 * Nodes whose evidence names no commit, and commits reachable from no branch
 * (the JihuLab mirror's fresh-orphan snapshots), are reported as notes, not
 * drift — otherwise the gate cries wolf on the two states it cannot judge.
 *
 * Exit codes: 0 clean · 1 drift · 2 cannot measure. A gate that cannot measure
 * must never report clean — same rule as `scripts/suite-total.ts`.
 *
 * Usage: node scripts/check-forest-landing.mjs [--json]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODES = join(
	REPO,
	".agent-workbench",
	"task-forest",
	"graph",
	"nodes.json",
);

function git(args) {
	return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

/** Exit code of a git command; never throws (non-zero when it did not run). */
function gitExit(args) {
	try {
		execFileSync("git", args, {
			cwd: REPO,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return 0;
	} catch (error) {
		return typeof error?.status === "number" ? error.status : 1;
	}
}

const problems = [];
const notes = [];
let defaultBranch = "main";
let measured = true;

try {
	try {
		defaultBranch = git([
			"symbolic-ref",
			"--short",
			"refs/remotes/origin/HEAD",
		]).replace(/^origin\//, "");
	} catch {
		// no remote HEAD ref (fresh clone, or refs pruned by the Windows git
		// defect documented in AGENTS.md) — fall back to the conventional name
		notes.push("origin/HEAD 不可读，默认分支按 main 处理");
	}

	const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean);
	if (dirty.length > 0) {
		problems.push(
			`工作树有 ${dirty.length} 处未提交改动（含已 staged 的删除）`,
		);
	}

	const ahead = git(["log", "--oneline", `${defaultBranch}..HEAD`])
		.split("\n")
		.filter(Boolean);
	if (ahead.length > 0) {
		problems.push(`HEAD 领先 ${defaultBranch} ${ahead.length} 个提交`);
	}

	const unmerged = git(["branch", "--no-merged", defaultBranch])
		.split("\n")
		.map((line) => line.replace(/^[*+]\s*/, "").trim())
		.filter(Boolean);
	for (const branch of unmerged) {
		const files = git(["diff", "--name-only", `${defaultBranch}...${branch}`])
			.split("\n")
			.filter(Boolean);
		const code = files.filter(
			(file) =>
				!file.startsWith(".agent-workbench/") && !file.startsWith("docs/"),
		);
		if (code.length > 0) {
			problems.push(
				`分支 ${branch} 有 ${code.length} 个代码文件未并入 ${defaultBranch}：` +
					`${code.slice(0, 5).join(", ")}${code.length > 5 ? " …" : ""}`,
			);
		} else {
			notes.push(
				`分支 ${branch} 只有森林/文档记账（${files.length} 个文件），不构成代码落库缺口`,
			);
		}
	}

	const nodes = JSON.parse(readFileSync(NODES, "utf8"));
	// Rule 4: reachability, not recency. A `done` node is not "late" because the
	// forest recorded it after the last commit — the forest is untracked, so
	// applying a proposal updates `updated_at` and produces no commit at all.
	const commitTokens = (node) => {
		const text = (node?.evidence ?? [])
			.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
			.join("\n");
		return [...new Set(text.match(/\b[0-9a-f]{7,40}\b/g) ?? [])].filter(
			(token) => gitExit(["cat-file", "-e", `${token}^{commit}`]) === 0,
		);
	};
	const orphans = [];
	const unattributed = [];
	for (const [id, node] of Object.entries(nodes)) {
		if (node?.status !== "done") {
			continue;
		}
		const tokens = commitTokens(node);
		if (tokens.length === 0) {
			unattributed.push(id);
			continue;
		}
		for (const token of tokens) {
			if (
				gitExit(["merge-base", "--is-ancestor", token, defaultBranch]) === 0
			) {
				continue;
			}
			const branches = git(["branch", "--all", "--contains", token])
				.split("\n")
				.map((line) => line.replace(/^[*+]\s*/, "").trim())
				.filter(Boolean)
				.filter(
					(name) =>
						name !== defaultBranch && name !== `origin/${defaultBranch}`,
				);
			if (branches.length > 0) {
				problems.push(
					`done 节点 ${id} 的证据提交 ${token} 只出现在未合并分支 ${branches.join("、")} 上`,
				);
			} else {
				orphans.push(`${id}:${token}`);
			}
		}
	}
	if (orphans.length > 0) {
		notes.push(
			`${orphans.length} 个 done 节点的证据提交不属于任何分支（孤立提交，` +
				`极狐镜像的 fresh-orphan 快照即此类；只报读数不判漂移）：` +
				`${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? " …" : ""}`,
		);
	}
	if (unattributed.length > 0) {
		notes.push(
			`${unattributed.length} 个 done 节点的证据里没有可解析成真实提交的 token` +
				"（无法归因，不判漂移——这是旧时间戳判据的假阳性来源 TFD-6b47ba440e）",
		);
	}
} catch (error) {
	measured = false;
	problems.push(`无法测量：${error?.message ?? error}`);
}

const status = !measured
	? "cannot-measure"
	: problems.length > 0
		? "drift"
		: "clean";

if (process.argv.includes("--json")) {
	process.stdout.write(
		`${JSON.stringify({ status, defaultBranch, problems, notes }, null, 2)}\n`,
	);
} else {
	console.log(
		`[forest-landing] 默认分支 ${defaultBranch} · ${status === "clean" ? "无漂移" : status === "drift" ? "有漂移" : "无法测量"}`,
	);
	for (const note of notes) {
		console.log(`  备注：${note}`);
	}
	for (const problem of problems) {
		console.log(`  ${problem}`);
	}
}

process.exit(!measured ? 2 : problems.length > 0 ? 1 : 0);
