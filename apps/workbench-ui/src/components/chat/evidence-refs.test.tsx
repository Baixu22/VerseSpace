import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../auth";
import { useChatStore } from "../../chat/store";
import { TooltipProvider } from "../ui/tooltip";
import { EvidenceRefs } from "./evidence-refs";

vi.mock("../../auth", () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
const response = (data: unknown) =>
	({ ok: true, json: async () => data }) as Response;
beforeEach(() => {
	useChatStore.setState({ activeId: "source" });
	api.mockResolvedValue(response({ ok: true }));
});
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
	useChatStore.setState({ activeId: null });
});

describe("可点击的恢复证据", () => {
	it("点击才请求原始来源，展开记一次动作，关闭不重复记账", async () => {
		api.mockImplementation(async (url) =>
			response(
				url.includes("/evidence?")
					? {
							title: "原始用户消息",
							content: "原始内容",
							kind: "message",
							truncated: true,
						}
					: { ok: true },
			),
		);
		render(<EvidenceRefs refs={["message:question"]} />, {
			wrapper: TooltipProvider,
		});
		expect(api).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "消息" }));
		await screen.findByText("原始内容");
		expect(screen.getByText(/仅展示前/)).toBeTruthy();
		expect(
			api.mock.calls.some(
				([url]) =>
					url === "/api/chat/threads/source/evidence?ref=message%3Aquestion",
			),
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "消息" }));
		expect(screen.queryByRole("region", { name: "证据内容" })).toBeNull();
		expect(
			api.mock.calls.filter(([url]) => url.endsWith("/resume-action")),
		).toHaveLength(1);
	});

	it("切换线程后迟到的来源不能显示在新线程", async () => {
		let release!: (value: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			release = resolve;
		});
		api.mockImplementation(async (url) =>
			url.includes("/evidence?") ? pending : response({ ok: true }),
		);
		render(<EvidenceRefs refs={["event-1"]} />, { wrapper: TooltipProvider });
		fireEvent.click(screen.getByRole("button", { name: "事件 1" }));
		await waitFor(() =>
			expect(api.mock.calls.some(([url]) => url.includes("/evidence?"))).toBe(
				true,
			),
		);
		act(() => useChatStore.setState({ activeId: "other" }));
		await act(async () =>
			release(
				response({
					title: "旧来源",
					content: "不应串线",
					kind: "event",
					truncated: false,
				}),
			),
		);
		expect(screen.queryByText("不应串线")).toBeNull();
		expect(screen.queryByRole("region", { name: "证据内容" })).toBeNull();
	});

	it("缺失引用展示原因，失败请求也可关闭后重试", async () => {
		api.mockImplementation(async (url) =>
			url.includes("/evidence?")
				? ({ ok: false, status: 503 } as Response)
				: response({ ok: true }),
		);
		render(<EvidenceRefs refs={["legacy:doing"]} />, {
			wrapper: TooltipProvider,
		});
		const button = screen.getByRole("button", { name: "旧版笔记" });
		fireEvent.click(button);
		await screen.findByRole("alert");
		fireEvent.click(button);
		api.mockImplementation(async (url) =>
			response(
				url.includes("/evidence?")
					? {
							title: "来源暂不可用",
							content: "没有保存原始引用",
							kind: "unavailable",
							truncated: false,
						}
					: { ok: true },
			),
		);
		fireEvent.click(button);
		await screen.findByText("没有保存原始引用");
	});
});
