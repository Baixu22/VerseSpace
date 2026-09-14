/**
 * 引用验证：把 extract 提取的断言对照仓库现实。
 *
 * 三条判定，全部确定性、零 agent：
 * - path    → 先按仓库根精确存在性检查；再按「任意现存路径的后缀」找一遍
 *             （文档里的表格缩写如 `index.tsx`、`features/panel` 是相对
 *             陈述基路径写的，按字面从仓库根检查会全部误报）；
 *             无扩展名的目录名找不到时降级为 unverified 而不是 stale，
 *             避免 `foo/` 这类示例名污染失效清单。
 * - package → 在仓库内所有 package.json 的依赖声明里查名字
 * - symbol  → 批量在源码语料库里做全词匹配，0 次出现即失效
 */

import {
	type Dirent,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CodeRef } from "./extract.ts";
import { buildFileIndex, type FileIndex, resolveRef } from "./file-index";

export type VerifyStatus = "valid" | "stale" | "unverified";

export interface VerifyResult {
	status: VerifyStatus;
	/** 失效原因（status=stale 时给出） */
	reason?: string;
}

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"target",
	"worktrees",
	"coverage",
	".turbo",
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	".venv",
	"venv",
	"__pycache__",
	".storybook",
	"playwright-report",
	"test-results",
]);

const SKIP_EXTENSIONS =
	/\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|mp3|ogg|wav|mp4|webm|wasm|zip|gz|br|rlib|rmeta|snap|bin|exe|dll|pdb|node|icns)$/;

const SKIP_NAME =
	/(?:bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 30_000;

const TEXT_EXTENSIONS =
	/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|rs|py|go|java|kt|swift|c|h|cpp|hpp|cs|rb|php|toml|json|ya?ml|md|mdx|css|scss|html|sh|bash|zsh|ps1|bat|cmd|sql|graphql|proto|txt|env)$/;

export interface Corpus {
	/** 仓库内全部文件与目录的相对路径（正斜杠），用于路径后缀匹配 */
	entries: string[];
	/** 参与符号搜索的文本文件（绝对路径） */
	sourceFiles: string[];
	/** 仓库内全部 package.json（绝对路径） */
	packageJsonFiles: string[];
	/** 应从语料中排除的指引文件本身（绝对路径） */
	docFiles: Set<string>;
}

/** 遍历仓库，收集路径索引、源码语料与 package.json。 */
export function buildCorpus(root: string, docRelativePaths: string[]): Corpus {
	const entries: string[] = [];
	const sourceFiles: string[] = [];
	const packageJsonFiles: string[] = [];
	const docFiles = new Set(docRelativePaths.map((p) => join(root, p)));

	const walk = (dir: string, depth: number): void => {
		if (depth > 15 || entries.length > MAX_FILES * 2) return;
		let list: Dirent[];
		try {
			list = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of list) {
			const full = join(dir, entry.name);
			const rel = relative(root, full).split("\\").join("/");
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				entries.push(rel);
				walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			entries.push(rel);
			if (SKIP_EXTENSIONS.test(entry.name) || SKIP_NAME.test(entry.name))
				continue;
			if (entry.name === "package.json") {
				packageJsonFiles.push(full);
			}
			if (docFiles.has(full)) continue;
			if (!TEXT_EXTENSIONS.test(entry.name) || entry.name.endsWith(".d.ts"))
				continue;
			if (sourceFiles.length >= MAX_FILES) continue;
			sourceFiles.push(full);
		}
	};
	walk(root, 0);
	return { entries, sourceFiles, packageJsonFiles, docFiles };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 指引文件里的「外部工具名」不是本仓库的符号：Tauri MCP bridge 的工具
 * （webview_* / ipc_* / driver_session / manage_window / read_logs）由
 * 仅 debug 构建下的 MCP server 提供，永远不会出现在本检出里。
 * 「语料 0 次出现」对它们是无效证据——判 unverified，不判 stale。
 * （2026-09-13：helmor 现场 28 条 symbol 失效里有 20 条是这类误报。）
 */
const EXTERNAL_TOOL_PREFIXES = ["webview_", "ipc_"];
const EXTERNAL_TOOL_NAMES = new Set([
	"driver_session",
	"manage_window",
	"read_logs",
]);

export function isExternalToolName(symbol: string): boolean {
	return (
		EXTERNAL_TOOL_NAMES.has(symbol) ||
		EXTERNAL_TOOL_PREFIXES.some((prefix) => symbol.startsWith(prefix))
	);
}

/** 全词匹配正则。点号按字面处理；`_` 与 `$` 属于词字符。 */
function symbolRegex(symbol: string): RegExp {
	return new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
}

/**
 * 按符号名字片段与文件路径的重合度给语料文件排序：
 * 符号的每个分段（camelCase 拆词）出现在路径里越多，排得越靠前。
 */
function rankFilesBySymbolAffinity(refs: CodeRef[], files: string[]): string[] {
	if (refs.length === 0) return files;
	const tokens = new Set<string>();
	for (const ref of refs) {
		for (const segment of ref.text.split(".")) {
			for (const word of segment
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.split(/[\s_$]+/)) {
				const w = word.toLowerCase();
				if (w.length >= 4) tokens.add(w);
			}
		}
	}
	if (tokens.size === 0) return files;
	const score = (file: string): number => {
		const lower = file.toLowerCase();
		let s = 0;
		for (const t of tokens) if (lower.includes(t)) s++;
		return s;
	};
	return [...files].sort((a, b) => score(b) - score(a));
}

function readText(file: string): string | null {
	try {
		if (statSync(file).size > MAX_FILE_BYTES) return null;
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

export function verifyRef(
	ref: CodeRef,
	root: string,
	corpus: Corpus,
	index?: FileIndex,
): VerifyResult {
	if (ref.kind === "path") {
		const target = join(root, ...ref.text.split("/"));
		if (existsSync(target)) return { status: "valid" };

		const lastSegment = ref.text.split("/").pop() ?? "";
		const path = lastSegment.includes(".") ? ref.text : `${ref.text}/`;
		if (resolveRef(path, index ?? buildFileIndex(root))) {
			return { status: "valid" };
		}

		// 无扩展名的目录引用找不到时降级，不进失效清单
		if (!lastSegment.includes(".")) {
			return { status: "unverified" };
		}
		return { status: "stale", reason: "路径不存在" };
	}

	if (ref.kind === "package") {
		for (const pkgPath of corpus.packageJsonFiles) {
			const content = readText(pkgPath);
			if (content === null) continue;
			try {
				const pkg = JSON.parse(content) as Record<string, unknown>;
				const sections = [
					pkg.name,
					...Object.keys((pkg.dependencies as object) ?? {}),
					...Object.keys((pkg.devDependencies as object) ?? {}),
					...Object.keys((pkg.peerDependencies as object) ?? {}),
					...Object.keys((pkg.optionalDependencies as object) ?? {}),
				];
				if (sections.includes(ref.text)) return { status: "valid" };
			} catch {
				// 解析失败的 package.json 不参与判定
			}
		}
		return { status: "stale", reason: "未在任何 package.json 声明" };
	}

	// 单个符号验证：全库全词搜索（批量场景请用 verifySymbols）
	if (isExternalToolName(ref.text)) {
		return { status: "unverified" };
	}
	const needle = symbolRegex(ref.text);
	for (const file of corpus.sourceFiles) {
		const content = readText(file);
		if (content === null) continue;
		if (needle.test(content)) return { status: "valid" };
	}
	return { status: "stale", reason: "全库 0 次出现" };
}

/**
 * 批量符号验证：每个语料文件只读一次，逐个淘汰仍未命中的符号。
 * 并行分块读取，保证大仓库也能即时输出。
 * 返回每条符号引用的判定结果（与输入顺序一致）。
 */
export async function verifySymbols(
	refs: CodeRef[],
	corpus: Corpus,
): Promise<VerifyResult[]> {
	const results: VerifyResult[] = refs.map((ref) =>
		isExternalToolName(ref.text)
			? { status: "unverified" }
			: { status: "stale", reason: "全库 0 次出现" },
	);
	// 外部工具名不进待搜集合——它们永远搜不到，留在 pending 里只会白扫语料
	const pending: number[] = refs
		.map((ref, index) => (isExternalToolName(ref.text) ? -1 : index))
		.filter((index) => index >= 0);
	if (pending.length === 0) return results;

	const CHUNK = 128;
	// 路径相关性优先：符号大概率在与其名字片段匹配的文件里先命中，
	// 优先读这些文件能让多数 valid 引用提前退出，不必扫完全库。
	const ranked = rankFilesBySymbolAffinity(refs, corpus.sourceFiles);
	for (let start = 0; start < ranked.length; start += CHUNK) {
		if (pending.length === 0) break;
		const chunk = ranked.slice(start, start + CHUNK);
		const contents = await Promise.all(
			chunk.map(async (file) => {
				try {
					if ((await stat(file)).size > MAX_FILE_BYTES) return null;
					return await readFile(file, "utf8");
				} catch {
					return null;
				}
			}),
		);
		for (let c = 0; c < contents.length; c++) {
			const content = contents[c];
			if (content == null) continue;
			for (let p = pending.length - 1; p >= 0; p--) {
				const idx = pending[p] as number;
				const ref = refs[idx] as CodeRef;
				if (symbolRegex(ref.text).test(content)) {
					results[idx] = { status: "valid" };
					pending.splice(p, 1);
				}
			}
		}
	}
	return results;
}
