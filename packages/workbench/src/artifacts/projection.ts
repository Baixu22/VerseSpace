import type { Blackboard } from "../blackboard";
import { type ArtifactReview, listArtifactReviews } from "./status";

const display = (text: string, cap = 160) =>
	text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
const entries = (files: Record<string, string> | undefined) =>
	Object.entries(files ?? {})
		.slice(0, 3)
		.map(([path, hash]) => ({ path: display(path), hash }));
const commandId = (id: string) =>
	/^[a-z0-9_.-]+$/i.test(id) ? id : `'${id.replace(/'/g, "''")}'`;

/** Small derived payload, with independent source/current/check/target facts and complete totals. */
export function projectArtifactReviews(
	reviews: ArtifactReview[],
	limit = 20,
	maxChars = 2000,
) {
	const counts = { current: 0, stale: 0, pending: 0, failed: 0, unknown: 0 };
	for (const item of reviews) counts[item.status]++;
	const items = reviews
		.slice(0, Math.max(0, Math.min(20, Math.floor(limit))))
		.map((item) => ({
			rootId: item.rootId,
			checkpointId: item.checkpointId,
			path: display(item.path),
			status: item.status,
			reason: display(item.reason),
			targetStatus: item.targetStatus,
			evidenceStrength: item.evidenceStrength ?? "unknown",
			refs: item.refs,
			revalidateCommand: `workbench checkpoint revalidate ${commandId(item.checkpointId)}`,
			handoff: item.handoff,
			facts: {
				origin: {
					strength: item.facts?.origin.strength ?? "unknown",
					reason: display(item.facts?.origin.reason ?? "未声明来源"),
				},
				inputs: {
					status: item.facts?.inputs.status ?? "unknown",
					total: item.inputs.length,
					changedTotal: item.facts?.inputs.changed.length ?? 0,
					previewTruncated:
						Object.keys(item.facts?.inputs.versions ?? {}).length > 3 ||
						(item.facts?.inputs.changed.length ?? 0) > 3,
					changed: (item.facts?.inputs.changed ?? [])
						.slice(0, 3)
						.map((path) => display(path)),
					versions: entries(item.facts?.inputs.versions),
				},
				verification: item.facts?.verification ?? {
					checkpointId: item.checkpointId,
					result: null,
					scope: "unknown",
					authority: "unknown",
					at: null,
				},
			},
			target: {
				status: item.targetStatus,
				change: item.targetChange ?? "unknown",
				ref: item.targetNow?.ref ?? null,
				checkedCommit:
					item.targetCheck?.baseCommit ??
					item.verifiedAt?.target?.commit ??
					null,
				currentCommit: item.targetNow?.commit ?? null,
			},
		}));
	const payload = {
		schemaVersion: 1 as const,
		total: reviews.length,
		counts,
		items,
		omitted: reviews.length - items.length,
		truncated: items.length < reviews.length,
	};
	while (payload.items.length && JSON.stringify(payload).length > maxChars) {
		payload.items.pop();
		payload.omitted++;
		payload.truncated = true;
	}
	return payload;
}
export type ArtifactReviewProjection = ReturnType<
	typeof projectArtifactReviews
>;

export async function artifactReviewProjection(
	bb: Blackboard,
	writer?: string,
) {
	return projectArtifactReviews(await listArtifactReviews(bb, writer));
}

export function artifactProjectionText(view: ArtifactReviewProjection): string {
	const counts = Object.entries(view.counts)
		.map(([status, count]) => `${status}=${count}`)
		.join("，");
	return [
		`产物 ${view.total} 项（${counts}；展示 ${view.items.length}，未展开 ${view.omitted}）：`,
		...view.items.map(
			(item) =>
				`- 产物 ${item.path}：${item.status}；来源 ${item.facts.origin.strength}；当前输入 ${item.facts.inputs.status}；最近范围检查 ${item.facts.verification.result ?? "unknown"}/${item.facts.verification.scope}；目标 ${item.targetStatus}；${item.reason}；${item.revalidateCommand}；refs=${item.refs.join(",")}`,
		),
	].join("\n");
}
