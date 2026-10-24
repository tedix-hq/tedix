import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/work?app=portfolio");
const name =
	"Daily harbor operations digest and outstanding supplier follow-ups " +
	"unbroken".repeat(30);
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [390, 1280]) {
		const page = await browser.newPage({
			viewport: { width, height: 844 },
		});
		await page.route("**/*getFactoryScoreboard*", async (route) => {
			const response = await route.fetch();
			await route.fulfill({
				response,
				body: (await response.text()).replaceAll("Weekly revenue report", name),
			});
		});
		await page.goto(`${server.origin}/work?app=portfolio`);
		const link = page.getByRole("link", { name, exact: true });
		await link.waitFor();
		const text = link.locator("span");
		const height = () =>
			text.evaluate((el) => el.getBoundingClientRect().height);
		const compactHeight = await height();
		assert(
			await text.evaluate((el) => el.scrollHeight > el.clientHeight),
			`${width}: long name starts compact`,
		);
		await link.focus();
		await page.keyboard.press("Tab");
		await page.keyboard.press("Shift+Tab");
		assert(await link.evaluate((el) => el === document.activeElement));
		assert((await height()) > compactHeight, `${width}: focus reveals name`);
		assert(
			await text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
			`${width}: focused name is completely visible`,
		);
		await page.keyboard.press("Tab");
		assert.equal(await height(), compactHeight, `${width}: blur compacts name`);
		await link.hover();
		assert((await height()) > compactHeight, `${width}: hover reveals name`);
		assert(
			await text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
			`${width}: hovered name is completely visible`,
		);
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			`${width}: long unbroken names do not widen the page`,
		);
		await page.close();
		console.log(`portfolio names ${width}px: ok`);
	}
} finally {
	await browser?.close();
	await server.stop();
}
