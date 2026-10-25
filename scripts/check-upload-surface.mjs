#!/usr/bin/env node
/**
 * Relay-handoff upload-surface gate (ADR-0020).
 *
 * Answers one question in both directions: *is the upload surface classified,
 * and does every path sit on the side its class demands?*
 *
 *   useful-not-uploaded  a local-only path whose class says it must ship
 *   useless-uploaded     a shipped path whose class says it must stay local
 *   unclassified         no rule covers it — nobody has decided
 *   oversize-uploaded    shipped file above `sizeLimitBytes`, no exception
 *
 * The first four are mechanical: the policy already decided, so the gate can
 * hard-fail. A fifth signal is a JUDGMENT CALL and is therefore reported as a
 * note, not a violation:
 *
 *   referenced-but-local a tracked Markdown doc points at a local-only doc
 *
 * That is worth surfacing (a reader on another machine follows the pointer into
 * nothing) but the remedy is not mechanical — sometimes the target should ship,
 * sometimes the shipped doc should stop presenting local material as load
 * bearing. Pass `--strict-references` to promote it to a violation once that
 * decision has been made for every remaining case.
 *
 * A sixth signal IS mechanical and therefore a violation, always on:
 *
 *   broken-relative-link a shipped Markdown doc's relative link resolves to a
 *                        path that does not exist on disk
 *
 * `referenced-but-local` is a substring probe, so it only sees a target spelled
 * as a repo-relative path. It missed two real classes of dead pointer (issue
 * #37): `../positioning-v5.md`-style relative spelling, and a whole file's worth
 * of links left at the wrong depth after the doc moved into `docs/handoff/` —
 * 24 links pointing at non-existent `docs/packages/…`, with the gate still
 * reporting 0 violations. `scripts/upload-surface/links.mjs` resolves every
 * relative link in every UPLOADED `.md` file against the directory of the
 * referring file and reports the ones whose target is neither a file nor a
 * directory. Local-only / ignored docs are deliberately not checked: a cloner
 * never sees them, and the gate's subject is what a cloner receives.
 *
 * Exit codes: 0 clean · 1 violations · 2 cannot measure. A gate that cannot
 * measure must never report clean — the same rule as
 * `scripts/check-forest-landing.mjs`.
 *
 * THE GIT PROBE IS SEPARABLE ON PURPOSE
 * -------------------------------------
 * On some hosts node cannot spawn a child process at all — the DSH agent
 * sandbox on the maintainer's Windows machine denies `spawnSync git` with
 * EPERM (AGENTS.md, "The agent harness sandbox denies child processes"). The
 * gate must not silently degrade to green there, and it must not need a second
 * implementation to stay useful. So the probe is one step:
 *
 *   git ls-files                                   > tracked.txt
 *   git ls-files --others --exclude-standard       > untracked.txt
 *   git ls-files --others --ignored --exclude-standard > ignored.txt
 *   node scripts/check-upload-surface.mjs --lists <dir>
 *
 * Without `--lists` the gate runs the probe itself; if the probe cannot run it
 * exits 2 and says which command to run instead.
 *
 * Usage: node scripts/check-upload-surface.mjs [--json] [--lists <dir>]
 *        [--root <dir>] [--policy <file>] [--strict-references] [--show <n>]
 *        [--emit-inventory <file>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	classifyPath,
	compilePolicy,
	evaluate,
	isAcceptedLocalReference,
} from "./upload-surface/classify.mjs";
import { checkRelativeLinks } from "./upload-surface/links.mjs";
import { loadPolicy } from "./upload-surface/policy-loader.mjs";
import { emitReport } from "./upload-surface/report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const ROOT = resolve(argValue("--root") ?? REPO);
const POLICY_PATH = resolve(
	argValue("--policy") ?? join(HERE, "upload-surface", "policy.json"),
);
const INVENTORY_PATH = join(HERE, "upload-surface", "legacy-local-docs.json");
const LISTS_DIR = argValue("--lists");
const AS_JSON = process.argv.includes("--json");
const STRICT_REFERENCES = process.argv.includes("--strict-references");
const SHOW = Number(argValue("--show") ?? 10);
const EMIT_INVENTORY = argValue("--emit-inventory");

/** Read a newline list, dropping blanks and normalising separators. */
function readList(text) {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/\\/g, "/"))
		.filter(Boolean);
}

function git(args) {
	return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
}

let measured = true;
let uploaded = [];
let ignored = [];
const problems = [];
const notes = [];

try {
	if (LISTS_DIR) {
		const dir = resolve(LISTS_DIR);
		uploaded = [
			...readList(readFileSync(join(dir, "tracked.txt"), "utf8")),
			...readList(readFileSync(join(dir, "untracked.txt"), "utf8")),
		];
		ignored = readList(readFileSync(join(dir, "ignored.txt"), "utf8"));
		notes.push(`文件清单来自 ${dir}（未运行 git 探针）`);
	} else {
		uploaded = [
			...readList(git(["ls-files"])),
			...readList(git(["ls-files", "--others", "--exclude-standard"])),
		];
		ignored = readList(
			git(["ls-files", "--others", "--ignored", "--exclude-standard"]),
		);
	}
} catch (error) {
	measured = false;
	problems.push(
		`无法测量：git 探针失败（${error?.message ?? error}）。` +
			" 本机若禁止 node 创建子进程，请先用 git 生成 tracked/untracked/ignored 三份清单，" +
			"再以 --lists <dir> 重跑。",
	);
}

const report = {
	status: "cannot-measure",
	violations: [],
	referenceNotes: [],
	acceptedReferences: [],
};

if (measured) {
	const policy = loadPolicy({
		policyPath: POLICY_PATH,
		inventoryPath: INVENTORY_PATH,
	});
	const sizes = {};
	for (const path of uploaded) {
		try {
			const stat = statSync(join(ROOT, path));
			if (stat.isFile()) {
				sizes[path] = stat.size;
			}
		} catch {
			// A tracked path can be absent from the working tree (sparse checkout,
			// or a file deleted but not staged). Absence is not a size violation.
		}
	}

	// --emit-inventory: freeze every local-only path the policy does not yet
	// cover as an explicitly accepted local-only doc. This is how the initial
	// inventory was produced, and how a reviewer regenerates it to see the
	// delta. It never *accepts* silently: the resulting file is a reviewable
	// diff, and the gate fails on anything not in it.
	if (EMIT_INVENTORY) {
		const compiled = compilePolicy(policy);
		const uncovered = ignored
			.filter((path) => path.startsWith("docs/"))
			.filter(
				(path) => classifyPath(compiled, path).class === compiled.defaultClass,
			)
			.sort();
		writeFileSync(
			resolve(EMIT_INVENTORY),
			`${JSON.stringify(
				{
					$comment:
						"冻结清单：按 TF-0220「原始数据本地留，精选读数入库」口径留在本机的按日期文档。只应缩小——把结论性的文件提升到 docs/handoff/ 或显式规则里。新增条目必须在评审 diff 里可见并说明理由。用 --emit-inventory 重新生成。",
					generatedAt: new Date().toISOString().slice(0, 10),
					class: "process-evidence",
					why: "按日期的过程报告/证据 dump：换机不可复算，且已被 docs/ 与节点 evidence 的精选读数取代",
					paths: uncovered,
				},
				null,
				"\t",
			)}\n`,
			"utf8",
		);
		console.log(
			`[upload-surface] 已写出 ${uncovered.length} 条本机文档清单 → ${EMIT_INVENTORY}`,
		);
		process.exit(0);
	}

	const result = evaluate({ policy, uploaded, ignored, sizes });
	report.status = result.status;
	report.counts = result.counts;
	report.violations = result.violations;
	report.policyVersion = result.policyVersion;

	// referenced-but-local: a tracked Markdown doc that points at a doc which is
	// excluded from the upload surface. Worth surfacing — a reader on another
	// machine follows the pointer into nothing — but the remedy is a judgment
	// call, so it is a note unless --strict-references says the call was made.
	const localDocs = ignored.filter((path) => path.startsWith("docs/"));
	if (localDocs.length > 0) {
		const compiled = compilePolicy(policy);
		const accepted = policy.acceptedLocalReferences ?? [];
		// Every referrer, not just the first. Recording only the first would let an
		// accepted referrer mask an unaccepted one pointing at the same local doc.
		const referenced = new Map();
		for (const path of uploaded) {
			if (!path.endsWith(".md")) {
				continue;
			}
			let text;
			try {
				const full = join(ROOT, path);
				if (statSync(full).size > 1_000_000) {
					continue;
				}
				text = readFileSync(full, "utf8");
			} catch {
				continue;
			}
			for (const local of localDocs) {
				if (!text.includes(local)) {
					continue;
				}
				if (!referenced.has(local)) {
					referenced.set(local, new Set());
				}
				referenced.get(local).add(path);
			}
		}
		for (const [local, referrers] of referenced) {
			const isAccepted = (referrer) =>
				isAcceptedLocalReference(accepted, local, referrer);
			const pending = [...referrers].filter(
				(referrer) => !isAccepted(referrer),
			);
			const decided = [...referrers].filter(isAccepted);
			const entry = {
				code: "referenced-but-local",
				side: "local-only",
				path: local,
				class: classifyPath(compiled, local).class,
				referrers: [...referrers],
				detail: pending.length
					? `被已入库文件 ${pending.join(", ")} 引用，但本身不在上传面内；换机读者会跟到空指针`
					: `被 ${decided.join(", ")} 引用；该引用已在 policy.acceptedLocalReferences 里记为已裁决`,
			};
			if (pending.length > 0) {
				if (STRICT_REFERENCES) {
					report.violations.push(entry);
				} else {
					report.referenceNotes.push(entry);
				}
			} else {
				// Reported either way: an accepted reference is a decision on the
				// record, not something the gate should quietly swallow.
				report.acceptedReferences.push(entry);
			}
		}
		report.status = report.violations.length > 0 ? "violations" : "clean";
		report.counts.violations = report.violations.length;
	}

	// broken-relative-link: a shipped Markdown doc whose relative link resolves
	// to nothing on disk. Unlike `referenced-but-local` this is mechanical — the
	// target either exists or it does not — so it is a violation in the normal
	// run, not a note behind a flag. Only uploaded `.md` files are read: a dead
	// link inside a doc that stays on this machine is not a defect of the upload
	// surface, because a cloner never sees that doc.
	const links = checkRelativeLinks({ root: ROOT, files: uploaded });
	report.relativeLinks = {
		checked: links.checked.length,
		broken: links.broken,
	};
	report.violations.push(...links.broken);
	report.status = report.violations.length > 0 ? "violations" : "clean";
	report.counts.violations = report.violations.length;
}

emitReport({
	report,
	asJson: AS_JSON,
	measured,
	notes,
	problems,
	show: SHOW,
});

process.exit(!measured ? 2 : report.violations.length > 0 ? 1 : 0);
