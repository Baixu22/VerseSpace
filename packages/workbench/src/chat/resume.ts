/**
 * 准备恢复笔记（TF-0097）。
 *
 * 离开一条车道的那一刻，从这条车道既有的事实推导一份恢复笔记——3-5 个
 * 有序节拍：你当时在做什么／你决定了什么／你脚下什么动了／下一步是
 * 什么。推导是纯函数，不额外调用模型、不付前置成本（与 suggest/ledger
 * 同源纪律）。agent 起草，用户确认：笔记生成时 confirmedAt 为空，用户
 * 在返回时可以确认或编辑，但确认不阻塞——不确认也能直接开始工作。
 *
 * 返回时给的是叙事，不是 diff：节拍文本是叙事性短语，不是文件列表或
 * patch。『你脚下什么动了』在 workbench 零依赖范围内从最后一条助手
 * 回答的 tool-call 推导（诚实地是 agent 起草，不是真 git diff）。
 *
 * 离开时存 leaveSignature（最后消息时间 + 条数），返回时由呈现层对比
 * 当前消息数检测『你不在时变了什么』——该对比不写回 meta，严格满足
 * 『笔记在离开的时刻生成，不在返回时索取』。
 */

import { collectDecisionPoints } from "./ledger";
import { suggestNext } from "./suggest";
import type { MessagePart, StoredMessage, ThreadMeta } from "./threads";

export type ResumeBeatKind = "doing" | "decided" | "shifted" | "next";

export interface ResumeBeat {
	kind: ResumeBeatKind;
	text: string;
	/** Evidence pointers (message/tool/path/ledger). Required to render. */
	refs?: string[];
}

export interface ResumeNote {
	beats: ResumeBeat[];
	/** 离开时刻——笔记生成的时间。 */
	draftedAt: string;
	/** 用户确认时间（空 = agent 起草的草稿，待确认）。 */
	confirmedAt?: string;
	/** 离开时的状态签名，返回时检测『你不在时变了什么』。 */
	leaveSignature: {
		lastMessageAt: string;
		messageCount: number;
		/** Per-thread footprint line at the exact leave observation. */
		footprintSeq?: number;
		/** Shared events clock at leave; absent on pre-R2 notes. */
		eventSeq?: number;
		/** Stable lifecycle event that established the leave boundary. */
		eventId?: string;
	};
}

const MAX_BEAT_TEXT = 80;

function truncate(text: string, max = MAX_BEAT_TEXT): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** 从 tool-call 的 args 里提取一个可读的目标（路径/命令），用于 shifted 节拍叙事。 */
function extractToolTarget(part: MessagePart): string | null {
	if (part.type !== "tool-call") {
		return null;
	}
	const args = part.args as Record<string, unknown> | null;
	if (!args || typeof args !== "object") {
		return null;
	}
	for (const key of ["file_path", "path", "filename", "file", "command"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

/** 取最后一条指定角色的消息。 */
function lastOfRole(
	messages: StoredMessage[],
	role: "user" | "assistant",
): StoredMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === role) {
			return messages[i];
		}
	}
	return undefined;
}

/**
 * 从消息序列与线程 meta 推导恢复笔记。空对话返回 null（没有可记的事就不记）。
 * 节拍数量 3-5：至少有 doing 才生成，其余按素材省略，封顶 5。
 */
export function buildResumeNote(
	messages: StoredMessage[],
	meta: Pick<ThreadMeta, "forks" | "promotion">,
	now: Date = new Date(),
): ResumeNote | null {
	if (messages.length === 0) {
		return null;
	}
	const beats: ResumeBeat[] = [];

	// 你当时在做什么：最后一条 user 消息
	const lastUser = lastOfRole(messages, "user");
	if (lastUser) {
		beats.push({
			kind: "doing",
			text: truncate(lastUser.text),
			refs: [`message:${lastUser.id}`],
		});
	}

	// 你决定了什么：决策点（分叉/备选）+ 晋升
	const points = collectDecisionPoints(messages, meta);
	const decidedTexts: string[] = [];
	const decidedRefs: string[] = [];
	for (const point of points.slice(0, 2)) {
		decidedRefs.push(`ledger:${point.messageId}`);
		if (point.kind === "fork") {
			decidedTexts.push(
				`在「${truncate(point.preview, 40)}」处分叉出 ${point.count} 条路径`,
			);
		} else {
			decidedTexts.push(
				`在「${truncate(point.preview, 40)}」处保留了 ${point.count} 个备选`,
			);
		}
	}
	if (meta.promotion) {
		decidedRefs.push("promotion");
		decidedTexts.push(`把这条对话命名为「${meta.promotion.title}」`);
	}
	if (decidedTexts.length > 0) {
		beats.push({
			kind: "decided",
			text: truncate(decidedTexts.join("；"), 100),
			refs: decidedRefs,
		});
	}

	// 你脚下什么动了：最后一条 assistant 的 tool-call（叙事，不是 diff）
	const lastAssistant = lastOfRole(messages, "assistant");
	if (lastAssistant?.parts) {
		const toolParts = lastAssistant.parts.filter(
			(p): p is Extract<MessagePart, { type: "tool-call" }> =>
				p.type === "tool-call",
		);
		if (toolParts.length > 0) {
			const summary = toolParts
				.slice(0, 3)
				.map((p) => {
					const target = extractToolTarget(p);
					return target ? `${p.toolName}(${truncate(target, 40)})` : p.toolName;
				})
				.join("、");
			beats.push({
				kind: "shifted",
				text: `动了 ${toolParts.length} 处：${summary}`,
				refs: [
					`message:${lastAssistant.id}`,
					...toolParts.slice(0, 3).flatMap((part) => {
						const target = extractToolTarget(part);
						return target
							? [
									`tool:${part.toolCallId}`,
									`path:${target.replace(/\\/g, "/")}`,
								]
							: [`tool:${part.toolCallId}`];
					}),
				],
			});
		}
	}

	// 下一步是什么：复用 suggestNext 的第一条
	const suggestions = suggestNext(messages);
	if (suggestions.length > 0) {
		beats.push({
			kind: "next",
			text: `下一步可以：${truncate(suggestions[0]!.text, 60)}`,
			refs: lastAssistant ? [`message:${lastAssistant.id}`] : ["suggest:next"],
		});
	}

	if (beats.length === 0) {
		return null;
	}
	const last = messages[messages.length - 1]!;
	return {
		beats: beats.slice(0, 5),
		draftedAt: now.toISOString(),
		leaveSignature: {
			lastMessageAt: last.at,
			messageCount: messages.length,
		},
	};
}

/**
 * 返回时检测『你不在时变了什么』：对比离开时的签名与当前消息数。
 * 返回新增的消息条数（0 = 没有变化）。纯呈现层用，不写回 meta。
 *
 * 这是**唯一来源**：`collectRestoreView` 用它算出读数随 GET 载荷下发，
 * 客户端直接读 `resumeDelta`，不再内联重算（2026-09-13 收尾 §5.6）。
 */
export function resumeDelta(
	currentMessages: StoredMessage[],
	note: ResumeNote,
): number {
	return Math.max(0, currentMessages.length - note.leaveSignature.messageCount);
}
