import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Command } from "commander";
import { buildProgram } from "./cli";
import { initGitFixture, makeTempWorkbench } from "./test/fixtures";

describe("buildProgram", () => {
	test("exposes the scaffolded top-level command tree", () => {
		const names = buildProgram().commands.map((command) => command.name());
		expect(names).toEqual([
			"init",
			"goal",
			"decision",
			"interface",
			"agent",
			"sessions",
			"premises",
			"mcp",
			// R3: the human channel, the flow limit, and the lane meters
			"tribunal",
			"wip",
			"metrics",
			"stats",
			"ws",
			"checkpoint",
			"dispatch",
			"queue",
			"status",
			"map",
			"log",
			"sync",
			"watch",
			"doctor",
			"ui",
			"config",
			"context",
		]);
	});

	test("goal subtree exposes its subcommands", () => {
		const goal = buildProgram().commands.find(
			(command) => command.name() === "goal",
		);
		if (!goal) {
			throw new Error("goal command is missing");
		}
		expect(goal.commands.map((command) => command.name())).toEqual([
			"add",
			"list",
			"show",
			"cancel",
		]);
	});

	test("premises subtree exposes inspection and the seal hook", () => {
		const premises = buildProgram().commands.find(
			(command) => command.name() === "premises",
		);
		if (!premises) {
			throw new Error("premises command is missing");
		}
		expect(premises.commands.map((command) => command.name())).toEqual([
			"pending",
			"current",
			"seal",
			"review-seal",
		]);
		const seal = premises.commands.find((command) => command.name() === "seal");
		expect(seal?.options.map((option) => option.long)).toEqual([
			"--writer",
			"--target",
			"--mode",
		]);
	});

	test("context subtree exposes inspection, lowering and landmark review", () => {
		const context = buildProgram().commands.find(
			(command) => command.name() === "context",
		);
		if (!context) {
			throw new Error("context command is missing");
		}
		expect(context.commands.map((command) => command.name())).toEqual([
			"list",
			"lower",
			"review",
		]);
	});

	test("tribunal subtree exposes the queue's four verbs and its numbers", () => {
		const tribunal = buildProgram().commands.find(
			(command) => command.name() === "tribunal",
		);
		if (!tribunal) {
			throw new Error("tribunal command is missing");
		}
		expect(tribunal.commands.map((command) => command.name())).toEqual([
			"list",
			"show",
			"shelve",
			"resolve",
			"stats",
		]);
	});

	test("dispatch exposes the CONWIP override as an explicit flag", () => {
		const dispatch = buildProgram().commands.find(
			(command) => command.name() === "dispatch",
		);
		expect(dispatch?.options.map((option) => option.long)).toContain("--force");
	});

	test("global flags include --json and --quiet", () => {
		const longFlags = buildProgram().options.map((option) => option.long);
		expect(longFlags).toContain("--json");
		expect(longFlags).toContain("--quiet");
	});
});

// The shape tests above only see the command tree. A command whose action
// arity does not match its operand count registers fine and crashes at call
// time, so the verbs that matter are executed through the real argv path.
describe("argv execution", () => {
	const argv = (args: string[]): string[] => ["node", "workbench", ...args];

	// commander's default on a parse error is process.exit(1), which would take
	// the test runner down with it; exitOverride turns that into a throw.
	// Subcommands copy the callback at creation time, so it has to be walked
	// down the tree after the program is built.
	const overrideExit = (cmd: Command): void => {
		cmd.exitOverride();
		cmd.commands.forEach(overrideExit);
	};

	test("tribunal verbs run through parseAsync", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		try {
			const submitted = await ws.bb.tribunal.submit({
				kind: "workspot_blocked",
				subject: "ws-a",
				causeKey: "workspot_blocked:ws-a",
				action: {
					label: "重新指派工位",
					command: "workbench ws reassign ws-a --task g-2",
				},
				sbar: {
					situation: "工位 ws-a 被阻塞",
					background: "任务 g-1 已进入 stale_done",
					assessment: "工位空转，本轮产出为零",
					recommendation: "把 ws-a 改派到 g-2，或关闭它",
				},
			});
			if (!submitted.admitted || !submitted.item) {
				throw new Error("fixture candidate was not admitted");
			}

			await buildProgram().parseAsync(
				argv(["tribunal", "list", "--json", "--quiet"]),
			);
			await buildProgram().parseAsync(
				argv(["tribunal", "show", submitted.item.id]),
			);

			// a deferral is the one that used to crash on action arity
			await buildProgram().parseAsync(
				argv(["tribunal", "shelve", submitted.item.id, "--minutes", "15"]),
			);
			const shelved = await ws.bb.tribunal.list({ includeResolved: true });
			expect(
				shelved.find((item) => item.id === submitted.item!.id)?.state,
			).toBe("shelved");

			await buildProgram().parseAsync(
				argv(["tribunal", "resolve", submitted.item.id]),
			);
		} finally {
			process.chdir(cwd);
			await ws.cleanup();
		}
	});

	test("ws create rejects a missing --branch at the arg parser", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		try {
			const program = buildProgram();
			overrideExit(program);
			await expect(
				program.parseAsync(argv(["ws", "create", "ws-a", "--task", "g-1"])),
			).rejects.toThrow(/required option '--branch/);
		} finally {
			process.chdir(cwd);
			await ws.cleanup();
		}
	});

	// Commander wraps every `.action(fn)` in a closure, so the registered
	// handler's `length` is 1 no matter what the real signature is — arity can
	// never be detected by inspecting the tree, only by calling it. The table
	// below keeps one real argv execution per operand-bearing command; the
	// completeness test after it refuses to let a new one slip past uncovered.
	interface ArgvCase {
		/** command path, e.g. ["goal", "add"]; the completeness test keys on it */
		readonly path: readonly string[];
		/** test name fragment, also interpolated into the case title */
		readonly label: string;
		/** seed fixture state and return the argv tail (flags included) */
		readonly build: (ws: WorkbenchFixture) => Promise<readonly string[]>;
		/** set when the handler legitimately rejects (domain error, not a crash) */
		readonly rejects?: RegExp;
		/** set when the handler reports failure via process.exitCode, not a throw */
		readonly exitCode?: number;
		/** optional post-run assertion on the fixture and captured stdout/stderr */
		readonly verify?: (ws: WorkbenchFixture, out: string) => Promise<void>;
	}

	type WorkbenchFixture = Awaited<ReturnType<typeof makeTempWorkbench>>;

	const GOAL_ID = "g-argv";
	const WORKSPOT_ID = "ws-argv";
	const WRITER_ID = "writer-argv";
	const CHECKPOINT_ID = "cp-argv";

	const seedWorkspot = async (ws: WorkbenchFixture): Promise<void> => {
		await ws.bb.state.workspots.save({
			id: WORKSPOT_ID,
			branch: "argv-branch",
			worktreePath: `worktrees/${WORKSPOT_ID}`,
			primaryTask: GOAL_ID,
			binding: "primary",
			status: "idle",
			contextNeeds: { decisions: [], interfaces: [] },
		});
	};

	const seedCheckpoint = async (ws: WorkbenchFixture): Promise<void> => {
		await ws.bb.checkpoints.save(
			{
				id: CHECKPOINT_ID,
				goal: GOAL_ID,
				workspot: WORKSPOT_ID,
				timestamp: new Date().toISOString(),
				lifecycle: "awaiting_review",
				assertion: "argv 断言",
				artifacts: [],
				unblocks: [],
			},
			"staging",
		);
	};

	const CASES: ArgvCase[] = [
		{
			path: ["goal", "add"],
			label: "goal add <title>",
			build: async () => ["goal", "add", "argv-goal", "--acceptance", "可验证"],
			verify: async (ws) => {
				const goals = await ws.bb.goals.list();
				expect(goals.some((goal) => goal.title === "argv-goal")).toBe(true);
			},
		},
		{
			path: ["goal", "show"],
			label: "goal show <id>",
			build: async (ws) => {
				const goal = await ws.bb.goals.add({ title: "argv-goal-show" });
				return ["goal", "show", goal.id, "--json"];
			},
			verify: async (_ws, out) => {
				expect(out).toContain("argv-goal-show");
			},
		},
		{
			path: ["goal", "cancel"],
			label: "goal cancel <id>",
			build: async (ws) => {
				const goal = await ws.bb.goals.add({ title: "argv-goal-cancel" });
				return ["goal", "cancel", goal.id];
			},
			verify: async (ws) => {
				const goals = await ws.bb.goals.list();
				expect(
					goals.find((goal) => goal.title === "argv-goal-cancel")?.status,
				).toBe("cancelled");
			},
		},
		{
			path: ["decision", "add"],
			label: "decision add <title>",
			build: async () => [
				"decision",
				"add",
				"argv 决策",
				"--rationale",
				"argv",
			],
			verify: async (ws) => {
				const decisions = await ws.bb.decisions.list();
				expect(decisions.some((d) => d.title === "argv 决策")).toBe(true);
			},
		},
		{
			path: ["interface", "register"],
			label: "interface register <path>",
			build: async (ws) => {
				await mkdir(join(ws.projectDir, "src"), { recursive: true });
				await writeFile(
					join(ws.projectDir, "src", "index.ts"),
					"export const x = 1;\n",
					"utf8",
				);
				return ["interface", "register", "src/index.ts", "--key", "argv-entry"];
			},
			verify: async (ws) => {
				const entry = await ws.bb.interfaces.getEntry("argv-entry");
				expect(entry?.canonicalPath).toBe("src/index.ts");
			},
		},
		{
			path: ["sessions", "show"],
			label: "sessions show <writer>",
			build: async (ws) => {
				await ws.bb.sessions.register(WRITER_ID, "agent", "argv");
				return ["sessions", "show", WRITER_ID, "--json"];
			},
			verify: async (_ws, out) => {
				expect(out).toContain(WRITER_ID);
			},
		},
		{
			path: ["premises", "review-seal"],
			label: "premises review-seal <event-id>",
			// a non-block event id is rejected by the review layer, which still
			// proves the handler received (eventId, options, command) intact
			build: async () => [
				"premises",
				"review-seal",
				"evt-none",
				"--correct",
				"--reason",
				"argv",
			],
			rejects: /未找到对应的封印阻断事件/,
		},
		{
			path: ["tribunal", "show"],
			label: "tribunal show <id>",
			build: async (ws) => {
				const submitted = await ws.bb.tribunal.submit({
					kind: "workspot_blocked",
					subject: WORKSPOT_ID,
					causeKey: `workspot_blocked:${WORKSPOT_ID}`,
					action: { label: "查看", command: "workbench ws status ws-argv" },
					sbar: {
						situation: "工位阻塞",
						background: "任务停滞",
						assessment: "本轮产出为零",
						recommendation: "检查工位",
					},
				});
				if (!submitted.admitted || !submitted.item) {
					throw new Error("fixture candidate was not admitted");
				}
				return ["tribunal", "show", submitted.item.id];
			},
		},
		{
			path: ["tribunal", "shelve"],
			label: "tribunal shelve <id>",
			build: async (ws) => {
				const submitted = await ws.bb.tribunal.submit({
					kind: "workspot_blocked",
					subject: WORKSPOT_ID,
					causeKey: `workspot_blocked:${WORKSPOT_ID}`,
					action: { label: "延期", command: "workbench ws status ws-argv" },
					sbar: {
						situation: "工位阻塞",
						background: "任务停滞",
						assessment: "本轮产出为零",
						recommendation: "稍后再看",
					},
				});
				if (!submitted.admitted || !submitted.item) {
					throw new Error("fixture candidate was not admitted");
				}
				return ["tribunal", "shelve", submitted.item.id, "--minutes", "5"];
			},
			verify: async (ws) => {
				const list = await ws.bb.tribunal.list({ includeResolved: true });
				expect(
					list.some(
						(item) => item.state === "shelved" && item.subject === WORKSPOT_ID,
					),
				).toBe(true);
			},
		},
		{
			path: ["tribunal", "resolve"],
			label: "tribunal resolve <id>",
			build: async (ws) => {
				const submitted = await ws.bb.tribunal.submit({
					kind: "workspot_blocked",
					subject: WORKSPOT_ID,
					causeKey: `workspot_blocked:${WORKSPOT_ID}`,
					action: { label: "解决", command: "workbench ws status ws-argv" },
					sbar: {
						situation: "工位阻塞",
						background: "任务停滞",
						assessment: "本轮产出为零",
						recommendation: "直接了结",
					},
				});
				if (!submitted.admitted || !submitted.item) {
					throw new Error("fixture candidate was not admitted");
				}
				return ["tribunal", "resolve", submitted.item.id];
			},
			verify: async (ws) => {
				const list = await ws.bb.tribunal.list({ includeResolved: true });
				expect(
					list.some(
						(item) => item.state === "resolved" && item.subject === WORKSPOT_ID,
					),
				).toBe(true);
			},
		},
		{
			path: ["ws", "create"],
			label: "ws create <id>",
			// the success path: the parse-error case above only proves the
			// option gate, this one proves the two operands reach wsCreate
			build: async () => [
				"ws",
				"create",
				WORKSPOT_ID,
				"--task",
				GOAL_ID,
				"--branch",
				"argv-branch",
			],
			verify: async (ws) => {
				const workspot = await ws.bb.state.workspots.get(WORKSPOT_ID);
				expect(workspot?.primaryTask).toBe(GOAL_ID);
			},
		},
		{
			path: ["ws", "status"],
			label: "ws status <id>",
			build: async (ws) => {
				await seedWorkspot(ws);
				return ["ws", "status", WORKSPOT_ID, "--json"];
			},
			verify: async (_ws, out) => {
				expect(out).toContain(WORKSPOT_ID);
			},
		},
		{
			path: ["ws", "reassign"],
			label: "ws reassign <id>",
			build: async (ws) => {
				await seedWorkspot(ws);
				return [
					"ws",
					"reassign",
					WORKSPOT_ID,
					"--task",
					"g-reassign",
					"--temporary",
				];
			},
			verify: async (ws) => {
				const workspot = await ws.bb.state.workspots.get(WORKSPOT_ID);
				expect(workspot?.binding).toBe("borrowed");
				expect(workspot?.currentTask).toBe("g-reassign");
			},
		},
		{
			path: ["checkpoint", "restore"],
			label: "checkpoint restore <id>",
			// no rollback snapshot was ever taken, so the plan refuses; the
			// dry-run report is what a person would see, and --yes is never
			// reached in a test on purpose
			build: async (ws) => {
				await seedCheckpoint(ws);
				return ["checkpoint", "restore", CHECKPOINT_ID, "--context", "--json"];
			},
			exitCode: 1,
			verify: async (_ws, out) => {
				expect(out).toContain(CHECKPOINT_ID);
			},
		},
		{
			path: ["checkpoint", "review"],
			label: "checkpoint review <id>",
			build: async (ws) => {
				await seedCheckpoint(ws);
				await seedWorkspot(ws);
				const cwd = join(ws.projectDir, "worktrees", WORKSPOT_ID);
				await mkdir(cwd, { recursive: true });
				initGitFixture(cwd);
				return ["checkpoint", "review", CHECKPOINT_ID, "--approve"];
			},
			verify: async (ws) => {
				const verified = await ws.bb.checkpoints.scanZone("verified");
				expect(verified.some((cp) => cp.id === CHECKPOINT_ID)).toBe(true);
				expect(
					verified.find((cp) => cp.id === CHECKPOINT_ID)?.verificationBinding
						?.commit,
				).toBeTruthy();
			},
		},
		{
			path: ["checkpoint", "revalidate"],
			label: "checkpoint revalidate <id>",
			build: async (ws) => {
				await seedCheckpoint(ws);
				return ["checkpoint", "revalidate", CHECKPOINT_ID, "--json"];
			},
			rejects: /没有声明产物依赖/,
		},
		{
			path: ["dispatch"],
			label: "dispatch <goal-id> [workspot-id]",
			// a goal that does not exist is a structured refusal: the handler
			// sets process.exitCode instead of throwing, which is the shape
			// an arity crash would never take
			build: async () => ["dispatch", GOAL_ID, WORKSPOT_ID, "--json"],
			exitCode: 1,
			verify: async (_ws, out) => {
				expect(out).toContain("目标不存在");
			},
		},
		{
			path: ["config", "set"],
			label: "config set <key> <value>",
			build: async () => ["config", "set", "scheduler.policy", "auto"],
			verify: async (ws) => {
				const config = await ws.bb.config.load();
				expect(config.scheduler.policy).toBe("auto");
			},
		},
		{
			path: ["context", "lower"],
			label: "context lower <handle>",
			build: async (ws) => {
				await ws.bb.sessions.register(WRITER_ID, "agent", "argv");
				return ["context", "lower", "nope.md", "--writer", WRITER_ID];
			},
			// nothing was ever observed for this handle, so the DOI scorer
			// refuses — the handler was reached with (handle, options, command)
			rejects: /没有已观察到的条目：nope\.md/,
		},
		{
			path: ["context", "review"],
			label: "context review <handle>",
			build: async (ws) => {
				await ws.bb.sessions.register(WRITER_ID, "agent", "argv");
				return [
					"context",
					"review",
					"nope.md",
					"--writer",
					WRITER_ID,
					"--reject",
					"--reason",
					"argv",
				];
			},
			rejects: /不在当前地标集合中：nope\.md/,
		},
	];

	test.each(CASES)("$label", async (theCase) => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		const lines: string[] = [];
		const originalLog = console.log;
		const originalError = console.error;
		console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
		console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
		const previousExitCode = process.exitCode;
		// bun keeps the last non-zero value when undefined is assigned, so the
		// reset has to be explicit — a case that legitimately exits 1 would
		// otherwise leak into every case after it
		process.exitCode = 0;
		try {
			const tail = await theCase.build(ws);
			const program = buildProgram();
			overrideExit(program);
			if (theCase.rejects) {
				await expect(program.parseAsync(argv([...tail]))).rejects.toThrow(
					theCase.rejects,
				);
			} else {
				await program.parseAsync(argv([...tail]));
			}
			if (theCase.exitCode !== undefined) {
				expect(process.exitCode).toBe(theCase.exitCode);
			} else {
				// a handler that signalled failure while still resolving is
				// exactly the silent break this suite exists to catch
				expect([undefined, 0]).toContain(process.exitCode);
			}
			await theCase.verify?.(ws, lines.join("\n"));
		} finally {
			process.exitCode = previousExitCode ?? 0;
			console.log = originalLog;
			console.error = originalError;
			process.chdir(cwd);
			await ws.cleanup();
		}
	});

	test("the argv table covers every operand-bearing command", () => {
		const covered = new Set(CASES.map((theCase) => theCase.path.join(" ")));
		const found: string[] = [];
		const walk = (cmd: Command, prefix: string): void => {
			for (const child of cmd.commands) {
				const path = `${prefix}${child.name()}`;
				// zero-operand commands always receive (options, command) from
				// commander, so the arity class cannot arise for them; only
				// commands with registered arguments need a case above
				if (child.registeredArguments.length > 0) {
					found.push(path);
				}
				walk(child, `${path} `);
			}
		};
		walk(buildProgram(), "");
		expect(found.sort()).toEqual([...covered].sort());
	});

	// `premises seal` takes no operands but is one of the verbs the issue
	// names, and it is written to be safe on an empty blackboard: nothing
	// pending means no opinion, so it returns without touching the exit code.
	// --target keeps it off stdin, which the sessions-record suite owns.
	test("premises seal passes on an empty blackboard", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			await buildProgram().parseAsync(
				argv(["premises", "seal", "--target", "src/nope.ts"]),
			);
			expect([undefined, 0]).toContain(process.exitCode);
		} finally {
			process.exitCode = previousExitCode ?? 0;
			process.chdir(cwd);
			await ws.cleanup();
		}
	});

	test("sessions record registers a writer from its flags", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "src", "a.ts"),
				"export const a = 1;\n",
				"utf8",
			);
			await buildProgram().parseAsync(
				argv([
					"sessions",
					"record",
					"--writer",
					WRITER_ID,
					"--kind",
					"agent",
					"--label",
					"argv",
					"--activity",
					"argv-round",
					"--generated",
					"src/a.ts",
					"--used",
					"src/a.ts",
				]),
			);
			const writer = await ws.bb.sessions.get(WRITER_ID);
			expect(writer?.kind).toBe("agent");
			expect(lines.join("\n")).toContain("argv-round");
		} finally {
			console.log = originalLog;
			process.chdir(cwd);
			await ws.cleanup();
		}
	});

	// `ui` binds a long-lived server and never resolves, so it cannot be
	// driven to completion here. Binding a port first makes uiCommand refuse
	// with a structured error, which still takes the action all the way into
	// createUiServer — and proves (options, command) arrived intact. Bun's
	// listen failure does not carry EADDRINUSE, so both phrasings are accepted.
	test("ui reaches the server binder through the argv path", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		const blocker = createServer();
		try {
			await new Promise<void>((resolve) =>
				blocker.listen(0, "127.0.0.1", resolve),
			);
			const address = blocker.address();
			if (address === null || typeof address === "string") {
				throw new Error("could not bind a blocker port");
			}
			const program = buildProgram();
			overrideExit(program);
			await expect(
				program.parseAsync(
					argv(["ui", "--port", String(address.port), "--no-open"]),
				),
			).rejects.toThrow(/端口 .* 已被占用|Failed to start server/);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
			process.chdir(cwd);
			await ws.cleanup();
		}
	});
});
