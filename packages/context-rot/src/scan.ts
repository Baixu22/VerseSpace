/**
 * 扫描编排：指引文件 → 引用提取 → 语料构建 → 分类型验证。
 * 符号引用走批量验证（每个语料文件只读一次），保证「即时输出」。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type CodeRef, DOC_FILES, extractRefs } from "./extract.ts";
import {
	buildCorpus,
	type VerifyResult,
	verifyRef,
	verifySymbols,
} from "./verify.ts";

export interface StaleRef extends CodeRef {
	reason: string;
}

export interface ScanResult {
	root: string;
	/** 实际扫描到的指引文件（相对路径） */
	docs: string[];
	/** 提取出的断言总数 */
	total: number;
	valid: number;
	stale: StaleRef[];
	/** gitignore 覆盖的生成物引用：索引不可证伪，不计入失效（issue #2） */
	generated: number;
	/** 文档惯例等无法确定性判定的引用数（不计入失效） */
	unverified: number;
	durationMs: number;
}

/** 找出仓库根实际存在的指引文件（相对路径）。 */
export function collectDocFiles(root: string): string[] {
	const found: string[] = [];
	for (const name of DOC_FILES) {
		const p = join(root, name);
		if (existsSync(p) && statSync(p).isFile()) found.push(name);
	}
	const cursorRules = join(root, ".cursor", "rules");
	if (existsSync(cursorRules)) {
		const stack = [cursorRules];
		while (stack.length > 0) {
			const dir = stack.pop() as string;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) stack.push(full);
				else if (/\.(md|mdc)$/i.test(entry.name)) {
					// 用 relative 而不是 slice：root 可能是 "." 之类的相对路径
					found.push(relative(resolve(root), full).split("\\").join("/"));
				}
			}
		}
	}
	return found;
}

/** 对一个仓库根执行完整扫描。root 接受相对路径，内部归一为绝对路径。 */
export async function scanRepo(rootInput: string): Promise<ScanResult> {
	const started = performance.now();
	const root = resolve(rootInput);
	const docs = collectDocFiles(root);

	const refs: CodeRef[] = [];
	for (const doc of docs) {
		const content = readFileSync(join(root, doc), "utf8");
		refs.push(...extractRefs(doc, content));
	}

	const corpus = buildCorpus(root, docs);

	const stale: StaleRef[] = [];
	let valid = 0;
	let unverified = 0;
	let generated = 0;

	const apply = (ref: CodeRef, result: VerifyResult): void => {
		if (result.status === "valid") {
			valid++;
		} else if (result.status === "unverified") {
			unverified++;
		} else {
			stale.push({ ...ref, reason: result.reason ?? "未知原因" });
		}
	};

	const symbolRefs: CodeRef[] = [];
	for (let i = 0; i < refs.length; i++) {
		const ref = refs[i] as CodeRef;
		if (ref.kind === "symbol") {
			symbolRefs.push(ref);
		} else {
			apply(ref, verifyRef(ref, root, corpus));
		}
	}
	const symbolResults = await verifySymbols(symbolRefs, corpus);
	for (let i = 0; i < symbolRefs.length; i++) {
		apply(symbolRefs[i] as CodeRef, symbolResults[i] as VerifyResult);
	}

	// 生成物重分类（issue #2，与 workbench src/rot/scan.ts 同口径）：
	// gitignore 覆盖且磁盘上不存在的引用（未构建的产物路径）无法从
	// 索引证伪——单独计数，绝不计入失效。git 失败保守地不豁免任何引用。
	const ignored = checkIgnored(
		root,
		stale.map((s) => s.text),
	);
	if (ignored.size > 0) {
		for (let i = stale.length - 1; i >= 0; i--) {
			const s = stale[i] as StaleRef;
			if (ignored.has(s.text)) {
				stale.splice(i, 1);
				generated++;
			}
		}
	}

	stale.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);

	return {
		root,
		docs,
		total: refs.length,
		valid,
		stale,
		generated,
		unverified,
		durationMs: Math.round(performance.now() - started),
	};
}

/**
 * 批量 `git check-ignore`：返回被 .gitignore 覆盖的引用集合。
 * 退出码 1 = 全部未被忽略（这是结果不是失败）；无 .git 或任何
 * git 异常时保守返回空集——宁可多报也不静默吞掉真失效。
 */
function checkIgnored(root: string, refs: string[]): Set<string> {
	const out = new Set<string>();
	if (refs.length === 0 || !existsSync(join(root, ".git"))) {
		return out;
	}
	try {
		const stdout = execFileSync("git", ["check-ignore", "--", ...refs], {
			cwd: root,
			encoding: "utf8",
		});
		for (const line of stdout.split("\n")) {
			const trimmed = line.trim();
			if (trimmed) out.add(trimmed);
		}
	} catch {
		// 退出码 1（全部未忽略）与其他 git 失败都走这里：保守不豁免
	}
	return out;
}
