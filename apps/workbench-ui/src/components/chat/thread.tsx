import { ThreadPrimitive } from "@assistant-ui/react";
import { MessageSquare } from "lucide-react";
import { ChatComposer } from "./chat-composer";
import { AssistantMessage, UserMessage } from "./thread-messages";
import { ForkNotice } from "./thread-notices";

export function ChatThread() {
	return (
		<ThreadPrimitive.Root className="relative flex min-h-0 min-w-0 flex-1 flex-col">
			<ForkNotice />
			<ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6 sm:py-8">
				<div className="mx-auto min-h-full w-full max-w-3xl space-y-7">
					<ThreadPrimitive.Empty>
						<div className="flex min-h-[45dvh] flex-col items-center justify-center gap-3 px-4 text-center">
							<div className="mb-1 flex size-12 items-center justify-center rounded-2xl border border-border-subtle bg-bg-surface">
								<MessageSquare className="size-5 text-fg-muted" />
							</div>
							<h2 className="text-heading font-medium tracking-tight">
								从一个想法开始
							</h2>
							<p className="max-w-sm text-body leading-relaxed text-fg-muted">
								讨论问题、整理思路，或一起推进下一步。
							</p>
						</div>
					</ThreadPrimitive.Empty>
					<ThreadPrimitive.Messages>
						{({ message }) =>
							message.role === "user" ? (
								<UserMessage messageId={message.id} />
							) : (
								<AssistantMessage messageId={message.id} />
							)
						}
					</ThreadPrimitive.Messages>
				</div>
			</ThreadPrimitive.Viewport>
			<ChatComposer />
		</ThreadPrimitive.Root>
	);
}
