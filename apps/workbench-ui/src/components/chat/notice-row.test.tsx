import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NoticePart } from "../../chat/message-types";
import { isNotice, NoticeRow } from "./notice-row";

// vitest globals are off in this package, so testing-library does not clean
// up between tests on its own — without this the next render finds two
// role="status" elements.
afterEach(cleanup);

const denial: NoticePart = {
	type: "notice",
	severity: "warning",
	label: "Permission denied for Bash",
	body: "Command writes outside the workspace",
};

describe("NoticeRow", () => {
	it("renders the provider's reason as an operator-facing strip", () => {
		render(<NoticeRow notice={denial} />);
		const strip = screen.getByRole("status");
		expect(strip).toHaveAttribute("data-severity", "warning");
		expect(strip).toHaveTextContent("Permission denied for Bash");
		expect(
			screen.getByText("Command writes outside the workspace"),
		).toBeInTheDocument();
	});

	it("renders an info notice without the warning styling and omits an empty body", () => {
		render(
			<NoticeRow
				notice={{ type: "notice", severity: "info", label: "Hint" }}
			/>,
		);
		expect(screen.getByRole("status")).toHaveAttribute("data-severity", "info");
		expect(screen.getByRole("status")).toHaveTextContent("Hint");
		expect(
			screen.queryByText("Command writes outside the workspace"),
		).not.toBeInTheDocument();
	});

	it("rejects unrelated or malformed data payloads", () => {
		expect(isNotice(denial)).toBe(true);
		for (const value of [
			null,
			{},
			{ type: "text", text: "not a notice" },
			{ ...denial, severity: "fatal" },
			{ ...denial, label: 42 },
			{ ...denial, body: 7 },
		]) {
			expect(isNotice(value)).toBe(false);
		}
	});

	it("is interactive-free: nothing in the strip swallows clicks meant for the message", () => {
		const { container } = render(<NoticeRow notice={denial} />);
		expect(container.querySelectorAll("button")).toHaveLength(0);
		fireEvent.click(screen.getByRole("status"));
	});
});
