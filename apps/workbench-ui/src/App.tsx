import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { useChatRuntimeAdapter } from "./chat/adapter";
import { useChatStore } from "./chat/store";
import { type ChatConfig, SettingsPanel } from "./components/chat/settings";
import { ChatThread } from "./components/chat/thread";
import { ThreadListSidebar } from "./components/chat/thread-list";
import { Button } from "./components/ui/button";

function ThreadSidebar() {
	const [config, setConfig] = useState<ChatConfig | null>(null);
	const [showSettings, setShowSettings] = useState(false);
	useEffect(() => {
		void fetch("/api/config/chat")
			.then((r) => r.json() as Promise<ChatConfig>)
			.then(setConfig);
	}, []);

	return (
		<aside className="flex w-64 shrink-0 flex-col border-r border-border bg-bg-surface">
			<div className="flex items-center gap-2 px-4 py-3">
				<span className="text-title font-semibold tracking-wide">
					Workbench
				</span>
				<Button
					size="xs"
					variant="ghost"
					className="ml-auto"
					title="对话设置（提供商 / 模型 / 强度）"
					onClick={() => setShowSettings(true)}
				>
					设置
				</Button>
			</div>
			<ThreadListSidebar />
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
