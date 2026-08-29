import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { useChatRuntimeAdapter } from "./chat/adapter";
import { useChatStore } from "./chat/store";
import { type ChatConfig, SettingsPanel } from "./components/chat/settings";
import { ChatThread } from "./components/chat/thread";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

function ThreadSidebar() {
	const [config, setConfig] = useState<ChatConfig | null>(null);
	const [showSettings, setShowSettings] = useState(false);
	const threads = useChatStore((s) => s.threads);
	const activeId = useChatStore((s) => s.activeId);
	const runningThreadId = useChatStore((s) => s.runningThreadId);
	const createThread = useChatStore((s) => s.createThread);
	const switchThread = useChatStore((s) => s.switchThread);

	return (
		<aside className="flex w-64 shrink-0 flex-col border-r border-border bg-bg-surface">
			<div className="flex items-center gap-2 px-4 py-3">
				<span className="text-title font-semibold tracking-wide">
					Workbench
				</span>
				<Button
					size="xs"
					variant="outline"
					className="ml-auto"
					onClick={() => void createThread()}
				>
					新对话
				</Button>
			</div>
			<div className="flex-1 overflow-y-auto px-2 pb-3">
				{threads.length === 0 ? (
					<p className="px-2 py-4 text-small text-fg-subtle">还没有线程</p>
				) : (
					threads.map((thread) => (
						<button
							key={thread.id}
							type="button"
							onClick={() => void switchThread(thread.id)}
							className={cn(
								"flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-small hover:bg-muted",
								thread.id === activeId && "bg-muted",
							)}
						>
							<span
								className={cn(
									"size-1.5 shrink-0 rounded-full",
									runningThreadId === thread.id || thread.status === "running"
										? "bg-status-info"
										: "bg-fg-subtle/40",
								)}
							/>
							<span className="truncate">{thread.title}</span>
						</button>
					))
				)}
			</div>
			<div className="border-t border-border px-4 py-3">
				<p className="font-mono text-micro text-fg-muted">
					{config
						? `${config.provider}${config.model ? ` · ${config.model}` : ""}`
						: "runtime"}
				</p>
				<p className="text-micro text-fg-subtle">线程各自串行 · 线程间并行</p>
			</div>
			{showSettings ? (
				<SettingsPanel
					onClose={() => {
						setShowSettings(false);
						void fetch("/api/config/chat")
							.then((r) => r.json() as Promise<ChatConfig>)
							.then(setConfig);
					}}
				/>
			) : null}
		</aside>
	);
}

export default function App() {
	const runtime = useChatRuntimeAdapter();
	useEffect(() => {
		void useChatStore.getState().init();
	}, []);

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<div className="flex h-dvh">
				<ThreadSidebar />
				<ChatThread />
			</div>
		</AssistantRuntimeProvider>
	);
}
