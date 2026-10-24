import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence = new URL(
	"../node_modules/.cache/admin-destinations/",
	import.meta.url,
).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer(
	"/browser-tests/admin-destinations.html",
);
const browser = await chromium.launch({ headless: true });
const started = performance.now();
let checks = 0;
try {
	for (const width of [375, 390, 1280]) {
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
			});
			await page.goto(
				`${server.origin}/browser-tests/admin-destinations.html?theme=${theme}`,
			);
			const first = page.locator("[data-row-description]").first();
			await first.waitFor();
			await page.evaluate(() => document.fonts.ready);
			const metrics = await page.evaluate(() => {
				const measure = (element: HTMLElement) => ({
					whiteSpace: getComputedStyle(element).whiteSpace,
					height: element.getBoundingClientRect().height,
					lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
					scrollWidth: element.scrollWidth,
					width: element.clientWidth,
					text: element.textContent ?? "",
				});
				return {
					descriptions: [
						...document.querySelectorAll<HTMLElement>("[data-row-description]"),
					].map(measure),
					overflow: document.documentElement.scrollWidth - innerWidth,
				};
			});
			assert.equal(metrics.overflow, 0, `${width}/${theme}: page overflow`);
			assert.equal(metrics.descriptions.length, 3);
			for (const description of metrics.descriptions) {
				assert.ok(
					description.scrollWidth <= description.width,
					`${width}/${theme}: clipped description ${description.text}`,
				);
				assert.equal(
					description.whiteSpace,
					"normal",
					`${width}/${theme}: nowrap description ${description.text}`,
				);
			}
			if (width < 600) {
				for (const description of [
					metrics.descriptions[0]!,
					metrics.descriptions[2]!,
				]) {
					assert.ok(
						description.height > description.lineHeight,
						`phone description wraps: ${description.text}`,
					);
				}
			} else {
				assert.ok(
					metrics.descriptions[1]!.height <=
						metrics.descriptions[1]!.lineHeight,
					"desktop short description stays on one line",
				);
			}
			await page.screenshot({
				path: `${evidence}/${width}-${theme}.png`,
				fullPage: true,
			});
			console.log(JSON.stringify({ width, theme, ...metrics }));
			checks++;
			await page.close();
		}
	}
	console.log(
		`${checks} viewport/theme checks passed in ${((performance.now() - started) / 1000).toFixed(2)}s`,
	);
} finally {
	await browser.close();
	await server.stop();
}
