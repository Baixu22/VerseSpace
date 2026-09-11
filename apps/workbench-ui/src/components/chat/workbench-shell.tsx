import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Command, HardDrive, PanelLeft, Settings2 } from "@/components/icon";
import { chatConfigQuery } from "../../chat/config";
import { useChatStore } from "../../chat/store";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetTrigger } from "../ui/sheet";
import { Tooltip } from "../ui/tooltip";
import { SettingsPanel } from "./settings";
import { ChatThread } from "./thread";
import { ThreadListSidebar } from "./thread-list";

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
	const { data: config } = useQuery(chatConfigQuery);
	return (
		<>
			<ThreadListSidebar onNavigate={onNavigate} />
			<div className="shrink-0 space-y-2 border-t border-border-subtle px-4 py-4">
				<p className="truncate font-mono text-small text-fg-muted">
					{config
						? config.provider + (config.model ? ` · ${config.model}` : "")
						: "正在连接…"}
				</p>
				<p className="flex items-center gap-1.5 text-small text-fg-subtle">
					<HardDrive className="size-3" /> 对话保存在本机
				</p>
			</div>
		</>
	);
}

function MobileSidebar() {
	const [open, setOpen] = useState(false);
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<Tooltip content="打开对话列表" side="bottom">
				<SheetTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						aria-label="打开对话列表"
						className="md:hidden"
					>
						<PanelLeft />
					</Button>
				</SheetTrigger>
			</Tooltip>
			<SheetContent
				side="left"
				title="Workbench"
				description="你的对话与思路，都在这里。"
			>
				<SidebarContent onNavigate={() => setOpen(false)} />
			</SheetContent>
		</Sheet>
	);
}

function ChatHeader() {
	const activeThread = useChatStore((state) =>
		state.threads.find((thread) => thread.id === state.activeId),
	);
	const running = useChatStore(
		(state) =>
			state.activeId !== null && state.runningThreadId === state.activeId,
	);
	return (
		<header className="flex h-16 shrink-0 items-center gap-3 border-b border-border-subtle px-4 sm:px-6">
			<MobileSidebar />
			<div className="min-w-0 flex-1">
				<h1 className="truncate text-title font-medium">
					{activeThread?.title || "新对话"}
				</h1>
				<p
					className="mt-0.5 flex items-center gap-1.5 text-small text-fg-muted"
					role="status"
				>
					<span
						className={
							"size-1.5 rounded-full " +
							(running ? "bg-status-info" : "bg-fg-subtle")
						}
					/>
					{running ? "正在回复…" : "准备就绪"}
				</p>
			</div>
			<Sheet>
				<Tooltip content="对话设置" side="bottom">
					<SheetTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							aria-label="设置"
							className="text-fg-muted"
						>
							<Settings2 />
						</Button>
					</SheetTrigger>
				</Tooltip>
				<SheetContent
					title="对话设置"
					description="选择模型，调整适合你的回答方式。"
				>
					<SettingsPanel />
				</SheetContent>
			</Sheet>
		</header>
	);
}

export function WorkbenchShell() {
	return (
		<div className="flex h-dvh min-w-0 overflow-hidden">
			<aside
				aria-label="对话列表"
				className="hidden w-64 shrink-0 flex-col border-r border-border-subtle bg-bg-surface md:flex xl:w-[17rem]"
			>
				<div className="flex h-16 shrink-0 items-center gap-2.5 px-4">
					<span className="flex size-8 items-center justify-center rounded-lg border border-border bg-bg-elevated">
						<Command className="size-4 text-fg-muted" />
					</span>
					<span className="text-title font-semibold tracking-tight">
						Workbench
					</span>
				</div>
				<SidebarContent />
			</aside>
			<main className="flex min-h-0 min-w-0 flex-1 flex-col">
				<ChatHeader />
				<ChatThread />
			</main>
		</div>
	);
}
