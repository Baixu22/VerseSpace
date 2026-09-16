import type { ActiveTurn } from "./claude-types";

export function acknowledgeClaudeNotices(turn: ActiveTurn): void {
	if (!turn.onNoticesSent || turn.noticeAcked) {
		return;
	}
	turn.noticeAcked = true;
	turn.noticeAckPromise = (async () => {
		const acknowledged = await turn.onNoticesSent?.();
		if (acknowledged === false) {
			return;
		}
		turn.emit({ type: "notice_delivered", count: turn.noticeCount });
	})().catch((err) => {
		// The provider already accepted the turn; a logging failure must not
		// strand the chat turn. The durable notice ack itself is best effort.
		// 失败仍要可见（2026-09-13 收尾 4.5）。
		console.error("[chat] notice ack bookkeeping failed:", err);
	});
}
