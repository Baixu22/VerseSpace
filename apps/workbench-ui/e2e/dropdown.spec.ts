import { expect, test } from "@playwright/test";

for (const viewport of [
	{ width: 1440, height: 1000 },
	{ width: 390, height: 844 },
	{ width: 320, height: 360 },
]) {
	test(`dropdown stays in the viewport at ${viewport.width}x${viewport.height}`, async ({
		page,
	}) => {
		const writes: string[] = [];
		page.on("request", (request) => {
			if (request.method() === "PATCH") writes.push(request.url());
		});
		await page.setViewportSize(viewport);
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await page.goto("/");
		await page.getByRole("button", { name: "设置", exact: true }).click();
		const provider = page.getByRole("combobox", {
			name: "提供商",
			exact: true,
		});
		const original = await provider.innerText();
		await provider.click();
		const menu = page.getByRole("listbox");
		await expect(menu).toBeVisible();
		expect(
			await menu.evaluate((element) =>
				Number.parseFloat(getComputedStyle(element).animationDuration),
			),
		).toBe(0.14);
		await expect(menu.getByRole("option")).toHaveCount(4);
		await expect(menu.getByRole("option", { selected: true })).toHaveText(
			new RegExp(original),
		);
		const box = await menu.boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
		expect(box!.y).toBeGreaterThanOrEqual(0);
		expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
		await page.keyboard.press("End");
		await expect(menu.getByRole("option").last()).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(provider).toBeFocused();
		await expect(provider).toHaveText(original);
		await expect(page.getByRole("dialog", { name: "对话设置" })).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(menu).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(menu).toBeHidden();
		await expect(provider).toBeFocused();
		expect(writes).toEqual([]);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden();
	});
}

test("dropdown honors reduced motion", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("combobox", { name: "提供商", exact: true }).click();
	const menu = page.getByRole("listbox");
	await expect(menu).toBeVisible();
	expect(
		await menu.evaluate((element) =>
			Number.parseFloat(getComputedStyle(element).animationDuration),
		),
	).toBeLessThan(0.001);
});

test("dropdown choices persist through the actual settings API", async ({
	page,
}) => {
	test.skip(
		process.env.WORKBENCH_E2E_CONFIG_SANDBOX !== "1",
		"Run only against an isolated workspace configured with openai-responses and high effort.",
	);
	await page.goto("/");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const select = async (name: string, option: string) => {
		const saved = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/config/chat" &&
				response.request().method() === "PATCH",
		);
		await page.getByRole("combobox", { name, exact: true }).click();
		await page.getByRole("option", { name: option, exact: true }).click();
		const response = await saved;
		expect(response.ok()).toBe(true);
		return response.json();
	};
	expect((await select("提供商", "Claude Code · 本机")).provider).toBe(
		"claude",
	);
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "提供商", exact: true }),
	).toHaveText("Claude Code · 本机");
	await select("提供商", "OpenAI · Responses");
	await expect(
		page.getByRole("combobox", { name: "推理力度", exact: true }),
	).toHaveText("高");
	expect(await select("推理力度", "默认")).not.toHaveProperty("effort");
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "推理力度", exact: true }),
	).toHaveText("默认");
});
