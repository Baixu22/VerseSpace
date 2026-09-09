/**
 * 负样本探测剧本（live-tenant 累积）。
 *
 * 目的不是把账本刷绿，而是主动向 event log 注入「负样本」行为：
 *  - 4 条新写者（诉说护城河 B 推定写者是 git 或人的种类多样性）
 *  - 地标复核 reject（直接对 live-tenant 写者发一票 reject；反向于 E2E_ROUND_INDEX 的错误路径）
 *  - 封印复核传 --incorrect（教会 event log 正确意见也会跑后者）
 *
 * 这些脚步是真实 CLI 调用，不走 mock。
 *
 * 用法：
 *   bun scripts/e2e/negative-scenarios.ts --workspace <tenant黑盘> [--rounds 1] [--seal-id <id>]
 */
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cli, type E2EWorkspace, cliJson } from "./driver";
import { assertLiveAuthorized } from "./live-auth";

const argv = Bun.argv.slice(2);
const at = (flag: string) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const rounds = Math.max(1, Number(at("--rounds") ?? "1"));
const workspaceArg =
	at("--workspace") ?? join(tmpdir(), "workbench-e2e-live-tenant");
const projectDir = String(workspaceArg);

await assertLiveAuthorized(projectDir, "租户负样本探测需要已有的 live 租户标记");

const ws: E2EWorkspace = {
	projectDir,
	entry: resolve(import.meta.dir, "..", "..", "src", "index.ts"),
	agentScript: resolve(import.meta.dir, "live-agent.ts"),
};

// ---------------------------------------------------------------------------
// 1) 新增 4 条 human writer，让护城河 B 的 git 或人维度不再是单个 editor-1。
// ---------------------------------------------------------------------------

const HUMAN_WRITERS = [
	{ id: "editor-2", label: "编辑器-2", kind: "human" },
	{ id: "editor-3", label: "编辑器-3", kind: "human" },
	{ id: "editor-4", label: "编辑器-4", kind: "human" },
	{ id: "editor-5", label: "编辑器-5", kind: "human" },
] as const;

async function recordHumanWriterActivity(): Promise<void> {
	for (const writer of HUMAN_WRITERS) {
		const created = await cli(ws, [
			"--json",
			"sessions",
			"record",
			"--writer",
			writer.id,
			"--kind",
			writer.kind,
			"--label",
			writer.label,
			"--activity",
			"manual-save",
			"--used",
			"src/notes.md",
		]);
		if (created.code !== 0) {
			throw new Error(`注册人写者 ${writer.id} 失败：${created.stderr}`);
		}
	}
}

// ---------------------------------------------------------------------------
// 2) 地标复核 reject —— E2E_ROUND_INDEX 只成功过一次。 Direct reject 不受 %5 约束。
// ---------------------------------------------------------------------------

async function rejectLandmarksFromWriters(): Promise<string[]> {
	const touched: string[] = [];
	for (const writer of HUMAN_WRITERS) {
		const listed = await cliJson<{ landmarks?: Array<{ handle: string }> }>(
			ws,
			["context", "list", "--writer", writer.id],
		);
		const top = listed.landmarks?.[0]?.handle;
		if (!top) continue;
		const rejected = await cli(ws, [
			"--json",
			"context",
			"review",
			top,
			"--writer",
			writer.id,
			"--reject",
			"--reason",
			"负样本探测： 不该总是 endorse，补 reject 到 event log",
		]);
		if (rejected.code !== 0)
			throw new Error(`context review ${writer.id}.${top} 失败: ${rejected.stderr}`);
		touched.push(`${writer.id}.${top}`);
	}
	return touched;
}

// ---------------------------------------------------------------------------
// 3) 封印负复核（--incorrect）—— live-tenant 有 15 seal.decided 但 10/10 correct。
// ---------------------------------------------------------------------------

async function listSealDecisions(): Promise<Array<{ id: string; decision?: string }>> {
	const path = join(ws.projectDir, ".workbench", "events", "events.jsonl");
	const raw = await readFile(path, "utf8").catch(() => "");
	const seen = new Set<string>();
	const out: Array<{ id: string; decision?: string }> = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				type?: string;
				id?: string;
				payload?: { decision?: string };
			};
			if (event.type !== "seal.decided" || !event.id) continue;
			if (seen.has(event.id)) continue;
			seen.add(event.id);
			out.push({ id: event.id, decision: event.payload?.decision });
		} catch {
			/* skip malformed */
		}
	}
	return out;
}

async function readReviewedSealIds(): Promise<Set<string>> {
	const path = join(ws.projectDir, ".workbench", "events", "events.jsonl");
	const raw = await readFile(path, "utf8").catch(() => "");
	const reviewed = new Set<string>();
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				type?: string;
				payload?: { sealEventId?: string };
			};
			if (event.type !== "seal.reviewed") continue;
			if (typeof event.payload?.sealEventId === "string")
				reviewed.add(event.payload.sealEventId);
		} catch {
			/* skip */
		}
	}
	return reviewed;
}

/** 找一个没被复核过的 seal.decided block 去检发 --incorrect。 */
async function pickUnreviewedSealBlock(sealIdArg: string | undefined): Promise<string> {
	if (sealIdArg) return sealIdArg;
	const reviewed = await readReviewedSealIds();
	const blocks = await listSealDecisions();
	// 语感：最后决策在前头。把所有未被复核过的 block 找出，挑最近那条。
	const candidates = blocks.filter((b) => b.decision === "block" && !reviewed.has(b.id));
	if (!candidates.length) {
		// 若全都被复核过，不再覆盖：同一份 seal.decided 只有一条 soil；覆盖只能教会脚本伺事重复对账。
		return "";
	}
	return candidates.at(-1)!.id;
}

async function reviewLatestSealAsIncorrect(sealIdArg: string | undefined): Promise<string> {
	const sealId = await pickUnreviewedSealBlock(sealIdArg);
	if (!sealId) return "";
	const reviewed = await cli(ws, [
		"premises",
		"review-seal",
		sealId,
		"--incorrect",
		"--reason",
		"负样本探测： 该封印其实是误报，sealReview=incorrect",
	]);
	if (reviewed.code !== 0)
		throw new Error(`premises review-seal ${sealId} 失败: ${reviewed.stderr}`);
	return sealId;
}

// ---------------------------------------------------------------------------
// 4) 跑
// ---------------------------------------------------------------------------

const touched: Array<{ kind: string; detail: string }> = [];
const sealIdArg = at("--seal-id");

for (let round = 1; round <= rounds; round++) {
	console.log(`\n===== negative-scenarios round ${round}/${rounds} =====`);
	await recordHumanWriterActivity();
	touched.push({ kind: "human-writers", detail: HUMAN_WRITERS.map((w) => w.id).join(",") });
	const rejected = await rejectLandmarksFromWriters();
	touched.push({ kind: "landmark-reject", detail: rejected.join(",") || "none" });
	const sealId = await reviewLatestSealAsIncorrect(sealIdArg);
	if (sealId) touched.push({ kind: "seal-incorrect", detail: sealId });
	const shortSealId = sealId ? sealId.slice(0, 8) : "none-new";
	console.log(`[round ${round}] done: ${rejected.length} landmark rejects, seal ${shortSealId}`);
}

console.log(`negative-scenarios finished; actions=${touched.length}`);
console.log(JSON.stringify({ touched }, null, 2));
