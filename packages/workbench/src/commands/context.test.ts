import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { NoWorkbenchError } from "../errors";
import { makeTempWorkbench } from "../test/fixtures";
import { resolveBlackboard } from "./context";

describe("resolveBlackboard --root override (TF-0241)", () => {
	test("opens the blackboard at an explicit root regardless of cwd", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		try {
			// The spawned MCP server may launch anywhere; the flag must win over
			// upward discovery from cwd.
			process.chdir(tmpdir());
			const bb = await resolveBlackboard(ws.workbenchRoot);
			expect(bb.paths.root).toBe(ws.workbenchRoot);
		} finally {
			process.chdir(cwd);
			await ws.cleanup();
		}
	});

	test("without a root, discovery from an unrelated cwd fails loudly", async () => {
		const cwd = process.cwd();
		try {
			process.chdir(tmpdir());
			await expect(resolveBlackboard()).rejects.toBeInstanceOf(
				NoWorkbenchError,
			);
		} finally {
			process.chdir(cwd);
		}
	});
});
