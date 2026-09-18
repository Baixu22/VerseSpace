import { describe, expect, it } from "vitest";
import type {
	AssistantRunEvent,
	CollapsedGroupPart,
	StoredMessage,
} from "./message-types";
import { applyAssistantRunEvent } from "./stream-reducer";

const draft: StoredMessage = {
	id: "assistant-1",
	role: "assistant",
	text: "",
	at: "2026-09-18T00:00:00.000Z",
	status: "running",
};
const group: CollapsedGroupPart = {
	type: "collapsed-group",
	id: "group:read-1",
	category: "read",
	summary: "读取 1 个文件",
	active: true,
	tools: [
		{
			type: "tool-call",
			toolCallId: "read-1",
			toolName: "Read",
			args: { file_path: "src/main.ts" },
		},
	],
};

const apply = (message: StoredMessage, event: AssistantRunEvent) =>
	applyAssistantRunEvent(message, event);

describe("assistant stream reducer", () => {
	it("delta → parts → delta → done keeps ordered text/tools/text and server authority", () => {
		const first = apply(draft, {
			type: "delta",
			messageId: draft.id,
			text: "draft intro",
		});
		expect(first.text).toBe("draft intro");
		expect(first.parts).toEqual([{ type: "text", text: "draft intro" }]);
		expect(draft.parts).toBeUndefined();

		const parts = [{ type: "text" as const, text: "Final intro" }, group];
		const structured = apply(first, {
			type: "parts",
			messageId: draft.id,
			parts,
		});
		expect(structured.parts).toBe(parts);
		expect(structured.text).toBe("Final intro");
		const after = apply(structured, {
			type: "delta",
			messageId: draft.id,
			text: "\nConclusion",
		});
		const continued = apply(after, {
			type: "delta",
			messageId: draft.id,
			text: ".",
		});
		expect(continued.text).toBe("Final intro\nConclusion.");
		expect(continued.parts).toEqual([
			...parts,
			{ type: "text", text: "\nConclusion." },
		]);
		expect(structured.parts).toEqual(parts);
		expect(after.parts?.at(-1)).toEqual({ type: "text", text: "\nConclusion" });

		const stored: StoredMessage = {
			id: draft.id,
			role: "assistant",
			at: "2026-09-18T01:00:00.000Z",
			text: "Persisted intro\nPersisted conclusion",
			parts: [
				{ type: "text", text: "Persisted intro" },
				{ ...group, active: false },
				{ type: "text", text: "\nPersisted conclusion" },
			],
			variants: ["Alternate"],
		};
		expect(
			apply(continued, { type: "done", messageId: draft.id, message: stored }),
		).toEqual({ ...stored, status: "complete" });
	});

	it("parts replaces every part and rebuilds only the text projection", () => {
		const parts = [
			{ type: "text" as const, text: "Before" },
			group,
			{ type: "text" as const, text: "After" },
		];
		const next = apply(
			{ ...draft, text: "obsolete", parts: [group] },
			{
				type: "parts",
				messageId: draft.id,
				parts,
			},
		);
		expect(next.text).toBe("BeforeAfter");
		expect(next.parts).toBe(parts);
		expect(
			apply(next, { type: "parts", messageId: draft.id, parts: [] }),
		).toEqual({
			...draft,
			parts: [],
		});
	});

	it("done drops stale optional fields when the stored message has none", () => {
		const stored = { ...draft, status: undefined, text: "final" };
		const result = apply(
			{ ...draft, parts: [group], variants: ["stale"] },
			{
				type: "done",
				messageId: draft.id,
				message: stored,
			},
		);
		expect(result).toEqual({ ...stored, status: "complete" });
		expect(result).not.toHaveProperty("parts");
		expect(result).not.toHaveProperty("variants");
	});

	it("text-only history stays visible when a delta creates structured parts", () => {
		expect(
			apply(
				{ ...draft, text: "Before" },
				{
					type: "delta",
					messageId: draft.id,
					text: "After",
				},
			),
		).toMatchObject({
			text: "BeforeAfter",
			parts: [{ type: "text", text: "BeforeAfter" }],
		});
		expect(apply(draft, { type: "delta", messageId: draft.id, text: "" })).toBe(
			draft,
		);
	});

	it("error.message appends after tools and completes the message", () => {
		const result = apply(
			{
				...draft,
				text: "Before",
				parts: [{ type: "text", text: "Before" }, group],
			},
			{ type: "error", messageId: draft.id, message: "Provider unavailable" },
		);
		expect(result.text).toBe("Before\n\n运行出错：Provider unavailable");
		expect(result.parts).toEqual([
			{ type: "text", text: "Before" },
			group,
			{ type: "text", text: "\n\n运行出错：Provider unavailable" },
		]);
		expect(result.status).toBe("complete");
	});

	it("pre-turn errors without an id apply to the draft; foreign ids are ignored", () => {
		expect(
			apply(draft, { type: "error", message: "Thread not found" }),
		).toMatchObject({
			text: "运行出错：Thread not found",
			parts: [{ type: "text", text: "运行出错：Thread not found" }],
			status: "complete",
		});
		expect(
			apply(draft, { type: "delta", messageId: "other", text: "wrong" }),
		).toBe(draft);
		expect(
			apply(draft, { type: "error", messageId: "other", message: "wrong" }),
		).toBe(draft);
	});
});
