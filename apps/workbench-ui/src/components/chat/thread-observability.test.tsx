import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThreadMeta } from "../../chat/store";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadObservability } from "./thread-observability";

function thread(extra: Partial<ThreadMeta>): ThreadMeta {
	return {
		id: "t1",
		title: "线程",
		createdAt: "2026-09-18T00:00:00.000Z",
		status: "idle",
		permissionMode: "default",
		...extra,
	};
}

function mount(meta: ThreadMeta) {
	return render(
		<TooltipProvider>
			<ThreadObservability thread={meta} />
		</TooltipProvider>,
	);
}

describe("ThreadObservability（TF-0191）", () => {
	it("从未运行过的线程不渲染任何东西", () => {
		const { container } = mount(thread({}));
		expect(container).toBeEmptyDOMElement();
	});

	it("claude 轮次可观测：不加标签", () => {
		const { container } = mount(
			thread({
				lastRun: {
					provider: "claude",
					readObservability: "footprint",
					at: "2026-09-18T00:00:00.000Z",
				},
			}),
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("HTTP 轮次不可观测：标注 provider 与「不参与前提继承」", () => {
		mount(
			thread({
				lastRun: {
					provider: "openai-chat",
					readObservability: "unobservable",
					at: "2026-09-18T00:00:00.000Z",
				},
			}),
		);
		expect(screen.getByTestId("thread-unobservable")).toHaveTextContent(
			"openai-chat · 读集不可观测，不参与前提继承",
		);
	});

	it("分叉继承两个开关分开写；全为 true 时不渲染", () => {
		const { container, unmount } = mount(
			thread({
				forkInheritance: {
					transcriptInherited: true,
					agentContextInherited: true,
					premiseInherited: true,
				},
			}),
		);
		expect(container).toBeEmptyDOMElement();
		unmount();

		mount(
			thread({
				forkInheritance: {
					transcriptInherited: true,
					agentContextInherited: true,
					premiseInherited: false,
				},
			}),
		);
		expect(screen.getByTestId("thread-inheritance")).toHaveTextContent(
			"继承：agent 上下文 是 · 前提 否",
		);
	});
});

it("codex stays visibly experimental even when a footprint was captured", () => {
	mount(
		thread({
			lastRun: {
				provider: "codex",
				readObservability: "footprint",
				at: "2026-09-26T00:00:00.000Z",
			},
		}),
	);
	expect(screen.getByTestId("thread-codex-experimental")).toHaveTextContent(
		"写保护未验证",
	);
});
