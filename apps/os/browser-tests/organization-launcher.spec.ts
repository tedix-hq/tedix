import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { startFixtureServer } from "./fixture-server";

const fixture = "/browser-tests/organization-launcher.html";
const server = await startFixtureServer(fixture);
const evidence = process.env.TEDIX_SCREENSHOT_DIR;
if (evidence) await mkdir(evidence, { recursive: true });

try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch();
		try {
			for (const width of [375, 1280])
				for (const theme of ["light", "dark"] as const) {
					const page = await browser.newPage({
						viewport: { width, height: 900 },
						colorScheme: theme,
						reducedMotion: "reduce",
					});
					const label = `${engine.name()} ${width} ${theme}`;
					const errors: string[] = [];
					page.on("pageerror", (error) => errors.push(error.message));
					await page.route("**/fixture-logo.svg", (route) =>
						route.fulfill({
							contentType: "image/svg+xml",
							body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2563eb"/><path d="M8 16h16M16 8v16" stroke="white" stroke-width="4"/></svg>',
						}),
					);
					await page.route("**/fixture-broken-logo.png", (route) =>
						route.fulfill({ status: 404, body: "Missing" }),
					);
					await page.goto(`${server.origin}${fixture}?theme=${theme}`);
					await page.getByRole("heading", { name: "Workspaces" }).waitFor();
					const row = (name: string) =>
						page.locator("li").filter({ hasText: name });
					const saved = row("Saved Logo").locator("img");
					await saved.waitFor();
					await page.waitForFunction(() => {
						const image = document.querySelector<HTMLImageElement>(
							'img[src="/fixture-logo.svg"]',
						);
						return image?.complete && image.naturalWidth > 0;
					});
					await row("Broken Logo")
						.locator("img")
						.waitFor({ state: "detached" });
					for (const name of ["Missing Logo", "Broken Logo", "Setting Up"]) {
						assert.equal(
							await row(name).locator("img").count(),
							0,
							`${label}: ${name} no failed image`,
						);
						assert.equal(
							await row(name)
								.locator('[data-entity-kind="workspace"]')
								.innerText(),
							name
								.split(" ")
								.map((word) => word[0])
								.join(""),
							`${label}: ${name} fallback`,
						);
					}
					assert.equal(await row("Setting Up").locator("a").count(), 0);
					assert.equal(
						await row("Saved Logo").locator("a").getAttribute("href"),
						"https://saved-logo.os.example.test/",
					);
					for (const avatar of await page
						.locator('[data-entity-kind="workspace"]')
						.all()) {
						const bounds = await avatar.boundingBox();
						assert(
							bounds && bounds.width === 32 && bounds.height === 32,
							`${label}: stable logo dimensions`,
						);
						assert.equal(await avatar.getAttribute("aria-hidden"), "true");
					}
					assert.equal(
						await page.evaluate(
							() => document.documentElement.scrollWidth - innerWidth,
						),
						0,
						`${label}: no horizontal overflow`,
					);
					await page.evaluate(() => document.fonts.ready);
					const settingUpName = await row("Setting Up")
						.getByText("Setting Up", { exact: true })
						.boundingBox();
					const provisioning = await row("Setting Up")
						.getByText("Provisioning", { exact: true })
						.boundingBox();
					assert(
						settingUpName && settingUpName.width > 50,
						`${label}: disabled name remains readable`,
					);
					assert(
						provisioning &&
							(provisioning.y >= settingUpName.y + settingUpName.height ||
								provisioning.x >= settingUpName.x + settingUpName.width),
						`${label}: provisioning does not cover the name`,
					);
					if (evidence)
						await page.screenshot({
							path: `${evidence}/chooser-${engine.name()}-${width}-${theme}.png`,
							fullPage: true,
						});
					await page
						.getByRole("searchbox", { name: "Search workspaces" })
						.fill("Saved");
					assert.equal(await page.locator("li").count(), 1);
					assert.equal(
						await page.locator('img[src="/fixture-logo.svg"]').count(),
						1,
					);
					assert.deepEqual(errors, [], `${label}: no page errors`);
					await page.close();
				}
		} finally {
			await browser.close();
		}
	}
	console.log(
		"PASS: workspace chooser logos, missing/broken fallback, provisioning, search and fit; Chromium/WebKit, 375/1280, light/dark (8 states)",
	);
} finally {
	await server.stop();
}
