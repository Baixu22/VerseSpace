import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkbenchEvent } from "../../src/types/event";
import {
	cliJson,
	type E2EWorkspace,
	type Server,
	sendTurn,
	waitFor,
} from "./driver";
import { type FamilyNotice, noticeTransition } from "./family-notice-evidence";

/** Three actual thread processes share reads, then siblings invalidate each other. */
export async function verifyFamilyNotices(
	ws: E2EWorkspace,
	server: Server,
	source: string,
	branches: string[],
) {
	if (branches.length !== 2 || new Set([source, ...branches]).size !== 3)
		throw new Error("家族场景需要三个独立写者");
	const readEvents = async (): Promise<WorkbenchEvent[]> =>
		(
			await readFile(
				join(ws.projectDir, ".workbench/events/events.jsonl"),
				"utf8",
			)
		)
			.trim()
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	const readPending = async () =>
		(await cliJson<{ pending: FamilyNotice[] }>(ws, ["premises", "pending"]))
			.pending;
	const capture = async (
		writers: string[],
		path: string,
		changedBy: string,
	) => {
		const version = createHash("sha256")
			.update(await readFile(join(ws.projectDir, path)))
			.digest("hex");
		let pending: FamilyNotice[] = [];
		await waitFor(
			`${path} 的家族失效通知：${writers.join("、")}`,
			async () => {
				pending = await readPending();
				return writers.every((writer) =>
					pending.some(
						(notice) =>
							notice.writer === writer &&
							notice.familyFold?.familyId === source &&
							notice.familyFold.paths.includes(path) &&
							notice.familyFold.writerIds.includes(changedBy) &&
							notice.stale.some(
								(claim) =>
									claim.path === path && claim.currentVersion === version,
							),
					),
				);
			},
			60_000,
		);
		return writers.map((writer) => {
			const notice = pending.find((item) => item.writer === writer)!;
			if (
				!notice.noticeId ||
				!notice.familyFold!.paths.every((folded) =>
					notice.stale.some((claim) => claim.path === folded),
				)
			)
				throw new Error(`折叠丢失通知身份或原始前提：${writer}`);
			return notice;
		});
	};
	const CONTRACT_SUFFIX =
		"\n\n输出契约：每个回合必须返回正文（解释你做了什么）或 tool_calls（调用工具）。不允许返回空响应。";
	const send = async (writer: string, text: string) => {
		const events = await sendTurn(server, writer, text + CONTRACT_SUFFIX);
		if (
			events.some((event) => event.type === "error") ||
			!events.some((event) => event.type === "done")
		) {
			throw new Error(`家族场景回合失败：${writer}`);
		}
	};
	await send(
		source,
		'WRITE src/family.ts\nexport const family = "v1";\n__END_WRITE__',
	);
	for (const writer of [source, ...branches])
		await send(writer, "READ src/alpha.ts\nREAD src/family.ts");
	await send(
		branches[0]!,
		'WRITE src/alpha.ts\nexport const alpha = "family-v5";\nexport const alphaChanged = true;\n__END_WRITE__',
	);
	// Observe both recipients before branch 2 runs: its next turn can consume
	// the notice and re-read alpha, so three simultaneously pending writers
	// are not a valid invariant for a real model.
	const alphaNotices = await capture(
		[source, branches[1]!],
		"src/alpha.ts",
		branches[0]!,
	);
	const boundary = (await readEvents()).length;
	await send(
		branches[1]!,
		'WRITE src/family.ts\nexport const family = "v2";\nexport const familyChanged = true;\n__END_WRITE__',
	);
	const familyNotices = await capture(
		[source, branches[0]!],
		"src/family.ts",
		branches[1]!,
	);
	const captured = [...alphaNotices, ...familyNotices];
	if (
		new Set(captured.map((notice) => notice.noticeId)).size !== captured.length
	)
		throw new Error("不同写者或前提集合错误地共用了通知身份");
	const pending = await readPending();
	const events = (await readEvents()).slice(boundary);
	return {
		writers: 3,
		folded: new Set(captured.map((notice) => notice.writer)).size,
		observations: captured,
		transitions: alphaNotices.map((notice) =>
			noticeTransition(notice, pending, events),
		),
	};
}
