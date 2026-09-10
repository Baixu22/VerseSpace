import { isAbsolute, relative } from "node:path";
import type { Blackboard } from "../blackboard";
import type { WorkbenchEvent } from "../types/event";
import { collectDecisionPoints } from "./ledger";
import type { ChatThreads } from "./threads";

const PREVIEW_CHARS = 16_000;

export interface ThreadEvidence {
	ref: string;
	kind:
		| "event"
		| "footprint"
		| "message"
		| "tool"
		| "path"
		| "ledger"
		| "promotion"
		| "unavailable";
	title: string;
	timestamp?: string;
	content: string;
	truncated: boolean;
}

function preview(
	ref: string,
	kind: ThreadEvidence["kind"],
	title: string,
	data: unknown,
	timestamp?: string,
): ThreadEvidence {
	const content = JSON.stringify(data, null, 2) ?? "";
	return {
		ref,
		kind,
		title,
		timestamp,
		content: content.slice(0, PREVIEW_CHARS),
		truncated: content.length > PREVIEW_CHARS,
	};
}

function unavailable(ref: string, reason: string): ThreadEvidence {
	return {
		ref,
		kind: "unavailable",
		title: "来源暂不可用",
		content: reason,
		truncated: false,
	};
}

/** Resolve recorded references only. A path reference never opens a file. */
export async function resolveThreadEvidence(
	bb: Blackboard,
	chat: ChatThreads,
	threadId: string,
	ref: string,
): Promise<ThreadEvidence> {
	const meta = await chat.get(threadId);
	if (
		ref.startsWith("legacy:") ||
		ref === "suggest:next" ||
		ref === "event:unknown"
	) {
		return unavailable(ref, "这条旧记录没有保存可核对的原始引用。");
	}
	if (ref === "promotion") {
		return meta.promotion
			? preview(ref, "promotion", "对话命名记录", meta.promotion)
			: unavailable(ref, "当前对话没有保存这条命名记录。");
	}
	if (/^(message|tool|ledger):/.test(ref)) {
		const [kind, ...parts] = ref.split(":");
		const id = parts.join(":");
		const messages = await chat.messages(threadId);
		if (kind === "message") {
			const message = messages.find((item) => item.id === id);
			return message
				? preview(
						ref,
						"message",
						message.role === "user" ? "原始用户消息" : "原始助手消息",
						message,
						message.at,
					)
				: unavailable(ref, "消息已不在这条对话的当前记录中。");
		}
		if (kind === "ledger") {
			const points = collectDecisionPoints(messages, meta).filter(
				(item) => item.messageId === id,
			);
			return points.length
				? preview(ref, "ledger", "决策记录", points)
				: unavailable(ref, "当前记录中找不到这个决策锚点。");
		}
		const calls = messages.flatMap((message) =>
			(message.parts ?? [])
				.filter((item) => item.type === "tool-call" && item.toolCallId === id)
				.map((part) => ({ messageId: message.id, at: message.at, ...part })),
		);
		if (calls.length === 0)
			return unavailable(ref, "工具调用已不在这条对话的当前记录中。");
		// Older/replayed providers may reuse tool IDs across turns. Do not pick
		// one message and silently present it as the uniquely referenced source.
		return calls.length === 1
			? preview(ref, "tool", "原始工具调用", calls[0], calls[0]!.at)
			: preview(
					ref,
					"tool",
					`工具调用有 ${calls.length} 条匹配记录（按消息区分）`,
					calls,
				);
	}
	if (ref.startsWith("footprintSeq:")) {
		const sequence = ref.slice("footprintSeq:".length);
		const footprint = /^\d+$/.test(sequence)
			? (await bb.sessions.footprint(threadId)).find(
					(line) => line.seq === Number(sequence),
				)
			: undefined;
		return footprint
			? preview(
					ref,
					"footprint",
					`读取时的足迹 #${footprint.seq}`,
					footprint,
					footprint.timestamp,
				)
			: unavailable(ref, "这条对话的历史足迹已缺失，无法还原读取时的内容。");
	}
	if (ref.startsWith("path:")) {
		const normalize = (path: string) =>
			(isAbsolute(path) ? relative(bb.projectRoot, path) : path)
				.replace(/\\/g, "/")
				.replace(/^\.\//, "");
		const path = normalize(ref.slice("path:".length));
		const records = (await bb.sessions.footprint(threadId)).flatMap((line) => {
			const used = line.used.filter((claim) => normalize(claim.path) === path);
			const generated = line.generated.filter(
				(claim) => normalize(claim.path) === path,
			);
			return used.length || generated.length
				? [
						{
							eventId: line.eventId,
							seq: line.seq,
							timestamp: line.timestamp,
							activity: line.activity,
							used,
							generated,
						},
					]
				: [];
		});
		return records.length
			? preview(ref, "path", `文件记录 · ${path}`, records.reverse())
			: unavailable(
					ref,
					"这条对话没有保存该路径的足迹；不会读取当前文件来替代历史证据。",
				);
	}
	const events = await bb.events.all();
	let event: WorkbenchEvent | undefined;
	if (ref.startsWith("footprint:")) {
		event = events.find(
			(item) =>
				item.id === ref.slice("footprint:".length) && item.type === "footprint",
		);
	} else if (ref.startsWith("eventSeq:")) {
		const sequence = ref.slice("eventSeq:".length);
		event = /^\d+$/.test(sequence)
			? events.find((item) => item.eventSeq === Number(sequence))
			: undefined;
	} else {
		event = events.find((item) => item.id === ref);
	}
	return event
		? preview(
				ref,
				event.type === "footprint" ? "footprint" : "event",
				`原始事件 · ${event.type}`,
				event,
				event.timestamp,
			)
		: unavailable(ref, "事件引用已缺失，当前记录中没有可核对的来源。");
}
