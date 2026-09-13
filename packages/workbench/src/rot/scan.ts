import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../fs/atomic";
import { git } from "../git";
import { findGitRoot } from "../paths";
import { extractRefs } from "./extract";

/**
 * Context-rot doctor (TF-0104): zero config, zero agent, one screenshotable
 * pair of numbers. Walk the agent instruction files a human already wrote
 * (CLAUDE.md / AGENTS.md / .cursorrules / Cursor rules / Copilot
 * instructions), pull the path-shaped citations, and count how many of
 * those files no longer exist.
 *
 * This is the acquisition hook, not the moat. Stale-premise detection on
 * a live session is R2; this command exists so someone can run
 * `npx @baixu22/workbench doctor` against an arbitrary checkout and see
 * a number.
 */

export interface RotFinding {
	ref: string;
	kind: "path" | "file";
	stale: boolean;
	/**
	 * The citation is covered by .gitignore (a build output / cache path).
	 * It cannot be falsified from the index — `bun run build` will create
	 * it — so it is counted separately, never as stale (issue #2).
	 */
	generated: boolean;
	/** Instruction file that cited it, repo-relative. */
	source: string;
	line: number;
}

export interface RotReport {
	/** Unique path-shaped citations across every instruction file. */
	assertions: number;
	stale: number;
	/** Ignored-by-git citations: unverifiable from the index, not rot. */
	generated: number;
	sources: string[];
	findings: RotFinding[];
}

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"target",
	"coverage",
	".next",
	".turbo",
	".output",
	"worktrees",
	".workbench",
	".agent-workbench",
	".workbuddy",
	".bundle-cache",
]);

const INSTRUCTION_BASENAMES = new Set([
	"claude.md",
	"agents.md",
	"gemini.md",
	".cursorrules",
	"copilot.md",
	".clinerules",
	".windsurfrules",
	"warp.md",
	"copilot-instructions.md",
]);

export function isInstructionFile(relPath: string): boolean {
	const posix = relPath.replace(/\\/g, "/");
	const base = posix.split("/").pop() ?? "";
	if (INSTRUCTION_BASENAMES.has(base.toLowerCase())) {
		return true;
	}
	if (
		(posix.startsWith(".cursor/rules/") || posix.includes("/.cursor/rules/")) &&
		(base.endsWith(".mdc") || base.endsWith(".md"))
	) {
		return true;
	}
	if (
		(posix.startsWith(".github/instructions/") ||
			posix.includes("/.github/instructions/")) &&
		base.endsWith(".md")
	) {
		return true;
	}
	return false;
}

export interface FileIndex {
	files: Set<string>;
	dirs: Set<string>;
	basenames: Set<string>;
}

export function resolveRef(ref: string, index: FileIndex): boolean {
	const trimmed = ref.replace(/\\/g, "/");
	const n = trimmed.replace(/\/+$/, "");
	const dirHint = trimmed.endsWith("/");
	if (!n) {
		return false;
	}
	if (index.files.has(n) || index.dirs.has(n)) {
		return true;
	}
	if (!n.includes("/")) {
		if (index.basenames.has(n.toLowerCase())) {
			return true;
		}
		if (dirHint) {
			for (const dir of index.dirs) {
				if (dir === n || dir.endsWith(`/${n}`)) {
					return true;
				}
			}
		}
		return false;
	}
	// instruction files often cite a path relative to a well-known root
	// (`features/panel/` meaning `src/features/panel/`). If any indexed
	// file or directory ends with that suffix, the citation still holds.
	const nested = `/${n}/`;
	const suffix = `/${n}`;
	for (const file of index.files) {
		if (
			file.startsWith(`${n}/`) ||
			file.includes(nested) ||
			file.endsWith(suffix)
		) {
			return true;
		}
	}
	for (const dir of index.dirs) {
		if (dir === n || dir.startsWith(`${n}/`) || dir.endsWith(suffix)) {
			return true;
		}
	}
	return false;
}

export async function buildFileIndex(root: string): Promise<FileIndex> {
	const listed = (await gitLs(root)) ?? (await walkFiles(root));
	const files = new Set<string>();
	const dirs = new Set<string>();
	const basenames = new Set<string>();
	for (const raw of listed) {
		const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
		if (!rel) {
			continue;
		}
		files.add(rel);
		const base = rel.split("/").pop();
		if (base) {
			basenames.add(base.toLowerCase());
		}
		const parts = rel.split("/");
		let acc = "";
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
			dirs.add(acc);
		}
	}
	return { files, dirs, basenames };
}

export async function findInstructionFiles(
	root: string,
	index: FileIndex,
): Promise<string[]> {
	const fromIndex = [...index.files].filter(isInstructionFile);
	if (fromIndex.length > 0) {
		return fromIndex.sort();
	}
	// untracked-only checkouts, or a tree git cannot see: look at the well
	// known names at the root so a brand-new CLAUDE.md still counts
	const known = [
		"CLAUDE.md",
		"AGENTS.md",
		"GEMINI.md",
		".cursorrules",
		"COPILOT.md",
	];
	const found: string[] = [];
	for (const name of known) {
		if (await pathExists(join(root, name))) {
			found.push(name);
		}
	}
	return found;
}

export async function runContextRot(startDir: string): Promise<RotReport> {
	const root = (await findGitRoot(startDir)) ?? startDir;
	const index = await buildFileIndex(root);
	const sources = await findInstructionFiles(root, index);
	const first = new Map<string, RotFinding>();

	for (const source of sources) {
		let text: string;
		try {
			text = await readFile(join(root, source), "utf8");
		} catch {
			continue;
		}
		for (const extracted of extractRefs(text)) {
			if (first.has(extracted.ref)) {
				continue;
			}
			first.set(extracted.ref, {
				ref: extracted.ref,
				kind: extracted.kind,
				stale: !resolveRef(extracted.ref, index),
				generated: false,
				source,
				line: extracted.line,
			});
		}
	}

	// Two reclassifications keep index-invisible citations out of the stale
	// count (issue #2):
	// 1. the path exists on disk (a gitignored cache dir like
	//    `sidecar/.bundle-cache`) — the citation is simply live;
	// 2. git says the path is covered by .gitignore and it is not on disk
	//    (an unbuilt output like `sidecar/dist/helmor-sidecar`) — it cannot
	//    be falsified from the index, count it separately as generated.
	for (const finding of first.values()) {
		if (finding.stale && (await pathExists(join(root, finding.ref)))) {
			finding.stale = false;
		}
	}
	const ignored = await checkIgnored(
		root,
		[...first.values()].filter((item) => item.stale).map((item) => item.ref),
	);
	for (const finding of first.values()) {
		if (finding.stale && ignored.has(finding.ref)) {
			finding.stale = false;
			finding.generated = true;
		}
	}

	const findings = [...first.values()].sort(
		(a, b) =>
			Number(b.stale) - Number(a.stale) ||
			a.source.localeCompare(b.source) ||
			a.line - b.line,
	);
	return {
		assertions: findings.length,
		stale: findings.filter((item) => item.stale).length,
		generated: findings.filter((item) => item.generated).length,
		sources,
		findings,
	};
}

export function formatRotHeadline(report: RotReport): string {
	if (report.assertions === 0) {
		return "context rot：指令文件里没有可核对的代码路径引用（CLAUDE.md / AGENTS.md / .cursorrules）";
	}
	const pct =
		report.stale === 0
			? "0%"
			: `${Math.round((report.stale / report.assertions) * 100)}%`;
	const generatedNote =
		report.generated > 0 ? `，另有 ${report.generated} 条生成物引用不计入` : "";
	return `context rot：${report.assertions} 条架构断言，${report.stale} 条已失效（${pct}）${generatedNote}`;
}

/**
 * Batch `git check-ignore` over the stale refs. Exit code 1 means "none of
 * them are ignored" — a result, not a failure. Only called when the root is
 * a git work tree; any other git failure conservatively ignores nothing.
 */
async function checkIgnored(
	root: string,
	refs: string[],
): Promise<Set<string>> {
	if (refs.length === 0 || !(await pathExists(join(root, ".git")))) {
		return new Set();
	}
	const result = await git(["check-ignore", "--", ...refs], root);
	if (result.code !== 0) {
		return new Set();
	}
	return new Set(
		result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0),
	);
}

async function gitLs(root: string): Promise<string[] | null> {
	// git walks up to a parent repo; only trust ls-files when THIS
	// directory is the root, otherwise a temp fixture inside some other
	// checkout would scan the wrong tree.
	if (!(await pathExists(join(root, ".git")))) {
		return null;
	}
	const result = await git(
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		root,
	);
	if (!result.ok || result.stdout.length === 0) {
		return null;
	}
	return result.stdout.split("\0").filter((item) => item.length > 0);
}

async function walkFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	await walk(root, root, out);
	return out;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (SKIP_DIRS.has(name)) {
			continue;
		}
		const full = join(dir, name);
		let st: Awaited<ReturnType<typeof stat>>;
		try {
			st = await stat(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			await walk(full, root, out);
			continue;
		}
		const rel = full.slice(root.length).replace(/\\/g, "/").replace(/^\//, "");
		if (rel) {
			out.push(rel);
		}
	}
}
