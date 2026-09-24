/**
 * `thresholds.idleNotification` (P0-2). The option used to be declared,
 * schema-validated, settable — and read by nothing. This is its consumer.
 *
 * The rule is deliberately narrow: work is in flight (at least one active
 * workspot) and *nothing at all* has been appended to the event log for longer
 * than the threshold. A quiet project with nothing running is not news, so it
 * stays silent.
 *
 * No separate de-duplication is needed: the notification is itself an event,
 * so it resets "last activity" and cannot repeat until the log goes quiet
 * again for another full threshold.
 */
export interface IdleCheckInput {
	nowMs: number;
	/** Threshold in milliseconds; a non-positive value disables the check. */
	thresholdMs: number;
	/** Timestamp of the newest event, or null when the log is empty. */
	lastActivityMs: number | null;
	activeWorkspots: number;
}

export type IdleDecision =
	| { notify: false; reason: string }
	| { notify: true; message: string; severity: "info" | "warning" };

export function shouldNotifyIdle(input: IdleCheckInput): IdleDecision {
	if (input.activeWorkspots <= 0) {
		return { notify: false, reason: "没有在办的工位" };
	}
	if (!Number.isFinite(input.thresholdMs) || input.thresholdMs <= 0) {
		return {
			notify: false,
			reason: "thresholds.idleNotification 不是有效时长",
		};
	}
	if (
		input.lastActivityMs === null ||
		!Number.isFinite(input.lastActivityMs) ||
		!Number.isFinite(input.nowMs)
	) {
		return { notify: false, reason: "事件日志为空，没有可比较的活动时间" };
	}
	const idleMs = input.nowMs - input.lastActivityMs;
	if (idleMs < input.thresholdMs) {
		return { notify: false, reason: "未达到空闲阈值" };
	}
	return {
		notify: true,
		severity: "warning",
		message:
			`${input.activeWorkspots} 个工位仍在进行中，但已 ${Math.round(idleMs / 60_000)} ` +
			"分钟没有任何事件（thresholds.idleNotification）",
	};
}
