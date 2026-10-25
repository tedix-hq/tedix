import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Runs in `bun run --cwd apps/os test:browser:settings` (part of test:run).
// On a phone the settings strip must wrap its destinations onto rows so every
// label stays fully on screen; at md it becomes the single-column rail.
const shots = process.env.TEDIX_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const server = await startFixtureServer();
let browser;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [375, 390]) {
		const page = await browser.newPage({
			viewport: { width, height: 844 },
			isMobile: true,
			hasTouch: true,
			reducedMotion: "reduce",
		});
		await page.goto(`${server.origin}/admin/connections`);
		const navigation = page.locator('nav[aria-label="Settings sections"]');
		await navigation.waitFor();
		await page.evaluate(() => document.fonts.ready);
		const state = await navigation.evaluate((nav) => {
			const box = nav.getBoundingClientRect();
			return {
				wrap: getComputedStyle(nav).flexWrap,
				scrollWidth: nav.scrollWidth,
				clientWidth: nav.clientWidth,
				documentWidth: document.documentElement.scrollWidth,
				innerWidth,
				nav: {
					left: box.left,
					right: box.right,
					top: box.top,
					bottom: box.bottom,
				},
				links: [...nav.querySelectorAll("a")].map((link) => {
					const rect = link.getBoundingClientRect();
					return {
						text: link.textContent,
						left: rect.left,
						right: rect.right,
						top: rect.top,
						bottom: rect.bottom,
					};
				}),
			};
		});
		assert.equal(state.wrap, "wrap", JSON.stringify(state));
		assert(state.links.length >= 8, JSON.stringify(state));
		const rows = new Set(state.links.map((link) => Math.round(link.top)));
		assert(
			rows.size >= 2,
			`strip did not wrap onto multiple rows: ${JSON.stringify(state)}`,
		);
		assert(state.scrollWidth <= state.clientWidth + 1, JSON.stringify(state));
		assert(state.documentWidth <= state.innerWidth + 1, JSON.stringify(state));
		for (const link of state.links) {
			assert(
				link.left >= -1 && link.right <= state.innerWidth + 1,
				`destination off screen: ${JSON.stringify(link)}`,
			);
			assert(
				link.top >= state.nav.top - 1 && link.bottom <= state.nav.bottom + 1,
				`destination clipped by the strip: ${JSON.stringify(link)}`,
			);
		}
		for (const link of await navigation.locator("a").all())
			assert(await link.isVisible(), await link.textContent());
		if (shots)
			await page.screenshot({
				path: `${shots}/settings-strip-${width}.png`,
			});
		console.log(
			`PASS settings-strip ${width}: ${rows.size} rows, ${state.links.length} destinations`,
		);
		await page.close();
	}
	const page = await browser.newPage({
		viewport: { width: 768, height: 900 },
		reducedMotion: "reduce",
	});
	await page.goto(`${server.origin}/admin/connections`);
	const rail = page.locator('nav[aria-label="Settings sections"]');
	await rail.waitFor();
	const desktop = await rail.evaluate((nav) => ({
		wrap: getComputedStyle(nav).flexWrap,
		direction: getComputedStyle(nav).flexDirection,
	}));
	assert.equal(desktop.wrap, "nowrap", JSON.stringify(desktop));
	assert.equal(desktop.direction, "column", JSON.stringify(desktop));
	console.log("PASS settings-strip 768: single-column rail");
	await page.close();
} finally {
	await browser?.close();
	await server.stop();
}
