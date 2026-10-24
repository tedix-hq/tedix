import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const path = "/workspace/00000030-0000-4000-8000-000000000001?pane=resources";
const name =
	"Daily harbor operations digest and supplier follow-ups " +
	"unbroken".repeat(30);
const server = await startFixtureServer("/");
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [390, 1280]) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				colorScheme: theme,
			});
			await page.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.origin !== server.origin) return route.abort("blockedbyclient");
				if (url.pathname.endsWith("/osWorkspaces/schedules/list")) {
					const response = await route.fetch();
					return route.fulfill({
						response,
						body: (await response.text()).replaceAll(
							"Weekly revenue report",
							name,
						),
					});
				}
				if (url.pathname.endsWith("/userSettings/getPreferences")) {
					const response = await route.fetch();
					const body = await response.json();
					body.json.preferences.theme = theme;
					return route.fulfill({ response, json: body });
				}
				return route.continue();
			});
			await page.goto(`${server.origin}${path}`);
			const heading = page.getByRole("heading", { name, exact: true });
			await heading.waitFor();
			await page.evaluate(() => document.fonts.ready);
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: theme applied`,
			);
			assert.equal(
				await heading.getAttribute("tabindex"),
				"0",
				`${label}: name is keyboard reachable`,
			);
			const compactHeight = await heading.evaluate((el) => el.clientHeight);
			assert(
				await heading.evaluate((el) => el.scrollHeight > el.clientHeight),
				`${label}: long name starts compact`,
			);
			await heading.focus();
			await page.keyboard.press("Tab");
			await page.keyboard.press("Shift+Tab");
			assert(
				await heading.evaluate((el) => el === document.activeElement),
				`${label}: Tab reaches name`,
			);
			assert(
				await heading.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
				`${label}: focused name is fully visible`,
			);
			assert((await heading.evaluate((el) => el.clientHeight)) > compactHeight);
			await page.keyboard.press("Tab");
			assert.equal(
				await heading.evaluate((el) => el.clientHeight),
				compactHeight,
				`${label}: blur compacts name`,
			);
			await heading.hover();
			assert(
				await heading.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
				`${label}: hovered name is fully visible`,
			);
			assert((await heading.evaluate((el) => el.clientHeight)) > compactHeight);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${label}: no page overflow`,
			);
			await page.close();
			console.log(`schedule names ${label}: ok`);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
