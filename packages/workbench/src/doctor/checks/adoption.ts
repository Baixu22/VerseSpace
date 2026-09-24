import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../../blackboard";
import type { ThreadMeta } from "../../chat/thread-types";
import type { DoctorIssue } from "../types";

export async function checkAdoption(
	bb: Blackboard,
	issues: DoctorIssue[],
): Promise<void> {
	// ── adoption consistency (TF-0200): dangling snapshots and half-adoptions ──
	const threads = await listThreadMetas(bb);
	// 悬空快照：收养快照只应挂在被归档的源线程上。未归档却挂着快照，说明 revert
	// 半途而废或 meta.json 被手工改坏——此时侧栏不会把它当归档呈现，快照却仍在。
	for (const thread of threads) {
		if (thread.adoptSnapshot && !thread.archived) {
			issues.push({
				check: "dangling_adopt_snapshot",
				severity: "error",
				message: `线程 ${thread.id} 挂着收养快照却未归档（revert 未完成或 meta.json 被手工改坏）`,
				subject: thread.id,
			});
		}
	}
	// 半收养：有 thread.adopted 事件，源线程却缺 adoptSnapshot。已反转的收养会
	// 正常清空快照（并留下 thread.adoption_reverted），那是终态、不算半收养；
	// 只有既无快照又没见到反转事件的，才是收养写到一半崩了。
	const threadById = new Map(threads.map((thread) => [thread.id, thread]));
	const [adoptedEvents, revertedEvents] = await Promise.all([
		bb.events.query({ type: "thread.adopted" }),
		bb.events.query({ type: "thread.adoption_reverted" }),
	]);
	const revertedSources = new Set(
		revertedEvents
			.map((event) => sourceThreadIdOf(event.payload))
			.filter((id): id is string => id !== null),
	);
	for (const event of adoptedEvents) {
		const sourceThreadId = sourceThreadIdOf(event.payload);
		if (!sourceThreadId || revertedSources.has(sourceThreadId)) {
			continue;
		}
		const source = threadById.get(sourceThreadId);
		if (source && !source.adoptSnapshot) {
			issues.push({
				check: "half_adopted",
				severity: "warning",
				message: `线程 ${sourceThreadId} 有 thread.adopted 事件但源线程缺少 adoptSnapshot（收养中途失败，且未见反转事件）`,
				subject: sourceThreadId,
			});
		}
	}
}

/** Read-only thread meta sweep: mirrors ThreadRepository.list, tolerant of a
 * missing threads dir (no chat yet) and unparseable meta.json. */
async function listThreadMetas(bb: Blackboard): Promise<ThreadMeta[]> {
	const threadsDir = join(bb.paths.root, "threads");
	let ids: string[];
	try {
		ids = await readdir(threadsDir);
	} catch {
		return [];
	}
	const metas = await Promise.all(
		ids.map(async (id) => {
			try {
				return JSON.parse(
					await readFile(join(threadsDir, id, "meta.json"), "utf8"),
				) as ThreadMeta;
			} catch {
				return null;
			}
		}),
	);
	return metas.filter((meta): meta is ThreadMeta => meta !== null);
}

function sourceThreadIdOf(payload: unknown): string | null {
	const source = (payload as { sourceThreadId?: unknown } | undefined)
		?.sourceThreadId;
	return typeof source === "string" ? source : null;
}
