import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Run against the fixture lane; no live credentials or writes are involved.
const origin = process.env.ATTENTION_ORIGIN ?? "http://127.0.0.1:3118";
const output = process.env.ATTENTION_SHOTS ?? "/tmp/tedix-attention-shots";
const server = process.env.ATTENTION_ORIGIN
	? null
	: spawn(
			"../../node_modules/.bin/vp",
			["dev", "--port", "3118", "--strictPort", "--host", "127.0.0.1"],
			{
				cwd: new URL("../", import.meta.url).pathname,
				stdio: ["ignore", "ignore", "inherit"],
				detached: true,
			},
		);
await mkdir(output, { recursive: true });
let browser;
try {
	for (let i = 0; i < 300; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		if (server?.exitCode != null) throw new Error("Fixture server exited");
		await Bun.sleep(200);
	}
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1440, height: 1100 },
	});
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(`${origin}/work/attention`);
	await page.locator("[data-attention-live]").waitFor();
	await page.reload();
	await page.locator("[data-attention-live]").waitFor();
	const paint = await page.evaluate(
		() =>
			performance
				.getEntriesByType("paint")
				.find((p) => p.name === "first-paint")?.startTime,
	);
	assert.ok(
		paint !== undefined && paint <= 1500,
		`warm first paint ${paint}ms exceeds 1500ms`,
	);
	const moving = page.getByRole("region", { name: "Running", exact: true });
	assert.doesNotMatch(
		await page.locator("[data-attention-live]").innerText(),
		/\b(laptop|offline|asleep|Lead|Aaron)\b/i,
	);
	const elapsed = moving.locator("time").first();
	const before = await elapsed.innerText();
	await page.waitForFunction(
		({ element, initial }) => element.innerText !== initial,
		{ element: await elapsed.elementHandle(), initial: before },
	);
	assert.notEqual(
		await elapsed.innerText(),
		before,
		"elapsed timer did not tick",
	);
	await page
		.getByRole("textbox", { name: "Focus today", exact: true })
		.fill("Search quality");
	await page.getByRole("button", { name: "Set focus", exact: true }).click();
	await page.waitForResponse(
		(r) => r.url().includes("getAttentionLayout") && r.ok(),
	);
	await page.reload();
	await page
		.getByRole("textbox", { name: "Focus today", exact: true })
		.waitFor();
	assert.equal(
		await page
			.getByRole("textbox", { name: "Focus today", exact: true })
			.inputValue(),
		"Search quality",
	);
	await page.getByRole("button", { name: "Arrange view", exact: true }).click();
	await page
		.getByRole("button", { name: "Hide Done today", exact: true })
		.click();
	await page
		.getByRole("region", { name: "Done today", exact: true })
		.waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "Reset view", exact: true }).click();
	await page.getByRole("region", { name: "Done today", exact: true }).waitFor();
	await page.getByRole("button", { name: "Arrange view", exact: true }).click();
	await page.screenshot({
		path: `${output}/attention-desktop-light.png`,
		fullPage: true,
	});
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await page.screenshot({
		path: `${output}/attention-desktop-dark.png`,
		fullPage: true,
	});
	for (const phoneWidth of [375, 390]) {
		const phone = await browser.newPage({
			viewport: { width: phoneWidth, height: phoneWidth === 375 ? 667 : 844 },
			isMobile: true,
			hasTouch: true,
		});
		await phone.goto(`${origin}/work/attention`);
		await phone.locator("[data-attention-live]").waitFor();
		await phone.keyboard.press("Escape");
		await phone.waitForTimeout(300);
		assert.equal(
			await phone.evaluate(
				() => document.documentElement.scrollWidth > innerWidth,
			),
			false,
			`phone has horizontal overflow at ${phoneWidth}px`,
		);
		const phoneLaneLinks = phone.locator("[data-attention-phone-lanes] a");
		assert.ok(
			await phoneLaneLinks.count(),
			`phone hides every recent lane link at ${phoneWidth}px`,
		);
		const firstPhoneLane = phoneLaneLinks.first();
		assert.ok(
			(await firstPhoneLane.innerText()).trim().length > 0,
			`phone recent lane link has no accessible name at ${phoneWidth}px`,
		);
		await phone.screenshot({
			path: `${output}/attention-phone-${phoneWidth}-light.png`,
			fullPage: true,
		});
		await phone.evaluate(() => document.documentElement.classList.add("dark"));
		await phone.screenshot({
			path: `${output}/attention-phone-${phoneWidth}-dark.png`,
			fullPage: true,
		});
		await Promise.all([
			phone.waitForURL((url) => url.pathname !== "/work/attention"),
			firstPhoneLane.click(),
		]);
		await phone.close();
	}
	assert.deepEqual(errors, []);
	await writeFile(
		`${output}/attention-browser-checks.json`,
		JSON.stringify(
			{
				warmFirstPaintMs: paint,
				phoneWidths: [375, 390],
				horizontalOverflow: false,
				timerTicks: true,
				layoutSurvivesReload: true,
				phoneLaneLinks: true,
				phoneLaneNavigation: true,
				errors,
			},
			null,
			2,
		),
	);
	console.log(
		`Attention browser checks passed; warm first paint ${paint}ms; screenshots: ${output}`,
	);
} finally {
	await browser?.close();
	if (server?.pid) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}
