import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { checkVerificationBinding } from "./verification-binding";
import { captureVerificationBinding } from "./verification-snapshot";

function git(dir: string, ...args: string[]) {
	execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

async function repo() {
	const ws = await makeTempWorkbench();
	await writeFile(join(ws.projectDir, ".gitignore"), ".workbench/\n");
	await writeFile(join(ws.projectDir, "tracked.txt"), "original");
	git(ws.projectDir, "init", "-q", "-b", "main");
	git(ws.projectDir, "config", "user.name", "test");
	git(ws.projectDir, "config", "user.email", "test@example.invalid");
	git(ws.projectDir, "add", ".");
	git(ws.projectDir, "-c", "core.hooksPath=", "commit", "-qm", "baseline");
	return ws;
}

test("clean tracked deletion invalidates; unchanged deletion remains valid; restoration invalidates", async () => {
	const ws = await repo();
	try {
		const before = await captureVerificationBinding(ws.projectDir);
		expect(before).not.toBeNull();
		await unlink(join(ws.projectDir, "tracked.txt"));
		expect(
			(await checkVerificationBinding(ws.projectDir, before!)).status,
		).toBe("invalidated");
		const deleted = await captureVerificationBinding(ws.projectDir);
		expect(deleted?.files["tracked.txt"]).toBeNull();
		expect(
			(await checkVerificationBinding(ws.projectDir, deleted!)).status,
		).toBe("intact");
		await writeFile(join(ws.projectDir, "tracked.txt"), "original");
		expect(
			(await checkVerificationBinding(ws.projectDir, deleted!)).status,
		).toBe("invalidated");
	} finally {
		await ws.cleanup();
	}
});

test("untracked directory inputs are hashed and staging alone preserves the binding", async () => {
	const ws = await repo();
	try {
		await mkdir(join(ws.projectDir, "newdir"));
		await writeFile(join(ws.projectDir, "newdir/input.txt"), "first");
		const before = await captureVerificationBinding(ws.projectDir);
		expect(before?.files["newdir/input.txt"]).toMatch(/^[a-f0-9]{64}$/);
		git(ws.projectDir, "add", "newdir/input.txt");
		expect(
			(await checkVerificationBinding(ws.projectDir, before!)).status,
		).toBe("intact");
		await writeFile(join(ws.projectDir, "newdir/input.txt"), "second");
		expect(
			(await checkVerificationBinding(ws.projectDir, before!)).status,
		).toBe("invalidated");
	} finally {
		await ws.cleanup();
	}
});

test("space and Unicode paths retain their exact names across edits and staged renames", async () => {
	const ws = await repo();
	try {
		const name = "带 空格.txt";
		await writeFile(join(ws.projectDir, name), "first");
		const before = await captureVerificationBinding(ws.projectDir);
		expect(before?.files[name]).toMatch(/^[a-f0-9]{64}$/);
		await writeFile(join(ws.projectDir, name), "second");
		expect(
			(await checkVerificationBinding(ws.projectDir, before!)).status,
		).toBe("invalidated");
		await rename(
			join(ws.projectDir, "tracked.txt"),
			join(ws.projectDir, "renamed 文件.txt"),
		);
		git(ws.projectDir, "add", "-A");
		const renamed = await captureVerificationBinding(ws.projectDir);
		expect(renamed?.files["tracked.txt"]).toBeNull();
		expect(renamed?.files["renamed 文件.txt"]).toMatch(/^[a-f0-9]{64}$/);
		expect(
			(await checkVerificationBinding(ws.projectDir, renamed!)).status,
		).toBe("intact");
	} finally {
		await ws.cleanup();
	}
});

test("unexpected file-read failure makes the entire capture unavailable", async () => {
	const ws = await repo();
	try {
		await mkdir(join(ws.projectDir, "unreadable-as-file"));
		for (const path of ["unreadable-as-file", "vanished.txt"]) {
			const capture = await captureVerificationBinding(
				ws.projectDir,
				async (args) => ({
					ok: true,
					code: 0,
					stderr: "",
					stdout: args[0] === "rev-parse" ? "abc123" : ` M ${path}\0`,
				}),
			);
			expect(capture).toBeNull();
		}
	} finally {
		await ws.cleanup();
	}
});
