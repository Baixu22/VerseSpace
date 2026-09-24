import type { DoctorContext, DoctorIssue } from "../types";

export function checkDrafts(ctx: DoctorContext, issues: DoctorIssue[]): void {
	const { staging } = ctx;
	// ── draft checkpoints without a verification strategy ──
	for (const checkpoint of staging) {
		if (checkpoint.lifecycle === "draft" && !checkpoint.verification) {
			issues.push({
				check: "draft_without_verification",
				severity: "warning",
				message: `checkpoint ${checkpoint.id} 没有 verification 策略，将永远停留在 draft`,
				subject: checkpoint.id,
			});
		}
	}
}
