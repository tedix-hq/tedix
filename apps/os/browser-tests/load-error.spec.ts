import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/load-error/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const scenario of [
		{
			name: "accounts",
			url: "/account/connections",
			endpoint: "/connections/getConnectionsOverview",
		},
		{
			name: "projects",
			url: "/work?app=projects",
			endpoint: "/projects/getPortfolio",
		},
		{
			name: "factories",
			url: "/work?app=projects",
			endpoint: "/projects/getFactoryScoreboard",
		},
	]) {
		for (const [width, theme] of [
			[375, "dark"],
			[1280, "light"],
		] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			page.setDefaultNavigationTimeout(120_000);
			page.setDefaultTimeout(60_000);
			let requests = 0;
			let recovered = false;
			await page.route("**/api/rpc/**", async (route) => {
				const path = new URL(route.request().url()).pathname;
				if (path.endsWith(scenario.endpoint)) {
					requests++;
					if (!recovered)
						return route.fulfill({
							status: 503,
							json: {
								json: {
									defined: false,
									code: "SERVICE_UNAVAILABLE",
									message: "Database temporarily unavailable; retry shortly",
									data: { traceId: "fictional-load-error-trace" },
								},
							},
						});
				}
				if (path.endsWith("/userSettings/getPreferences")) {
					const response = await route.fetch();
					const body = await response.json();
					body.json.preferences.theme = theme;
					return route.fulfill({ response, json: body });
				}
				return route.continue();
			});
			try {
				await page.goto(`${server.origin}${scenario.url}`);
				const composition = page.locator('[data-slot="load-error"]');
				await composition.waitFor();
				await composition.scrollIntoViewIfNeeded();
				await page.evaluate(() => document.fonts.ready);
				assert.equal(
					await composition
						.locator('[data-slot="load-error-help"]')
						.innerText(),
					"This is taking longer than usual. Try again in a moment.",
				);
				assert.ok(
					!(await composition.innerText()).includes("Database temporarily"),
				);
				const retry = composition.getByRole("button", {
					name: "Retry",
					exact: true,
				});
				const text = await composition
					.locator('[data-slot="alert-title"]')
					.boundingBox();
				const button = await retry.boundingBox();
				const box = await composition.boundingBox();
				assert.ok(text && button && box);
				if (width === 375) {
					assert.ok(
						button.y > text.y + text.height,
						"phone: Retry follows the text",
					);
					assert.ok(
						Math.abs(button.width - box.width) < 2,
						"phone: Retry fills its row",
					);
				} else {
					assert.ok(
						button.x > text.x + text.width,
						"desktop: Retry follows text inline",
					);
					assert.ok(
						Math.abs(button.y - text.y) < 4,
						"desktop: Retry aligns with text",
					);
				}
				assert.equal(
					await page.evaluate(
						() => document.documentElement.scrollWidth > innerWidth,
					),
					false,
				);
				await page.screenshot({
					path: `${evidence}/${scenario.name}-${width}-${theme}.png`,
				});
				await composition
					.getByRole("button", { name: "Details", exact: true })
					.focus();
				await page.keyboard.press("Enter");
				assert.ok(
					(await composition.innerText()).includes(
						"Database temporarily unavailable; retry shortly",
					),
				);
				assert.ok(
					(await composition.innerText()).includes(
						"Trace ID: fictional-load-error-trace",
					),
				);
				await page.screenshot({
					path: `${evidence}/${scenario.name}-details-${width}-${theme}.png`,
				});
				const beforeRetry = requests;
				recovered = true;
				await retry.click();
				await composition.waitFor({ state: "detached" });
				assert.equal(
					requests,
					beforeRetry + 1,
					`Retry repeats the ${scenario.name} read once`,
				);
			} finally {
				await page.close();
			}
		}
	}
	console.log(
		"PASS: accounts, projects and factories load-error layout, closed diagnostics, keyboard Details and read retry on phone and desktop",
	);
} finally {
	await browser.close();
	await server.stop();
}
