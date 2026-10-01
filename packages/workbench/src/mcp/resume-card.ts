import { listArtifactReviews } from "../artifacts/status";
import type { Blackboard } from "../blackboard";
import { collectRestoreView } from "../chat/restore-view";
import type { ChatThreads } from "../chat/threads";

export async function resumeCardText(
	bb: Blackboard,
	chat: ChatThreads,
	threadId: string,
): Promise<string> {
	const artifacts = await listArtifactReviews(bb, threadId);
	const artifactText = artifacts
		.map(
			(item) =>
				`- 产物 ${item.path}：${item.status}；${item.reason}；checkpoint revalidate ${item.checkpointId}`,
		)
		.join("\n");
	const view = await collectRestoreView(bb, chat, threadId);
	if (!view.resumeCard) return `线程 ${threadId} 没有恢复卡。\n${artifactText}`;
	const card = view.resumeCard;
	const beats = (view.resumeNote?.beats ?? [])
		.map((beat) => `${beat.kind}:${beat.text}`)
		.join(" | ");
	const facts = card.facts
		.slice(0, card.factsPreviewCount)
		.map((fact) => `${fact.path}${fact.summary ? ` ${fact.summary}` : ""}`)
		.join("；");
	return [
		`线程 ${threadId} 恢复卡：`,
		artifactText,
		`- 覆盖：${card.coverage.text}`,
		`- 恢复增量：${view.resumeDelta}`,
		`- 恢复笔记：${beats || "无"}`,
		`- 事实：${facts || "无"}`,
		`- 已忽略：${card.dismissed ? "是" : "否"}；注入：${card.inject ? "是" : "否"}`,
	].join("\n");
}
