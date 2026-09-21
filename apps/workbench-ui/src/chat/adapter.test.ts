import {
	fromThreadMessageLike,
	type ThreadMessageLike,
} from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { toThreadMessage } from "./adapter";
import type {
	CollapsedGroupPart,
	NoticePart,
	StoredMessage,
	ToolCallPart,
} from "./message-types";

const tool: ToolCallPart = {
	type: "tool-call",
	toolCallId: "read-1",
	toolName: "Read",
	args: { file_path: "src/main.ts", offset: 2 },
	result: "File contents",
	isError: false,
};
const group: CollapsedGroupPart = {
	type: "collapsed-group",
	id: "group:read-1",
	category: "read",
	tools: [tool],
	active: false,
	summary: "Persisted server summary",
};
const stored: StoredMessage = {
	id: "assistant-1",
	role: "assistant",
	text: "BeforeAfter",
	at: "2026-09-18T00:00:00.000Z",
	parts: [
		{ type: "text", text: "Before" },
		group,
		{ type: "text", text: "After" },
	],
};
const normalize = (message: ThreadMessageLike) =>
	fromThreadMessageLike(message, "fallback", { type: "running" });

describe("Workbench assistant-ui adapter", () => {
	it("maps persisted groups to supported data parts in the original order", () => {
		const message: ThreadMessageLike = toThreadMessage(stored);
		expect(message.content).toEqual([
			{ type: "text", text: "Before" },
			{ type: "data-workbench-collapsed-group", data: group },
			{ type: "text", text: "After" },
		]);
		const converted = normalize(message);
		expect(converted.id).toBe(stored.id);
		expect(converted.createdAt).toEqual(new Date(stored.at));
		expect(converted.content).toEqual([
			{ type: "text", text: "Before" },
			{ type: "data", name: "workbench-collapsed-group", data: group },
			{ type: "text", text: "After" },
		]);
		expect(converted).toMatchObject({
			status: { type: "complete", reason: "stop" },
		});
		const part = converted.content[1];
		if (part?.type !== "data")
			throw new Error("Expected a normalized data part");
		expect(part.data).toBe(group);
		expect(stored.parts?.[1]).toBe(group);
	});

	it("maps a provider notice to its own data part and keeps it ordered with text and groups", () => {
		const notice: NoticePart = {
			type: "notice",
			severity: "warning",
			label: "Permission denied for Bash",
			body: "Command writes outside the workspace",
		};
		const message: ThreadMessageLike = toThreadMessage({
			...stored,
			parts: [group, notice, { type: "text", text: "After" }],
		});
		expect(message.content).toEqual([
			{ type: "data-workbench-collapsed-group", data: group },
			{ type: "data-workbench-notice", data: notice },
			{ type: "text", text: "After" },
		]);
		const converted = normalize(message);
		expect(converted.content).toEqual([
			{ type: "data", name: "workbench-collapsed-group", data: group },
			{ type: "data", name: "workbench-notice", data: notice },
			{ type: "text", text: "After" },
		]);
	});

	it("leaves uncollapsed historical tools alone and preserves arguments/results/errors", () => {
		const failed = {
			...tool,
			toolCallId: "read-2",
			isError: true,
			result: { error: "Missing file" },
		};
		const converted = normalize(
			toThreadMessage({ ...stored, parts: [tool, failed] }),
		);
		// assistant-ui annotates parsed args with a private symbol; assert the
		// public tool shape without coupling this test to parser internals.
		expect(converted.content).toHaveLength(2);
		expect(converted.content).toMatchObject([
			{ ...tool, argsText: JSON.stringify(tool.args, null, 2) },
			{ ...failed, argsText: JSON.stringify(failed.args, null, 2) },
		]);
	});

	it("keeps premise notices on a user message ahead of the typed text (TF-0243)", () => {
		const notice: NoticePart = {
			type: "notice",
			severity: "warning",
			label: "前提失效：1 个文件。",
			body: "- src/a.ts\n  观察版本 1 → 当前版本 2",
		};
		const message = toThreadMessage({
			id: "user-2",
			role: "user",
			text: "second",
			at: "2026-09-21T00:00:00.000Z",
			parts: [notice, { type: "text", text: "second" }],
		});
		expect(message.role).toBe("user");
		// user messages must not carry a status — the external store throws
		expect(message).not.toHaveProperty("status");
		const converted = normalize(message);
		expect(converted.content).toEqual([
			{ type: "data", name: "workbench-notice", data: notice },
			{ type: "text", text: "second" },
		]);
	});

	it("uses text fallback for legacy history, but honors an explicit empty parts snapshot", () => {
		expect(
			normalize(toThreadMessage({ ...stored, parts: undefined })).content,
		).toEqual([{ type: "text", text: stored.text }]);
		expect(
			normalize(toThreadMessage({ ...stored, parts: [] })).content,
		).toEqual([]);
	});

	it("only assistant messages receive a status accepted by the runtime", () => {
		const user = toThreadMessage({
			...stored,
			role: "user",
			parts: undefined,
			status: "complete",
		});
		expect(user).not.toHaveProperty("status");
		expect(normalize(user)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: stored.text }],
		});
		expect(
			normalize(toThreadMessage({ ...stored, status: "running" })),
		).toMatchObject({ status: { type: "running" } });
	});
});
