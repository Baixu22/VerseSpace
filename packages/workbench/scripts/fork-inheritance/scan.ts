/**
 * TF-0140 · `--scan`：从真实历史会话里识别 fork 家族并比对继承事实。
 *
 * fork 的磁盘签名是「逐字前缀 + 不同 sessionId」：
 *   - 同一 sessionId 内的 rewind／编辑不新建会话文件 → 不会误入样本；
 *   - 压缩写的是 summary 消息而不是逐字前缀 → 也不会误入样本。
 *
 * 默认排除本脚本 `--live` 自己造的 scratch 会话（临时目录里的 `wb-fork*`）：
 * 否则每跑一次 live 就给自己加一个配对，报告里的分母会漂。`--include-probe` 可保留它们。
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	commonPrefix,
	loadSession,
	type Msg,
	PROJECTS,
	toolIds,
	type Usage,
	usageOf,
} from "./sessions";

/** `--live` 的 scratch 目录名（tmpdir 里的 wb-fork…），默认不计入统计。 */
const PROBE_PROJECT = /-Temp-wb-fork/;

export interface Pair {
	project: string;
	source: string;
	fork: string;
	/** 逐字共享的消息条数（uuid 相同且同序）。 */
	prefixMessages: number;
	sourceTail: number;
	forkTail: number;
	/** 共享前缀里的 tool_use / tool_result id 条数。 */
	toolIds: number;
	/** 两侧共享前缀的 tool id 序列是否完全一致 —— Q3 的判据。 */
	toolIdsIdentical: boolean;
	/** 源会话最后一条前缀内 assistant 的 usage。 */
	prefixUsage: Usage | null;
	/** 分叉后第一条新 assistant 的 usage —— Q2 的原始数字。 */
	forkFirstUsage: Usage | null;
	/** 前缀末轮到分叉首轮的间隔（分钟）；缓存 TTL 是 Q2 的混淆项。 */
	gapMinutes: number | null;
}

interface Loaded {
	project: string;
	id: string;
	path: string;
	mtime: number;
	msgs: Msg[];
}

async function loadAll(includeProbe: boolean): Promise<Loaded[]> {
	const out: Loaded[] = [];
	let projects: string[];
	try {
		projects = await readdir(PROJECTS);
	} catch {
		return out;
	}
	for (const project of projects) {
		if (!includeProbe && PROBE_PROJECT.test(project)) continue;
		let files: string[];
		try {
			files = await readdir(join(PROJECTS, project));
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(PROJECTS, project, file);
			const msgs = await loadSession(path);
			if (msgs.length === 0) continue;
			const stat = await Bun.file(path).stat();
			out.push({
				project,
				id: file.replace(/\.jsonl$/, ""),
				path,
				mtime: stat.mtimeMs,
				msgs,
			});
		}
	}
	return out;
}

function describePair(source: Loaded, fork: Loaded, n: number): Pair {
	const sourceIds: string[] = [];
	const forkIds: string[] = [];
	for (let k = 0; k < n; k += 1) {
		sourceIds.push(...toolIds(source.msgs[k]!));
		forkIds.push(...toolIds(fork.msgs[k]!));
	}
	let prefixUsage: Usage | null = null;
	let prefixAt: string | undefined;
	for (let k = n - 1; k >= 0; k -= 1) {
		if (source.msgs[k]!.type === "assistant") {
			prefixUsage = usageOf(source.msgs[k]!);
			prefixAt = source.msgs[k]!.timestamp;
			break;
		}
	}
	let forkFirstUsage: Usage | null = null;
	let forkAt: string | undefined;
	for (let k = n; k < fork.msgs.length; k += 1) {
		if (fork.msgs[k]!.type === "assistant") {
			forkFirstUsage = usageOf(fork.msgs[k]!);
			forkAt = fork.msgs[k]!.timestamp;
			break;
		}
	}
	const gapMinutes =
		prefixAt && forkAt
			? (Date.parse(forkAt) - Date.parse(prefixAt)) / 60_000
			: null;
	return {
		project: source.project,
		source: source.id,
		fork: fork.id,
		prefixMessages: n,
		sourceTail: source.msgs.length - n,
		forkTail: fork.msgs.length - n,
		toolIds: sourceIds.length,
		toolIdsIdentical:
			sourceIds.length === forkIds.length &&
			sourceIds.every((v, i) => v === forkIds[i]),
		prefixUsage,
		forkFirstUsage,
		gapMinutes: gapMinutes === null ? null : Math.round(gapMinutes * 10) / 10,
	};
}

/** 家族 = 首条消息 uuid 相同的多个会话文件；每个 fork 取共享前缀最长的更早兄弟作最近祖先。 */
export async function scanPairs(includeProbe = false): Promise<Pair[]> {
	const all = await loadAll(includeProbe);
	const families = new Map<string, Loaded[]>();
	for (const s of all) {
		const key = s.msgs[0]!.uuid;
		const list = families.get(key);
		if (list) list.push(s);
		else families.set(key, [s]);
	}
	const pairs: Pair[] = [];
	for (const list of families.values()) {
		if (list.length < 2) continue;
		const byAge = [...list].sort((x, y) => x.mtime - y.mtime);
		for (let i = 1; i < byAge.length; i += 1) {
			const fork = byAge[i]!;
			let best: Loaded | null = null;
			let bestN = -1;
			for (let j = 0; j < i; j += 1) {
				const n = commonPrefix(byAge[j]!.msgs, fork.msgs);
				if (n > bestN) {
					bestN = n;
					best = byAge[j]!;
				}
			}
			if (!best || bestN <= 0) continue;
			pairs.push(describePair(best, fork, bestN));
		}
	}
	return pairs;
}

export function reportScan(pairs: Pair[]): void {
	console.log(`== 真实 fork 家族扫描（${PROJECTS}）==`);
	console.log(`  配对数：${pairs.length}\n`);
	const identical = pairs.filter((p) => p.toolIdsIdentical);
	const withTools = pairs.filter((p) => p.toolIds > 0);
	for (const p of pairs) {
		console.log(`  ${p.project}`);
		console.log(
			`    ${p.source.slice(0, 8)} → ${p.fork.slice(0, 8)}  前缀=${
				p.prefixMessages
			} 源尾=${p.sourceTail} fork尾=${p.forkTail}`,
		);
		console.log(
			`    tool id=${p.toolIds} 序列一致=${p.toolIdsIdentical} 间隔=${
				p.gapMinutes ?? "n/a"
			}min`,
		);
		const u = p.forkFirstUsage;
		if (u) {
			console.log(
				`    fork 首轮 usage: input=${u.input} cacheCreate=${u.cacheCreate} cacheRead=${u.cacheRead}`,
			);
		}
	}
	console.log("\n== Q3 结论 ==");
	console.log(
		`  带工具调用的配对 ${withTools.length}/${pairs.length}；tool id 序列逐字一致 ${
			identical.length
		}/${pairs.length}`,
	);
	console.log(
		"  一致即表示 fork 不重置 tool_use_id 命名空间，按 tool_use_id 建的足迹可 join。",
	);
	console.log("\n== Q2 结论 ==");
	const cached = pairs.filter((p) => (p.forkFirstUsage?.cacheRead ?? 0) > 0);
	console.log(
		`  fork 首轮 cacheRead>0 的配对 ${cached.length}/${pairs.length}；` +
			"缓存 TTL 只有 5 分钟／1 小时，间隔一变数字就变，",
	);
	console.log(
		"  所以 cacheRead 是时序产物而不是继承语义的判据 —— Q2 这个代理指标本身不成立。",
	);
}
