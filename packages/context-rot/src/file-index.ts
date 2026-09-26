import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".next",
	".turbo",
	".output",
	".nuxt",
	".svelte-kit",
	".venv",
	"venv",
	"__pycache__",
	"worktrees",
	".workbench",
	".agent-workbench",
	".workbuddy",
	".bundle-cache",
	"playwright-report",
	"test-results",
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
	const path = relPath.replace(/\\/g, "/");
	const base = path.split("/").pop() ?? "";
	return (
		INSTRUCTION_BASENAMES.has(base.toLowerCase()) ||
		(/(?:^|\/)\.cursor\/rules\//.test(path) && /\.mdc?$/i.test(base)) ||
		(/(?:^|\/)\.github\/instructions\//.test(path) && /\.md$/i.test(base))
	);
}

export interface FileIndex {
	files: Set<string>;
	dirs: Set<string>;
	basenames: Set<string>;
}

export function resolveRef(ref: string, index: FileIndex): boolean {
	const trimmed = ref.replace(/\\/g, "/");
	const path = trimmed.replace(/\/+$/, "");
	if (!path) return false;
	if (index.files.has(path) || index.dirs.has(path)) return true;
	if (!path.includes("/")) {
		if (index.basenames.has(path.toLowerCase())) return true;
		return (
			trimmed.endsWith("/") &&
			[...index.dirs].some((dir) => dir.endsWith(`/${path}`))
		);
	}
	const suffix = `/${path}`;
	return [...index.files, ...index.dirs].some((entry) =>
		entry.endsWith(suffix),
	);
}

/** Use the checkout's index, including untracked files but excluding deleted files. */
export function buildFileIndex(root: string): FileIndex {
	let listed: string[] | undefined;
	if (existsSync(join(root, ".git"))) {
		try {
			listed = execFileSync(
				"git",
				["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
				{
					cwd: root,
					encoding: "utf8",
					windowsHide: true,
					stdio: ["ignore", "pipe", "ignore"],
					maxBuffer: 16 * 1024 * 1024,
				},
			)
				.split("\0")
				.filter((path) => path && existsSync(join(root, path)));
		} catch {
			// Non-git trees and unavailable git use the filesystem walk.
		}
	}
	if (!listed) {
		listed = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (SKIP_DIRS.has(entry.name)) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile()) listed!.push(relative(root, full));
			}
		};
		walk(root);
	}
	const files = new Set<string>();
	const dirs = new Set<string>();
	const basenames = new Set<string>();
	for (const raw of listed) {
		const path = raw.replace(/\\/g, "/");
		const parts = path.split("/");
		if (parts.slice(0, -1).some((part) => SKIP_DIRS.has(part))) continue;
		files.add(path);
		basenames.add(parts.at(-1)!.toLowerCase());
		for (let i = 1; i < parts.length; i++)
			dirs.add(parts.slice(0, i).join("/"));
	}
	return { files, dirs, basenames };
}

/** NUL-delimited paths preserve spaces and non-ASCII names in git output. */
export function checkIgnored(root: string, refs: string[]): Set<string> {
	if (refs.length === 0 || !existsSync(join(root, ".git"))) return new Set();
	// A directory-only ignore pattern (`/.workbench/`) cannot match a bare path
	// whose directory is absent: git will not guess that a path it cannot stat is
	// a directory. Probe the trailing-slash form too and map the answer back —
	// otherwise a gitignored directory that a clean clone legitimately lacks
	// reads as rot. Measured 2026-09-26: `doctor` exited 1 in CI on exactly
	// `.workbench` and `.agent-contexts`, while the same tree passed locally,
	// where those directories exist (ADR-0020 keeps them out of the clone).
	const probes = new Map<string, string>();
	for (const ref of refs) {
		probes.set(ref, ref);
		probes.set(`${ref.replace(/\/+$/, "")}/`, ref);
	}
	try {
		const printed = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
			cwd: root,
			input: `${[...probes.keys()].join("\0")}\0`,
			encoding: "utf8",
			windowsHide: true,
			stdio: ["pipe", "pipe", "ignore"],
			maxBuffer: 16 * 1024 * 1024,
		})
			.split("\0")
			.filter(Boolean);
		const ignored = new Set<string>();
		for (const probe of printed) {
			const original = probes.get(probe);
			if (original) ignored.add(original);
		}
		return ignored;
	} catch {
		// Exit 1 means none ignored. Other failures do not exempt any citation.
		return new Set();
	}
}
