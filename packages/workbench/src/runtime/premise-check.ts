import type { Blackboard } from "../blackboard";
import { claimVersion } from "../blackboard/claim-version";
import { hashPathClaim } from "../blackboard/footprint";
import { emptyPassCounts } from "./premise-counts";
import { diffFor } from "./premise-diff";
import { spanInvalidated, surfaceUnchanged } from "./premise-predicate";
import type { StalePremiseClaim } from "./premises";

/** Read-only current validity. Delivery and notification deduplication are not inputs. */
export async function inspectWriterPremises(bb: Blackboard, writerId: string) {
	const { readFragments, writes } = await bb.sessions.readSetView(writerId);
	const touched = new Set(writes.map((write) => write.path));
	const counts = emptyPassCounts();
	counts.writers = 1;
	const stale: StalePremiseClaim[] = [];
	for (const [path, fragments] of readFragments) {
		const volatile = fragments.filter(
			(claim) => claim.durability !== "durable",
		);
		if (volatile.length === 0) {
			counts.suppressedL1 += 1;
			continue;
		}
		const current = await hashPathClaim(bb.projectRoot, path);
		const changed = volatile.filter(
			(claim) => claimVersion(claim) !== claimVersion(current),
		);
		if (!changed.length) continue;
		counts.overlaps += 1;
		let suppressed: "suppressedL2" | "suppressedL3" = "suppressedL2";
		let evidence: StalePremiseClaim | undefined;
		for (const claim of changed) {
			let diff: string | undefined;
			if (claim.span) {
				diff = await diffFor(bb, writerId, claim);
				if (!(await spanInvalidated(bb, claim, claim.span, diff))) continue;
			} else if (
				!touched.has(path) &&
				(await surfaceUnchanged(bb, writerId, claim))
			) {
				suppressed = "suppressedL3";
				continue;
			}
			evidence = {
				path,
				observedVersion: claimVersion(claim),
				currentVersion: claimVersion(current),
				diff: diff ?? (await diffFor(bb, writerId, claim)),
			};
			break; // One affected path, not one notification per fragment.
		}
		if (evidence) stale.push(evidence);
		else counts[suppressed] += 1;
	}
	counts.notified = stale.length;
	return { stale, counts };
}
