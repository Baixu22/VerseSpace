import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { makeTempWorkbench } from "../test/fixtures";
import { pendingPremiseNotices } from "./delivery";
import type { StalePremiseClaim } from "./premises";
import { reconcilePremises } from "./premises";
import { judgeSeal, normalizeTarget, targetOfHookInput } from "./seal";

const claim = (path: string): StalePremiseClaim => ({
	path,
	observedVersion: "aaaaaaaaaaaaaaaa",
	currentVersion: "bbbbbbbbbbbbbbbb",
});

describe("封印点（R2 · TF-0078）", () => {
	test("目标不在失效区域时放行", () => {
		const verdict = judgeSeal("/repo", "/repo/src/other.ts", [
			claim("src/a.ts"),
		]);
		expect(verdict.blocked).toBe(false);
	});

	test("绝对路径、相对路径、反斜杠都能归一到同一形状", () => {
		expect(normalizeTarget("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
		expect(normalizeTarget("/repo", "src/a.ts")).toBe("src/a.ts");
		expect(normalizeTarget("/repo", "./src/a.ts")).toBe("src/a.ts");
		expect(normalizeTarget("/repo", "src\\a.ts")).toBe("src/a.ts");
	});

	test("写入失效文件被拦下，且理由里带上失效证据", () => {
		const verdict = judgeSeal("/repo", "/repo/src/a.ts", [claim("src/a.ts")]);
		expect(verdict.blocked).toBe(true);
		if (!verdict.blocked) {
			return;
		}
		expect(verdict.reason).toContain("封印点");
		expect(verdict.reason).toContain("src/a.ts");
		expect(verdict.reason).toContain("aaaaaaaaaaaa");
		expect(verdict.reason).toContain("bbbbbbbbbbbb");
		expect(verdict.evidence.map((e) => e.path)).toEqual(["src/a.ts"]);
	});

	test("写失效文件所在目录也被拦下（整目录视为失效）", () => {
		expect(judgeSeal("/repo", "/repo/src", [claim("src/a.ts")]).blocked).toBe(
			true,
		);
	});

	test("hook 载荷里取目标：Write/Edit 与 NotebookEdit", () => {
		expect(
			targetOfHookInput({
				tool_name: "Write",
				tool_input: { file_path: "/repo/src/a.ts", content: "x" },
			}),
		).toBe("/repo/src/a.ts");
		expect(
			targetOfHookInput({
				tool_name: "NotebookEdit",
				tool_input: { notebook_path: "/repo/n.ipynb" },
			}),
		).toBe("/repo/n.ipynb");
		expect(
			targetOfHookInput({ tool_name: "Bash", tool_input: { command: "ls" } }),
		).toBeNull();
	});

	// ---- 验收标准：把检测、失效区域、封印判定串起来 ----

	test("别人改过的文件，写入被拦下；没动过的文件照常放行", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "src", "changed.ts"),
				"export const a = 1;",
				"utf8",
			);
			await writeFile(
				join(ws.projectDir, "src", "untouched.ts"),
				"export const b = 1;",
				"utf8",
			);
			// 读过但没被动过的那个：记录真实版本，前提应当仍然成立
			const untouched = await hashPathClaim(ws.projectDir, "src/untouched.ts");
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [
					{ path: "src/changed.ts", version: "stale", durability: "volatile" },
					untouched,
				],
				generated: [],
			});
			// 只动其中一个
			await writeFile(
				join(ws.projectDir, "src", "changed.ts"),
				"export const a = 2;",
				"utf8",
			);
			await reconcilePremises(ws.bb);

			const claims = (await pendingPremiseNotices(ws.bb)).flatMap(
				(notice) => notice.claims,
			);
			expect(claims.map((c) => c.path)).toEqual(["src/changed.ts"]);

			// 封印：写被改过的那个要拦
			const blocked = judgeSeal(
				ws.projectDir,
				join(ws.projectDir, "src", "changed.ts"),
				claims,
			);
			expect(blocked.blocked).toBe(true);
			// 没被改过的那个照常放行
			expect(
				judgeSeal(
					ws.projectDir,
					join(ws.projectDir, "src", "untouched.ts"),
					claims,
				).blocked,
			).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});

	test("--writer 只认自己那条失效区域，不拦别人的", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "src", "a.ts"),
				"export const a = 1;",
				"utf8",
			);
			await writeFile(
				join(ws.projectDir, "src", "b.ts"),
				"export const b = 1;",
				"utf8",
			);
			for (const [id, path] of [
				["wa", "src/a.ts"],
				["wb", "src/b.ts"],
			] as const) {
				await ws.bb.sessions.register(id, "agent", id);
				await ws.bb.sessions.recordActivity(id, {
					activity: "a1",
					agent: id,
					used: [{ path, version: "stale", durability: "volatile" }],
					generated: [],
				});
			}
			await writeFile(
				join(ws.projectDir, "src", "a.ts"),
				"export const a = 2;",
				"utf8",
			);
			await writeFile(
				join(ws.projectDir, "src", "b.ts"),
				"export const b = 2;",
				"utf8",
			);
			await reconcilePremises(ws.bb);

			const pending = await pendingPremiseNotices(ws.bb);
			const mine = pending
				.filter((notice) => notice.writerId === "wb")
				.flatMap((notice) => notice.claims);

			expect(
				judgeSeal(ws.projectDir, join(ws.projectDir, "src", "a.ts"), mine)
					.blocked,
			).toBe(false);
			expect(
				judgeSeal(ws.projectDir, join(ws.projectDir, "src", "b.ts"), mine)
					.blocked,
			).toBe(true);
		} finally {
			await ws.cleanup();
		}
	});
});
