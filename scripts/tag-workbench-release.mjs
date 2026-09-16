// Emit the `workbench-v<version>` tag that release-workbench.yml listens for.
//
// Why this exists: `.github/workflows/release-workbench.yml` builds the four
// platform binaries and attaches them to a GitHub Release, but it only fires on
// a `workbench-v*` tag push — and nothing in the repo ever created such a tag.
// `scripts/create-release-tag.mjs` (the changesets/action `publish` step) reads
// the ROOT package.json, which is the frozen legacy Helmor app (0.46.0), so it
// emits `v0.46.0` and drives publish.yml instead. The workbench binary channel
// was therefore reachable only by hand-typing a tag.
//
// Safety: this is dry-run by default. It prints the tag it would push and exits
// 0. Pass `--push` to actually create and push it — a pushed tag starts a real
// release build and creates a public GitHub Release, so it never happens by
// accident.
//
// Usage:
//   bun scripts/tag-workbench-release.mjs              # show the plan
//   bun scripts/tag-workbench-release.mjs --push       # tag + push
//   bun scripts/tag-workbench-release.mjs --version 0.3.1 --push
//   bun scripts/tag-workbench-release.mjs --allow-dirty --push

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const push = args.includes("--push");
const allowDirty = args.includes("--allow-dirty");
const versionFlag = args.indexOf("--version");
const flagged = versionFlag === -1 ? null : args[versionFlag + 1];

const manifestPath = path.join(root, "packages", "workbench", "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const version = flagged ?? manifest.version ?? "";

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error(
		`packages/workbench/package.json 的 version 不是合法语义化版本：${JSON.stringify(version)}`,
	);
	process.exit(1);
}
if (flagged && flagged !== manifest.version) {
	console.error(
		`--version ${flagged} 与 packages/workbench/package.json 的 ${manifest.version} 不一致；` +
			"请先用 changeset version 改包版本，不要只改 tag。",
	);
	process.exit(1);
}

const tag = `workbench-v${version}`;
console.log(`包：${manifest.name}@${version}`);
console.log(`tag：${tag}`);
console.log(
	`触发：.github/workflows/release-workbench.yml（4 平台二进制 + 挂到 GitHub Release）`,
);

const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim();
if (dirty) {
	const lines = dirty.split("\n");
	console.log(`\n⚠ 工作区有 ${lines.length} 项未提交改动：`);
	for (const line of lines.slice(0, 10)) console.log(`   ${line}`);
	if (lines.length > 10) console.log(`   …（其余 ${lines.length - 10} 项略）`);
	console.log(
		"  发布的 tag 指向 HEAD 提交，未提交的改动不会进入发行物。" +
			(allowDirty
				? "\n  --allow-dirty 已给出，继续。"
				: "\n  确认无误后加 --allow-dirty 或先提交。"),
	);
	if (!allowDirty) process.exit(2);
}

let exists = false;
try {
	execSync(`git rev-parse --verify refs/tags/${tag}`, { stdio: "ignore" });
	exists = true;
} catch {
	exists = false;
}
const remoteExists = (() => {
	try {
		return (
			execSync(`git ls-remote --tags origin refs/tags/${tag}`, {
				encoding: "utf8",
			}).trim() !== ""
		);
	} catch {
		return null;
	}
})();

if (!push) {
	console.log(
		`\n[dry-run] 本地 tag 存在：${exists}；远端 tag 存在：${remoteExists}`,
	);
	console.log(`[dry-run] 未做任何写操作。要真正发布请运行：`);
	console.log(
		`  bun scripts/tag-workbench-release.mjs --push${allowDirty ? " --allow-dirty" : ""}`,
	);
	process.exit(0);
}

if (remoteExists === true) {
	console.error(`\n远端已存在 tag ${tag}；换版本号再发，不要重打同一个 tag。`);
	process.exit(1);
}
if (!exists) execSync(`git tag ${tag}`, { stdio: "inherit" });
execSync(`git push origin ${tag}`, { stdio: "inherit" });
console.log(`New tag: ${tag}`);
