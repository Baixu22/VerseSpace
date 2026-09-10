import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatRuntimeAdapter } from "../../chat/adapter";
import type { ThreadMeta } from "../../chat/store";
import { useChatStore } from "../../chat/store";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadListSidebar } from "./thread-list";

vi.mock("../../auth", () => ({ apiFetch: vi.fn() }));

function thread(
	id: string,
	title: string,
	forkOf?: ThreadMeta["forkOf"],
): ThreadMeta {
	return {
		id,
		title,
		createdAt: "2026-09-08T00:00:00.000Z",
		status: "idle",
		permissionMode: "default",
		forkOf,
	};
}

function Harness() {
	const runtime = useChatRuntimeAdapter();
	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<TooltipProvider>
				<ThreadListSidebar />
			</TooltipProvider>
		</AssistantRuntimeProvider>
	);
}

function reset() {
	useChatStore.setState({
		threads: [],
		activeId: null,
		messages: {},
		runningThreadId: null,
		forkNotice: null,
		suggestions: [],
		decisionPoints: [],
		drafts: {},
		parked: {},
		resumeNote: null,
		resumeDelta: 0,
		readSetDiff: null,
		resumeCard: null,
		resumeCardDismissed: false,
		resumeCardRevealed: false,
	});
}

afterEach(reset);

describe("ThreadListSidebar 血统表达", () => {
	it("fork 与源保持同级，hover 只做临时软高亮", async () => {
		useChatStore.setState({
			activeId: "source",
			threads: [
				thread("source", "源线程"),
				thread("fork", "接力线程", {
					sourceThreadId: "source",
					sourceTitle: "源线程",
					anchorMessageId: "m-1",
					inheritedMessages: 4,
					at: "2026-09-08T00:01:00.000Z",
				}),
			],
		});
		render(<Harness />);

		expect(screen.getByText("继承 4")).toBeInTheDocument();
		const source = screen.getByText("源线程").closest("[data-lineage-id]");
		const fork = screen.getByText("接力线程").closest("[data-lineage-id]");
		expect(source?.parentElement).toBe(fork?.parentElement);

		fireEvent.pointerEnter(fork!);
		await waitFor(() => {
			expect(source?.querySelector(".ring-accent-default\\/30")).toBeTruthy();
			expect(fork?.querySelector(".ring-accent-default\\/30")).toBeTruthy();
		});
		fireEvent.pointerLeave(fork!);
		await waitFor(() => {
			expect(source?.querySelector(".ring-accent-default\\/30")).toBeNull();
		});
	});
});
