import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence = new URL(
	"../node_modules/.cache/skills-metadata/",
	import.meta.url,
).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer("/browser-tests/skills-metadata.html");
const browser = await chromium.launch({ headless: true });
const started = performance.now();
let checks = 0;
try {
	for (const width of [390, 1280]) {
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({ viewport: { width, height: 900 } });
			await page.goto(
				`${server.origin}/browser-tests/skills-metadata.html?theme=${theme}`,
			);
			const summary = page.locator("[data-row-summary]");
			await summary.waitFor();
			await page.evaluate(() => document.fonts.ready);
			const badge = page
				.locator('[data-slot="badge"]')
				.filter({ hasText: "Scheduled" });
			const metrics = await page.evaluate(() => {
				const summary =
					document.querySelector<HTMLElement>("[data-row-summary]")!;
				const badge = [
					...document.querySelectorAll<HTMLElement>('[data-slot="badge"]'),
				].find((element) => element.textContent?.startsWith("Scheduled"))!;
				const measure = (element: HTMLElement) => ({
					whiteSpace: getComputedStyle(element).whiteSpace,
					height: element.getBoundingClientRect().height,
					lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
					scrollWidth: element.scrollWidth,
					width: element.clientWidth,
				});
				return {
					summary: measure(summary),
					badge: measure(badge),
					overflow: document.documentElement.scrollWidth - innerWidth,
				};
			});
			assert.equal(metrics.overflow, 0, `${width}/${theme}: page overflow`);
			assert.ok(
				metrics.summary.scrollWidth <= metrics.summary.width,
				`${width}/${theme}: clipped summary`,
			);
			assert.ok(
				metrics.badge.scrollWidth <= metrics.badge.width,
				`${width}/${theme}: clipped schedule`,
			);
			if (width === 390) {
				assert.equal(metrics.summary.whiteSpace, "normal");
				assert.equal(metrics.badge.whiteSpace, "normal");
				assert.ok(
					metrics.summary.height > metrics.summary.lineHeight,
					"phone summary wraps",
				);
				assert.ok(
					metrics.badge.height > metrics.badge.lineHeight * 2,
					"phone schedule wraps",
				);
			} else {
				assert.equal(metrics.badge.whiteSpace, "nowrap");
				assert.ok(
					metrics.badge.height < metrics.badge.lineHeight * 2,
					"desktop schedule stays compact",
				);
			}
			assert.ok(await badge.isVisible());
			for (const state of ["cold", "stale"]) {
				const example = page.locator(`[data-evidence-state="${state}"]`);
				const retry = example.getByRole("button", {
					name: "Retry",
					exact: true,
				});
				await retry.waitFor();
				const spacing = await retry.evaluate((button) => {
					const message = button.previousElementSibling!;
					const action = button.getBoundingClientRect();
					const text = message.getBoundingClientRect();
					return {
						gap: action.top - text.bottom,
						left: action.left - text.left,
						width: action.width,
					};
				});
				assert.ok(
					spacing.gap >= 7.5,
					`${width}/${theme}/${state}: Retry needs a separate row with an 8px gap`,
				);
				assert.ok(
					Math.abs(spacing.left) <= 1,
					`${width}/${theme}/${state}: Retry aligns with its message`,
				);
				assert.ok(
					spacing.width < 160,
					`${width}/${theme}/${state}: Retry stays compact`,
				);
			}
			const warningGap = await page
				.locator('[data-evidence-state="stale"]')
				.getByRole("button", { name: "Technical details", exact: true })
				.evaluate((button) => {
					const disclosure = button.parentElement!;
					return (
						disclosure.getBoundingClientRect().top -
						disclosure.previousElementSibling!.getBoundingClientRect().bottom
					);
				});
			assert.ok(
				warningGap >= 7.5,
				`${width}/${theme}: warning and disclosure have an 8px gap`,
			);
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
