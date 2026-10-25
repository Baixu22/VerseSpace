import { artifactProjectionText } from "../artifacts/projection";
import type { Blackboard } from "../blackboard";
import { collectRestoreView } from "../chat/restore-view";
import type { ChatThreads } from "../chat/threads";

export async function resumeCardText(
	bb: Blackboard,
	chat: ChatThreads,
	threadId: string,
): Promise<string> {
	const view = await collectRestoreView(bb, chat, threadId);
	const artifactText = artifactProjectionText(view.artifactReviews);
	if (!view.resumeCard)
		return `线程 ${threadId} 没有恢复卡。\n${artifactText}\n${view.inputCoverage.text}`;
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
		view.inputCoverage.text,
		artifactText,
		`- 覆盖：${card.coverage.text}`,
		`- 恢复增量：${view.resumeDelta}`,
		`- 恢复笔记：${beats || "无"}`,
		`- 事实：${facts || "无"}`,
		`- 已忽略：${card.dismissed ? "是" : "否"}；注入：${card.inject ? "是" : "否"}`,
	].join("\n");
}
