import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { makeTempWorkbench } from "../test/fixtures";
import { reconcilePremises } from "./premises";
import { exportSurface, stripComments, surfaceHash } from "./surface";

/**
 * R2 predicate layer 3 (TF-0076). Two properties decide whether this layer is
 * worth having at all:
 * - body-only and whitespace-only edits must NOT move the surface, or the
 *   channel drowns in ~1000x over-notification;
 * - any observable change to the surface MUST move it, or the predicate is
 *   silently wrong in the dangerous direction.
 */

const MODULE = `export function add(a: number, b: number): number {
	return a + b;
}

export const NAME: string = "workbench";

export interface Writer {
	id: string;
	kind: string;
}
`;

describe("注释与字符串处理", () => {
	test("行注释与块注释被剥掉，但不会拼接相邻 token", () => {
		expect(stripComments("const a = 1; // note")).toBe("const a = 1; ");
		// 前后各留一个空格：宁可多留空白，也不能把两个 token 拼成一个
		expect(stripComments("a/* c */b")).toBe("a  b");
	});

	test("字符串里的注释记号不是注释", () => {
		expect(stripComments("const s = '// not a comment';")).toBe(
			"const s = '// not a comment';",
		);
		expect(stripComments("const t = `/* nope */`;")).toBe(
			"const t = `/* nope */`;",
		);
		expect(stripComments("const q = 'a\\'b';")).toBe("const q = 'a\\'b';");
	});
});

describe("导出面投影", () => {
	test("函数体、类体不进投影，只有签名", () => {
		expect(exportSurface(MODULE)).toEqual([
			"export function add ( a : number , b : number ) : number",
			"export const NAME : string",
			"export interface Writer { id : string ; kind : string ; }",
		]);
	});

	test("只改函数体，导出面不动", () => {
		const changed = MODULE.replace("return a + b;", "return a - b;");
		expect(surfaceHash(changed)).toBe(surfaceHash(MODULE));
	});

	test("纯空白编辑，导出面不动", () => {
		const reformatted = MODULE.replace(/\t/g, "    ").replace(
			"export function add",
			"export function  add",
		);
		expect(surfaceHash(reformatted)).toBe(surfaceHash(MODULE));
	});

	test("改签名、改成员、加导出、改导出顺序，导出面都要动", () => {
		expect(
			surfaceHash(MODULE.replace("b: number): number", "b: string): number")),
		).not.toBe(surfaceHash(MODULE));
		expect(
			surfaceHash(MODULE.replace("kind: string;", "kind: number;")),
		).not.toBe(surfaceHash(MODULE));
		expect(surfaceHash(`${MODULE}\nexport const EXTRA = 1;\n`)).not.toBe(
			surfaceHash(MODULE),
		);
		expect(
			surfaceHash(`export interface Writer {
	id: string;
	kind: string;
}

export function add(a: number, b: number): number {
	return a + b;
}

export const NAME: string = "workbench";
`),
		).not.toBe(surfaceHash(MODULE));
	});

	test("注释改动不算变化（注释不在投影里）", () => {
		const withComment = `// a brand new leading comment
${MODULE}`;
		expect(surfaceHash(withComment)).toBe(surfaceHash(MODULE));
	});

	test("没有导出就不表态（返回 null，而不是空哈希）", () => {
		expect(surfaceHash("const internal = 1;")).toBeNull();
	});
});

describe("依赖式读 vs 主题式读（R2 谓词第 3 层 · TF-0076）", () => {
	test("只改函数体时，仅 import 了它的写者不被通知", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "mod.ts"), MODULE, "utf8");
			const spoolDir = join(ws.workbenchRoot, "sessions", "w", "spool");
			// 依赖式读：只读不写
			const claim = await hashPathClaim(ws.projectDir, "src/mod.ts", spoolDir);
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});

			// 别人只改了函数体
			await writeFile(
				join(ws.projectDir, "src", "mod.ts"),
				MODULE.replace("return a + b;", "return a * b;"),
				"utf8",
			);

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	});

	test("改了签名时，依赖式读照样被通知", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "mod.ts"), MODULE, "utf8");
			const spoolDir = join(ws.workbenchRoot, "sessions", "w", "spool");
			const claim = await hashPathClaim(ws.projectDir, "src/mod.ts", spoolDir);
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});

			await writeFile(
				join(ws.projectDir, "src", "mod.ts"),
				MODULE.replace("b: number): number", "b: string): number"),
				"utf8",
			);

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(1);
			expect(notices[0]!.stale.map((s) => s.path)).toEqual(["src/mod.ts"]);
		} finally {
			await ws.cleanup();
		}
	});

	test("同一个写者自己也改这个文件 → 主题式读，改函数体也要通知", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "mod.ts"), MODULE, "utf8");
			const spoolDir = join(ws.workbenchRoot, "sessions", "w", "spool");
			const claim = await hashPathClaim(ws.projectDir, "src/mod.ts", spoolDir);
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [{ path: "src/mod.ts" }],
			});

			await writeFile(
				join(ws.projectDir, "src", "mod.ts"),
				MODULE.replace("return a + b;", "return a / b;"),
				"utf8",
			);

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(1);
		} finally {
			await ws.cleanup();
		}
	});

	test("非 JS/TS 文件不走第 3 层，照常通知", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "notes.md"), "a\n", "utf8");
			const spoolDir = join(ws.workbenchRoot, "sessions", "w", "spool");
			const claim = await hashPathClaim(
				ws.projectDir,
				"src/notes.md",
				spoolDir,
			);
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});
			await writeFile(join(ws.projectDir, "src", "notes.md"), "b\n", "utf8");

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(1);
		} finally {
			await ws.cleanup();
		}
	});
});
