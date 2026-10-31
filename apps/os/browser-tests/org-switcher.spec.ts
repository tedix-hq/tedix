import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// The sidebar organization switcher with twelve organizations: one compact row
// each, current first, CMS only where provisioned, a search field, a short
// scrolling list, and arrow/Enter/Escape. Chromium and WebKit at 375 and
// 1280 px, light and dark.
const fixture = "/browser-tests/org-switcher.html";
const server = await startFixtureServer(fixture);
const evidenceDir = process.env.ORG_SWITCHER_EVIDENCE_DIR;
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });

async function settled(page: Page) {
	await page.waitForFunction(
		() =>
			!document.querySelector("[data-starting-style], [data-ending-style]") &&
			document
				.getAnimations()
				.every((animation) => animation.playState !== "running"),
	);
}

const switches = (page: Page) =>
	page.evaluate(() => (window as unknown as { switches: string[] }).switches);

const visibleRows = (page: Page) =>
	page
		.locator('[role="menu"] [data-org-row]:has([role="menuitem"])')
		.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-org-row")));

try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch();
		try {
			for (const width of [375, 1280])
				for (const theme of ["light", "dark"] as const) {
					const label = `${engine.name()} ${width} ${theme}`;
					const context = await browser.newContext({
						viewport: { width, height: width < 800 ? 812 : 900 },
						colorScheme: theme,
						hasTouch: width < 800,
					});
					const page = await context.newPage();
					const errors: string[] = [];
					page.on("pageerror", (error) => errors.push(error.message));
					await page.goto(`${server.origin}${fixture}?theme=${theme}`);
					const trigger = page.getByRole("button", {
						name: "Switch organization",
					});
					await trigger.waitFor();
					await page.reload();

					// Pointer: one row per org, current first with a check.
					await trigger.click();
					const menu = page.getByRole("menu");
					await menu.waitFor();
					await settled(page);
					const rows = await visibleRows(page);
					assert.equal(rows.length, 12, `${label}: twelve rows`);
					assert.equal(rows[0], "harbor", `${label}: current org first`);
					const current = menu.locator('[aria-current="true"]');
					assert.equal(await current.count(), 1);
					assert.match((await current.textContent()) ?? "", /Harbor Kitchen/);
					const selectedMarker = current.locator(
						":scope > span.inline-flex > svg",
					);
					assert.equal(await selectedMarker.count(), 1);
					assert(
						await selectedMarker.isVisible(),
						`${label}: current check visible`,
					);
					assert.equal(
						await menu
							.locator(
								'[data-org-row] [role="menuitem"] > span.inline-flex > svg',
							)
							.count(),
						1,
						`${label}: only the current organization has a check`,
					);
					assert.deepEqual(
						await menu
							.locator('[aria-label$=" CMS"]')
							.evaluateAll((items) =>
								items.map((item) => item.getAttribute("aria-label")),
							),
						[
							"Open Alder Works CMS",
							"Open Dune Freight CMS",
							"Open Granite Legal Partners and Associates International CMS",
							"Open Juniper Farms CMS",
						],
						`${label}: CMS only where provisioned`,
					);
					assert.equal(
						await menu.getByText("OS", { exact: true }).count(),
						0,
						`${label}: no per-product OS rows`,
					);
					assert.equal(
						await menu
							.locator('[data-org-row="lantern"] [role="menuitem"]')
							.getAttribute("aria-disabled"),
						"true",
						`${label}: an org still setting up is disabled`,
					);

					// Fits the viewport, no sideways scroll, and the list scrolls.
					// With a search field Base UI makes the popup a dialog that holds
					// the search box and the menu list.
					const geometry = await menu.evaluate((list) => {
						const popup = list.closest<HTMLElement>('[role="dialog"]')!;
						const rect = popup.getBoundingClientRect();
						return {
							left: rect.left,
							right: rect.right,
							bottom: rect.bottom,
							popupOverflowX: popup.scrollWidth - popup.clientWidth,
							listScrolls: list.scrollHeight > list.clientHeight,
							listHeight: list.clientHeight,
							rowsOverflowX: [
								...popup.querySelectorAll<HTMLElement>("[data-org-row]"),
							].some((row) => row.scrollWidth > row.clientWidth),
						};
					});
					assert(geometry.left >= 0, `${label}: left edge in view`);
					assert(geometry.right <= width, `${label}: right edge in view`);
					assert(
						geometry.bottom <= (width < 800 ? 812 : 900),
						`${label}: bottom in view`,
					);
					assert.equal(geometry.popupOverflowX, 0, `${label}: no overflow`);
					assert.equal(geometry.rowsOverflowX, false, `${label}: rows fit`);
					assert(geometry.listScrolls, `${label}: list scrolls`);
					assert(geometry.listHeight <= 320, `${label}: short list`);
					if (evidenceDir)
						await page.screenshot({
							path: `${evidenceDir}/org-switcher-${engine.name()}-${width}-${theme}.png`,
						});

					// The CMS chip opens that org's CMS; the row opens its OS.
					await menu
						.getByRole("menuitem", { name: "Open Dune Freight CMS" })
						.click();
					assert.deepEqual(await switches(page), ["dune:cms"]);
					await menu.waitFor({ state: "hidden" });
					await trigger.click();
					await menu.getByRole("menuitem", { name: /Birch Studio/ }).click();
					assert.deepEqual(await switches(page), ["dune:cms", "birch:os"]);
					await menu.waitFor({ state: "hidden" });

					// Keyboard: open, search, arrow, Enter.
					await trigger.focus();
					await page.keyboard.press("Enter");
					await menu.waitFor();
					const search = page.getByRole("searchbox", {
						name: "Search organizations",
					});
					await search.waitFor();
					await page.waitForFunction(
						() =>
							document.activeElement?.getAttribute("aria-label") ===
							"Search organizations",
					);
					await page.keyboard.type("juni");
					await page.waitForFunction(
						() =>
							document.querySelectorAll(
								'[role="menu"] [data-org-row]:has([role="menuitem"])',
							).length === 1,
					);
					assert.deepEqual(await visibleRows(page), ["juniper"]);
					await page.keyboard.press("ArrowDown");
					await page.keyboard.press("Enter");
					assert.deepEqual(
						(await switches(page)).at(-1),
						"juniper:os",
						`${label}: Enter opens the highlighted org's OS`,
					);
					await menu.waitFor({ state: "hidden" });

					// Arrow keys walk the rows; Escape closes back to the trigger.
					await trigger.focus();
					await page.keyboard.press("Enter");
					await menu.waitFor();
					await page.keyboard.type("zzz");
					await page
						.getByRole("status")
						.getByText("No organizations match")
						.waitFor();
					await page.keyboard.press("Escape");
					await menu.waitFor({ state: "hidden" });
					await page.waitForFunction(
						() =>
							document.activeElement?.getAttribute("aria-label") ===
							"Switch organization",
					);
					assert.deepEqual(errors, [], `${label}: no page errors`);
					await context.close();
				}
		} finally {
			await browser.close();
		}
	}
	console.log("org switcher: 12 orgs, chromium + webkit, 375/1280, light/dark");
} finally {
	await server.stop();
}
