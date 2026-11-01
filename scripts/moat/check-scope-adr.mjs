#!/usr/bin/env node
/**
 * ADR-0026 scope check: the four fact kinds and the consumption boundary are
 * recorded, indexed, and not contradicted by the README's ADR range.
 *
 * This is a documentation check, not a product guarantee. It answers one
 * question: "does the ADR that bounds this round say what it claims to say, and
 * do the two places that index it agree?" It cannot tell whether the code still
 * matches the prose — that is what the per-node readings are for.
 *
 * Exit codes: 0 clean · 1 drift · 2 cannot measure (missing inputs are
 * drift-free failures to measure, never a pass).
 *
 * Usage: node scripts/moat/check-scope-adr.mjs [--json] [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
}

const root = resolve(argValue("--root") ?? REPO);
const ADR = join(
	root,
	"docs",
	"decisions",
	"0026-input-origin-and-artifact-use.md",
);
const INDEX = join(root, "docs", "decisions", "README.md");
const ROOT_README = join(root, "README.md");

// Each row is [id, pattern]. The pattern is the wording the ADR must actually
// carry; a fact kind that is only implied does not count as recorded.
const FACT_KINDS = [
	["observed-input", /\bObserved input\b/],
	["declared-origin", /\bDeclared origin\b/],
	["verified-artifact", /\bVerified artifact\b/],
	["target-applicability", /\bTarget applicability\b/],
];

const BOUNDARY = [
	["consumption-scope", /保证范围只覆盖 Workbench 管理的验收消费/],
	["outside-scope", /裸编辑器、Git 直接操作、无审批写入/],
	["retirement-kept", /ADR-0024 的非 Windows 实机验证与真人研究不恢复/],
	["no-full-seal", /不做全仓写保护/],
];

const asJson = process.argv.includes("--json");
const checks = [];
const notes = [];

function check(id, ok, detail) {
	checks.push({ id, ok, detail });
}

let readable = true;
function read(path, label) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		readable = false;
		notes.push(`读不到 ${label}：${error.message}`);
		return null;
	}
}

const adrText = read(ADR, "ADR-0026");
const indexText = read(INDEX, "决策索引");
const readmeText = read(ROOT_README, "README");

if (adrText) {
	check(
		"adr-exists",
		true,
		"docs/decisions/0026-input-origin-and-artifact-use.md",
	);
	for (const [id, pattern] of FACT_KINDS) {
		check(`fact-${id}`, pattern.test(adrText), id);
	}
	for (const [id, pattern] of BOUNDARY) {
		check(`boundary-${id}`, pattern.test(adrText), id);
	}
	// A conditional claim has to stay conditional in the text itself.
	check(
		"conditional-scope",
		/只有阶段一的独立 judge 指出强朴素方案确实覆盖不到缺口时/.test(adrText),
		"后续节点保持 proposed 的前置条件",
	);
	check(
		"supersedes-declared",
		/补充 ADR-0010/.test(adrText) && /ADR-0025/.test(adrText),
		"关系声明",
	);
}

if (indexText) {
	const row = indexText
		.split("\n")
		.find((line) => line.includes("0026-input-origin-and-artifact-use.md"));
	check("index-row", Boolean(row), row?.trim() ?? "缺少 0026 行");
	if (row) {
		check("index-node", /TF-0284/.test(row), "索引行指向 TF-0284");
		check(
			"index-status",
			/已接受/.test(row),
			"索引行状态与 ADR 一致（已接受）",
		);
	}
}

if (readmeText) {
	// The README states the ADR range as a single span, so the range has to
	// reach the highest ADR on disk. Pinning it to 0026 made every later ADR
	// register as drift in the one check that is supposed to notice a stale
	// range — measured 2026-11-01 when 0027 landed. The bound is read from the
	// directory rather than typed, so the check keeps asking the same question.
	const decisionDir = join(root, "docs", "decisions");
	const numbers = existsSync(decisionDir)
		? (() => {
				try {
					return readdirSync(decisionDir)
						.map((name) => /^(\d{4})-.+\.md$/.exec(name)?.[1])
						.filter((value) => typeof value === "string");
				} catch {
					return [];
				}
			})()
		: [];
	const highest = numbers.sort().at(-1) ?? null;
	if (highest) {
		const span = new RegExp(`ADR 0001[–-]${highest}`);
		check(
			"readme-range",
			span.test(readmeText),
			`README 的 ADR 范围覆盖到 ${highest}`,
		);
	}
}

const failures = checks.filter((entry) => !entry.ok);
const status = !readable
	? "cannot-measure"
	: failures.length === 0
		? "clean"
		: "drift";

if (asJson) {
	process.stdout.write(
		`${JSON.stringify({ status, checks: checks.length, failures: failures.length, rows: checks, notes }, null, 2)}\n`,
	);
} else {
	console.log(
		`[moat-scope] ${checks.length} 项检查 · ${
			status === "clean" ? "一致" : status === "drift" ? "有漂移" : "无法测量"
		}`,
	);
	for (const entry of checks) {
		console.log(
			`  ${entry.ok ? "✔" : "✘"} ${entry.id}${entry.ok ? "" : ` — ${entry.detail}`}`,
		);
	}
	for (const note of notes) console.log(`  备注：${note}`);
}

process.exit(status === "cannot-measure" ? 2 : status === "drift" ? 1 : 0);
