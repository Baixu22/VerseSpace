import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatStore } from "../../chat/store";
import { TooltipProvider } from "../ui/tooltip";
import { NoticeDelivered } from "./notice-delivered";
import { PromoteThread } from "./promote-thread";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	useChatStore.setState(useChatStore.getInitialState(), true);
});

it("送达数量可见且十秒后收起", () => {
	vi.useFakeTimers();
	useChatStore.setState({
		noticesDelivered: { count: 2, at: new Date().toISOString() },
	});
	render(
		<TooltipProvider>
			<NoticeDelivered />
		</TooltipProvider>,
	);
	expect(screen.getByRole("status").textContent).toContain(
		"已向 agent 送达 2 条前提通知",
	);
	act(() => {
		vi.advanceTimersByTime(10_000);
	});
	expect(useChatStore.getState().noticesDelivered).toBeNull();
});

it("命名失败显示可重试反馈", async () => {
	const promote = vi.fn().mockRejectedValue(new Error("request failed"));
	useChatStore.setState({ canPromote: true, promoteActive: promote });
	render(
		<TooltipProvider>
			<PromoteThread />
		</TooltipProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "命名" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"命名失败，请重试",
	);
	expect(promote).toHaveBeenCalledOnce();
	expect(screen.getByRole("button", { name: "命名" })).toHaveProperty(
		"disabled",
		false,
	);
});
