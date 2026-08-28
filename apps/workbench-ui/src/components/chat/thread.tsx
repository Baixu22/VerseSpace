import {
	AuiIf,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
} from "@assistant-ui/react";
import { MarkdownText } from "./markdown-text";

function UserMessage() {
	return (
		<MessagePrimitive.Root className="flex justify-end">
			<div className="max-w-[80%] rounded-xl bg-primary px-4 py-2.5 text-body text-primary-foreground">
				<MessagePrimitive.Parts>
					{({ part }) =>
						part.type === "text" ? (
							<p className="whitespace-pre-wrap">{part.text}</p>
						) : null
					}
				</MessagePrimitive.Parts>
			</div>
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="flex flex-col gap-1">
			<div className="max-w-[92%] rounded-xl border border-border bg-bg-surface px-4 py-3">
				<MessagePrimitive.Parts>
					{({ part }) => (part.type === "text" ? <MarkdownText /> : null)}
				</MessagePrimitive.Parts>
			</div>
		</MessagePrimitive.Root>
	);
}

export function ChatThread() {
	return (
		<ThreadPrimitive.Root className="flex h-full min-w-0 flex-1 flex-col">
			<ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-6 py-4">
				<ThreadPrimitive.Empty>
					<div className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
						<p className="text-heading">Workbench</p>
						<p className="text-small">
							对话由 workbench runtime 承载——线程持久化在
							.workbench/，多线程并行互不阻塞
						</p>
					</div>
				</ThreadPrimitive.Empty>
				<ThreadPrimitive.Messages>
					{({ message }) =>
						message.role === "user" ? <UserMessage /> : <AssistantMessage />
					}
				</ThreadPrimitive.Messages>
			</ThreadPrimitive.Viewport>

			<ThreadPrimitive.ViewportFooter className="px-6 pb-5">
				<ComposerPrimitive.Root className="flex items-end gap-2 rounded-xl border border-border bg-bg-surface p-2.5">
					<ComposerPrimitive.Input
						rows={1}
						placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
						className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-body outline-none"
					/>
					<AuiIf condition={({ thread }) => thread.isRunning}>
						<ComposerPrimitive.Cancel className="h-8 rounded-lg border border-border px-3 text-small hover:bg-muted">
							停止
						</ComposerPrimitive.Cancel>
					</AuiIf>
					<AuiIf condition={({ thread }) => !thread.isRunning}>
						<ComposerPrimitive.Send className="h-8 rounded-lg bg-primary px-4 text-small text-primary-foreground disabled:opacity-50">
							发送
						</ComposerPrimitive.Send>
					</AuiIf>
				</ComposerPrimitive.Root>
				<p className="mt-1.5 text-center text-micro text-fg-subtle">
					由 workbench runtime 驱动 · 线程并行 · 会话持久化
				</p>
			</ThreadPrimitive.ViewportFooter>
		</ThreadPrimitive.Root>
	);
}
