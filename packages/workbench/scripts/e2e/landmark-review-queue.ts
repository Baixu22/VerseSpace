/**
 * TF-0057 L1 · 自然证据的快速通道：把「等地标被认可」变成一份可过一遍的队列。
 *
 * 为什么需要它：L1 的判据是「地标集合里 80% 以上是用户认可的核心」，这条读数
 * 只能由人产生——脚本或模型安排的手势会把读数收敛到脚本里的常数（2026-09-10
 * 实测 0.08，且随每轮新增地标继续下降），所以它不可能靠采样「等出来」。
 * 能做的只有一件事：把人的成本压到最低——先算清楚有哪些地标、哪些还没复核、
 * 每条长什么样，人只需回答 endorse / reject。
 *
 * 用法：
 *   bun scripts/e2e/landmark-review-queue.ts                       # 打印队列
 *   bun scripts/e2e/landmark-review-queue.ts --out ../../docs/landmark-review-queue.md
 *   bun scripts/e2e/landmark-review-queue.ts --template answers.json   # 生成待填模板
 *   bun scripts/e2e/landmark-review-queue.ts --apply answers.json      # 回填并给出新读数
 *
 * 队列只读：不加 --apply 时它不改黑板。回填走的也是 CLI 同一支手势（human 来源、
 * 只对当前投影有效），所以人回答过的部分才会进 L1 的分母。
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openBlackboard } from "../../src/blackboard";
import { collectInterest } from "../../src/interactions/context";
import {
	collectLandmarkReviews,
	landmarkReviewJudgement,
	reviewLandmark,
} from "../../src/interactions/review";

const argv = Bun.argv.slice(2);
const at = (flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	return index >= 0 ? (argv[index + 1] as string | undefined) : undefined;
};

const workspace = at("--workspace");
const blackboardAt = at("--blackboard")
	? resolve(at("--blackboard") as string)
	: workspace
		? resolve(workspace, ".workbench")
		: null;
if (!blackboardAt) {
	console.error("需要 --workspace <租户> 或 --blackboard <.workbench 目录>");
	process.exit(2);
}

interface QueueRow {
	writer: string;
	handle: string;
	summary: string;
	current: "endorse" | "reject" | null;
}

/**
 * 从投影里取这条地标的摘要：折叠进父目录的子条目只出现在父条目的 collapsed
 * 文本里（`handle（DOI x，编辑 2 次 · …）`），取不到就留空——队列宁可少一句话，
 * 也不自己编一句。
 */
function summaryFor(
	interest: Awaited<ReturnType<typeof collectInterest>>,
	handle: string,
): string {
	const direct = interest.landmarks.find(
		(landmark) => landmark.handle === handle,
	);
	if (direct) return direct.summary;
	for (const landmark of interest.landmarks) {
		const folded = landmark.collapsed.find((entry) =>
			entry.startsWith(`${handle}（`),
		);
		if (folded) return folded.slice(handle.length + 1).replace(/^（|）$/g, "");
	}
	return "";
}

async function buildQueue(): Promise<{
	bb: Awaited<ReturnType<typeof openBlackboard>>;
	rows: QueueRow[];
	starvedWriters: number;
	containerLandmarks: number;
	judgement: ReturnType<typeof landmarkReviewJudgement> & { byWriter: number };
}> {
	const bb = openBlackboard(blackboardAt as string);
	const [writers, events] = await Promise.all([
		bb.sessions.list(),
		bb.events.all(),
	]);
	const reviews = collectLandmarkReviews(events);
	const latest = new Map<string, "endorse" | "reject">();
	for (const review of reviews)
		latest.set(`${review.writer}\u0000${review.handle}`, review.verdict);

	const rows: QueueRow[] = [];
	let total = 0;
	let reviewed = 0;
	let endorsed = 0;
	let starvedWriters = 0;
	let containerLandmarks = 0;
	for (const writer of writers) {
		const interest = await collectInterest(bb, writer.id);
		// 只列真地标（DOI>10）里的文件级条目：L1 的分母就是它。没有地标的写者不是
		// 「没有核心」，而是这一层没触发，单独计数；目录（含项目根）能被推到地标线
		// 以上、也能被复核，但人没法把它回答成「这次干的活的核心」，所以它不进分母，
		// 只记个数——「目录占了多少」这件事本身是标定信号，不能看不见。
		containerLandmarks +=
			interest.landmarkHandles.length - interest.fileLandmarkHandles.length;
		if (interest.fileLandmarkHandles.length === 0) {
			if (interest.visible.length > 0) starvedWriters += 1;
			continue;
		}
		const writerReviews = reviews.filter(
			(review) => review.writer === writer.id,
		);
		const judgement = landmarkReviewJudgement(
			interest.fileLandmarkHandles.map((handle) => ({ handle })),
			writerReviews,
		);
		total += judgement.total;
		reviewed += judgement.reviewed;
		endorsed += judgement.endorsed;
		for (const handle of interest.fileLandmarkHandles) {
			rows.push({
				writer: writer.id,
				handle,
				summary: summaryFor(interest, handle),
				current: latest.get(`${writer.id}\u0000${handle}`) ?? null,
			});
		}
	}
	return {
		bb,
		containerLandmarks,
		rows: rows.sort(
			(a, b) =>
				Number(a.current !== null) - Number(b.current !== null) ||
				a.writer.localeCompare(b.writer) ||
				a.handle.localeCompare(b.handle),
		),
		starvedWriters,
		judgement: {
			total,
			reviewed,
			endorsed,
			rejected: reviewed - endorsed,
			endorsedShare: total > 0 ? endorsed / total : null,
			reviewedCoverage: total > 0 ? reviewed / total : null,
			byWriter: writers.length,
		},
	};
}

const { bb, rows, judgement, starvedWriters, containerLandmarks } =
	await buildQueue();

const applyPath = at("--apply");
if (applyPath) {
	const answers = JSON.parse(
		await readFile(resolve(applyPath), "utf8"),
	) as Array<{
		writer: string;
		handle: string;
		verdict: "endorse" | "reject" | null;
		reason?: string;
	}>;
	let applied = 0;
	const skipped: string[] = [];
	for (const answer of answers) {
		if (answer.verdict !== "endorse" && answer.verdict !== "reject") continue;
		try {
			await reviewLandmark(
				bb,
				answer.writer,
				answer.handle,
				answer.verdict,
				answer.reason,
			);
			applied += 1;
		} catch (error) {
			skipped.push(`${answer.writer}/${answer.handle}: ${String(error)}`);
		}
	}
	console.log(`已回填地标复核 ${applied} 条；跳过 ${skipped.length} 条`);
	for (const line of skipped.slice(0, 10)) console.log(`  跳过：${line}`);
	const after = await buildQueue();
	console.log(
		`L1 读数：认可 ${after.judgement.endorsed} / 全部 ${after.judgement.total} = ${after.judgement.endorsedShare?.toFixed(4) ?? "无样本"}（复核覆盖 ${after.judgement.reviewedCoverage?.toFixed(4) ?? "无样本"}）`,
	);
	if (after.judgement.endorsedShare !== null)
		console.log(
			after.judgement.endorsedShare >= 0.8
				? "L1 判据（≥ 0.8）已满足，可据此收口 TF-0057 的地标验收。"
				: "L1 判据（≥ 0.8）未满足：要改的是地标投影让核心真的进集合，不是阈值也不是分母。",
		);
} else if (at("--template")) {
	// 刻意留空：模板若自带现状，照着点一遍就是一次静默的重新认可，而脚本手势
	// 产生的结论本来就不构成用户认可——必须由人重新回答。
	const template = rows.map((row) => ({
		writer: row.writer,
		handle: row.handle,
		verdict: null,
		reason: "",
	}));
	await writeFile(
		resolve(at("--template") as string),
		`${JSON.stringify(template, null, 1)}\n`,
	);
	console.log(`已写出待填模板：${resolve(at("--template") as string)}`);
	console.log("把 verdict 改成 endorse / reject 后，用 --apply 回填。");
} else {
	const out = at("--out");
	const pending = rows.filter((row) => row.current === null);
	// 默认列全部地标：脚本手势留下的结论也要被人自己的回答覆盖一次，
	// 否则「现状」那一列的 endorse 是脚本的，不是人的。
	const shown = argv.includes("--pending-only") ? pending : rows;
	const lines: string[] = [];
	lines.push("# L1 地标复核队列（TF-0057 验收三的数据源）");
	lines.push("");
	lines.push(`- 黑板：\`${bb.paths.root}\` · 写者 ${judgement.byWriter} 个`);
	lines.push(
		`- 当前读数：认可 ${judgement.endorsed} / 全部地标 ${judgement.total} = ${judgement.endorsedShare?.toFixed(4) ?? "无样本"}；复核覆盖 ${judgement.reviewedCoverage?.toFixed(4) ?? "无样本"}`,
	);
	lines.push(
		`- 待复核 ${pending.length} 条（下表 ${shown.length} 条）。判据：地标集合中 ≥ 80% 是用户认可的「这次干的活的核心」（positioning-v6 §11：地标集合 = DOI>10，本队列只列文件级）。`,
	);
	lines.push(
		`- 另有 ${starvedWriters} 个写者没有任何文件级地标（只有回退可见表，不是地标集合）：这一层没触发，属标定问题，不计入 L1 分母。`,
	);
	if (containerLandmarks > 0)
		lines.push(
			`- 还有 ${containerLandmarks} 条目录地标（\`.\` / \`src\` 这类）被排除在分母外：它们确实过了 DOI>10，但没法被回答成「这次干的活的核心」；这个计数是标定信号，越低越好。`,
		);
	lines.push("");
	lines.push(
		"这一项只能由人回答：脚本与模型安排的手势会把读数收敛到脚本常数，不构成用户认可。下表里已有的结论如果来自脚本，" +
			"只有人自己再答一次才会被覆盖（同一地标取最新结论）。",
	);
	lines.push("");
	lines.push("| 写者 | 地标 | 摘要 | 现状 |");
	lines.push("| --- | --- | --- | --- |");
	for (const row of shown.slice(0, 200))
		lines.push(
			`| \`${row.writer}\` | \`${row.handle}\` | ${row.summary.replace(/\|/g, "/")} | ${row.current ?? "未复核"} |`,
		);
	lines.push("");
	lines.push("回填方式（任选）：");
	lines.push("");
	lines.push("```bash");
	lines.push("# 逐条（CLI 同支手势，human 来源，只对当前投影有效）");
	lines.push(
		"bun packages/workbench/src/index.ts context review <handle> --writer <id> --endorse",
	);
	lines.push("");
	lines.push("# 或整批：生成模板 → 填 verdict → 回填");
	lines.push(
		"bun packages/workbench/scripts/e2e/landmark-review-queue.ts --template answers.json",
	);
	lines.push(
		"bun packages/workbench/scripts/e2e/landmark-review-queue.ts --apply answers.json",
	);
	lines.push("```");
	lines.push("");
	const text = `${lines.join("\n")}\n`;
	if (out) {
		await writeFile(resolve(out), text, "utf8");
		console.log(`wrote ${resolve(out)}`);
	} else {
		process.stdout.write(text);
	}
	console.log(
		`[landmark-queue] 地标 ${judgement.total} 条，待复核 ${pending.length} 条，无地标写者 ${starvedWriters} 个，当前认可率 ${judgement.endorsedShare?.toFixed(4) ?? "无样本"}`,
	);
}
