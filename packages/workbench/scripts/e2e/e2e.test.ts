/**
 * 真进程 E2E（一次性现场）：在临时目录里跑完整场景，跑完即清。
 * 租户累积跑见 run.ts；场景本体在 scenario.ts。
 */
import { expect, test } from "bun:test";
import { makeTempWorkspace, runE2E } from "./scenario";

test("E2E：真 CLI + 真 HTTP 服务 + 真 git 写者走完 恢复卡/R10/封印复核/兴趣降低/账本 t0", async () => {
	const ws = await makeTempWorkspace();
	const report = await runE2E(ws);
	if (!report.ok) {
		const failed = report.steps.filter((s) => !s.ok);
		throw new Error(
			`E2E 未走完：${failed.map((s) => `${s.step}: ${s.detail.error}`).join(" | ")}`,
		);
	}
	expect(report.steps.every((step) => step.ok)).toBe(true);
}, 240_000);
