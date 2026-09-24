import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCodexAppServer,
	decideServerRequest,
	normalizeNotification,
} from "./codex-app-server";

/**
 * TF-0250 / ADR-0017: codex approval requests are auto-accepted and
 * user-input requests are auto-declined. Auto-accept is not a seal.
 * `decideSeal` is not called on this path.
 */
describe("codex server-request policy (TF-0250 / ADR-0017)", () => {
	test("permission requests are auto-accepted and do not consult seal", () => {
		for (const method of [
			"item/commandExecution/requestApproval",
			"item/fileChange/requestApproval",
			"item/fileRead/requestApproval",
		]) {
			expect(decideServerRequest(method)).toEqual({
				kind: "approval",
				decision: "accept",
			});
		}
	});

	test("user-input requests are auto-declined so a turn cannot wedge", () => {
		for (const method of [
			"item/tool/requestUserInput",
			"mcpServer/elicitation/request",
		]) {
			expect(decideServerRequest(method)).toEqual({
				kind: "userInput",
				action: "decline",
			});
		}
	});

	test("everything else is ignored (no ledger effect, no response contract)", () => {
		expect(decideServerRequest("something/else")).toEqual({ kind: "ignore" });
	});
});

describe("app-server notification normalization", () => {
	test("flattens {method, params} into the fixture's type-tagged shape", () => {
		expect(
			normalizeNotification("turn/completed", {
				threadId: "t1",
				turn: { id: "turn_1", status: "completed" },
			}),
		).toEqual({
			type: "turn/completed",
			threadId: "t1",
			turn: { id: "turn_1", status: "completed" },
		});
	});

	test("a param-less notification still carries its type", () => {
		expect(normalizeNotification("end", undefined)).toEqual({ type: "end" });
	});
});

/**
 * TF-0249: the app-server is the only thing that can settle its own promises.
 * If it never starts, the handshake must reject rather than stay pending — a
 * pending `initialize` holds the thread's enqueue lock forever, and the user
 * sees a turn that never finishes instead of an error. (The claude lane gets
 * the same guarantee by resolving its turn from `proc.wait()`.)
 */
describe("app-server liveness (TF-0249)", () => {
	test("a command that cannot spawn rejects the handshake instead of hanging", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codex-app-server-"));
		const server = createCodexAppServer({
			cwd: dir,
			registryDir: join(dir, "proc"),
			label: "chat:test",
			commandLine: "workbench-definitely-not-a-real-binary",
			onEvent: () => {},
		});
		try {
			const outcome = await Promise.race([
				server.initialize().then(
					() => "resolved",
					(error: Error) => `rejected: ${error.message}`,
				),
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("still pending"), 5_000),
				),
			]);
			expect(outcome).toContain("rejected");
			expect(outcome).toContain("codex app-server 启动失败");
		} finally {
			await server.shutdown().catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	});
});
