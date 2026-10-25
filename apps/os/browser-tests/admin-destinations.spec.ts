import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence = new URL(
	"../node_modules/.cache/admin-destinations/",
	import.meta.url,
).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer(
	"/browser-tests/admin-destinations.html",
);
const narrowToken =
	"tenant-org-0000aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666";
const started = performance.now();
let checks = 0;
try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch({ headless: true });
		try {
			for (const width of [320, 375, 390, 1280]) {
				for (const theme of ["light", "dark"]) {
					const label = `${engine.name()}-${width}-${theme}`;
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
							lineHeight: Number.parseFloat(
								getComputedStyle(element).lineHeight,
							),
							scrollWidth: element.scrollWidth,
							width: element.clientWidth,
							scrollHeight: element.scrollHeight,
							clientHeight: element.clientHeight,
							text: element.textContent ?? "",
						});
						const descriptions = [
							...document.querySelectorAll<HTMLElement>(
								"[data-row-description]",
							),
						];
						return {
							descriptions: descriptions.map(measure),
							titles: descriptions.map((description) =>
								measure(description.previousElementSibling as HTMLElement),
							),
							overflow: document.documentElement.scrollWidth - innerWidth,
						};
					});
					assert.ok(
						metrics.overflow <= 1,
						`${label}: page overflow ${metrics.overflow}`,
					);
					assert.equal(metrics.descriptions.length, 3);
					assert.ok(
						metrics.descriptions.some(({ text }) => text === narrowToken),
						`${label}: exact narrow token row is rendered`,
					);
					for (const copy of [...metrics.titles, ...metrics.descriptions]) {
						assert.ok(
							copy.scrollWidth <= copy.width + 1 &&
								copy.scrollHeight <= copy.clientHeight + 1,
							`${label}: clipped destination copy ${copy.text}`,
						);
						assert.equal(
							copy.whiteSpace,
							"normal",
							`${label}: nowrap destination copy ${copy.text}`,
						);
					}
					if (width < 600) {
						for (const description of [
							metrics.descriptions[0]!,
							metrics.descriptions[2]!,
						]) {
							assert.ok(
								description.height > description.lineHeight,
								`${label}: phone description wraps: ${description.text}`,
							);
						}
					} else {
						assert.ok(
							metrics.descriptions[1]!.height <=
								metrics.descriptions[1]!.lineHeight + 1,
							`${label}: desktop short description stays on one line`,
						);
					}
					await page.screenshot({
						path: `${evidence}/${label}.png`,
						fullPage: true,
					});
					console.log(
						JSON.stringify({ engine: engine.name(), width, theme, ...metrics }),
					);
					checks++;
					await page.close();
				}
			}
		} finally {
			await browser.close();
		}
	}
	console.log(
		`${checks} engine/viewport/theme checks passed in ${((performance.now() - started) / 1000).toFixed(2)}s`,
	);
} finally {
	await server.stop();
}
