import { describe, expect, test } from "bun:test";
import { decideServerRequest, normalizeNotification } from "./codex-app-server";

/**
 * TF-0250: codex's app-server issues six interaction protocols; ADR-0017 admits
 * exactly one into the premise ledger — permission requests, because the
 * request *is* the read/write claim. The rest are answered only enough to keep
 * the turn from wedging, or ignored. This pins that policy.
 */
describe("codex server-request policy (TF-0250 / ADR-0017)", () => {
	test("permission requests are auto-accepted — seal is the one interception point", () => {
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
