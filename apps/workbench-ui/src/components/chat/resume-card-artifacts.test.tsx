import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ArtifactReviewProjectionItem,
	ArtifactReviewProjectionView,
	ArtifactReviewStatus,
} from "../../chat/resume-types";
import { type ResumeCardView, useChatStore } from "../../chat/store";
import { TooltipProvider } from "../ui/tooltip";
import { ResumeCard } from "./resume-card";

const CARD: ResumeCardView = {
	coverage: { status: "unknown", text: "没有可比较的文件记录" },
	narrative: [],
	facts: [],
	dismissed: false,
	inject: true,
	factsPreviewCount: 3,
};

function item(
	status: ArtifactReviewStatus,
	index: number,
): ArtifactReviewProjectionItem {
	return {
		rootId: `root-${status}`,
		checkpointId: `cp-${status}`,
		path: `dist/${status}.json`,
		status,
		reason:
			status === "unknown"
				? "所选历史输入来源不是完整工具观察；目标适用性未知"
				: `artifact ${status}`,
		targetStatus: status === "stale" ? "inputs-differ" : "unknown",
		evidenceStrength:
			status === "current" ? "observed-origin-and-scope" : "unknown",
		refs: [`evt-${index}`],
		revalidateCommand: `workbench checkpoint revalidate cp-${status}`,
		facts: {
			origin: {
				strength: status === "unknown" ? "fs-sample" : "tool-observed",
				reason: status === "unknown" ? "文件采样" : "工具观察",
			},
			inputs: {
				status:
					status === "stale"
						? "different"
						: status === "unknown"
							? "unknown"
							: "matched",
				total: 1,
				changedTotal: status === "stale" ? 1 : 0,
				previewTruncated: false,
				changed: status === "stale" ? ["api.txt"] : [],
				versions: [{ path: "api.txt", hash: "a".repeat(64) }],
			},
			verification: {
				checkpointId: `cp-${status}`,
				result:
					status === "failed"
						? "failed"
						: status === "unknown"
							? null
							: "passed",
				scope: status === "unknown" ? "unknown" : "satisfied",
				authority: status === "unknown" ? "unknown" : "command",
				at: null,
			},
		},
		target: {
			status: status === "stale" ? "inputs-differ" : "unknown",
			change: status === "stale" ? "revalidation-required" : "unknown",
			ref: status === "unknown" ? null : "main",
			checkedCommit: status === "unknown" ? null : "1".repeat(40),
			currentCommit: status === "unknown" ? null : "2".repeat(40),
		},
	};
}

function projection(
	statuses: ArtifactReviewStatus[],
): ArtifactReviewProjectionView {
	const counts = {
		current: 0,
		stale: 0,
		pending: 0,
		failed: 0,
		unknown: 0,
	};
	for (const status of statuses) counts[status]++;
	return {
		schemaVersion: 1,
		total: statuses.length,
		counts,
		items: statuses.map(item),
		omitted: 0,
		truncated: false,
	};
}

function reset() {
	useChatStore.setState({
		activeId: "thread-1",
		resumeCard: null,
		resumeCardDismissed: false,
		resumeCardRevealed: false,
		artifactReviews: null,
	});
}

afterEach(() => {
	cleanup();
	reset();
	vi.restoreAllMocks();
});

describe("ResumeArtifactRows", () => {
	it("renders an artifact-only restore card with all five honest statuses", () => {
		reset();
		useChatStore.setState({
			artifactReviews: projection([
				"current",
				"stale",
				"pending",
				"failed",
				"unknown",
			]),
		});
		render(<ResumeCard />, { wrapper: TooltipProvider });
		expect(screen.getByRole("region", { name: "恢复卡" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "产物检查" })).toBeTruthy();
		expect(screen.getByText("检查当前")).toBeTruthy();
		expect(screen.getByText("需要重验")).toBeTruthy();
		expect(screen.getByText("等待检查")).toBeTruthy();
		expect(screen.getAllByText("检查失败").length).toBeGreaterThan(0);
		expect(screen.getByText("无法确认")).toBeTruthy();
		expect(screen.getAllByText("仅有文件采样").length).toBeGreaterThan(0);
		expect(screen.getAllByText("目标未知").length).toBeGreaterThan(0);
		expect(screen.queryByText("当前可用")).toBeNull();
	});

	it("copies the existing CLI command without changing the stale projection", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		reset();
		useChatStore.setState({ artifactReviews: projection(["stale"]) });
		render(<ResumeCard />, { wrapper: TooltipProvider });
		const button = screen.getByRole("button", {
			name: /复制 dist\/stale\.json 的重验命令/,
		});
		button.click();
		await waitFor(() => {
			expect(writeText).toHaveBeenCalledWith(
				"workbench checkpoint revalidate cp-stale",
			);
		});
		expect(useChatStore.getState().artifactReviews?.items[0]?.status).toBe(
			"stale",
		);
		expect(screen.getByText("查看或复制不会清除待重验状态")).toBeTruthy();
	});

	it("keeps the existing read-set card when artifact projection is empty", () => {
		reset();
		useChatStore.setState({
			resumeCard: CARD,
			artifactReviews: projection([]),
		});
		render(<ResumeCard />, { wrapper: TooltipProvider });
		expect(screen.getByRole("region", { name: "恢复卡" })).toBeTruthy();
		expect(screen.queryByRole("region", { name: "产物检查" })).toBeNull();
		expect(screen.getByText("尚无可比较的文件记录。")).toBeTruthy();
	});
});
