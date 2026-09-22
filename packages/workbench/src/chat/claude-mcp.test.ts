import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitCommandLine } from "../supervisor/argv";
import {
	appendCommandFlags,
	buildMcpConfig,
	MCP_SERVER_NAME,
	mcpConfigFlags,
	resolveSelfInvocation,
	WORKBENCH_MCP_TOOL_PREFIX,
} from "./claude-mcp";

describe("resolveSelfInvocation", () => {
	test("compiled binary: execPath is the CLI, no entry arg", () => {
		expect(
			resolveSelfInvocation({
				execPath: "/opt/workbench",
				mainPath: "B:/~BUN/root/index.ts",
				mainExists: false,
			}),
		).toEqual({ command: "/opt/workbench", baseArgs: [] });
	});

	test("dev run: bun runtime plus the real entry module", () => {
		expect(
			resolveSelfInvocation({
				execPath: "/usr/bin/bun",
				mainPath: "/repo/packages/workbench/src/index.ts",
				mainExists: true,
			}),
		).toEqual({
			command: "/usr/bin/bun",
			baseArgs: ["/repo/packages/workbench/src/index.ts"],
		});
	});

	test("virtual $bunfs entry is treated as a binary even if statable", () => {
		expect(
			resolveSelfInvocation({
				execPath: "/opt/workbench.exe",
				mainPath: "/$bunfs/root/index.ts",
				mainExists: true,
			}),
		).toEqual({ command: "/opt/workbench.exe", baseArgs: [] });
	});
});

describe("buildMcpConfig", () => {
	test("names the workbench server and passes --root to the mcp subcommand", () => {
		const config = buildMcpConfig("/proj/.workbench", {
			command: "/usr/bin/bun",
			baseArgs: ["/repo/src/index.ts"],
		});
		expect(config).toEqual({
			mcpServers: {
				[MCP_SERVER_NAME]: {
					command: "/usr/bin/bun",
					args: ["/repo/src/index.ts", "mcp", "--root", "/proj/.workbench"],
				},
			},
		});
	});
});

describe("mcpConfigFlags", () => {
	test("writes the config under .workbench/mcp and returns the CLI flags", async () => {
		const root = await mkdtemp(join(tmpdir(), "wb-mcp-"));
		try {
			const flags = await mcpConfigFlags(root, {
				command: "/usr/bin/bun",
				baseArgs: ["/repo/src/index.ts"],
			});
			const configPath = join(root, "mcp", "claude-mcp.json");
			expect(flags).toEqual([
				"--mcp-config",
				configPath,
				"--allowedTools",
				WORKBENCH_MCP_TOOL_PREFIX,
			]);
			const written = JSON.parse(await readFile(configPath, "utf8"));
			expect(written.mcpServers[MCP_SERVER_NAME].args).toEqual([
				"/repo/src/index.ts",
				"mcp",
				"--root",
				root,
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("WORKBENCH_CLAUDE_MCP=off disables wiring and writes nothing", async () => {
		const root = await mkdtemp(join(tmpdir(), "wb-mcp-off-"));
		const previous = process.env.WORKBENCH_CLAUDE_MCP;
		process.env.WORKBENCH_CLAUDE_MCP = "off";
		try {
			const flags = await mcpConfigFlags(root, {
				command: "/opt/workbench",
				baseArgs: [],
			});
			expect(flags).toEqual([]);
			expect(
				await readFile(join(root, "mcp", "claude-mcp.json")).catch(
					() => "missing",
				),
			).toBe("missing");
		} finally {
			if (previous === undefined) delete process.env.WORKBENCH_CLAUDE_MCP;
			else process.env.WORKBENCH_CLAUDE_MCP = previous;
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("namespacing", () => {
	test("the allowed-tools prefix matches the server name", () => {
		expect(WORKBENCH_MCP_TOOL_PREFIX).toBe(`mcp__${MCP_SERVER_NAME}`);
	});
});

describe("appendCommandFlags", () => {
	test("a config path with a space survives splitCommandLine as one argv token", () => {
		// Windows: C:\Users\First Last\proj\.workbench\mcp\claude-mcp.json
		const spacedPath =
			"C:/Users/First Last/proj/.workbench/mcp/claude-mcp.json";
		const line = appendCommandFlags("claude -p --verbose", [
			"--mcp-config",
			spacedPath,
			"--allowedTools",
			WORKBENCH_MCP_TOOL_PREFIX,
		]);
		const argv = splitCommandLine(line);
		const configArg = argv[argv.indexOf("--mcp-config") + 1];
		expect(configArg).toBe(spacedPath);
		expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
			WORKBENCH_MCP_TOOL_PREFIX,
		);
	});

	test("flags without spaces are appended bare", () => {
		expect(appendCommandFlags("claude", ["--fork-session"])).toBe(
			"claude --fork-session",
		);
	});
});
