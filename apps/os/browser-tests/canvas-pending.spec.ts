import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

// The workspace route's loading shell mirrors the workbench geometry: below
// 960px the chat pane fills the viewport on its own (the loaded canvas shows
// one pane per `data-mobile-pane`), at 960px and up the 420px chat pane stands
// beside the stage. A 390px phone must never scroll sideways.
const fixturePath = "/browser-tests/canvas-pending.html";
const server = await startFixtureServer(fixturePath);

let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [390, 1280]) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				isMobile: width === 390,
				hasTouch: width === 390,
				colorScheme: theme,
			});
			await page.goto(`${server.origin}${fixturePath}?theme=${theme}`);
			await page.locator("main[aria-busy]").waitFor();
			const geometry = await page.evaluate(() => {
				const pane = document.querySelector("aside")!;
				const stage = document.querySelector("section")!;
				return {
					viewport: innerWidth,
					scrollWidth: document.documentElement.scrollWidth,
					paneWidth: pane.getBoundingClientRect().width,
					stageDisplay: getComputedStyle(stage).display,
				};
			});
			assert(
				geometry.scrollWidth <= geometry.viewport,
				`${label}: no horizontal overflow ${JSON.stringify(geometry)}`,
			);
			if (width < 960) {
				assert.equal(
					geometry.paneWidth,
					width,
					`${label}: chat pane fills the phone viewport`,
				);
				assert.equal(
					geometry.stageDisplay,
					"none",
					`${label}: stage stays out of the single mobile pane`,
				);
			} else {
				assert.equal(
					geometry.paneWidth,
					420,
					`${label}: chat pane keeps its 420px default`,
				);
				assert.notEqual(
					geometry.stageDisplay,
					"none",
					`${label}: stage renders beside the pane`,
				);
			}
			await page.close();
			console.log(`canvas pending ${label}: ok`);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
