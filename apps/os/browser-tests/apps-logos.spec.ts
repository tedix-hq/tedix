import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * Apps → In use shows each app's logo: its own, else the one it inherits from
 * its base app, else a favicon, else letters. Never a blank placeholder.
 */
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/apps-logos/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
	for (const width of [375, 1280])
		for (const theme of ["light", "dark"] as const) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			// Favicons for the fixture's reserved domains never load offline.
			await page.route("https://www.google.com/s2/favicons**", (route) =>
				route.abort(),
			);
			await page.goto(`${server.origin}/apps`);
			const variant = width < 640 ? "mobile" : "desktop";
			const rows = page.locator(`[data-app-row="${variant}"]`);
			await rows.first().waitFor();
			assert.equal(await rows.count(), 4, `${label}: four apps`);
			assert.equal(
				await rows.locator('[data-slot="icon-frame"]').count(),
				0,
				`${label}: no placeholder squares`,
			);
			const logo = async (name: string) => {
				const row = rows.filter({ hasText: name }).first();
				const avatar = row.locator(".entity-avatar").first();
				await avatar.waitFor();
				const img = avatar.locator("img");
				return (await img.count())
					? { src: await img.getAttribute("src"), text: "" }
					: { src: null, text: (await avatar.innerText()).trim() };
			};
			const own = await logo("Storefront");
			assert.ok(own.src?.startsWith("data:image/"), `${label}: own logo`);
			const inherited = await logo("Support Inbox");
			assert.ok(
				inherited.src?.startsWith("data:image/") && inherited.src !== own.src,
				`${label}: logo inherited from the base app`,
			);
			await page.waitForFunction(
				(selector) =>
					[...document.querySelectorAll(selector)].every(
						(row) =>
							!row.textContent?.includes("Finance Ledger") ||
							!row.querySelector(".entity-avatar img"),
					),
				`[data-app-row="${variant}"]`,
			);
			assert.deepEqual(
				await logo("Finance Ledger"),
				{ src: null, text: "FL" },
				`${label}: letters when no logo loads`,
			);
			const box = await rows
				.filter({ hasText: "Storefront" })
				.locator(".entity-avatar")
				.first()
				.boundingBox();
			assert.ok(
				box && box.width >= 32 && Math.abs(box.width - box.height) < 1,
				`${label}: square logo tile`,
			);
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth - innerWidth,
				),
				0,
				`${label}: horizontal overflow`,
			);
			await page.screenshot({ path: `${evidence}apps-${width}-${theme}.png` });
			checks += 1;
			await page.close();
		}
	console.log(`PASS: apps logos ${checks} views; screenshots in ${evidence}`);
} finally {
	await browser.close();
	await server.stop();
}
