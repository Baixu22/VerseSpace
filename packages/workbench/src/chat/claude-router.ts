import { extractFootprint, hashPathClaim } from "../blackboard/footprint";
import { writerSpoolDir } from "../blackboard/sessions";
import { acknowledgeClaudeNotices } from "./claude-ack";
import type { LiveClaudeSession } from "./claude-types";
import type { ThreadContext } from "./thread-context";
import {
	inheritParentFootprint,
	observeForkInheritance,
} from "./thread-inheritance";
import type { MessagePart } from "./thread-types";

export function registerTurnRouter(
	context: ThreadContext,
	id: string,
	session: LiveClaudeSession,
): void {
	const handleLine = (line: string): void => {
		if (!line.trim()) {
			return;
		}
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		const sessionId =
			typeof event.session_id === "string" ? event.session_id : undefined;
		if (sessionId) {
			session.claudeSessionId = sessionId;
		}
		const turn = session.turn;
		if (!turn) {
			if (session.bufferInitialLines && session.initialLines.length < 512) {
				session.initialLines.push(line);
			}
			return; // no turn in flight: session-level noise
		}
		if (event.type === "system" && event.subtype === "init") {
			turn.sawInit = true;
		}
		// An assistant/result line is the first proof that the provider
		// actually consumed the fork context. Do not mark inheritance at fork
		// time or merely when stdin is queued behind the init gate.
		if (
			(event.type === "assistant" || event.type === "result") &&
			!turn.inheritanceStarted
		) {
			turn.inheritanceStarted = true;
			turn.inheritancePromise = (async () => {
				let inherited: { refs: string[]; comparable: boolean } = {
					refs: [],
					comparable: false,
				};
				if (session.agentContextMode === "fork-session" && session.forkPlan) {
					try {
						inherited = await inheritParentFootprint(
							context,
							id,
							session.forkPlan,
						);
					} catch (err) {
						// Provider context may still be inherited even when the local
						// footprint mirror is unavailable; record that distinction.
						// （fit 账本要数的继承观测证据，写失败不能无声——2026-09-13 收尾 4.5）
						console.error("[chat] fork footprint mirror failed:", err);
					}
				}
				await observeForkInheritance(context, id, "claude", {
					agentContextInherited: session.agentContextMode === "fork-session",
					premiseInherited:
						session.agentContextMode === "fork-session" && inherited.comparable,
					mode: session.agentContextMode,
					refs: inherited.refs,
				});
			})().catch((err) => {
				// 继承观测（thread.inheritance_observed）写失败无声 =
				// fit 账本样本静默缺失（2026-09-13 收尾 4.5）。
				console.error("[chat] fork inheritance observation failed:", err);
			});
		}
		if (event.type === "stream_event") {
			const inner = event.event as
				| { type?: string; delta?: { type?: string; text?: string } }
				| undefined;
			if (
				inner?.type === "content_block_delta" &&
				inner.delta?.type === "text_delta" &&
				inner.delta.text
			) {
				const last = turn.messageParts.at(-1);
				if (last?.type === "text") {
					last.text += inner.delta.text;
				} else {
					turn.messageParts.push({ type: "text", text: inner.delta.text });
				}
				turn.assistantTexts.push(inner.delta.text);
				turn.emit({ type: "delta", text: inner.delta.text });
			}
		} else if (event.type === "assistant") {
			const message = event.message as
				| { content?: Array<Record<string, unknown>> }
				| undefined;
			for (const block of message?.content ?? []) {
				if (block.type === "tool_use") {
					const part: MessagePart = {
						type: "tool-call",
						toolCallId: String(block.id ?? ""),
						toolName: String(block.name ?? "tool"),
						args: block.input ?? {},
					};
					turn.messageParts.push(part);
					turn.emit({ type: "tool", part });
					const fp = extractFootprint(
						{ ...event, message: { content: [block] } },
						id,
					);
					if (fp) {
						turn.pendingFootprints.set(fp.activity, fp);
						turn.fpQueue = turn.fpQueue.then(async () => {
							// hash reads at call time: the version the agent's
							// premise is built on (spooled for R2 diffs)
							for (const used of fp.used) {
								Object.assign(
									used,
									await hashPathClaim(
										context.bb.projectRoot,
										used.path,
										writerSpoolDir(context.bb.paths, id),
										used.span,
									),
								);
							}
						});
					}
				}
			}
		} else if (event.type === "user") {
			// tool_result blocks ride on transcript "user" events
			const message = event.message as
				| { content?: Array<Record<string, unknown>> }
				| undefined;
			for (const block of message?.content ?? []) {
				if (block.type === "tool_result") {
					const toolCallId = String(block.tool_use_id ?? "");
					const part = turn.messageParts.find(
						(p) => p.type === "tool-call" && p.toolCallId === toolCallId,
					);
					if (part && part.type === "tool-call") {
						part.result = block.content ?? null;
						turn.emit({ type: "tool_result", part });
					}
					const fp = turn.pendingFootprints.get(toolCallId);
					if (fp) {
						turn.pendingFootprints.delete(toolCallId);
						if (block.is_error === true) continue;
						turn.fpQueue = turn.fpQueue.then(async () => {
							// hash writes at result time: the state the write
							// actually produced
							for (const gen of fp.generated) {
								Object.assign(
									gen,
									await hashPathClaim(context.bb.projectRoot, gen.path),
								);
							}
							await context.bb.sessions.recordActivity(id, fp);
						});
					}
				}
			}
		} else if (event.type === "result") {
			// A tool-use assistant event proves only that the provider started a
			// turn. Ack queued notices at the terminal result, so a crash between
			// tool invocation and the final result leaves them retryable.
			if (event.subtype === "success" && event.is_error !== true) {
				acknowledgeClaudeNotices(turn);
			}
			const result =
				typeof event.result === "string" ? event.result : undefined;
			if (
				event.is_error === true ||
				(typeof event.subtype === "string" && event.subtype.startsWith("error"))
			) {
				turn.emit({ type: "error", message: result || "agent 回合执行失败" });
				turn.resolve();
				return;
			}
			if (result && turn.assistantTexts.length === 0) {
				turn.assistantTexts.push(result);
				turn.messageParts.push({ type: "text", text: result });
				turn.emit({ type: "delta", text: result });
			}
			// one result = one finished turn (streaming input mode)
			turn.resolve();
		}
	};
	context.lineRouters.set(id, handleLine);
}
