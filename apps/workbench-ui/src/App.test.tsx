/**
 * 首屏渲染冒烟（回归守护）：thread-list.tsx 曾在 zustand selector 里派生
 * 新对象，getSnapshot 不缓存，首次挂载就把 React 打进 #185（Maximum
 * update depth）死循环（e3be9c5 修复）。这里以真实 <App/> 挂载到 #root +
 * console 哨兵守住该回归面——循环在零线程时同样会炸，所以空态也是用例。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { apiFetch } from "./auth";
import { useChatStore } from "./chat/store";

vi.mock("./auth", () => ({
	apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

function jsonResponse(data: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => data,
	} as unknown as Response;
}

const THREAD = {
	id: "thread-1",
	title: "首个线程",
	createdAt: "2026-09-06T00:00:00.000Z",
	status: "idle",
	permissionMode: "default",
};

interface RecordedCall {
	url: string;
	method: string;
}

function installRoutes(threads: Array<typeof THREAD>): Array<RecordedCall> {
	const calls: Array<RecordedCall> = [];
	apiFetchMock.mockImplementation(async (input, init) => {
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push({ url: input, method });
		if (input === "/api/config/chat") {
			return jsonResponse({ provider: "openai-chat", model: "test-model" });
		}
		if (input === "/api/chat/threads" && method === "GET") {
			return jsonResponse(threads);
		}
		if (input === "/api/chat/threads/thread-1" && method === "GET") {
			return jsonResponse({
				meta: THREAD,
				messages: [],
				suggestions: [],
				decisionPoints: [],
				resumeNote: null,
			});
		}
		// switch / restore 等生命周期 POST：fire-and-forget，只返回 ok
		return jsonResponse({ ok: true });
	});
	return calls;
}

/** zustand 是模块级单例：用例间清场，避免上一例的线程泄进下一例。 */
function resetChatStore(): void {
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

/** React #185 的两种报法：update depth 超限与 getSnapshot 未缓存。 */
function expectNoRenderLoopErrors(): void {
	const loop = consoleErrors.filter((message) =>
		/Maximum update depth|getSnapshot should be cached|#185/.test(message),
	);
	expect(loop).toEqual([]);
}

let consoleErrors: Array<string> = [];

beforeEach(() => {
	consoleErrors = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		consoleErrors.push(args.map((a) => String(a)).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	cleanup();
	resetChatStore();
});

/** 镜像 main.tsx：StrictMode（双挂载正是 #185 的引爆面）+ #root 容器。 */
function mountApp(): HTMLElement {
	const root = document.createElement("div");
	root.id = "root";
	document.body.appendChild(root);
	const queryClient = new QueryClient();
	render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<App />
			</QueryClientProvider>
		</StrictMode>,
		{ container: root },
	);
	return root;
}

describe("App 首屏渲染", () => {
	it("空线程列表：#root 渲染出骨架，无 React #185 死循环", async () => {
		const calls = installRoutes([]);

		const root = mountApp();

		await waitFor(() => {
			expect(calls.some((c) => c.url === "/api/chat/threads")).toBe(true);
		});
		expect(screen.getByText("新对话")).toBeInTheDocument();
		expect(screen.getByText(/workbench runtime 承载/)).toBeInTheDocument();
		expect(root.children.length).toBeGreaterThan(0);
		expectNoRenderLoopErrors();
	});

	it("带一个线程：线程列表与切换手势齐全，无 React #185 死循环", async () => {
		const calls = installRoutes([THREAD]);

		const root = mountApp();

		await waitFor(() => {
			expect(screen.getByText("首个线程")).toBeInTheDocument();
		});
		await waitFor(() => {
			expect(
				calls.some((c) => c.url === "/api/chat/threads/thread-1/switch"),
			).toBe(true);
		});
		expect(
			calls.some((c) => c.url === "/api/chat/threads/thread-1/restore"),
		).toBe(true);
		expect(screen.getByText("openai-chat · test-model")).toBeInTheDocument();
		expect(root.children.length).toBeGreaterThan(0);
		expectNoRenderLoopErrors();
	});
});
