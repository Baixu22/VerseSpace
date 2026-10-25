import { expect, test } from "@playwright/test";

const states = [
	{
		name: "current",
		title: "e2e artifact current",
		path: "consumer-current.txt",
		status: "current",
		label: "检查当前",
		origin: "来源已观察",
		input: "输入一致",
	},
	{
		name: "stale",
		title: "e2e artifact stale",
		path: "consumer-stale.txt",
		status: "stale",
		label: "需要重验",
		origin: "来源已观察",
		input: "输入有变化",
	},
	{
		name: "unknown",
		title: "e2e artifact unknown",
		path: "consumer-unknown.txt",
		status: "unknown",
		label: "无法确认",
		origin: "仅有文件采样",
		input: "输入一致",
	},
] as const;

async function restorePayload(
	page: import("@playwright/test").Page,
	id: string,
) {
	return page.evaluate(async (threadId) => {
		const boot = await fetch("/api/bootstrap").then((response) =>
			response.json(),
		);
		return fetch(`/api/chat/threads/${threadId}`, {
			headers: { "x-workbench-token": boot.token },
		}).then((response) => response.json());
	}, id);
}

test("artifact restore cards expose source, scope, target and copy-only revalidation", async ({
	context,
	page,
}, testInfo) => {
	await page.goto("/");
	await context.grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: new URL(page.url()).origin,
	});

	for (const state of states) {
		const row = page
			.locator("aside [data-lineage-id]")
			.filter({ hasText: state.title })
			.first();
		await expect(row).toBeVisible();
		await row.getByRole("button").first().click();

		const card = page.getByRole("region", { name: "产物检查" });
		const item = card.locator(`[data-artifact-status="${state.status}"]`);
		await expect(item).toBeVisible();
		await expect(item.getByText(state.path, { exact: true })).toBeVisible();
		await expect(
			item.getByText(state.label, { exact: true }).first(),
		).toBeVisible();
		await expect(
			item.getByText(state.origin, { exact: true }).first(),
		).toBeVisible();
		await expect(item.getByText(state.input, { exact: true })).toBeVisible();
		await expect(card.getByText("查看或复制不会清除待重验状态")).toBeVisible();
		if (state.status !== "current")
			await expect(card.getByText("检查当前", { exact: true })).toHaveCount(0);

		await page.screenshot({
			path: testInfo.outputPath(`artifact-${state.name}.png`),
			fullPage: true,
		});
	}

	const staleRow = page
		.locator("aside [data-lineage-id]")
		.filter({ hasText: "e2e artifact stale" })
		.first();
	await staleRow.getByRole("button").first().click();
	const threadId = await staleRow.getAttribute("data-lineage-id");
	expect(threadId, "stale artifact thread id is required").toBeTruthy();
	const before = await restorePayload(page, threadId!);
	const card = page.getByRole("region", { name: "产物检查" });
	await card.getByText("查看检查依据与重验命令").click();
	await card
		.getByRole("button", { name: /复制 consumer-stale\.txt 的重验命令/ })
		.click();
	await expect(
		card.getByText("workbench checkpoint revalidate e2e-artifact-stale", {
			exact: true,
		}),
	).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("workbench checkpoint revalidate e2e-artifact-stale");
	const after = await restorePayload(page, threadId!);
	expect(after.artifactReviews).toEqual(before.artifactReviews);
	expect(
		after.artifactReviews.items.find(
			(item: { checkpointId: string }) =>
				item.checkpointId === "e2e-artifact-stale",
		),
	).toMatchObject({ status: "stale" });
});
