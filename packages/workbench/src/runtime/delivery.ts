import type { Blackboard } from "../blackboard";
import { noticeIdForClaims } from "./notice-id";
import type { StalePremiseClaim } from "./premises";
import { formatNotice } from "./premises";

/**
 * R2 delivery (TF-0077): turn recorded `premise_stale` events into actual
 * notices. Detection and delivery are deliberately separate:
 *
 * - detection runs anywhere the world is watched (the watcher, `sync`);
 * - delivery only runs where live sessions actually live (the UI server),
 *   because only that process holds the stdin to write into.
 *
 * Everything in between sits in the event log, addressed by
 * (writer, path, currentVersion) so a second pass never re-delivers and a
 * writer that was offline gets its notices on the next drain.
 *
 * KV-cache red line: notices are append-only user turns. Never edit, reorder,
 * or delete mid-history messages, never change the system prompt or the tool
 * set mid-flight.
 */

export interface PendingNotice {
	/** Stable identity for this writer + current stale claim set. */
	noticeId: string;
	writerId: string;
	claims: StalePremiseClaim[];
	message: string;
}

export type NoticeDeliveryOutcome = "delivered" | "queued";

export interface DrainOptions {
	/**
	 * Push one notice into a live session. Return true only if it landed —
	 * a false/throw keeps the notice queued for the next pass.
	 */
	deliver?: (
		writerId: string,
		message: string,
		noticeId: string,
	) => Promise<boolean | NoticeDeliveryOutcome>;
	/** Approximate token budget for one rendered bundle (default: 300). */
	tokenBudget?: number;
}

export interface DrainResult {
	delivered: PendingNotice[];
	/** Still undelivered: no channel, session not live, or delivery failed. */
	pending: PendingNotice[];
}

export const DEFAULT_NOTICE_TOKEN_BUDGET = 300;

function noticeCharBudget(tokenBudget: number): number {
	if (!Number.isFinite(tokenBudget)) {
		return DEFAULT_NOTICE_TOKEN_BUDGET * 4;
	}
	return Math.max(0, Math.trunc(tokenBudget * 4));
}

function truncateNotice(text: string, maxLength: number): string {
	if (maxLength <= 0) {
		return "";
	}
	if (text.length <= maxLength) {
		return text;
	}
	if (maxLength === 1) {
		return "…";
	}
	return `${text.slice(0, maxLength - 1)}…`;
}

function claimKey(
	writer: string,
	claim: { path: string; currentVersion?: string | null },
): string {
	return `${writer}|${claim.path}|${claim.currentVersion ?? ""}`;
}

/** The delivery-side mirror of `formatNotice`: evidence a writer can act on. */
export function renderNotice(
	claims: StalePremiseClaim[],
	tokenBudget = DEFAULT_NOTICE_TOKEN_BUDGET,
): string {
	const budgetChars = noticeCharBudget(tokenBudget);
	if (budgetChars === 0) {
		return "";
	}
	const header = formatNotice(claims.length);
	if (header.length >= budgetChars) {
		return truncateNotice(header, budgetChars);
	}

	// Add all compact path/version facts first. Diffs are lower priority and
	// are appended only after the fact lines have a place, so a large diff can
	// never hide every later path from the model.
	let output = header;
	const included: StalePremiseClaim[] = [];
	let omittedClaims = 0;
	for (const claim of claims) {
		const prefix = `- ${claim.path}\n  观察版本 ${claim.observedVersion ?? "未知"} → 当前版本 ${claim.currentVersion ?? "未知"}`;
		const separator = output === header ? "\n\n" : "\n";
		if (output.length + separator.length + prefix.length > budgetChars) {
			omittedClaims += 1;
			continue;
		}
		output += `${separator}${prefix}`;
		included.push(claim);
	}

	let omittedDiffs = 0;
	const diffClaims = included.filter((claim) => Boolean(claim.diff));
	// Reserve room for the omission footer before spending characters on diff.
	const footerReserve =
		omittedClaims > 0 || diffClaims.length > 0
			? `\n\n（${omittedClaims} 个文件未展开；${diffClaims.length} 条 diff 因通知预算未完整展开；事件仍保留）`
					.length
			: 0;
	let diffBudget = Math.max(0, budgetChars - output.length - footerReserve);
	for (const claim of diffClaims) {
		const marker = `\n\n${claim.path} 的 diff\n\`\`\`diff\n`;
		const suffix = "\n```";
		if (diffBudget <= marker.length + suffix.length) {
			omittedDiffs += 1;
			continue;
		}
		const room = diffBudget - marker.length - suffix.length;
		const diff = claim.diff!.slice(0, room);
		const truncated = diff.length < claim.diff!.length;
		const tail = truncated ? "\n…（diff 已截断）" : "";
		const section = `${marker}${diff}${tail}${suffix}`;
		if (section.length > diffBudget) {
			omittedDiffs += 1;
			continue;
		}
		output += section;
		diffBudget -= section.length;
		if (truncated) {
			omittedDiffs += 1;
		}
	}

	const omittedTotal = omittedClaims + omittedDiffs;
	if (omittedTotal === 0) {
		return output.slice(0, budgetChars);
	}
	const footerParts: string[] = [];
	if (omittedClaims > 0) {
		footerParts.push(`${omittedClaims} 个文件未展开`);
	}
	if (omittedDiffs > 0) {
		footerParts.push(`${omittedDiffs} 条 diff 因通知预算未完整展开`);
	}
	footerParts.push("事件仍保留");
	const footer = `\n\n（${footerParts.join("；")}）`;
	if (output.length + footer.length <= budgetChars) {
		return `${output}${footer}`;
	}
	// Only diff sections are after the fact lines. Trim their tail to make the
	// omission count fit; if the budget is tiny, the header/facts win.
	const room = Math.max(0, budgetChars - footer.length);
	return `${output.slice(0, room)}${footer}`.slice(0, budgetChars);
}

/**
 * Notices recorded but not yet delivered, grouped by writer. Pure read — safe
 * to call from `status`, from a doctor check, or from any host.
 */
export async function pendingPremiseNotices(
	bb: Blackboard,
	options: { tokenBudget?: number } = {},
): Promise<PendingNotice[]> {
	// Read the append-only log once; querying it separately for each projection
	// doubles the cost on long-running workspaces.
	const allEvents = await bb.events.all();
	const staleEvents = allEvents.filter(
		(event) => event.type === "premise_stale",
	);
	const outcomeEvents = allEvents.filter(
		(event) =>
			event.type === "premise_notice_outcome" ||
			event.type === "premise_notice_delivered",
	);

	const landed = new Set<string>();
	const landedClaimKeys = new Set<string>();
	for (const event of outcomeEvents) {
		const payload = event.payload as
			| {
					writer?: string;
					outcome?: string;
					noticeId?: string;
					noticeIds?: unknown;
					stale?: Array<{ path: string; currentVersion?: string | null }>;
			  }
			| undefined;
		const deliveredEvent = event.type === "premise_notice_delivered";
		if (
			(!deliveredEvent && payload?.outcome !== "delivered") ||
			!payload?.writer
		) {
			continue;
		}
		if (typeof payload.noticeId === "string") {
			landed.add(payload.noticeId);
		}
		for (const noticeId of Array.isArray(payload.noticeIds)
			? payload.noticeIds
			: []) {
			if (typeof noticeId === "string") {
				landed.add(noticeId);
			}
		}
		for (const claim of payload.stale ?? []) {
			landedClaimKeys.add(claimKey(payload.writer, claim));
		}
	}
	// One bucket per writer, keyed by path: a later `premise_stale` supersedes
	// an earlier one for the same file, so only the newest state per path can
	// still be pending. Keying by (path, version) instead would leave the
	// superseded entry behind and notify twice about one file.
	const byWriter = new Map<string, Map<string, StalePremiseClaim>>();
	for (const event of staleEvents) {
		const payload = event.payload as
			| { writer?: string; stale?: StalePremiseClaim[] }
			| undefined;
		const writer = payload?.writer;
		if (!writer) {
			continue;
		}
		let bucket = byWriter.get(writer);
		if (!bucket) {
			bucket = new Map();
			byWriter.set(writer, bucket);
		}
		for (const claim of payload.stale ?? []) {
			bucket.set(claim.path, claim);
		}
	}

	const notices: PendingNotice[] = [];
	for (const [writerId, bucket] of byWriter) {
		const claims = [...bucket.values()].filter(
			(claim) => !landedClaimKeys.has(claimKey(writerId, claim)),
		);
		// a writer with nothing left is not a pending notice — emitting an
		// empty one would deliver a content-free turn and mark it delivered
		if (claims.length === 0) {
			continue;
		}
		const noticeId = noticeIdForClaims(writerId, claims);
		if (landed.has(noticeId)) {
			continue;
		}
		notices.push({
			noticeId,
			writerId,
			claims,
			message: renderNotice(claims, options.tokenBudget),
		});
	}
	return notices;
}

/**
 * One delivery pass. Without a `deliver` callback this is a pure inspection:
 * everything comes back in `pending` and nothing is written.
 */
export async function drainPremiseQueue(
	bb: Blackboard,
	options: DrainOptions = {},
): Promise<DrainResult> {
	const pending = await pendingPremiseNotices(bb, {
		tokenBudget: options.tokenBudget,
	});
	const delivered: PendingNotice[] = [];
	const stillPending: PendingNotice[] = [];

	for (const notice of pending) {
		let outcome: NoticeDeliveryOutcome | false = false;
		if (options.deliver) {
			try {
				const result = await options.deliver(
					notice.writerId,
					notice.message,
					notice.noticeId,
				);
				outcome = result === true ? "delivered" : result;
			} catch {
				outcome = false; // a broken channel must not lose the notice
			}
		}
		if (outcome !== "delivered") {
			stillPending.push(notice);
			continue;
		}
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_notice_delivered",
			payload: {
				writer: notice.writerId,
				noticeId: notice.noticeId,
				noticeIds: [notice.noticeId],
				stale: notice.claims.map((claim) => ({
					path: claim.path,
					currentVersion: claim.currentVersion,
				})),
			},
		});
		delivered.push(notice);
	}

	return { delivered, pending: stillPending };
}
