import {
	blankFencedBlocks,
	extractRefs as extractPathRefs,
	isPlaceholderRef,
	FILE_EXT as KNOWN_EXTENSIONS,
	stripLineSuffix,
} from "./path-refs";

export { blankFencedBlocks, stripLineSuffix } from "./path-refs";

/**
 * 从 agent 指引文件（AGENTS.md / CLAUDE.md / .cursorrules）中提取代码引用。
 *
 * 设计口径：一条「架构断言」= 指引文件行内代码 span 中出现的路径、
 * 符号或包名。围栏代码块里的内容是示例而不是断言，整体跳过，
 * 但保留行号（块内行替换为空行，行数不变）。
 *
 * 不可检验的内容一律忽略而不是报失效——doctor 的可信度取决于
 * 不把文档惯例（表格缩写、占位符、glob、家目录引用）误报成 rot。
 */

export type RefKind = "path" | "symbol" | "package";

export interface CodeRef {
	kind: RefKind;
	/** 归一化后的引用文本（路径统一为正斜杠，去掉行号后缀） */
	text: string;
	/** 原始 span 内容 */
	raw: string;
	/** 相对仓库根的指引文件路径 */
	doc: string;
	/** 1-based 行号 */
	line: number;
}

const QUALIFIED_SYMBOL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const PLAIN_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * 占位符**文件**引用：既命中 foo/bar/baz 段、又带已知扩展名。
 *
 * 必须带扩展名才生效：限定符号 `Foo.Bar` 对 isPlaceholderRef 也返回 true
 * （以 `foo.` 开头），不能因此被豁免。
 */
function isPlaceholderFileRef(token: string): boolean {
	return KNOWN_EXTENSIONS.test(token) && isPlaceholderRef(token);
}

/** 提取一行内的行内代码 span（`code`）。 */
export function inlineSpans(line: string): string[] {
	const spans: string[] = [];
	const re = /(`+)((?:(?!\1)[\s\S])+?)\1/g;
	for (const m of line.matchAll(re)) {
		spans.push((m[2] as string).trim());
	}
	return spans;
}

/**
 * 把一个 span 分类为 path / symbol / package 引用；
 * 返回 null 表示不是可检验的断言（命令、URL、版本号、占位符、纯散文等）。
 */
export function classifySpan(
	raw: string,
): { kind: RefKind; text: string } | null {
	const t = raw.trim();
	if (t.length === 0 || t.length > 200) return null;
	if (t.includes("://")) return null; // URL
	if (t.startsWith("#") || t.startsWith("<") || t.startsWith("--")) return null;
	if (/^v?\d[\d.\-+]*$/.test(t)) return null; // 版本号、纯数字
	if (/\s/.test(t)) return null; // 命令或短语，如 `bun run test`
	// 不可检验的路径写法：占位符（{a}/<b>）、glob（*.md）、省略号、
	// 家目录、根斜杠命令、Windows 盘符绝对路径
	if (/[{<>}*…]/.test(t) || t.startsWith("~") || t.startsWith("/")) return null;
	if (/^[a-z]:[\\/]/i.test(t)) return null;

	// 包名：@scope/name
	if (/^@[\w.-]+\/[\w.-]+$/.test(t)) {
		return { kind: "package", text: t };
	}

	// 路径：含分隔符或带已知扩展名
	const candidate = stripLineSuffix(t);
	if (candidate.includes("\\") || candidate.includes("/")) {
		const normalized = candidate.replace(/\\/g, "/").replace(/\/+$/, "");
		if (
			normalized.length < 2 ||
			!/\w/.test(normalized) ||
			normalized === "." ||
			normalized.split("/").includes("..") || // 不做仓库外遍历
			isPlaceholderRef(normalized) // 教学示例名不是断言（issue #2）
		) {
			return null; // `@/`、`./` 之类的别名碎片
		}
		return { kind: "path", text: normalized };
	}
	if (candidate.split("/").includes("..")) return null;
	if (KNOWN_EXTENSIONS.test(candidate) && !isPlaceholderRef(candidate)) {
		return { kind: "path", text: candidate };
	}

	// 符号：限定名（a.b.c）或「足够像代码」的单词标识符。
	// 全小写短词（rust、bun、streamdown 之类）不是断言。
	// 占位符文件不能继续落入限定符号分支（foo.rs 也匹配 a.b）。
	if (isPlaceholderFileRef(t)) return null;
	if (QUALIFIED_SYMBOL.test(t)) {
		return { kind: "symbol", text: t };
	}
	if (
		PLAIN_IDENTIFIER.test(t) &&
		t.length >= 5 &&
		(/[A-Z]/.test(t) || t.includes("_") || t.includes("$"))
	) {
		return { kind: "symbol", text: t };
	}

	return null;
}

/** 从一份指引文件内容中提取全部代码引用。 */
export function extractRefs(doc: string, content: string): CodeRef[] {
	const refs: CodeRef[] = extractPathRefs(content).map((ref) => ({
		kind: "path",
		text: ref.ref.replace(/\/+$/, ""),
		raw: ref.ref,
		doc,
		line: ref.line,
	}));
	const blanked = blankFencedBlocks(content);
	const lines = blanked.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		for (const span of inlineSpans(line)) {
			const classified = classifySpan(span);
			if (classified && classified.kind !== "path") {
				refs.push({
					kind: classified.kind,
					text: classified.text,
					raw: span,
					doc,
					line: i + 1,
				});
			}
		}
	}
	return refs.sort((a, b) => a.line - b.line);
}
