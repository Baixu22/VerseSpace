import type { Blackboard } from "../blackboard";
import { publicChatConfig } from "../chat/credentials";

import { workbenchConfigSchema } from "../types/config";

export async function workspaceRoute(
	bb: Blackboard,
	url: URL,
	request: Request,
): Promise<Response | null> {
	if (url.pathname === "/api/sync" && request.method === "POST") {
		const { runOnce } = await import("../runtime");
		const result = await runOnce(bb);
		// the watcher or a manual sync holds the run lock: refuse instead
		// of racing — the UI can retry on the next interaction
		return Response.json(result, { status: result.busy ? 409 : 200 });
	}

	if (url.pathname === "/api/dispatch" && request.method === "POST") {
		const { dispatchGoal } = await import("../scheduler/dispatch");
		const body = (await request.json()) as {
			goalId?: string;
			workspotId?: string;
			force?: boolean;
		};
		if (!body.goalId) {
			return Response.json(
				{ ok: false, reason: "缺少 goalId" },
				{ status: 400 },
			);
		}
		const result = await dispatchGoal(bb, body.goalId, body.workspotId, {
			force: body.force === true,
		});
		return Response.json(result, { status: result.ok ? 200 : 409 });
	}

	if (url.pathname === "/api/agent/run" && request.method === "POST") {
		const { startAgent } = await import("../agents/runner");
		const body = (await request.json()) as {
			workspotId?: string;
			prompt?: string;
		};
		if (!body.workspotId || !body.prompt) {
			return Response.json(
				{ ok: false, reason: "缺少 workspotId / prompt" },
				{ status: 400 },
			);
		}
		const result = await startAgent(bb, {
			workspotId: body.workspotId,
			prompt: body.prompt,
		});
		return Response.json(result, { status: result.ok ? 200 : 409 });
	}

	if (url.pathname === "/api/review" && request.method === "POST") {
		const { reviewCheckpoint } = await import("../runtime/review");
		const body = (await request.json()) as {
			cpId?: string;
			approve?: boolean;
		};
		if (!body.cpId || typeof body.approve !== "boolean") {
			return Response.json(
				{ ok: false, reason: "缺少 cpId / approve" },
				{ status: 400 },
			);
		}
		return Response.json(await reviewCheckpoint(bb, body.cpId, body.approve));
	}

	if (url.pathname === "/api/chat/feedback" && request.method === "POST") {
		const body = (await request.json()) as {
			threadId?: string;
			messageId?: string;
			kind?: string;
		};
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "human",
			type: "feedback",
			payload: body,
		});
		return Response.json({ ok: true });
	}

	if (url.pathname === "/api/config/chat" && request.method === "GET") {
		const config = await bb.config.load();
		return Response.json(publicChatConfig(config.chat));
	}

	if (url.pathname === "/api/config/chat" && request.method === "PATCH") {
		const body = (await request.json()) as Record<string, unknown>;
		const config = await bb.config.load();
		const next = { ...config.chat, ...body };
		if (body.apiKey === "") {
			next.apiKey = undefined; // empty string clears the key
		}
		if (body.effort === null) next.effort = undefined;
		config.chat = workbenchConfigSchema.parse({
			...config,
			chat: next,
		}).chat;
		await bb.config.save(config);
		return Response.json(publicChatConfig(config.chat));
	}
	return null;
}
