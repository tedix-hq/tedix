import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * A workspace page has at most two navigation rows above the canvas: the
 * workspace's top bar, and the open item's tab row. No control appears twice
 * (one Files toggle, one place for each view), and every width gets the same
 * structure in both themes.
 */
const appPath =
	"/workspace/00000030-0000-4000-8000-000000000001?workpiece=gadget%3A00000031-0000-4000-8000-00000000000a&pane=workpiece";

const server = await startFixtureServer("/");
const browser = await chromium.launch({ headless: true });

async function navigationRows(page: Page): Promise<number> {
	// Rows of chrome that stack above the canvas column's content.
	return page.evaluate(() => {
		const rows = [
			...document.querySelectorAll(
				".canvas-workspace-header, .canvas-pane-switcher, .canvas-workpiece-bar, .canvas-desktop-pane-switcher",
			),
		].filter((row) => {
			const box = row.getBoundingClientRect();
			return box.height > 0 && box.width > 0;
		});
		const canvas = document
			.querySelector(".canvas-stage-content")
			?.getBoundingClientRect();
		return rows.filter((row) => {
			const box = row.getBoundingClientRect();
			return !canvas || box.top < canvas.top;
		}).length;
	});
}

try {
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 768, 1280, 1600]) {
			const label = `${width}/${theme}`;
			const phone = width < 700;
			// Below 960px the workbench shows one pane at a time.
			const narrow = width < 960;
			const context = await browser.newContext({
				viewport: { width, height: phone ? 812 : 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
				isMobile: phone,
				hasTouch: phone,
			});
			const page = await context.newPage();
			await page.route("**/userSettings/getPreferences", async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.json.preferences.theme = theme;
				return route.fulfill({ response, json: body });
			});
			await page.goto(`${server.origin}${appPath}`, {
				waitUntil: "domcontentloaded",
			});
			await page.getByRole("tab").first().waitFor();
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: theme applied`,
			);

			assert(
				(await navigationRows(page)) <= 2,
				`${label}: at most two navigation rows above the canvas`,
			);
			const switcher = page.locator(".canvas-pane-switcher");
			assert.equal(
				await switcher.count(),
				1,
				`${label}: one pane switcher in the tree`,
			);
			assert.equal(
				await switcher.isVisible(),
				narrow,
				`${label}: the pane switcher is for narrow screens only`,
			);
			assert.deepEqual(
				await page
					.getByRole("group", { name: "Active workpiece view" })
					.getByRole("button")
					.allInnerTexts(),
				["App", "Edit", "History"],
				`${label}: three plain tabs for the open app`,
			);

			// One control per job: a single Files toggle, and nothing named
			// Resources or Outputs beside it.
			const filesToggles = page.getByRole("button", {
				name: /^(Collapse|Expand) files$/,
			});
			assert.equal(
				await filesToggles.count(),
				narrow ? 0 : 1,
				`${label}: one Files toggle on wide screens, none on narrow ones`,
			);
			for (const stale of ["Resources", "Outputs", "Editor"]) {
				assert.equal(
					await page.getByRole("button", { name: stale, exact: true }).count(),
					0,
					`${label}: no "${stale}" control`,
				);
			}
			assert.equal(
				await page.getByRole("button", { name: "Focus", exact: true }).count(),
				1,
				`${label}: one Focus control`,
			);
			// One Share, in the top bar. Sharing the open app alone is a section
			// of its dialog, not a second icon beside History.
			const share = page.getByRole("button", { name: /^Share\b/ });
			assert.equal(await share.count(), 1, `${label}: one Share control`);
			assert(
				await share.evaluate(
					(button) => !!button.closest(".canvas-workspace-header"),
				),
				`${label}: Share sits in the top bar`,
			);
			await share.click();
			await page
				.getByRole("button", { name: "Link to this app", exact: true })
				.waitFor();
			await page.keyboard.press("Escape");
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth + 1,
				),
				`${label}: no sideways page scroll`,
			);
			// Drop route handlers first: a request still in flight must not
			// reach route.fetch() after the context is gone.
			await page.unrouteAll({ behavior: "ignoreErrors" });
			await context.close();
			console.log(`workspace nav ${label}: ok`);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
