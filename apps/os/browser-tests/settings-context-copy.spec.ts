import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Runs in `bun run --cwd apps/os test:browser:settings` (part of test:run).
// Personal settings must explain what the sign-in allows in plain words at
// phone and desktop widths in both themes, keeping the exact permission codes
// behind the Technical details disclosure instead of fronting them.
const shots = process.env.TEDIX_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const server = await startFixtureServer();
let browser;
try {
	browser = await chromium.launch({ headless: true });
	for (const colorScheme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				isMobile: width < 768,
				hasTouch: width < 768,
				reducedMotion: "reduce",
				colorScheme,
			});
			await page.goto(`${server.origin}/account/settings`);
			await page.getByText("Workspace context", { exact: true }).waitFor();
			await page.getByText("What you can do", { exact: true }).waitFor();
			await page.evaluate(() => document.fonts.ready);
			const text = await page.evaluate(() => document.body.innerText);
			assert(
				text.includes("You can manage this organization"),
				`plain role summary missing at ${width} ${colorScheme}: ${text.slice(0, 400)}`,
			);
			assert(
				!text.includes("apps:create"),
				`raw permission code visible at ${width} ${colorScheme}`,
			);
			assert(
				!text.includes("admitting inference"),
				`jargon AI label at ${width} ${colorScheme}`,
			);
			const overflow = await page.evaluate(() => ({
				documentWidth: document.documentElement.scrollWidth,
				innerWidth,
			}));
			assert(
				overflow.documentWidth <= overflow.innerWidth + 1,
				`horizontal overflow at ${width} ${colorScheme}: ${JSON.stringify(overflow)}`,
			);
			if (shots)
				await page.screenshot({
					path: `${shots}/workspace-context-${width}-${colorScheme}.png`,
				});
			await page.getByRole("button", { name: "Technical details" }).click();
			const opened = await page.evaluate(() => document.body.innerText);
			assert(
				opened.includes("apps:create"),
				`codes missing after opening details at ${width} ${colorScheme}`,
			);
			const openedOverflow = await page.evaluate(() => ({
				documentWidth: document.documentElement.scrollWidth,
				innerWidth,
			}));
			assert(
				openedOverflow.documentWidth <= openedOverflow.innerWidth + 1,
				`overflow with details open at ${width} ${colorScheme}: ${JSON.stringify(openedOverflow)}`,
			);
			if (shots)
				await page.screenshot({
					path: `${shots}/workspace-context-details-${width}-${colorScheme}.png`,
				});
			console.log(
				`PASS workspace-context ${width} ${colorScheme}: plain summary visible, codes behind Technical details, no overflow`,
			);
			await page.close();
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
