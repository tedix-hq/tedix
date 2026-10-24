import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer(
	"/browser-tests/b13-slide-rail-touch-actions.html",
);
const browser = await chromium.launch();
const started = performance.now();
const evidence = process.env.TEDIX_SCREENSHOT_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
try {
	for (const width of [390, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				hasTouch: width === 390,
			});
			for (const [index, deleted, focused, position] of [
				[0, "Alpha revenue summary", "Beta hiring plan", 1],
				[1, "Beta hiring plan", "Gamma rollout dates", 2],
				[3, "Delta next steps", "Gamma rollout dates", 3],
			] as const) {
				await page.goto(
					`${server.origin}/browser-tests/b13-slide-rail-touch-actions.html?theme=${theme}`,
				);
				const rail = page.locator('[data-variant="editable"]');
				const button = rail
					.getByRole("button", { name: "Delete slide", exact: true })
					.nth(index);
				await button.focus();
				await page.keyboard.press("Enter");
				await page.waitForFunction(
					() =>
						document.querySelectorAll(
							'[data-variant="editable"] [data-slide-row]',
						).length === 3,
				);
				const target = rail.getByRole("button", {
					name: `Slide ${position}: ${focused}`,
					exact: true,
				});
				assert(
					await target.evaluate((node) => node === document.activeElement),
					`${width}/${theme}: focus after deleting ${deleted}`,
				);
				assert.equal(
					await rail.locator('[aria-live="polite"]').textContent(),
					`Deleted ${deleted}. ${focused} is at position ${position} of 3.`,
				);
				assert(
					await target.evaluate((node) => {
						const box = node.getBoundingClientRect();
						return box.left >= 0 && box.right <= innerWidth;
					}),
					"Focused slide fits viewport",
				);
			}
			if (evidence)
				await page.screenshot({ path: `${evidence}/${width}-${theme}.png` });
			console.log(`PASS slide deletion ${width}px ${theme}: first/middle/last`);
			await page.close();
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
console.log(
	`12 deletion cases passed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
