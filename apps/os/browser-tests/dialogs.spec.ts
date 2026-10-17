import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const origin = "http://127.0.0.1:3017";
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		"3017",
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
);
let browser: Browser | undefined;
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null)
			throw new Error(`Vite exited: ${server.exitCode}`);
		try {
			ready = (await fetch(`${origin}/browser-tests/dialogs.html`)).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(ready, "Vite must serve the real CSS browser fixture");
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 1280, height: 720 },
		{ width: 390, height: 844 },
	]) {
		const page = await browser.newPage({ viewport });
		await page.goto(`${origin}/browser-tests/dialogs.html`);
		await page.getByRole("button", { name: "Get help", exact: true }).click();
		const dialog = page.getByRole("dialog");
		await dialog.waitFor();
		await page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== "running"),
		);
		assert(
			await page
				.getByRole("textbox", { name: "Summary", exact: true })
				.evaluate((el) => el === document.activeElement),
			"Summary receives focus",
		);
		const columns = await page
			.locator(".support-report-fields")
			.evaluate(
				(el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
			);
		assert.equal(
			columns,
			viewport.width >= 900 ? 2 : 1,
			"responsive columns use real app CSS",
		);
		const checkChrome = async () => {
			for (const name of ["Preview report", "File support request"]) {
				const box = await page
					.getByRole("button", { name, exact: true })
					.boundingBox();
				assert(
					box &&
						box.y >= 0 &&
						box.y + box.height <= viewport.height &&
						box.x >= 0 &&
						box.x + box.width <= viewport.width,
					`${name} must stay in viewport ${JSON.stringify({ viewport, box })}`,
				);
			}
			const header = await dialog
				.locator('[data-slot="dialog-header"]')
				.boundingBox();
			assert(
				header && header.y >= 0 && header.y + header.height < viewport.height,
				"heading stays visible",
			);
		};
		await checkChrome();
		for (const name of [
			"What did you expect?",
			"What happened?",
			"Steps to reproduce",
		]) {
			await page
				.getByRole("textbox", { name, exact: true })
				.fill("A line of report detail.\n".repeat(20));
		}
		await page
			.getByRole("textbox", { name: "Summary", exact: true })
			.fill("A layout problem");

		await checkChrome();
		await page
			.getByRole("button", { name: "Preview report", exact: true })
			.click();
		const scroller = dialog.locator(".os-dialog-scroll");
		assert(
			await scroller.evaluate((el) => el.scrollHeight > el.clientHeight),
			"long report scrolls internally",
		);
		await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await checkChrome();
		await page.mouse.move(2, viewport.height / 2);
		await page.mouse.wheel(0, 500);
		assert.equal(
			await page.evaluate(() => window.scrollY),
			0,
			"modal locks background scrolling",
		);
		await page.keyboard.press("Tab");
		assert(
			await dialog.evaluate((el) => el.contains(document.activeElement)),
			"focus remains trapped",
		);
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		await page.close();
		console.log(`Dialog viewport passed: ${viewport.width}x${viewport.height}`);
	}
} finally {
	await browser?.close();
	// vp launches Vite in a child; close the group so test gates receive EOF.
	process.kill(-server.pid, "SIGTERM");
	await server.exited;
}
