import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

// An epic adds tasks and dependencies by picking titles, never by
// typing ids, and lists both by title.
const STREAM = "/work/cases/000000b1-0000-4000-8000-000000000001";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const server = await startFixtureServer(STREAM, { shared: false });
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const [width, search] of [
		[375, "churn cohort"],
		[1280, "goodwill"],
	] as const) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await page.goto(`${server.origin}${STREAM}`);
		await page
			.getByRole("heading", { name: "Maple Books delivery investigation" })
			.waitFor();
		assert.equal(await page.locator('input[placeholder*="UUID"]').count(), 0);

		await page.getByRole("combobox", { name: "Choose a task" }).click();
		await page.getByRole("combobox", { name: "Find a task" }).fill(search);
		await page
			.getByRole("option", { name: new RegExp(search, "i") })
			.first()
			.click();
		await page.getByRole("button", { name: "Add task", exact: true }).click();
		await page
			.locator("[data-case-task]", { hasText: new RegExp(search, "i") })
			.first()
			.waitFor();

		await page.getByRole("combobox", { name: "Choose an epic" }).click();
		await page
			.getByRole("option", { name: "Willow Studio workshop preparation" })
			.click();
		await page
			.getByRole("button", { name: "Add dependency", exact: true })
			.click();
		await page
			.locator("[data-case-dependency]", {
				hasText: "Willow Studio workshop preparation waits for this one",
			})
			.first()
			.waitFor();

		const text = await page.locator("#os-main-content").innerText();
		assert(!UUID.test(text), `${width}: no raw ids on the page`);
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			`${width}: the page does not scroll sideways`,
		);
		await page.close();
		console.log(`epic pickers ${width}px: ok`);
	}
} finally {
	await browser?.close();
	await server.stop();
}
