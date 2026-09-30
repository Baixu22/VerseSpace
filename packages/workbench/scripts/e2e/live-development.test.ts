import { expect, test } from "bun:test";
import { assertFreshSeal } from "./live-development";

test("live reread acceptance rejects a still-stale warning instead of accepting unblocked alone", () => {
	expect(() =>
		assertFreshSeal({ blocked: false, hit: true, decision: "warn" }),
	).toThrow("warn");
	expect(() =>
		assertFreshSeal({ blocked: false, hit: true, decision: "pass" }),
	).toThrow();
	expect(() =>
		assertFreshSeal({ blocked: true, hit: true, decision: "block" }),
	).toThrow();
	expect(() =>
		assertFreshSeal({ blocked: false, hit: false, decision: "pass" }),
	).not.toThrow();
});
