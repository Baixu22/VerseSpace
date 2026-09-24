/**
 * Parse the human-friendly durations `workbench.yaml` uses for thresholds —
 * `"30s"`, `"15m"`, `"2h"`, `"1d"`, or a bare number meaning seconds.
 *
 * Returns `null` for anything that is not a positive duration, so a caller can
 * fall back to its own default. Returning `0` on a typo would turn
 * `checkpointTimeout: "5 min"` into "kill the verification instantly", which
 * is the kind of silent misreading these options are supposed to prevent.
 */
const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86_400,
};

export function parseDurationSeconds(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed === "") {
		return null;
	}
	const match = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(trimmed);
	if (!match) {
		return null;
	}
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) {
		return null;
	}
	// `match[2]` is "" (not undefined) when the unit is omitted, so `??` would
	// leave it empty and the lookup would fail — a bare "45" must mean 45s.
	const unit = (match[2] || "s").toLowerCase();
	const factor = UNIT_SECONDS[unit];
	return factor === undefined ? null : Math.round(amount * factor);
}
