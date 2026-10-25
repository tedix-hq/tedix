import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Projects lists every project, and a project's target date is set, shown
// and removed from its page, with no placeholder when there is none.
const server = await startFixtureServer("/work?app=portfolio", {
	shared: false,
});
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await page.goto(`${server.origin}/work?app=portfolio`);
		await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
		const rows = page.locator("[data-project-row]");
		await rows.first().waitFor();
		assert.equal(await rows.count(), 3, `${width}: every project is listed`);
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			`${width}: the list does not scroll sideways`,
		);
		await page
			.getByRole("searchbox", { name: "Search projects" })
			.fill("finance");
		await page.waitForFunction(
			() => document.querySelectorAll("[data-project-row]").length === 1,
		);
		await page.getByRole("link", { name: "Finance ops" }).click();
		assert.equal(await page.getByText("Horizon").count(), 0);
		assert.equal(await page.getByText("Not recorded").count(), 0);
		await page.getByRole("button", { name: "Set target date" }).click();
		await page.getByRole("button", { name: /October 28/ }).click();
		const set = page.getByRole("button", { name: /Target date Oct 28, 2026/ });
		await set.waitFor();
		await set.click();
		await page.getByRole("button", { name: "Remove target date" }).click();
		await page.getByRole("button", { name: "Set target date" }).waitFor();
		await page.close();
		console.log(`project target date ${width}px: ok`);
	}
} finally {
	await browser?.close();
	await server.stop();
}
