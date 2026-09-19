import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { pathExists, writeFileAtomic } from "../fs/atomic";
import { withPidLock } from "../fs/lockfile";
import { noticeIdForText } from "../runtime/notice-id";

import type { ThreadContext } from "./thread-context";

import { turnInFlight } from "./thread-lifecycle";

export interface QueuedNotice {
	id: string;
	notice: string;
	at: string;
}

export interface NoticeBatch {
	entries: QueuedNotice[];
}

export interface NoticeSelection {
	entries: QueuedNotice[];
	/** Entries that fit the provider-side notice budget, in original order. */
	notices: string[];
}

export function selectNoticeEntries(
	entries: QueuedNotice[],
	tokenBudget: number | undefined,
): NoticeSelection {
	const budget = Number.isFinite(tokenBudget)
		? Math.max(0, Math.trunc((tokenBudget as number) * 4))
		: 300 * 4;
	if (budget === 0) {
		return { entries: [], notices: [] };
	}
	let used = 0;
	const selected: QueuedNotice[] = [];
	for (const entry of entries) {
		const separator = selected.length === 0 ? 0 : 2;
		if (used + separator + entry.notice.length > budget) {
			continue;
		}
		selected.push(entry);
		used += separator + entry.notice.length;
	}
	return {
		entries: selected,
		notices: selected.map((entry) => entry.notice),
	};
}

export async function notifySession(
	context: ThreadContext,
	writerId: string,
	notice: string,
	noticeId?: string,
): Promise<"queued" | false> {
	if (!notice.trim()) return false;
	// Batch writers share the sessions registry but have no chat transcript or
	// stdin channel. Leave their notice pending instead of falsely marking it
	// delivered into a directory nobody will ever drain.
	if (!(await pathExists(context.store.metaFile(writerId)))) {
		return false;
	}
	const noticeFile = noticesFile(context, writerId);
	return withPidLock<"queued">(`${noticeFile}.lock`, async () => {
		await mkdir(context.store.dir(writerId), { recursive: true });
		const id = noticeId ?? noticeIdForText(writerId, notice);
		const existing = await readNoticeEntries(context, writerId);
		const sameId = existing.findIndex((entry) => entry.id === id);
		if (sameId >= 0) {
			// A reconcile pass may have queued the compact header before the
			// delivery pass rendered evidence. Keep the stable identity, but
			// upgrade the queued body so the provider receives the richest facts.
			if (existing[sameId]?.notice !== notice) {
				existing[sameId] = {
					...existing[sameId]!,
					notice,
					at: new Date().toISOString(),
				};
				await writeFileAtomic(
					noticeFile,
					`${existing.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				);
			}
			return "queued";
		}
		if (existing.some((entry) => entry.notice === notice)) {
			return "queued";
		}
		await appendFile(
			noticeFile,
			`${JSON.stringify({
				id,
				notice,
				at: new Date().toISOString(),
			})}\n`,
			"utf8",
		);
		await context.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_notice_queued",
			payload: {
				writer: writerId,
				noticeId: id,
				reason: turnInFlight(context, writerId)
					? "turn-in-flight"
					: "next-user-turn",
			},
		});
		return "queued";
	});
}

export function noticesFile(context: ThreadContext, id: string): string {
	return join(context.store.dir(id), "notices.jsonl");
}

export function parseNoticeEntries(raw: string): QueuedNotice[] {
	const legacy = (line: string): QueuedNotice => ({
		id: `legacy-${createHash("sha256")
			.update(line, "utf8")
			.digest("hex")
			.slice(0, 16)}`,
		notice: line,
		at: "",
	});
	return raw
		.split("\n")
		.map((line) => {
			if (!line.trim()) {
				return null;
			}
			try {
				const parsed = JSON.parse(line) as {
					id?: unknown;
					notice?: unknown;
					at?: unknown;
				};
				if (typeof parsed.notice !== "string" || !parsed.notice.trim()) {
					// A syntactically valid but unknown row is still durable user
					// evidence. Keep the raw line during schema migrations instead
					// of silently deleting it on the next acknowledgement.
					return legacy(line);
				}
				const id =
					typeof parsed.id === "string" && parsed.id.length > 0
						? parsed.id
						: `legacy-${createHash("sha256")
								.update(line, "utf8")
								.digest("hex")
								.slice(0, 16)}`;
				return {
					id,
					notice: parsed.notice,
					at: typeof parsed.at === "string" ? parsed.at : "",
				};
			} catch {
				// Keep a legacy/plain-text line deliverable instead of silently
				// dropping it during a migration.
				return legacy(line);
			}
		})
		.filter((entry): entry is QueuedNotice => entry !== null);
}

export async function readNoticeEntries(
	context: ThreadContext,
	id: string,
): Promise<QueuedNotice[]> {
	try {
		return parseNoticeEntries(await readFile(noticesFile(context, id), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

export async function drainNotices(
	context: ThreadContext,
	id: string,
): Promise<NoticeBatch> {
	const noticeFile = noticesFile(context, id);
	return withPidLock(`${noticeFile}.lock`, async () => {
		return { entries: await readNoticeEntries(context, id) };
	});
}

export async function ackNotices(
	context: ThreadContext,
	id: string,
	ids: string[],
): Promise<boolean> {
	if (ids.length === 0) {
		return true;
	}
	const acknowledged = new Set(ids);
	const noticeFile = noticesFile(context, id);
	await withPidLock(`${noticeFile}.lock`, async () => {
		const entries = await readNoticeEntries(context, id);
		const remaining = entries.filter((entry) => !acknowledged.has(entry.id));
		if (remaining.length === 0) {
			await rm(noticeFile, { force: true });
			return;
		}
		await writeFileAtomic(
			noticeFile,
			`${remaining.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
	});
	return true;
}

/**
 * 恢复卡 dismiss 的注入撤回（TF-0198，D3-Q2「未投递时完全撤」）：投递时
 * 已被 ack 移除，所以留在队列里的恰是未投递部分——整队清空即精确撤回。
 * dismiss 路由同步调用它：路由返回即队列已空（≤2s 语义由同步性保证）。
 */
export async function clearNotices(
	context: ThreadContext,
	id: string,
): Promise<void> {
	const noticeFile = noticesFile(context, id);
	await withPidLock(`${noticeFile}.lock`, async () => {
		await rm(noticeFile, { force: true });
	});
}
