import { useState } from "react";
import { Tag } from "@/components/icon";
import { useChatStore } from "../../chat/store";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

/** One gesture names an unnamed conversation using its first message. */
export function PromoteThread() {
	const canPromote = useChatStore((state) => state.canPromote);
	const promote = useChatStore((state) => state.promoteActive);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState(false);
	if (!canPromote) return null;
	return (
		<div className="flex shrink-0 flex-col items-end gap-1">
			<Tooltip content="用第一条消息为对话命名" side="bottom">
				<Button
					variant="ghost"
					size="xs"
					className="text-fg-muted"
					disabled={pending}
					onClick={async () => {
						setPending(true);
						setError(false);
						try {
							await promote();
						} catch {
							setError(true);
						} finally {
							setPending(false);
						}
					}}
				>
					<Tag className="size-3" />
					{pending ? "命名中…" : "命名"}
				</Button>
			</Tooltip>
			{error ? (
				<span role="alert" className="text-small text-status-danger">
					命名失败，请重试
				</span>
			) : null}
		</div>
	);
}
