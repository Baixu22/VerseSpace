import { describe, expect, test } from "bun:test";
import {
	blankFencedBlocks,
	classifySpan,
	extractRefs,
	inlineSpans,
	stripLineSuffix,
} from "./extract.ts";

describe("inlineSpans", () => {
	test("提取单行内的行内代码 span", () => {
		expect(inlineSpans("use `foo.ts` and `bar` here")).toEqual([
			"foo.ts",
			"bar",
		]);
	});

	test("支持双反引号 span", () => {
		expect(inlineSpans("run ``a `b`` now")).toEqual(["a `b"]);
	});

	test("没有 span 时返回空数组", () => {
		expect(inlineSpans("no code here")).toEqual([]);
	});
});

describe("stripLineSuffix", () => {
	test("去掉 :12 与 :12-40 与 #L12 后缀", () => {
		expect(stripLineSuffix("src/a.ts:12")).toBe("src/a.ts");
		expect(stripLineSuffix("src/a.ts:12-40")).toBe("src/a.ts");
		expect(stripLineSuffix("src/a.ts#L12")).toBe("src/a.ts");
		expect(stripLineSuffix("src/a.ts")).toBe("src/a.ts");
	});
});

describe("classifySpan", () => {
	test("路径引用", () => {
		expect(classifySpan("src/agents/streaming.ts")).toEqual({
			kind: "path",
			text: "src/agents/streaming.ts",
		});
		expect(classifySpan("src\\legacy\\old.ts")).toEqual({
			kind: "path",
			text: "src/legacy/old.ts",
		});
		expect(classifySpan("packages/workbench/")).toEqual({
			kind: "path",
			text: "packages/workbench",
		});
		expect(classifySpan("README.md")).toEqual({
			kind: "path",
			text: "README.md",
		});
	});

	test("路径引用去掉行号后缀", () => {
		expect(classifySpan("src/a.ts:12")).toEqual({
			kind: "path",
			text: "src/a.ts",
		});
	});

	test("路径引用去掉锚点后缀", () => {
		expect(classifySpan("README.md#usage")).toEqual({
			kind: "path",
			text: "README.md",
		});
		expect(classifySpan("src/a.ts#L12")).toEqual({
			kind: "path",
			text: "src/a.ts",
		});
	});

	test("绝对路径与仓库外遍历不参与判定", () => {
		expect(classifySpan("C:\\Users\\demo\\src\\a.ts")).toBeNull(); // Windows 盘符
		expect(classifySpan("D:/repo/src/a.ts")).toBeNull();
		expect(classifySpan("../escape/a.ts")).toBeNull(); // 越出仓库根
		expect(classifySpan("src/../../etc/passwd")).toBeNull();
	});

	test("符号引用：限定名与代码风格单词", () => {
		expect(classifySpan("agents.streaming.runTurn")).toEqual({
			kind: "symbol",
			text: "agents.streaming.runTurn",
		});
		expect(classifySpan("useAppShellState")).toEqual({
			kind: "symbol",
			text: "useAppShellState",
		});
		expect(classifySpan("HELMOR_DATA_DIR")).toEqual({
			kind: "symbol",
			text: "HELMOR_DATA_DIR",
		});
	});

	test("包引用：@scope/name", () => {
		expect(classifySpan("@anthropic-ai/claude-agent-sdk")).toEqual({
			kind: "package",
			text: "@anthropic-ai/claude-agent-sdk",
		});
	});

	test("不可检验的内容返回 null", () => {
		expect(classifySpan("https://example.com")).toBeNull();
		expect(classifySpan("bun run test")).toBeNull(); // 含空格
		expect(classifySpan("1.2.3")).toBeNull();
		expect(classifySpan("v4.3.0")).toBeNull();
		expect(classifySpan("rust")).toBeNull(); // 全小写短词
		expect(classifySpan("")).toBeNull();
		expect(classifySpan("#anchor")).toBeNull();
		expect(classifySpan("--flag")).toBeNull();
	});

	test("文档惯例写法不判失效，直接忽略", () => {
		expect(classifySpan("{data_dir}/logs")).toBeNull(); // 占位符
		expect(classifySpan("src/features/<name>")).toBeNull(); // 占位符
		expect(classifySpan(".changeset/*.md")).toBeNull(); // glob
		expect(classifySpan("…/checksums.txt")).toBeNull(); // 省略号
		expect(classifySpan("~/helmor")).toBeNull(); // 家目录
		expect(classifySpan("/agent-browser")).toBeNull(); // 根斜杠命令
		expect(classifySpan("@/")).toBeNull(); // 别名碎片
		expect(classifySpan("@scope/pkg-{a,b}")).toBeNull(); // 花括号展开
		expect(classifySpan("./")).toBeNull();
	});
});

describe("blankFencedBlocks", () => {
	test("围栏内容清空但行数不变", () => {
		const src = ["before", "```ts", "const x = 1;", "```", "after"].join("\n");
		const blanked = blankFencedBlocks(src);
		expect(blanked.split("\n").length).toBe(5);
		expect(blanked).not.toContain("const x");
		expect(blanked.split("\n")[0]).toBe("before");
		expect(blanked.split("\n")[4]).toBe("after");
	});

	test("波浪线围栏同样处理", () => {
		const src = ["~~~", "code", "~~~"].join("\n");
		expect(
			blankFencedBlocks(src)
				.split("\n")
				.every((l) => l === ""),
		).toBe(true);
	});
});

describe("extractRefs", () => {
	test("行号保持正确且跳过围栏内容", () => {
		const content = [
			"# Title",
			"see `src/exists.ts`",
			"",
			"```sh",
			"`src/in-fence.ts`",
			"```",
			"and `MissingSymbol`",
		].join("\n");
		const refs = extractRefs("AGENTS.md", content);
		const texts = refs.map((r) => r.text);
		expect(texts).toContain("src/exists.ts");
		expect(texts).toContain("MissingSymbol");
		expect(texts).not.toContain("src/in-fence.ts");

		const exists = refs.find((r) => r.text === "src/exists.ts");
		expect(exists?.line).toBe(2);
		expect(exists?.doc).toBe("AGENTS.md");
	});
});
