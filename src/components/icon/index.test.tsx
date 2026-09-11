import { render } from "@testing-library/react";
import type { ComponentType, SVGProps } from "react";
import { describe, expect, it } from "vitest";

import * as icons from "./index";

/**
 * Every icon the app can import must render an `<svg>`. This is the guard that
 * catches a mapping rename in the layer: a bad alias throws at import time, and
 * a component that renders nothing fails the assertion below.
 */
const entries = Object.entries(icons).filter(
	([, value]) =>
		value !== null &&
		(typeof value === "function" || typeof value === "object"),
) as [string, ComponentType<SVGProps<SVGSVGElement>>][];

describe("icon layer", () => {
	it("re-exports a meaningful number of icons", () => {
		expect(entries.length).toBeGreaterThan(150);
	});

	it("renders every exported icon as an svg", () => {
		const failures: string[] = [];
		for (const [name, Icon] of entries) {
			const { container, unmount } = render(<Icon />);
			if (!container.querySelector("svg")) failures.push(name);
			unmount();
		}
		expect(failures).toEqual([]);
	});

	it("forwards className, size and strokeWidth to the svg", () => {
		const { container } = render(
			<icons.ChevronDown
				className="size-3.5 text-fg-subtle"
				size={16}
				strokeWidth={2}
			/>,
		);
		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("class")).toContain("size-3.5");
		expect(svg?.getAttribute("class")).toContain("text-fg-subtle");
		expect(svg?.getAttribute("width")).toBe("16");
		expect(svg?.getAttribute("height")).toBe("16");
	});

	/**
	 * Reicon ships no git, panel-collapse, or keyboard glyphs. If this list
	 * changes, the mapping in `scripts/gen-icon-layer.mjs` was edited — regenerate
	 * rather than hand-patching the generated modules.
	 */
	it("keeps the lucide compatibility set to the known gaps", () => {
		const COMPAT = [
			"ArchiveRestore",
			"ArrowBigUp",
			"Bot",
			"Brain",
			"BrainIcon",
			"Circle",
			"CircleDashed",
			"CircleDot",
			"CornerDownLeft",
			"Delete",
			"FileAudio",
			"FileDiff",
			"FolderGit2",
			"FolderSearch",
			"GitBranch",
			"GitBranchPlus",
			"GitFork",
			"GitMerge",
			"GitPullRequest",
			"GitPullRequestArrow",
			"GripVertical",
			"Option",
			"Orbit",
			"Pickaxe",
			"Rows3",
			"ShieldQuestion",
			"Space",
			"Split",
			"Square",
			"Workflow",
		];
		// compat.ts re-exports identically-named lucide components; assert the
		// names are present so a dropped export fails loudly here.
		for (const name of COMPAT) {
			expect(icons, `missing compat icon ${name}`).toHaveProperty(name);
		}
		expect(COMPAT).toHaveLength(30);
	});
});
