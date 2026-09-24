import { describe, expect, test } from "bun:test";
import { parseDurationSeconds } from "./duration";

describe("parseDurationSeconds（P0-2：阈值单位解析）", () => {
	test("带单位的时长按秒解析", () => {
		expect(parseDurationSeconds("30s")).toBe(30);
		expect(parseDurationSeconds("15m")).toBe(900);
		expect(parseDurationSeconds("5m")).toBe(300);
		expect(parseDurationSeconds("2h")).toBe(7200);
		expect(parseDurationSeconds("1d")).toBe(86_400);
	});

	test("裸数字按秒，大小写与空格都容忍", () => {
		expect(parseDurationSeconds("45")).toBe(45);
		expect(parseDurationSeconds(" 15M ")).toBe(900);
		expect(parseDurationSeconds("1.5h")).toBe(5400);
	});

	test("解析不了的值返回 null，而不是 0", () => {
		// 关键：把 "5 min" 当成 0 秒会把 checkpointTimeout 变成"立刻超时"，
		// 正是这些配置项本该避免的静默误读。
		expect(parseDurationSeconds("5 min")).toBeNull();
		expect(parseDurationSeconds("")).toBeNull();
		expect(parseDurationSeconds("abc")).toBeNull();
		expect(parseDurationSeconds("0")).toBeNull();
		expect(parseDurationSeconds("-5m")).toBeNull();
		expect(parseDurationSeconds("10w")).toBeNull();
	});
});
