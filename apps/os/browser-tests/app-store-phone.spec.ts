import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * Catalog cards at phone width, light and dark: a long description and
 * provider byline stay fully readable instead of silently truncating. At `sm`
 * and up the card keeps its two-line clamp and single-line byline, and the
 * card link to the app detail page is the accessible full-text path.
 */
const server = await startFixtureServer("/explore/apps");
const LONG_DESCRIPTION =
	"Indexes every shared drive and answers with citations across policies, " +
	"contracts, and standing team agreements. ".repeat(3);
const LONG_DEVELOPER =
	"Solstice Internal Tooling Collective" + " and Partner Platforms".repeat(3);
const FIXTURE_DESCRIPTION =
	"Search documents and prepare a sourced team briefing.";

let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [390, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const label = `${width}px ${theme}`;
			const context = await browser.newContext({
				viewport: { width, height: 844 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			await context.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			const page = await context.newPage();
			await page.route("**/api/rpc/catalog/list", async (route) => {
				const response = await route.fetch();
				const body = (await response.text())
					.replaceAll(FIXTURE_DESCRIPTION, LONG_DESCRIPTION)
					.replaceAll("Local fixture", LONG_DEVELOPER);
				await route.fulfill({ response, body });
			});
			await page.goto(`${server.origin}/explore/apps`);
			const card = page.locator('a[href="/explore/apps/local-documents"]');
			await card.waitFor();
			const description = card.locator(
				'[data-slot="card-content"] [data-slot="text"]',
			);
			const byline = card.locator('[data-slot="card-description"]');
			await page.evaluate(() => document.fonts.ready);
			assert.equal(
				await page.evaluate(() => document.documentElement.dataset.mode),
				theme,
				`${label}: theme applied`,
			);
			const phone = width < 640;
			assert.equal(
				await description.evaluate(
					(el) => el.scrollHeight <= el.clientHeight + 1,
				),
				phone,
				phone
					? `${label}: long description is fully readable`
					: `${label}: long description stays clamped to two lines`,
			);
			assert.equal(
				await byline.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
				phone,
				phone
					? `${label}: provider byline wraps instead of clipping`
					: `${label}: provider byline stays on one truncated line`,
			);
			assert.equal(
				await byline.evaluate(
					(el) => getComputedStyle(el).textOverflow === "ellipsis",
				),
				!phone,
				`${label}: byline ellipsis only above phone widths`,
			);
			// The card link is the accessible full-text path on clamped layouts.
			assert.equal(
				await card.getAttribute("href"),
				"/explore/apps/local-documents",
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth + 1,
				),
				`${label}: long catalog text does not widen the page`,
			);
			// Drop route handlers first: a request still in flight must not
			// reach route.fetch() after the context is gone.
			await page.unrouteAll({ behavior: "ignoreErrors" });
			await context.close();
			console.log(`catalog cards ${label}: ok`);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
