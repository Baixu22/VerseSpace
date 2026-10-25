import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, judge } from "./judge.mjs";
import { runNaive } from "./naive.mjs";

test("strong native baseline exercises every frozen case without unsafe acceptance", () => {
	const result = judge(fixture.cases.map(runNaive));
	assert.equal(result.errors, 0);
	assert.equal(result.unknown, 0);
	assert.equal(result.costBudgetExceeded, 1);
	assert.ok(new Set(fixture.cases.map((r) => r.category)).size >= 8);
});
test("oracle rejects false acceptance, false rejection and source substitution", () => {
	const rows = fixture.cases.map(runNaive);
	const swap = structuredClone(rows);
	swap.find((r) => r.id === "cross-file").consumable = true;
	swap.find((r) => r.id === "normal").consumable = false;
	swap.find((r) => r.id === "late-origin").originInput = "wrong";
	assert.equal(judge(swap).falseCurrent, 1);
	assert.equal(judge(swap).falseReject, 1);
	assert.equal(judge(swap).sourceMisattribution, 1);
});
test("unknown does not count as a successful protection and cannot masquerade as a complete row set", () => {
	const rows = fixture.cases.map(runNaive);
	rows.find((r) => r.id === "cross-file").consumable = null;
	assert.equal(judge(rows).unknown, 1);
	assert.throws(() => judge(rows.slice(1)), /incomplete/);
	assert.throws(() => judge([...rows.slice(1), rows[1]]), /duplicate/);
});
