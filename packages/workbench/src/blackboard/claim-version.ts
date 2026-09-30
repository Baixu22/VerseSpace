import type { FootprintUsed } from "./sessions";

export function claimStrength(
	claim: Pick<FootprintUsed, "version" | "size">,
): "content-hash" | "size-only" | "unknown" {
	return claim.version != null
		? "content-hash"
		: claim.size !== undefined
			? "size-only"
			: "unknown";
}

/** Size-only versions preserve the capture cap; equal-size edits remain unobservable. */
export function claimVersion(
	claim: Pick<FootprintUsed, "version" | "size">,
): string | null {
	return (
		claim.version ?? (claim.size === undefined ? null : `size:${claim.size}`)
	);
}
