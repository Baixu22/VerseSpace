import type { Blackboard } from "../blackboard";

import { restoreObservationSchema } from "../chat/restore-timing";
import { collectRestoreView } from "../chat/restore-view";
import { resumeNotePatchSchema } from "../chat/thread-resume";
import type { ChatThreads, RunEvent } from "../chat/threads";

import { evidenceResponse } from "./evidence-route";
import { jsonObjectBody } from "./json-body";

export async function chatRoute(
	bb: Blackboard,
	chat: ChatThreads,
	url: URL,
	request: Request,
): Promise<Response | null> {
	if (url.pathname === "/api/chat/threads" && request.method === "GET") {
		return Response.json(await chat.list());
	}

	if (url.pathname === "/api/chat/threads" && request.method === "POST") {
		const body = await jsonObjectBody(request);
		if (body instanceof Response) return body;
		return Response.json(await chat.create(body.title as string | undefined));
	}

	const chatMatch = url.pathname.match(
		/^\/api\/chat\/threads\/([^/]+)(\/(messages|cancel|reload|promote|fork|adopt|revert|leave|switch|restore|resume-note(?:\/consume|\/dismiss)?|resume-card\/shown|resume-action|evidence))?$/,
	);

	if (chatMatch) {
		let threadId: string;
		try {
			threadId = decodeURIComponent(chatMatch[1] ?? "");
		} catch {
			// Bun 1.3.14 起，非法百分号编码（如 %ZZ）在 HTTP 解析层即被
			// 断开（fetch 直接 ECONNRESET），本分支在该运行时不可达；
			// 不在此层断开请求的运行时仍会走到这里。两条路径都是
			// 「拒收」，保留为运行时兜底（2026-09-13 分诊；CI 与本地
			// 已统一到 1.3.14）。
			return Response.json({ error: "对话标识无效" }, { status: 400 });
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) {
			return Response.json({ error: "对话标识无效" }, { status: 400 });
		}
		const sub = chatMatch[3];
		if (sub === "evidence" && request.method === "GET") {
			return evidenceResponse(bb, chat, threadId, url);
		}
		if (!sub && request.method === "GET") {
			return Response.json(await collectRestoreView(bb, chat, threadId));
		}
		if (sub === "cancel" && request.method === "POST") {
			chat.cancel(threadId);
			return Response.json({ ok: true });
		}
		if (sub === "reload" && request.method === "POST") {
			return Response.json(await chat.reload(threadId));
		}
		if (sub === "promote" && request.method === "POST") {
			// TF-0092：手动晋升——任意时刻一个手势命名无名对话
			return Response.json(await chat.promote(threadId));
		}
		if (sub === "fork" && request.method === "POST") {
			// TF-0093：追溯式分叉——锚点消息一个手势，零仪式
			const body = (await request.json().catch(() => ({}))) as {
				anchorMessageId?: string;
			};
			if (!body.anchorMessageId) {
				return Response.json(
					{ ok: false, reason: "缺少 anchorMessageId" },
					{ status: 400 },
				);
			}
			return Response.json(await chat.fork(threadId, body.anchorMessageId));
		}
		if (sub === "adopt" && request.method === "POST") {
			// TF-0200：由分支线程发起收养——:id 是分支，源线程从血统反查。
			try {
				const snapshotId = await chat.adopt(threadId);
				return Response.json({ ok: true, snapshotId });
			} catch (error) {
				return Response.json(
					{ ok: false, reason: String(error) },
					{ status: 400 },
				);
			}
		}
		if (sub === "revert" && request.method === "POST") {
			// TF-0200：由源线程发起反转——:id 是源，被收养线程从快照反查。
			try {
				await chat.revert(threadId);
				return Response.json({ ok: true });
			} catch (error) {
				return Response.json(
					{ ok: false, reason: String(error) },
					{ status: 400 },
				);
			}
		}
		if (sub === "leave" && request.method === "POST") {
			// TF-0097：离开车道时生成恢复笔记（agent 起草），空对话返回 null
			return Response.json(await chat.leave(threadId));
		}
		if (sub === "switch" && request.method === "POST") {
			const body = await jsonObjectBody(request);
			if (body instanceof Response) return body;
			await chat.recordSwitch(
				(body.fromThreadId as string | null | undefined) ?? null,
				threadId,
			);
			return Response.json({ ok: true });
		}
		if (sub === "restore" && request.method === "POST") {
			// TF-0261 sweep: a malformed body used to collapse to `{}`, which the
			// all-optional observation schema accepts — the route then appended a
			// `thread.restored` event that observed nothing. Reject the body
			// before the schema so a bad request cannot fabricate that fact.
			const raw = await jsonObjectBody(request);
			if (raw instanceof Response) return raw;
			const body = restoreObservationSchema.safeParse(raw);
			if (!body.success) {
				return Response.json({ error: "恢复观测字段无效" }, { status: 400 });
			}
			await chat.recordRestored(
				threadId,
				body.data.fromThreadId ?? null,
				body.data,
			);
			return Response.json({ ok: true });
		}
		if (sub === "resume-note/consume" && request.method === "POST") {
			const body = await jsonObjectBody(request);
			if (body instanceof Response) return body;
			const surface = body.surface;
			await chat.recordResumeNoteConsumed(
				threadId,
				typeof surface === "string" && surface.trim()
					? surface.slice(0, 80)
					: "card",
			);
			return Response.json({ ok: true });
		}
		if (sub === "resume-note/dismiss" && request.method === "POST") {
			// TF-0198：dismiss 记观测并清空模型侧注入队列——返回即队列已空。
			await chat.dismissResumeCard(threadId);
			return Response.json({ ok: true });
		}
		if (sub === "resume-card/shown" && request.method === "POST") {
			// TF-0199：恢复卡展示观测——fit 指标 7 的分母（渲染了才计数）。
			const body = await jsonObjectBody(request);
			if (body instanceof Response) return body;
			const rows = Array.isArray(body.branchRows)
				? body.branchRows.filter(
						(row): row is string => typeof row === "string",
					)
				: [];
			await chat.recordResumeCardShown(threadId, rows);
			return Response.json({ ok: true });
		}
		if (sub === "resume-action" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				action?: string;
				label?: string;
			};
			if (typeof body.action !== "string" || !body.action.trim()) {
				return Response.json(
					{ ok: false, reason: "缺少 action" },
					{ status: 400 },
				);
			}
			const label =
				typeof body.label === "string" && body.label.trim()
					? body.label.trim().slice(0, 120)
					: undefined;
			await chat.recordResumeAction(threadId, body.action.slice(0, 80), label);
			return Response.json({ ok: true });
		}
		if (sub === "resume-note" && request.method === "PATCH") {
			// TF-0097：用户编辑/确认恢复笔记
			// TF-0261 sweep: this body was an unchecked cast, so `{"beats":"evil"}`
			// (or any other shape) was persisted verbatim into the thread meta by
			// setResumeNote — the same "arbitrary payload becomes a durable fact"
			// defect the feedback route had. Validate before it reaches the store.
			const raw = await jsonObjectBody(request);
			if (raw instanceof Response) return raw;
			const parsed = resumeNotePatchSchema.safeParse(raw);
			if (!parsed.success) {
				return Response.json({ error: "恢复笔记字段无效" }, { status: 400 });
			}
			const result = await chat.setResumeNote(threadId, parsed.data);
			if (!result) {
				return Response.json(
					{ ok: false, reason: "该线程没有恢复笔记" },
					{ status: 404 },
				);
			}
			return Response.json(result);
		}
		if (sub === undefined && request.method === "DELETE") {
			const outcome = await chat.remove(threadId);
			return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
		}
		if (sub === undefined && request.method === "PATCH") {
			const body = (await request.json()) as {
				title?: string;
				permissionMode?: "default" | "plan" | "acceptEdits";
				archived?: boolean;
			};
			return Response.json(await chat.update(threadId, body));
		}
		if (sub === "messages" && request.method === "POST") {
			const body = (await request.json()) as {
				text?: string;
				resend?: boolean;
			};
			if (!body.text?.trim()) {
				return Response.json({ error: "text is required" }, { status: 400 });
			}
			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					// cancel can resolve the run while a final event is still in
					// flight — once closed, drop anything late instead of throwing
					let closed = false;
					let messageId: string | undefined;
					const emit = (event: RunEvent) => {
						if (event.type === "turn_started") messageId = event.messageId;
						if (closed) {
							return;
						}
						try {
							controller.enqueue(
								encoder.encode(`${JSON.stringify(event)}
`),
							);
						} catch {
							closed = true;
						}
					};
					const close = () => {
						if (closed) {
							return;
						}
						closed = true;
						try {
							controller.close();
						} catch {
							// already closed by the peer
						}
					};
					chat
						.run(threadId, body.text as string, emit, {
							resend: Boolean(body.resend),
						})
						.then(close)
						.catch((error) => {
							emit({ type: "error", message: String(error), messageId });
							close();
						});
				},
			});
			return new Response(stream, {
				headers: { "content-type": "application/x-ndjson" },
			});
		}
	}
	return null;
}
