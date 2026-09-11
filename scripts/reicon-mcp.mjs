#!/usr/bin/env node
/**
 * Cwd-independent launcher for the vendored `reicon-mcp` server.
 *
 * MCP clients spawn this from whatever directory a session happens to use —
 * the repo root, or a Helmor worktree under `worktrees/` / `.claude/worktrees/`
 * that has no `node_modules` of its own. Node resolves the package from *this
 * file's* location rather than the cwd, so both cases find the root install.
 *
 * This also sidesteps a Windows footgun: MCP clients that spawn `npx` directly
 * fail there (`ENOENT`, or `EINVAL` for `npx.cmd`, because Node cannot spawn a
 * `.cmd` shim without a shell). Spawning `node` with a resolved path works.
 *
 * Usage from an MCP client config:
 *   { "command": "node", "args": ["scripts/reicon-mcp.mjs"] }
 *
 * Args are passed through, so CLI mode works too:
 *   node scripts/reicon-mcp.mjs search "shopping cart"
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let bin;
try {
	bin = require.resolve("reicon-mcp/bin/run.cjs");
} catch (err) {
	process.stderr.write(
		`reicon-mcp not found. Run \`bun install\` in the repo root first.\n${err.message}\n`,
	);
	process.exit(1);
}

const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
	stdio: "inherit",
});

child.on("error", (err) => {
	process.stderr.write(`Failed to start reicon-mcp: ${err.message}\n`);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
