// Publish a Workbench release from a dist/ directory that already holds the
// four cross-compiled binaries plus NOTICE / LICENSE / LICENSE-APACHE.
//
// Used by the JihuLab `release-publish` job (the GitHub Actions release lane
// has no runner while the account's Actions quota is exhausted) and runnable
// by hand after `cd packages/workbench && bun run build:all`.
//
// It creates the GitHub Release for the `workbench-v<version>` tag, with the
// matching CHANGELOG section as notes plus a platform-coverage note: the
// binaries are cross-compiled on one Windows host, so macOS / Linux are built
// but not exercised. A checksum file rides along with the assets.
//
// Usage:
//   node scripts/publish-workbench-release.mjs --tag workbench-v0.3.1 [--dist packages/workbench/dist] [--dry-run]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i === -1 ? null : args[i + 1];
};
const dryRun = args.includes("--dry-run");
const tag = flag("--tag") ?? process.env.CI_COMMIT_TAG ?? "";
const root = process.cwd();
const dist = path.resolve(root, flag("--dist") ?? "packages/workbench/dist");

const m = /^workbench-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!m) {
	console.error(
		`--tag 必须是 workbench-v<semver>，收到：${JSON.stringify(tag)}`,
	);
	process.exit(1);
}
const version = m[1];

const manifest = JSON.parse(
	fs.readFileSync(path.join(root, "packages/workbench/package.json"), "utf8"),
);
if (manifest.version !== version) {
	console.error(
		`tag 版本 ${version} 与 packages/workbench/package.json 的 ${manifest.version} 不一致。`,
	);
	process.exit(1);
}

const REQUIRED = [
	"workbench-windows-x64.exe",
	"workbench-linux-x64",
	"workbench-macos-arm64",
	"workbench-macos-x64",
	"NOTICE",
	"LICENSE",
	"LICENSE-APACHE",
];
const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(dist, f)));
if (missing.length) {
	console.error(`dist 缺少发行物：${missing.join(", ")}（${dist}）`);
	process.exit(1);
}

const sums = REQUIRED.filter((f) => f.startsWith("workbench-")).map((f) => {
	const hash = createHash("sha256")
		.update(fs.readFileSync(path.join(dist, f)))
		.digest("hex");
	return `${hash}  ${f}`;
});
const sumsPath = path.join(dist, "SHA256SUMS");
fs.writeFileSync(sumsPath, `${sums.join("\n")}\n`);

const changelog = fs.readFileSync(
	path.join(root, "packages/workbench/CHANGELOG.md"),
	"utf8",
);
const section = changelog
	.split(/^## /m)
	.map((chunk) => chunk.trim())
	.find((chunk) => chunk.startsWith(`${version}\n`));
const body = section
	? section.slice(version.length).trim()
	: `（CHANGELOG 中没有 ${version} 段落）`;

const notes = `${body}

---

**平台覆盖说明。** 四个二进制由一台 Windows 主机用 Bun 交叉编译（JihuLab 自托管 runner，见 \`.gitlab-ci.yml\`）。
只有 windows-x64 在构建前跑过完整测试；linux-x64、macos-arm64、macos-x64 只做了构建，没有在对应平台上执行过。
校验和见 \`SHA256SUMS\`。
`;

const notesPath = path.join(os.tmpdir(), `workbench-release-${version}.md`);
fs.writeFileSync(notesPath, notes);

const assets = [...REQUIRED, "SHA256SUMS"].map((f) => path.join(dist, f));
const cmd = [
	"release",
	"create",
	tag,
	...assets,
	"--verify-tag",
	"--title",
	`Workbench ${version}`,
	"--notes-file",
	notesPath,
];

console.log(`tag：${tag}`);
console.log(`dist：${dist}`);
console.log(`assets：${assets.map((a) => path.basename(a)).join(", ")}`);
console.log(`notes：${notesPath}`);
if (dryRun) {
	console.log(`\n[dry-run] gh ${cmd.join(" ")}`);
	process.exit(0);
}
execFileSync("gh", cmd, { stdio: "inherit" });
