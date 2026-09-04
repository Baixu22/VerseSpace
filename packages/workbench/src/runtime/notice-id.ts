import { createHash } from "node:crypto";

function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value), "utf8")
		.digest("hex")
		.slice(0, 24);
}

/**
 * Stable identity for a stale claim bundle. Diffs are deliberately excluded:
 * they are best-effort evidence and may disappear when a spool is rotated;
 * path + observed/current versions are the durable fact identity.
 */
export function noticeIdForClaims(
	writerId: string,
	claims: Array<{
		path: string;
		observedVersion?: string | null;
		currentVersion?: string | null;
	}>,
): string {
	const canonical = claims
		.map((claim) => ({
			path: claim.path,
			observedVersion: claim.observedVersion ?? null,
			currentVersion: claim.currentVersion ?? null,
		}))
		.sort((a, b) => {
			const left = `${a.path}\u0000${a.currentVersion ?? ""}\u0000${a.observedVersion ?? ""}`;
			const right = `${b.path}\u0000${b.currentVersion ?? ""}\u0000${b.observedVersion ?? ""}`;
			return left < right ? -1 : left > right ? 1 : 0;
		});
	return `notice-${digest({ writerId, claims: canonical })}`;
}

/** Stable fallback identity for manually queued/legacy text-only notices. */
export function noticeIdForText(writerId: string, notice: string): string {
	return `notice-${digest({ writerId, notice })}`;
}
