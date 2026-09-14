import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { ClipboardCheck, X } from "@/components/icon";
import { useChatStore } from "../../chat/store";
import { TWEEN_FAST } from "../../lib/motion";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

/**
 * TF-0142 前提通知送达指示。
 *
 * 服务端在通知真正投进 agent 的那一轮发出 `notice_delivered` 流事件。
 * 在此之前客户端对它只有一句「显式跳过」——送达了但用户看不见，而前提通道
 * 正是这个产品的核心：用户必须能看见 agent 被提醒过。形态选在 composer 上方
 * 的安静层（与分叉提示同一层），短暂可见后自动消失，不打断对话。
 */
export function NoticeDelivered() {
	const delivered = useChatStore((s) => s.noticesDelivered);
	const dismiss = useChatStore((s) => s.dismissNoticeDelivered);
	useEffect(() => {
		if (!delivered) return;
		const timer = setTimeout(dismiss, 10_000);
		return () => clearTimeout(timer);
	}, [delivered, dismiss]);
	return (
		<AnimatePresence initial={false}>
			{delivered ? (
				<motion.div
					initial={{ y: -4, opacity: 0 }}
					animate={{ y: 0, opacity: 1 }}
					exit={{ y: -4, opacity: 0 }}
					transition={TWEEN_FAST}
					role="status"
					className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-bg-surface px-3 py-2 text-small text-fg-muted"
				>
					<ClipboardCheck className="mt-0.5 size-3.5 shrink-0 text-accent-default" />
					<span className="min-w-0 flex-1">
						已向 agent 送达 {delivered.count} 条前提通知
					</span>
					<Tooltip content="关闭送达提示">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="关闭送达提示"
							onClick={dismiss}
							className="text-fg-muted"
						>
							<X className="size-3" />
						</Button>
					</Tooltip>
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}
