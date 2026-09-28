// Emit and push the `workbench-v<version>` tag on `origin` (GitHub) — the first
// half of a release.
//
// There is no CI any more: GitHub Actions was deleted under ADR-0018 and the
// JihuLab lane was retired under ADR-0021. Nothing listens for this tag and no
// pipeline runs; publishing is a separate, hand-run step:
//   bun run --cwd packages/workbench build:all
//   node scripts/publish-workbench-release.mjs --tag workbench-v<version>
// Read the Workbench package version, independent of the private monorepo root
// version. The old `v*` tag and publish scripts were retired under ADR-0015.
//
// The tag must be on `origin` BEFORE publishing: `publish-workbench-release.mjs`
// passes `--verify-tag` to `gh release create`.
//
// Safety: this is dry-run by default. It prints the tag it would push and exits
// 0. Pass `--push` to actually create and push it — a pushed tag is a real
// public release step, so it never happens by accident.
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
			"请先手改 packages/workbench/package.json 的 version 与 CHANGELOG（.changeset/ 已随 ADR-0015 删除），不要只改 tag。",
	);
	process.exit(1);
}

const tag = `workbench-v${version}`;
console.log(`包：${manifest.name}@${version}`);
console.log(`tag：${tag}`);
console.log(
	"触发：无——CI 已全部退役（ADR-0018 删 GitHub Actions，ADR-0021 退役极狐通道）。" +
		"这个 tag 只是发布的第一步；构建与挂 Release 由本机命令完成。",
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
	console.log(
		"[dry-run] 只推一处：origin 推真实 tag（极狐同树快照已随 ADR-0021 退役）。",
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
console.log(`New tag: ${tag}（origin）`);
console.log(
	"\n下一步（本机执行，没有 CI 会接手）：\n" +
		"  bun run --cwd packages/workbench build:all\n" +
		`  node scripts/publish-workbench-release.mjs --tag ${tag}\n`,
);
