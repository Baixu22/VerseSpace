import type { Blackboard } from "../blackboard";
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
	writerId: string;
	claims: StalePremiseClaim[];
	message: string;
}

export interface DrainOptions {
	/**
	 * Push one notice into a live session. Return true only if it landed —
	 * a false/throw keeps the notice queued for the next pass.
	 */
	deliver?: (writerId: string, message: string) => Promise<boolean>;
}

export interface DrainResult {
	delivered: PendingNotice[];
	/** Still undelivered: no channel, session not live, or delivery failed. */
	pending: PendingNotice[];
}

function claimKey(
	writer: string,
	claim: { path: string; currentVersion?: string | null },
): string {
	return `${writer}|${claim.path}|${claim.currentVersion ?? ""}`;
}

/** The delivery-side mirror of `formatNotice`: evidence a writer can act on. */
export function renderNotice(claims: StalePremiseClaim[]): string {
	const body = claims
		.map((claim) => {
			const versions = `\n  观察版本 ${claim.observedVersion ?? "未知"} → 当前版本 ${claim.currentVersion ?? "未知"}`;
			const diff = claim.diff ? `\n\`\`\`diff\n${claim.diff}\n\`\`\`` : "";
			return `- ${claim.path}${versions}${diff}`;
		})
		.join("\n");
	return `${formatNotice(claims.length)}\n\n${body}`;
}

/**
 * Notices recorded but not yet delivered, grouped by writer. Pure read — safe
 * to call from `status`, from a doctor check, or from any host.
 */
export async function pendingPremiseNotices(
	bb: Blackboard,
): Promise<PendingNotice[]> {
	const staleEvents = await bb.events.query({ type: "premise_stale" });
	const outcomeEvents = await bb.events.query({
		type: "premise_notice_outcome",
	});

	const landed = new Set<string>();
	for (const event of outcomeEvents) {
		const payload = event.payload as
			| {
					writer?: string;
					outcome?: string;
					stale?: Array<{ path: string; currentVersion?: string | null }>;
			  }
			| undefined;
		if (payload?.outcome !== "delivered" || !payload.writer) {
			continue;
		}
		for (const claim of payload.stale ?? []) {
			landed.add(claimKey(payload.writer, claim));
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
			(claim) => !landed.has(claimKey(writerId, claim)),
		);
		// a writer with nothing left is not a pending notice — emitting an
		// empty one would deliver a content-free turn and mark it delivered
		if (claims.length === 0) {
			continue;
		}
		notices.push({ writerId, claims, message: renderNotice(claims) });
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
	const pending = await pendingPremiseNotices(bb);
	const delivered: PendingNotice[] = [];
	const stillPending: PendingNotice[] = [];

	for (const notice of pending) {
		let landed = false;
		if (options.deliver) {
			try {
				landed = await options.deliver(notice.writerId, notice.message);
			} catch {
				landed = false; // a broken channel must not lose the notice
			}
		}
		if (!landed) {
			stillPending.push(notice);
			continue;
		}
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_notice_outcome",
			payload: {
				writer: notice.writerId,
				outcome: "delivered",
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
