/**
 * 地标复核覆盖率押检：对租户中每个已注册写者，各挑 2 个其拥有的地标随机复
 * 核一次（endorse 概率 ~75%，reject 概率 ~25%，作为混合校准)。
 *
 * 目的：把复核通道从「少数写者给出的点状反馈」扩成「全租户范围的反馈
 * 矩阵」，验证 reviewedCoverage、按写者隔离和最新结论覆盖在规模下仍成立。
 *
 * 不是目的：推动 L1 的 fit。endorsedShare 在这里只会收敛到下面的
 * ENDORSE_PROBABILITY 常数，它度量的是脚本不是用户；fit 账本自 2026-09-10 起
 * 只在 --evidence-kind natural 下为 TF-0154 计 fit（TF-0154 证据栏、TF-0136 提示）。
 *
 * 用法：
 *   bun scripts/e2e/landmark-coverage.ts [--workspace <tenant黑盘>] [--reviews K]
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
await assertLiveAuthorized(projectDir, "地标覆盖率押检需要已有 live 租户标记");
const ws: E2EWorkspace = {
	projectDir,
	entry: resolve(import.meta.dir, "..", "..", "src", "index.ts"),
	agentScript: resolve(import.meta.dir, "live-agent.ts"),
};

const REVIEWS_PER_WRITER = Math.max(1, Number(at("--reviews") ?? "2") || 2);
/** 控制 endorse 占比，25% reject 保证不至于被当全部点赞的橡皮章。 */
const ENDORSE_PROBABILITY = 0.75;

interface SessionsListed {
	writers?: Array<{ writer?: string; id?: string }>;
	sessions?: Array<{ writer?: string; id?: string }>;
}

async function listWriters(): Promise<string[]> {
	const raw = await cliJson<SessionsListed>(ws, ["sessions", "list", "--json"]);
	const arr = raw.writers ?? raw.sessions ?? [];
	const out: string[] = [];
	for (const w of arr) {
		const id = w?.writer ?? w?.id;
		if (typeof id === "string" && id.length > 0) out.push(id);
	}
	return out;
}

async function listHandlesFor(writer: string): Promise<string[]> {
	const listed = await cliJson<{ landmarks?: Array<{ handle: string }> }>(ws, [
		"--json",
		"context",
		"list",
		"--writer",
		writer,
	]);
	const handles = (listed.landmarks ?? []).map((l) => l.handle);
	// 顺序去重,根目录标 "."、src/、src/notes.md 反复出现时只算一次
	return [...new Set(handles)];
}

/** 随机抽 K 个不同下标。 */
function pickK<T>(arr: T[], k: number): T[] {
	if (arr.length <= k) return arr.slice();
	const shuffled = arr.slice();
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
	}
	return shuffled.slice(0, k);
}

const writers = await listWriters();
console.error(`[landmark-coverage] writers=${writers.length}`);

const touched: Array<{
	writer: string;
	handle: string;
	verdict: "endorse" | "reject";
}> = [];
const skipped: Array<{ writer: string; reason: string }> = [];

for (const writer of writers) {
	let handles: string[] = [];
	try {
		handles = await listHandlesFor(writer);
	} catch (e) {
		skipped.push({
			writer,
			reason: `context list failed: ${(e as Error).message}`,
		});
		continue;
	}
	if (!handles.length) {
		skipped.push({ writer, reason: "no landmarks" });
		continue;
	}
	const targets = pickK(handles, REVIEWS_PER_WRITER);
	for (const handle of targets) {
		const isEndorse = Math.random() < ENDORSE_PROBABILITY;
		const verdict: "endorse" | "reject" = isEndorse ? "endorse" : "reject";
		const cmd = await cli(ws, [
			"--json",
			"context",
			"review",
			handle,
			"--writer",
			writer,
			isEndorse ? "--endorse" : "--reject",
			"--reason",
			`覆盖率押检 ${writer.slice(0, 8)}.${handle.slice(-20)}`,
		]);
		if (cmd.code !== 0) {
			skipped.push({
				writer,
				reason: `review failed: ${cmd.stderr.slice(0, 120)}`,
			});
			continue;
		}
		touched.push({ writer, handle, verdict });
	}
}

console.log(
	JSON.stringify(
		{
			writers: writers.length,
			touched: touched.length,
			skipped: skipped.length,
			byVerdict: {
				endorse: touched.filter((t) => t.verdict === "endorse").length,
				reject: touched.filter((t) => t.verdict === "reject").length,
			},
			skipped_reasons: skipped.slice(0, 12),
		},
		null,
		2,
	),
);
