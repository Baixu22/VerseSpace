import { describe, expect, test } from "bun:test";
import type { VerificationStrategy } from "../types/goal";
import {
	DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
	resolveTimeoutSeconds,
} from "./index";

/**
 * P0-2：`thresholds.checkpointTimeout` 以前没有任何消费者——默认值恰好等于
 * 常量 300s，所以"默认看起来生效"，把配置改成别的值却什么也不发生。
 * 这里钉住优先级：checkpoint 自己声明 > 调用方默认（配置）> 模块常量。
 */
describe("resolveTimeoutSeconds（P0-2：checkpointTimeout 真的生效）", () => {
	test("checkpoint 自己声明的 timeout 最优先", () => {
		const verification: VerificationStrategy = {
			strategy: "test",
			timeout: 42,
		};
		expect(resolveTimeoutSeconds(verification, 900)).toBe(42);
	});

	test("checkpoint 没声明时用调用方传入的配置值", () => {
		const verification: VerificationStrategy = { strategy: "test" };
		expect(resolveTimeoutSeconds(verification, 900)).toBe(900);
		// 之前这里会被忽略，永远回落到 300。
		expect(resolveTimeoutSeconds(verification, 900)).not.toBe(
			DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
		);
	});

	test("两边都没有才回落到模块常量", () => {
		expect(resolveTimeoutSeconds({ strategy: "test" })).toBe(
			DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
		);
		expect(resolveTimeoutSeconds(undefined)).toBe(
			DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
		);
		// 配置里写了非法时长时，parseDurationSeconds 返回 null，调用方传 undefined，
		// 于是回落到常量而不是 0。
		expect(resolveTimeoutSeconds({ strategy: "test" }, undefined)).toBe(
			DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
		);
	});
});
