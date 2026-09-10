import { expect, test } from "@playwright/test";

test("settings share cached data, trap focus, and return it on Escape", async ({
	page,
}) => {
	const errors: string[] = [];
	const configRequests: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/config/chat")
			configRequests.push(request.method());
	});
	await page.goto("/");
	const settings = page.getByRole("button", { name: "设置", exact: true });
	for (let i = 0; i < 5; i++) {
		await settings.click();
		const dialog = page.getByRole("dialog", { name: "对话设置" });
		await expect(dialog.getByLabel("模型", { exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await expect(settings).toBeFocused();
	}
	await settings.click();
	const dialog = page.getByRole("dialog", { name: "对话设置" });
	await dialog.getByRole("button", { name: "关闭", exact: true }).focus();
	await page.keyboard.press("Shift+Tab");
	expect(
		await dialog.evaluate((element) =>
			element.contains(document.activeElement),
		),
	).toBe(true);
	await page.keyboard.press("Escape");
	await expect(settings).toBeFocused();
	expect(configRequests.filter((method) => method === "GET")).toHaveLength(1);
	expect(configRequests.filter((method) => method !== "GET")).toHaveLength(0);
	expect(errors).toEqual([]);
});

test("tooltips respond to both hover and keyboard focus", async ({ page }) => {
	await page.goto("/");
	const settings = page.getByRole("button", { name: "设置", exact: true });
	await settings.hover();
	await expect(page.getByRole("tooltip")).toHaveText("对话设置");
	await page.mouse.move(600, 400, { steps: 10 });
	await expect(page.getByRole("tooltip")).toBeHidden();
	await settings.focus();
	await expect(page.getByRole("tooltip")).toHaveText("对话设置");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("tooltip")).toBeHidden();
});

test("planning controls never submit the draft", async ({ page }) => {
	const sends: string[] = [];
	const threadsReady = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/chat/threads" &&
			response.request().method() === "GET",
	);
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			new URL(request.url()).pathname.endsWith("/messages")
		)
			sends.push(request.url());
	});
	await page.goto("/");
	const threads = (await (await threadsReady).json()) as Array<{
		id: string;
		permissionMode: string;
		archived?: boolean;
	}>;
	const candidate = threads.find(
		(thread) =>
			!thread.archived && ["default", "plan"].includes(thread.permissionMode),
	);
	test.skip(
		!candidate,
		"Requires a local conversation in default or plan mode.",
	);
	const row = page.locator(`aside [data-lineage-id="${candidate!.id}"]`);
	await row.getByRole("button").first().click();
	await expect(row).toHaveAttribute("data-active", "true");
	const input = page.getByRole("textbox", { name: "消息", exact: true });
	const plan = page.getByRole("button", { name: /^规划(中)?$/ });
	const original = String(candidate!.permissionMode === "plan");
	await expect(plan).toHaveAttribute("aria-pressed", original);
	const draft = "切换规划模式不应发送这条草稿。";
	await input.fill(draft);
	await plan.click();
	await expect(plan).toHaveAttribute(
		"aria-pressed",
		original === "true" ? "false" : "true",
	);
	await expect(input).toHaveValue(draft);
	await plan.click();
	await expect(plan).toHaveAttribute("aria-pressed", original);
	await expect(input).toHaveValue(draft);
	await input.fill("");
	expect(sends).toEqual([]);
});

for (const width of [320, 390, 768, 1440]) {
	test(`composer stays usable at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 });
		await page.goto("/");
		const input = page.getByRole("textbox", { name: "消息", exact: true });
		await input.fill(
			`多行输入验证\nhttps://example.com/${"long-path/".repeat(15)}`,
		);
		const box = await input.boundingBox();
		expect(box!.width).toBeGreaterThan(Math.min(width - 70, 280));
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		const send = await page
			.getByRole("button", { name: "发送", exact: true })
			.boundingBox();
		expect(send!.x + send!.width).toBeLessThanOrEqual(width);
		await input.fill("");
		if (width < 768) {
			const trigger = page.getByRole("button", { name: "打开对话列表" });
			await trigger.click();
			const dialog = page.getByRole("dialog", { name: "Workbench" });
			await expect(dialog).toBeVisible();
			const rows = dialog.locator("[data-lineage-id]");
			if (await rows.count())
				await rows.first().getByRole("button").first().click();
			else await page.keyboard.press("Escape");
			await expect(dialog).toBeHidden();
			await expect(trigger).toBeFocused();
		}
	});
}

test("reduced motion removes drawer animation", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "对话设置" });
	await expect(dialog).toBeVisible();
	expect(
		await dialog.evaluate((element) =>
			Number.parseFloat(getComputedStyle(element).animationDuration),
		),
	).toBeLessThan(0.001);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
});

test("switching away parks a draft and restoring it keeps the text", async ({
	page,
}) => {
	await page.goto("/");
	await expect(
		page.getByRole("textbox", { name: "消息", exact: true }),
	).toBeVisible();
	const rows = page.locator("aside [data-lineage-id]");
	await expect(rows.first()).toBeVisible();
	test.skip(
		(await rows.count()) < 2,
		"Requires two existing local conversations.",
	);
	const draft = "E2E 草稿恢复：保留输入，不发送消息。";
	await page.getByRole("textbox", { name: "消息", exact: true }).fill(draft);
	await rows.nth(1).getByRole("button").first().click();
	await expect(
		page.getByRole("textbox", { name: "消息", exact: true }),
	).toHaveValue("");
	await rows.first().getByRole("button").first().click();
	await page.getByRole("button", { name: /停放快照/ }).click();
	await page.getByRole("button", { name: "恢复", exact: true }).click();
	await expect(
		page.getByRole("textbox", { name: "消息", exact: true }),
	).toHaveValue(draft);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("");
});
