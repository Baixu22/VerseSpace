import type { Command } from "commander";
import {
	readAllSessionContinuity,
	readSessionContinuity,
	type SessionContinuity,
} from "../chat/continuity";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

/**
 * 会话延续性的 CLI 面。
 *
 * 「这条会话还能不能被信任着继续」现在的答案散在三个地方：线程 meta 的
 * status、消息文件的最后一条是谁说的、事件日志里的中断与通知投递。这个命令
 * 把它们折成一份读数，并在 state = review 时逐条说出原因。
 *
 * 它是查询，不执行任何补救动作：不重跑、不重投、不动线程。
 */

const STATE_LABEL: Record<SessionContinuity["state"], string> = {
	intact: "无待办观察",
	review: "需要人看一眼",
	unknown: "无法判定（材料不足）",
};

/**
 * 列表里的行首标记：`!` 会话本身需要人看，`?` 材料不足，`~` 只有投递积压，
 * `-` 三者都没有。投递积压单独一维——它常常是同一个后端在几十条旧会话上的
 * 同一个事实，混进 `!` 会让真正的断点看不见。
 */
function flagOf(row: SessionContinuity): string {
	if (row.state === "review") return "!";
	if (row.state === "unknown") return "?";
	if (row.delivery.pendingNotices > 0) return "~";
	return "-";
}

function describeIdentity(row: SessionContinuity): string {
	const lane = row.identity.lane ?? "未绑定车道";
	const session = row.identity.providerSessionId
		? `会话 ${row.identity.providerSessionId.slice(0, 8)}`
		: "无 provider 会话身份";
	const resume = row.identity.resumable ? "可续" : "不可续";
	return `${lane} · ${session} · ${resume}`;
}

function printDetail(row: SessionContinuity): void {
	console.log(`${row.title}（${row.threadId}）`);
	console.log(`  读取时刻：${row.readAt}`);
	console.log(`  身份：${describeIdentity(row)}`);
	const lineage: string[] = [];
	if (row.identity.lineage.forkedFrom) {
		lineage.push(`分叉自 ${row.identity.lineage.forkedFrom}`);
	}
	if (row.identity.lineage.promotedAs) {
		lineage.push(`已命名「${row.identity.lineage.promotedAs}」`);
	}
	if (row.identity.lineage.adoptedSnapshot) {
		lineage.push(`收养快照 ${row.identity.lineage.adoptedSnapshot}`);
	}
	if (lineage.length > 0) {
		console.log(`  血统：${lineage.join("；")}`);
	}
	console.log(
		`  回合：完成 ${row.turns.completed} 轮，最近一条 ${row.turns.lastAt ?? "无"}${
			row.turns.open ? "，末条是人类消息（未获回复）" : ""
		}`,
	);
	console.log(
		`  通知：待投递 ${row.delivery.pendingNotices} 条，已投递 ${row.delivery.deliveredNotices} 次`,
	);
	for (const file of row.delivery.pendingPaths.slice(0, 5)) {
		console.log(`    ~ ${file}`);
	}
	if (row.delivery.pendingPaths.length > 5) {
		console.log(`    …另 ${row.delivery.pendingPaths.length - 5} 个文件`);
	}
	for (const interruption of row.turns.interruptions) {
		console.log(
			`  中断：${interruption.at}（${interruption.reason}，${
				interruption.messageCount === null
					? "条数未记录"
					: `${interruption.messageCount} 条消息`
			}）· ${interruption.recovered ? "之后已回复" : "之后没有回复"}`,
		);
	}
	console.log(`  状态：${STATE_LABEL[row.state]}`);
	for (const reason of row.because) {
		console.log(`    · ${reason}`);
	}
	for (const unknown of row.unknowns) {
		console.log(`    ? ${unknown}`);
	}
	if (row.refs.length > 0) {
		console.log(`  可核对：${row.refs.join("、")}`);
	}
}

export async function sessionsContinuityCommand(
	thread: string | undefined,
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();

	if (thread) {
		const row = await readSessionContinuity(bb, thread);
		if (opts.json) {
			emitJson({ continuity: row });
			return;
		}
		if (opts.quiet) {
			return;
		}
		printDetail(row);
		return;
	}

	const { rows, summary } = await readAllSessionContinuity(bb);
	if (opts.json) {
		emitJson({ summary, continuity: rows });
		return;
	}
	if (opts.quiet) {
		return;
	}
	if (rows.length === 0) {
		console.log("（还没有对话线程）");
		return;
	}
	for (const row of rows) {
		const flag = flagOf(row);
		const reason = [...row.because, ...row.unknowns][0] ?? "";
		const pending =
			row.delivery.pendingNotices > 0
				? `  · 未投递通知 ${row.delivery.pendingPaths.length} 个文件`
				: "";
		console.log(
			`${flag} ${row.threadId}  ${row.title}${
				row.archived ? "（已归档）" : ""
			}  ${describeIdentity(row)}${reason ? `  · ${reason}` : ""}${pending}`,
		);
	}
	console.log(
		`共 ${summary.total} 条会话：无待办观察 ${summary.intact} · 需要人看一眼 ${summary.review} · 材料不足 ${summary.unknown} · 有未投递通知 ${summary.pending}`,
	);
}
