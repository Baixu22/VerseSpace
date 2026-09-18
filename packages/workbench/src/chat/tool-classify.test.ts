import { describe, expect, test } from "bun:test";
import { classifyToolWithArgs, normalizeToolName } from "./tool-classify";

const category = (command: string) => classifyToolWithArgs("Bash", { command });

describe("tool collapse classification", () => {
	test("normalizes built-in and MCP tool names", () => {
		expect(normalizeToolName("WebSearch")).toBe("web_search");
		expect(classifyToolWithArgs("Glob", { pattern: "*.ts" })).toBe("search");
		expect(
			classifyToolWithArgs("mcp__filesystem__read_text_file", { path: "a.ts" }),
		).toBe("read");
		expect(classifyToolWithArgs("Write", { file_path: "a.ts" })).toBe("other");
		expect(classifyToolWithArgs("Bash", null)).toBe("other");
	});

	test.each([
		'rg "foo|bar" src | head -20',
		"git -C repo status && git diff --stat",
		"rg needle src || grep needle file; cat file",
		"cat file | sort | uniq | wc -l",
		"/bin/bash -lc 'git status && ls'",
		"sed -n '1,20p' source.ts",
		"find src -type f -name '*.ts'",
		"echo 'literal > output; rm file'",
		"printf '%s' 'literal $(touch no)'",
	])("recognizes readonly shell: %s", (command) => {
		expect(category(command)).toBe("shell");
	});

	test.each([
		"cat files.txt | xargs rm",
		"rg foo || touch marker",
		"cat source > copy",
		"cat source >> copy",
		"cat < source",
		"git status; git checkout main",
		"cat source & touch marker",
		"cat source\nrm file",
		"echo $(touch file)",
		"echo `touch file`",
		'echo "$(touch file)"',
		"sed -i 's/a/b/' file",
		"sed 'w output' file",
		"awk 'BEGIN {system(\"touch file\")}'",
		"find . -delete",
		"find . -exec rm '{}' ';'",
		"find . -fprint output",
		"fd -x rm",
		"sort -o output input",
		"sort --output=output input",
		"uniq input output",
		"file -C",
		"rg --pre='touch file' needle file",
		"git -c core.pager='touch file' log",
		"git diff --output=out",
		"git show --ext-diff",
		"git cat-file --filters HEAD:path",
		"/bin/bash -lc 'ls; touch file'",
		"env touch file",
		"date -s tomorrow",
		"cat file &&",
		"| cat file",
		"cat 'unclosed",
		"",
		"FOO=value cat file",
	])("keeps writes and ambiguous shell visible: %s", (command) => {
		expect(category(command)).toBe("other");
	});
});
