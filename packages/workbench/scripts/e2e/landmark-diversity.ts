/**
 * 地标复核多样性押检：给当前 live-tenant 上每个登过的 writer，随机挑一个 handle + 随机 endors/reject 发一单。
 * 目的：让整理出的 landmarks.endorsedShare 不再是单一 4 条 editor-2..5 × src/notes.md 的负样本，而是按作家合集内多 judgements 拼出的 matrix。
 *
 * 避免重复当前已完成封面：同一份 (writer, handle) 只保留 latest verdict——脚本总是把新 event 追加进去，ledger 的 current 釆取会自动覆盖。
 *
 * 用法：
 *   bun scripts/e2e/landmark-diversity.ts --workspace <tenant黑盘>
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cli, cliJson, type E2EWorkspace } from "./driver";
import { assertLiveAuthorized } from "./live-auth";

const argv = Bun.argv.slice(2);
const at = (flag: string) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const workspaceArg =
	at("--workspace") ?? join(tmpdir(), "workbench-e2e-live-tenant");
const projectDir = String(workspaceArg);
await assertLiveAuthorized(projectDir, "地标复核押检需要已有 live 租户标记");
const ws: E2EWorkspace = {
	projectDir,
	entry: resolve(import.meta.dir, "..", "..", "src", "index.ts"),
	agentScript: resolve(import.meta.dir, "live-agent.ts"),
};

/** 对一位写者取凉意前几个 handle（不用锁定、不需要一致性），随机取一当判据。 */
async function pickHandlesFor(writer: string): Promise<string[]> {
	const listed = await cliJson<{ landmarks?: Array<{ handle: string }> }>(ws, [
		"context",
		"list",
		"--writer",
		writer,
	]);
	return (listed.landmarks ?? []).map((l) => l.handle);
}

const SEED_WRITERS = ["editor-2", "editor-3", "editor-4", "editor-5"] as const;
const VERDICTS: Array<"endorse" | "reject"> = ["endorse", "reject"];

const touched: Array<{ writer: string; handle: string; verdict: string }> = [];
for (const writer of SEED_WRITERS) {
	const handles = await pickHandlesFor(writer);
	if (!handles.length) continue;
	// 随机 2 个 handle（避免始终压同一个 notes.md），每个随机 endors/reject
	for (const handle of handles.slice(0, 2)) {
		const verdict = VERDICTS[Math.floor(Math.random() * VERDICTS.length)]!;
		const cmd = await cli(ws, [
			"--json",
			"context",
			"review",
			handle,
			"--writer",
			writer,
			verdict === "endorse" ? "--endorse" : "--reject",
			"--reason",
			`多样样押检： ${writer.slice(0, 8)}.${handle.slice(-20)}`,
		]);
		if (cmd.code !== 0)
			throw new Error(`review ${writer}.${handle} 失败: ${cmd.stderr}`);
		touched.push({ writer, handle, verdict });
	}
}
console.log(JSON.stringify({ count: touched.length, touched }, null, 2));
