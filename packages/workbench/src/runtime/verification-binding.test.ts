import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitResult, GitRunner } from "../git";
import { hashFile } from "../hash";
import { checkVerificationBinding } from "./verification-binding";

const ok = (stdout: string): GitResult => ({
	ok: true,
	code: 0,
	stdout,
	stderr: "",
});
const fail: GitResult = { ok: false, code: 128, stdout: "", stderr: "boom" };

/** 注入式 git：只回答本模块用到的两条命令。 */
function fakeGit(answers: { head?: GitResult; status?: GitResult }): GitRunner {
	return async (args: string[]) => {
		if (args[0] === "rev-parse") {
			return answers.head ?? fail;
		}
		if (args[0] === "status") {
			return answers.status ?? fail;
		}
		return fail;
	};
}

async function makeDir(files: Record<string, string> = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "vbinding-"));
	for (const [path, content] of Object.entries(files)) {
		await writeFile(join(root, path), content, "utf8");
	}
	return root;
}

describe("验证绑定比较谓词（注入 GitRunner）", () => {
	test("没有绑定 → unbound，不判过期", async () => {
		const verdict = await checkVerificationBinding(
			"unused",
			undefined,
			fakeGit({}),
		);
		expect(verdict.status).toBe("unbound");
	});

	test("HEAD 与改动文件都一致 → intact", async () => {
		const dir = await makeDir();
		try {
			const verdict = await checkVerificationBinding(
				dir,
				{ commit: "abc123", files: {} },
				fakeGit({
					head: ok("abc123"),
					status: ok(""),
				}),
			);
			expect(verdict.status).toBe("intact");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("HEAD 变化 → 过期", async () => {
		const dir = await makeDir();
		try {
			const verdict = await checkVerificationBinding(
				dir,
				{ commit: "abc123", files: {} },
				fakeGit({
					head: ok("def456"),
					status: ok(""),
				}),
			);
			expect(verdict.status).toBe("invalidated");
			if (verdict.status === "invalidated") {
				expect(verdict.reason).toContain("HEAD");
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("验证后改动文件内容变化 → 过期", async () => {
		const dir = await makeDir({ "a.txt": "v1\n" });
		try {
			const recorded = await hashFile(join(dir, "a.txt"));
			await writeFile(join(dir, "a.txt"), "v2\n", "utf8");
			const verdict = await checkVerificationBinding(
				dir,
				{ commit: "abc123", files: { "a.txt": recorded } },
				fakeGit({
					head: ok("abc123"),
					status: ok(" M a.txt\0"),
				}),
			);
			expect(verdict.status).toBe("invalidated");
			if (verdict.status === "invalidated") {
				expect(verdict.reason).toContain("a.txt");
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("验证后新增未覆盖的改动 → 过期", async () => {
		const dir = await makeDir({ "b.txt": "new\n" });
		try {
			const verdict = await checkVerificationBinding(
				dir,
				{ commit: "abc123", files: {} },
				fakeGit({
					head: ok("abc123"),
					status: ok("?? b.txt\0"),
				}),
			);
			expect(verdict.status).toBe("invalidated");
			if (verdict.status === "invalidated") {
				expect(verdict.reason).toContain("b.txt");
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("验证后被改的文件已删除 → 过期", async () => {
		const dir = await makeDir();
		try {
			const verdict = await checkVerificationBinding(
				dir,
				{ commit: "abc123", files: { "a.txt": "deadbeef" } },
				fakeGit({
					head: ok("abc123"),
					status: ok(" D a.txt\0"),
				}),
			);
			expect(verdict.status).toBe("invalidated");
			if (verdict.status === "invalidated") {
				expect(verdict.reason).toContain("已被删除");
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("当前工作区不可读 → 过期（不静默当 intact）", async () => {
		const verdict = await checkVerificationBinding(
			"does-not-matter",
			{ commit: "abc123", files: {} },
			fakeGit({ head: fail, status: fail }),
		);
		expect(verdict.status).toBe("invalidated");
		if (verdict.status === "invalidated") {
			expect(verdict.reason).toContain("不可读");
		}
	});
});
