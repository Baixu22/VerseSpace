import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyReadSpan,
	goalFromUserText,
	goalMet,
	spansFromUserText,
} from "./live-agent-goals";

const cleanup: string[] = [];

afterEach(async () => {
	for (const dir of cleanup.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

test("spansFromUserText 解析 READSPAN 并强制补到全文 Read 参数上", () => {
	const prompt = [
		"请处理以下任务。",
		"READSPAN src/notes.md 1 3",
		"WRITE src/alpha.ts",
		'export const alpha = "v2";',
		"__END_WRITE__",
	].join("\n");
	expect(spansFromUserText(prompt)).toEqual([
		{ path: "src/notes.md", offset: 1, limit: 3 },
	]);
	expect(
		applyReadSpan(
			"Read",
			{ file_path: "src/notes.md" },
			spansFromUserText(prompt),
		),
	).toEqual({ file_path: "src/notes.md", offset: 1, limit: 3 });
	expect(
		applyReadSpan(
			"Read",
			{ file_path: "src/alpha.ts" },
			spansFromUserText(prompt),
		),
	).toEqual({ file_path: "src/alpha.ts" });
	expect(
		applyReadSpan("Write", { file_path: "src/notes.md", content: "x" }, spansFromUserText(prompt)),
	).toEqual({ file_path: "src/notes.md", content: "x" });
});

test("goalFromUserText 解析 WRITE 指令的目标路径与期望内容", () => {
	const goal = goalFromUserText(
		"分支上继续。\nWRITE src/alpha.ts\nexport const alpha = \"v4 on branch\";\n__END_WRITE__",
	);
	expect(goal).not.toBeNull();
	expect(goal?.path).toBe("src/alpha.ts");
	expect(goal?.expected).toBe('export const alpha = "v4 on branch";');
});

test("goalFromUserText 仅识别 src/ 相对路径 WRITE，其他文本返回 null", () => {
	expect(goalFromUserText("普通问题，不含写指令")).toBeNull();
	expect(goalFromUserText("WRITE /etc/passwd\nx\n__END_WRITE__")).toBeNull();
	expect(
		goalFromUserText("WRITE src/notes.md\nfirst\nsecond\n__END_WRITE__"),
	).toEqual({ path: "src/notes.md", expected: "first\nsecond" });
});

test("goalMet 对比磁盘实际内容：相等返回 true，缺文件/不等返回 false", async () => {
	const root = await mkdtemp(join(tmpdir(), "live-agent-goals-"));
	cleanup.push(root);
	const goal = goalFromUserText(
		"WRITE src/alpha.ts\nexport const alpha = \"v4 on branch\";\n__END_WRITE__",
	);
	expect(goal).not.toBeNull();
	// File absent
	expect(await goalMet(root, goal!)).toBe(false);
	// File present but different
	await writeFile(
		join(root, "src", "alpha.ts"),
		'export const alpha = "v2";',
		"utf8",
	).catch(async () => {
		await import("node:fs/promises").then((fs) =>
			fs.mkdir(join(root, "src"), { recursive: true }),
		);
		await writeFile(
			join(root, "src", "alpha.ts"),
			'export const alpha = "v2";',
			"utf8",
		);
	});
	expect(await goalMet(root, goal!)).toBe(false);
	// File matching exactly
	await writeFile(
		join(root, "src", "alpha.ts"),
		'export const alpha = "v4 on branch";',
		"utf8",
	);
	expect(await goalMet(root, goal!)).toBe(true);
});

test("goalMet 对带换行结尾的 WRITE 容忍指令末尾换行差异", async () => {
	const root = await mkdtemp(join(tmpdir(), "live-agent-goals-"));
	cleanup.push(root);
	const goal = goalFromUserText(
		"WRITE src/alpha.ts\nline1\nline2\n__END_WRITE__",
	);
	expect(goal).not.toBeNull();
	await import("node:fs/promises").then((fs) =>
		fs.mkdir(join(root, "src"), { recursive: true }),
	);
	await writeFile(join(root, "src", "alpha.ts"), "line1\nline2", "utf8");
	expect(await goalMet(root, goal!)).toBe(true);
});
