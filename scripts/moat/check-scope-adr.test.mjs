import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check-scope-adr.mjs", import.meta.url));

const ADR_BODY = `# ADR-0026

- 补充 ADR-0010 与 ADR-0025。

| 事实 |
| --- |
| Observed input |
| Declared origin |
| Verified artifact |
| Target applicability |

保证范围只覆盖 Workbench 管理的验收消费。裸编辑器、Git 直接操作、无审批写入不在保证内。
ADR-0024 的非 Windows 实机验证与真人研究不恢复。不做全仓写保护。

只有阶段一的独立 judge 指出强朴素方案确实覆盖不到缺口时，才按各自读数推进。
`;

const INDEX_ROW =
	"| [0026](./0026-input-origin-and-artifact-use.md) | 四类事实 | 已接受 | TF-0284 |";

function fixture({
	adr = ADR_BODY,
	index = INDEX_ROW,
	readme = "ADR 0001–0026",
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "wb-scope-adr-"));
	mkdirSync(join(root, "docs", "decisions"), { recursive: true });
	if (adr !== null)
		writeFileSync(
			join(root, "docs", "decisions", "0026-input-origin-and-artifact-use.md"),
			adr,
		);
	writeFileSync(
		join(root, "docs", "decisions", "README.md"),
		`| 编号 |\n| --- |\n${index}\n`,
	);
	writeFileSync(join(root, "README.md"), `${readme}\n`);
	return root;
}

function run(root) {
	const result = spawnSync(
		process.execPath,
		[SCRIPT, "--json", "--root", root],
		{ encoding: "utf8" },
	);
	return { status: result.status, report: JSON.parse(result.stdout) };
}

function withFixture(options, assertion) {
	const root = fixture(options);
	try {
		assertion(root);
	} finally {
		rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 40,
			retryDelay: 250,
		});
	}
}

test("a complete ADR, index row and README range read as clean", () => {
	withFixture({}, (root) => {
		const { status, report } = run(root);
		assert.equal(status, 0);
		assert.equal(report.status, "clean");
		assert.equal(report.failures, 0);
	});
});

test("dropping one fact kind turns the check red instead of passing on the rest", () => {
	withFixture(
		{ adr: ADR_BODY.replace("| Target applicability |", "| merge result |") },
		(root) => {
			const { status, report } = run(root);
			assert.equal(status, 1);
			assert.ok(
				report.rows.some(
					(row) => row.id === "fact-target-applicability" && !row.ok,
				),
			);
		},
	);
});

test("an index row that names another node is drift", () => {
	withFixture({ index: INDEX_ROW.replace("TF-0284", "TF-9999") }, (root) => {
		const { status, report } = run(root);
		assert.equal(status, 1);
		assert.ok(report.rows.some((row) => row.id === "index-node" && !row.ok));
	});
});

test("a README that still stops at 0025 is drift", () => {
	withFixture({ readme: "ADR 0001–0025" }, (root) => {
		const { status } = run(root);
		assert.equal(status, 1);
	});
});

test("a missing ADR is cannot-measure, never clean", () => {
	withFixture({ adr: null }, (root) => {
		const { status, report } = run(root);
		assert.equal(status, 2);
		assert.equal(report.status, "cannot-measure");
	});
});
