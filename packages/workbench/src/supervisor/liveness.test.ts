import { describe, expect, test } from "bun:test";
import {
	HEARTBEAT_INTERVAL_MS,
	type LivenessVerdict,
	STALL_MS,
	UNRESPONSIVE_MS,
	watchLiveness,
} from "./liveness";
import { spawnSupervised } from "./process";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A clock the test moves by hand, so silence windows are exact. */
function fakeClock(start = 1_000_000) {
	let value = start;
	return {
		now: () => value,
		advance: (ms: number) => {
			value += ms;
		},
	};
}

describe("supervisor 存活心跳（TF-0205）", () => {
	test("默认阈值是支线那套：15s 心跳、45s 软阈值、135s 判死", () => {
		expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
		expect(STALL_MS).toBe(45_000);
		expect(UNRESPONSIVE_MS).toBe(135_000);
	});

	test("静默先报 stalled，继续静默才判死；两者都只报一次", async () => {
		const clock = fakeClock();
		const verdicts: LivenessVerdict[] = [];
		const watch = watchLiveness({
			tickMs: 5,
			stallMs: 40,
			unresponsiveMs: 120,
			now: clock.now,
			onVerdict: (v) => verdicts.push(v),
		});
		try {
			await sleep(15);
			expect(verdicts).toHaveLength(0); // 还在容忍窗口内

			clock.advance(50);
			await sleep(20);
			expect(verdicts.map((v) => v.kind)).toEqual(["stalled"]);

			clock.advance(200);
			await sleep(20);
			expect(verdicts.map((v) => v.kind)).toEqual(["stalled", "unresponsive"]);
			expect(
				(verdicts[1] as { silentMs: number }).silentMs,
			).toBeGreaterThanOrEqual(120);

			// 判死之后再静默也不会重复上报
			clock.advance(500);
			await sleep(20);
			expect(verdicts).toHaveLength(2);
		} finally {
			watch.stop();
		}
	});

	test("有事件就把静默窗口清零：长工具调用不会被误报", async () => {
		const clock = fakeClock();
		const verdicts: LivenessVerdict[] = [];
		const watch = watchLiveness({
			tickMs: 5,
			stallMs: 40,
			unresponsiveMs: 120,
			now: clock.now,
			onVerdict: (v) => verdicts.push(v),
		});
		try {
			for (let round = 0; round < 3; round++) {
				clock.advance(30);
				watch.note();
				await sleep(10);
			}
			expect(verdicts).toHaveLength(0);

			// stalled 上报之后如果又来事件，下一次静默要重新报，而不是永久闭嘴
			clock.advance(50);
			await sleep(20);
			expect(verdicts.map((v) => v.kind)).toEqual(["stalled"]);
			watch.note();
			clock.advance(50);
			await sleep(20);
			expect(verdicts.map((v) => v.kind)).toEqual(["stalled", "stalled"]);
		} finally {
			watch.stop();
		}
	});

	test("管道损坏不立即判死，但也不冻结静默窗口", async () => {
		const clock = fakeClock();
		const verdicts: LivenessVerdict[] = [];
		const watch = watchLiveness({
			tickMs: 5,
			stallMs: 40,
			unresponsiveMs: 120,
			now: clock.now,
			onVerdict: (v) => verdicts.push(v),
		});
		try {
			watch.pipeBroken("EPIPE on stdin write");
			expect(verdicts.map((v) => v.kind)).toEqual(["pipe_broken"]);
			// 同一件事重复报没有意义
			watch.pipeBroken("EPIPE again");
			expect(verdicts.filter((v) => v.kind === "pipe_broken")).toHaveLength(1);

			// EPIPE 不是死亡证明（对端可能只是某条管道抽了一下），所以它本身
			// 不判死；但静默窗口照旧在跑 —— 对端真走了，接下来必然是静默。
			clock.advance(50);
			await sleep(20);
			expect(verdicts.map((v) => v.kind)).toEqual(["pipe_broken", "stalled"]);
			clock.advance(200);
			await sleep(20);
			expect(verdicts.map((v) => v.kind)).toEqual([
				"pipe_broken",
				"stalled",
				"unresponsive",
			]);
		} finally {
			watch.stop();
		}
	});

	test("对端真的走了才是终局，且会注明之前坏过管道", async () => {
		const verdicts: LivenessVerdict[] = [];
		const watch = watchLiveness({
			tickMs: 1000,
			stallMs: 40,
			unresponsiveMs: 120,
			onVerdict: (v) => verdicts.push(v),
		});
		try {
			watch.pipeBroken("EPIPE on stdin write");
			watch.exited("子进程退出码 3");
			const exited = verdicts.at(-1);
			expect(exited?.kind).toBe("exited");
			expect((exited as { afterPipeBreak: boolean }).afterPipeBreak).toBe(true);
			// 退出之后不再有任何上报
			const count = verdicts.length;
			watch.pipeBroken("EPIPE after exit");
			expect(verdicts).toHaveLength(count);
		} finally {
			watch.stop();
		}
	});

	test("真子进程：活着时输出算心跳，退出是一条 exited", async () => {
		const verdicts: LivenessVerdict[] = [];
		let watch: ReturnType<typeof watchLiveness> | null = null;
		const proc = spawnSupervised(
			[
				process.execPath,
				"-e",
				String.raw`
process.stdout.write("tick\n");
setTimeout(() => { process.stdout.write("tick\n"); process.exit(3); }, 150);
`,
			],
			{
				label: "liveness-test",
				onLine: () => {
					watch?.note();
				},
			},
		);
		watch = watchLiveness({
			tickMs: 20,
			// 阈值远大于这个子进程的寿命：这条用例要证的是「真实退出会走到
			// exited」，不是静默判死（后者由上面用假时钟精确覆盖）。
			stallMs: 2_000,
			unresponsiveMs: 6_000,
			onVerdict: (v) => verdicts.push(v),
		});
		try {
			const outcome = await proc.wait();
			watch.exited(`退出码 ${outcome.exitCode}`);
			expect(outcome.exitCode).toBe(3);
			expect(verdicts.map((v) => v.kind)).toEqual(["exited"]);
		} finally {
			watch.stop();
			await proc.kill();
		}
	});
});
