import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CollapsedGroupPart } from "../../chat/message-types";
import { CollapsedToolGroup, isCollapsedGroup } from "./collapsed-tool-group";

const group: CollapsedGroupPart = {
	type: "collapsed-group",
	id: "group:read-1",
	category: "read",
	active: true,
	summary: "读取中 2 个文件…",
	tools: [
		{
			type: "tool-call",
			toolCallId: "read-1",
			toolName: "Read",
			args: { file_path: "one.ts" },
			result: "first file contents",
		},
		{
			type: "tool-call",
			toolCallId: "read-2",
			toolName: "Read",
			args: { file_path: "two.ts" },
		},
	],
};

describe("CollapsedToolGroup", () => {
	it("starts as a summary; expands individual args/results and retains disclosure state on settlement", () => {
		const { rerender } = render(<CollapsedToolGroup group={group} />);
		const summary = screen.getByRole("button", { name: /读取中 2 个文件/ });
		expect(summary).toHaveAttribute("aria-expanded", "false");
		expect(summary).toHaveTextContent("2 个工具");
		expect(screen.getByRole("status")).toHaveAccessibleName("工具执行中");
		expect(screen.queryByText("first file contents")).not.toBeInTheDocument();
		fireEvent.click(summary);
		expect(summary).toHaveAttribute("aria-expanded", "true");
		const read = screen.getByRole("button", { name: /Read.*one.ts/ });
		fireEvent.click(read);
		expect(screen.getByText("first file contents")).toBeInTheDocument();
		expect(screen.getByText(/"file_path": "one.ts"/)).toBeInTheDocument();
		rerender(
			<CollapsedToolGroup
				group={{ ...group, active: false, summary: "读取 2 个文件" }}
			/>,
		);
		expect(screen.getByRole("status")).toHaveAccessibleName("工具组已结束");
		expect(
			screen.getByRole("button", { name: /读取 2 个文件/ }),
		).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("first file contents")).toBeInTheDocument();
	});

	it("preserves error results in reused tool cards", () => {
		render(
			<CollapsedToolGroup
				group={{
					...group,
					active: false,
					tools: [
						group.tools[0]!,
						{ ...group.tools[1]!, result: "permission denied", isError: true },
					],
				}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /读取中/ }));
		fireEvent.click(screen.getByRole("button", { name: /Read.*two.ts.*失败/ }));
		expect(screen.getByText("permission denied")).toBeInTheDocument();
	});

	it("rejects unrelated or malformed assistant-ui data parts", () => {
		expect(isCollapsedGroup(group)).toBe(true);
		for (const value of [
			null,
			{},
			{ ...group, tools: [null] },
			{ ...group, category: "unknown" },
			{ ...group, tools: [{ type: "text" }] },
		]) {
			expect(isCollapsedGroup(value)).toBe(false);
		}
	});
});
