/**
 * 构建单文件 Node 目标 CLI：dist/cli.js（带 shebang，供 bin 入口与 npx 使用）。
 */

const result = await Bun.build({
	entrypoints: ["./src/cli.ts"],
	target: "node",
	outdir: "./dist",
	naming: "cli.js",
});

if (!result.success) {
	console.error(result.logs);
	process.exit(1);
}

const path = await import("node:path");
const cliPath = path.resolve(import.meta.dir, "../dist/cli.js");
const content = await Bun.file(cliPath).text();
if (!content.startsWith("#!")) {
	await Bun.write(cliPath, `#!/usr/bin/env node\n${content}`);
}
console.log(`built dist/cli.js (${result.outputs.length} output)`);
