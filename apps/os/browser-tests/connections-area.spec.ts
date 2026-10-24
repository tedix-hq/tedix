import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * The connections area is three tabs (Apps, Accounts, Skills). Apps holds the
 * apps in use and the catalog; Accounts holds the organization's and your own
 * accounts. The gateway is a line on Apps, and its old URL redirects there.
 */
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/connections-area/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
	for (const width of [375, 1280])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			await page.goto(`${server.origin}/gateways`);
			await page.waitForURL((url) => url.pathname === "/apps");

			for (const [path, tab, view] of [
				["/apps", "Apps", "In use"],
				["/explore/apps", "Apps", "Browse and add"],
				["/admin/connections", "Accounts", "Organization"],
				["/account/connections", "Accounts", "Only you"],
			] as const) {
				const label = `${path} ${width}/${theme}`;
				await page.goto(`${server.origin}${path}`);
				const subnav = page.locator("[data-capability-subnav]");
				await subnav.waitFor();
				assert.equal(
					(await subnav.locator('[aria-current="page"]').innerText()).trim(),
					view,
					`${label}: current view`,
				);
				const rail = page.locator("[data-capability-nav]");
				if (await rail.isVisible()) {
					assert.deepEqual(
						(await rail.locator("a").allInnerTexts()).map((text) =>
							text.trim(),
						),
						["Apps", "Accounts", "Skills"],
						`${label}: three tabs`,
					);
					assert.equal(
						(await rail.locator('[aria-current="page"]').innerText()).trim(),
						tab,
						`${label}: current tab`,
					);
				} else assert.ok(width < 768, `${label}: tabs hidden only on phones`);
				const text = await page.locator("body").innerText();
				for (const old of [
					"Installed apps",
					"Connected accounts",
					"Shared connection",
				])
					assert.ok(
						!text.includes(old) ||
							path.startsWith("/admin") ||
							path.startsWith("/account"),
						`${label}: old tab "${old}" is gone`,
					);
				if (path === "/apps")
					assert.ok(
						!(await page.locator("[data-gateway-line]").count()) ||
							(await page.locator("[data-gateway-line]").innerText()).includes(
								"Gateway details",
							),
						`${label}: gateway is a quiet line`,
					);
				assert.equal(
					await page.evaluate(
						() => document.documentElement.scrollWidth - innerWidth,
					),
					0,
					`${label}: horizontal overflow`,
				);
				await page.screenshot({
					path: `${evidence}${path.replaceAll("/", "_")}-${width}-${theme}.png`,
				});
				checks += 1;
			}
			await page.close();
		}
	console.log(
		`PASS: connections area ${checks} views; screenshots in ${evidence}`,
	);
} finally {
	await browser.close();
	await server.stop();
}
