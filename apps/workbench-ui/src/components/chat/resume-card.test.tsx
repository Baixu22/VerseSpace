/**
 * 恢复卡交互（TF-0128/TF-0151 的 UI 面）：分支行的「查看分支」是
 * resume_branch_opened 记账探针的 UI 源头（先记再切），dismiss/reveal
 * 决定恢复卡下一轮是否注入，「及另 N 条」是超预算折叠不静默丢弃的
 * UI 镜像。这些手势此前零测试——它们错，租户样本和样本窗口就跟着错。
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../auth";
import {
	type ResumeCardFactRow,
	type ResumeCardView,
	type ThreadMeta,
	useChatStore,
} from "../../chat/store";
import { TooltipProvider } from "../ui/tooltip";
import { ResumeCard } from "./resume-card";

vi.mock("../../auth", () => ({
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

function thread(id: string, title: string): ThreadMeta {
	return {
		id,
		title,
		createdAt: "2026-09-06T00:00:00.000Z",
		status: "idle",
		permissionMode: "default",
	};
}

interface RecordedCall {
	path: string;
	method: string;
	body: Record<string, unknown> | null;
}

function installRoutes(): Array<RecordedCall> {
	const calls: Array<RecordedCall> = [];
	apiFetchMock.mockImplementation(async (input, init) => {
		const method = (init?.method ?? "GET").toUpperCase();
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: null;
		calls.push({ path: input, method, body });
		if (input === "/api/chat/threads/branch-1") {
			return jsonResponse({
				meta: thread("branch-1", "分支线程"),
				messages: [],
				suggestions: [],
				decisionPoints: [],
				resumeNote: null,
			});
		}
		return jsonResponse({ ok: true });
	});
	return calls;
}

const BRANCH_FACT: ResumeCardFactRow = {
	path: "src/alpha.ts",
	summary: "分支上被改写",
	refs: ["evt-forked-1", "evt-premise-1"],
	source: "branch",
	branch: {
		threadId: "branch-1",
		anchorMessageId: "m-1",
		paths: ["src/alpha.ts"],
		newForks: 0,
	},
	annotation: { rule: "R10", label: "兄弟分支在你离开后改写了它" },
};

function readSetFact(path: string): ResumeCardFactRow {
	return {
		path,
		summary: "离开后已被别人改写",
		refs: [`evt-${path}`],
		source: "read-set",
		annotation: { rule: "R4", label: "文件已删" },
	};
}

function cardWith(facts: Array<ResumeCardFactRow>): ResumeCardView {
	return {
		coverage: { status: "available", text: "已比对 3 个前提，覆盖 2 个工具" },
		narrative: [
			{ kind: "doing", text: "正在实现恢复卡 R10", refs: ["evt-n1"] },
		],
		facts,
		dismissed: false,
		inject: true,
		factsPreviewCount: 3,
	};
}

/** 用例间清场：zustand 是模块级单例。 */
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

function seedCard(card: ResumeCardView): void {
	useChatStore.setState({
		threads: [thread("thread-1", "源线程"), thread("branch-1", "分支线程")],
		activeId: "thread-1",
		resumeCard: card,
	});
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

describe("ResumeCard 交互", () => {
	it("R10 分支行：先记 resume_branch_opened（记在源线程）再切换到分支", async () => {
		const calls = installRoutes();
		seedCard(cardWith([BRANCH_FACT]));

		render(<ResumeCard />, { wrapper: TooltipProvider });
		screen.getByText("查看分支").click();

		await waitFor(() => {
			expect(useChatStore.getState().activeId).toBe("branch-1");
		});
		const record = calls.find(
			(c) =>
				c.path === "/api/chat/threads/thread-1/resume-action" &&
				c.body?.action === "resume_branch_opened",
		);
		expect(record).toBeDefined();
		const leave = calls.findIndex(
			(c) => c.path === "/api/chat/threads/thread-1/leave",
		);
		const switchCall = calls.findIndex(
			(c) => c.path === "/api/chat/threads/branch-1/switch",
		);
		expect(calls.indexOf(record!)).toBeLessThan(switchCall);
		expect(leave).toBeGreaterThanOrEqual(0);
		// 循环守卫与 App.test.tsx 同源：手势路径不许把 React 打进 #185。
		expect(
			consoleErrors.filter((m) => /Maximum update depth|#185/.test(m)),
		).toEqual([]);
	});

	it("R10 记账请求较慢时仍等待完成后才切换", async () => {
		const calls = installRoutes();
		let releaseRecord!: () => void;
		const recordReady = new Promise<void>((resolve) => {
			releaseRecord = resolve;
		});
		apiFetchMock.mockImplementation(async (input, init) => {
			const method = (init?.method ?? "GET").toUpperCase();
			const body = init?.body
				? (JSON.parse(String(init.body)) as Record<string, unknown>)
				: null;
			calls.push({ path: input, method, body });
			if (input.endsWith("/resume-action")) {
				await recordReady;
			}
			if (input === "/api/chat/threads/branch-1") {
				return jsonResponse({
					meta: thread("branch-1", "分支线程"),
					messages: [],
					suggestions: [],
					decisionPoints: [],
					resumeNote: null,
				});
			}
			return jsonResponse({ ok: true });
		});
		seedCard(cardWith([BRANCH_FACT]));

		render(<ResumeCard />, { wrapper: TooltipProvider });
		screen.getByText("查看分支").click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls.some((call) => call.path.endsWith("/switch"))).toBe(false);

		releaseRecord();
		await waitFor(() => {
			expect(useChatStore.getState().activeId).toBe("branch-1");
		});
		const recordIndex = calls.findIndex((call) =>
			call.path.endsWith("/resume-action"),
		);
		const switchIndex = calls.findIndex((call) =>
			call.path.endsWith("/switch"),
		);
		expect(recordIndex).toBeGreaterThanOrEqual(0);
		expect(switchIndex).toBeGreaterThan(recordIndex);
	});

	it("收起写 dismiss 且卡片消失；dismissed + revealed 复显仍在", async () => {
		installRoutes();
		seedCard(cardWith([BRANCH_FACT]));

		const view = render(<ResumeCard />, { wrapper: TooltipProvider });
		screen.getByRole("button", { name: "收起" }).click();

		await waitFor(() => {
			expect(useChatStore.getState().resumeCardDismissed).toBe(true);
		});
		expect(view.container.querySelector("li")).toBeNull();

		// 用户点回来（reveal）时 dismissed 不再吞掉卡片
		useChatStore.setState({
			resumeCardDismissed: true,
			resumeCardRevealed: true,
		});
		view.rerender(<ResumeCard />);
		expect(screen.getByText("查看分支")).toBeTruthy();
	});

	it("事实预览只展示前三条，『及另 N 条』展开全部并记 consume(facts)", async () => {
		const calls = installRoutes();
		seedCard(
			cardWith([
				readSetFact("src/a.ts"),
				readSetFact("src/b.ts"),
				readSetFact("src/c.ts"),
				readSetFact("src/d.ts"),
				BRANCH_FACT,
			]),
		);

		render(<ResumeCard />, { wrapper: TooltipProvider });
		expect(screen.getByText("src/a.ts")).toBeTruthy();
		expect(screen.queryByText("src/d.ts")).toBeNull();
		screen.getByText("及另", { exact: false }).click();

		await waitFor(() => {
			expect(screen.getByText("src/d.ts")).toBeTruthy();
		});
		expect(
			calls.some(
				(c) =>
					c.path === "/api/chat/threads/thread-1/resume-note/consume" &&
					c.body?.surface === "facts",
			),
		).toBe(true);
	});

	it("事实行只在展开时记 resume_fact_opened，收起不重复记账", async () => {
		const calls = installRoutes();
		seedCard(cardWith([readSetFact("src/a.ts")]));

		render(<ResumeCard />, { wrapper: TooltipProvider });
		const disclosure = screen.getByRole("button", { name: /src\/a\.ts/ });
		disclosure.click();
		await waitFor(() => {
			expect(screen.getByText("diff 未保留；版本证据仍可核对。")).toBeTruthy();
		});
		disclosure.click();

		await waitFor(() => {
			expect(
				calls.filter(
					(c) =>
						c.path === "/api/chat/threads/thread-1/resume-action" &&
						c.body?.action === "resume_fact_opened",
				),
			).toHaveLength(1);
		});
	});

	it("无恢复卡时一个节点都不渲染", () => {
		installRoutes();
		const view = render(<ResumeCard />, { wrapper: TooltipProvider });
		expect(view.container.firstChild).toBeNull();
	});
});
