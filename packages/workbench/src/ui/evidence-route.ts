import type { Blackboard } from "../blackboard";
import { resolveThreadEvidence } from "../chat/evidence";
import type { ChatThreads } from "../chat/threads";

export async function evidenceResponse(
	bb: Blackboard,
	chat: ChatThreads,
	threadId: string,
	url: URL,
): Promise<Response> {
	const ref = url.searchParams.get("ref");
	if (!ref?.trim() || ref.length > 2_048) {
		return Response.json({ error: "缺少有效的证据引用" }, { status: 400 });
	}
	try {
		return Response.json(await resolveThreadEvidence(bb, chat, threadId, ref));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return Response.json({ error: "这条对话已不存在" }, { status: 404 });
		}
		throw error;
	}
}
