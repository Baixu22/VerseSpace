import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBlackboard } from "../blackboard";
import { pathExists } from "../fs/atomic";
import { initCommand, initWorkbench } from "./init";

describe("initWorkbench", () => {
	test("creates the full .workbench layout and default config", async () => {
		const projectDir = join(
			tmpdir(),
			`workbench-init-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		try {
			const result = await initWorkbench(projectDir);
			expect(result.ok).toBe(true);
			expect(result.created.length).toBeGreaterThan(10);
			expect(result.existing).toEqual([]);

			const root = join(projectDir, ".workbench");
			expect(await pathExists(join(root, "blackboard", "goals"))).toBe(true);
			expect(await pathExists(join(root, "checkpoints", "staging"))).toBe(true);
			expect(await pathExists(join(root, "events", "events.jsonl"))).toBe(true);

			const config = await readFile(join(root, "workbench.yaml"), "utf8");
			expect(config).toContain("policy: manual");

			// the freshly initialized blackboard must open cleanly
			const bb = openBlackboard(root);
			expect(await bb.goals.list()).toEqual([]);
			expect((await bb.config.load()).scheduler.policy).toBe("manual");
		} finally {
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("re-init is idempotent: nothing created, nothing overwritten", async () => {
		const projectDir = join(
			tmpdir(),
			`workbench-init-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		try {
			const first = await initWorkbench(projectDir);
			const second = await initWorkbench(projectDir);
			expect(second.created).toEqual([]);
			expect(second.existing.length).toBe(first.created.length);
		} finally {
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("initCommand --json prints the result", async () => {
		const projectDir = join(
			tmpdir(),
			`workbench-init-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		try {
			const logs: string[] = [];
			const original = console.log;
			console.log = (message: string) => logs.push(message);
			try {
				await initCommand(projectDir, { json: true });
			} finally {
				console.log = original;
			}
			const parsed = JSON.parse(logs[0] ?? "{}") as {
				ok: boolean;
				created: string[];
			};
			expect(parsed.ok).toBe(true);
			expect(parsed.created.length).toBeGreaterThan(10);
		} finally {
			await rm(projectDir, { recursive: true, force: true });
		}
	});
});
