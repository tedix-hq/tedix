import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/apps-tool-counts/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
let browser: Browser | undefined;
let checks = 0;
try {
	for (const engine of [chromium, webkit]) {
		browser = await engine.launch({ headless: true });
		for (const width of [375, 1280]) {
			for (const theme of ["light", "dark"] as const) {
				const label = `${engine.name()} ${width}px ${theme}`;
				const context = await browser.newContext({
					viewport: { width, height: 900 },
					colorScheme: theme,
					reducedMotion: "reduce",
				});
				await context.addInitScript(
					(mode) => localStorage.setItem("tedix-os-theme", mode),
					theme,
				);
				const page = await context.newPage();
				// Finance Ledger's inventory is unknown — an empty read, not a
				// verified zero.
				await page.route(
					"**/api/rpc/appGating/installedEligibility",
					async (route) => {
						const response = await route.fetch();
						const body = await response.json();
						for (const entry of body.json)
							if (entry.appName === "Finance Ledger") {
								entry.result.availableTools = [];
								entry.result.unavailableTools = [];
							}
						await route.fulfill({ response, json: body });
					},
				);
				// One catalog app reports exactly one MCP tool.
				await page.route("**/api/rpc/catalog/list", async (route) => {
					const response = await route.fetch();
					const body = await response.json();
					const app = body.json.apps.find(
						(item: { slug?: string }) => item.slug === "local-documents",
					);
					assert.ok(app, "catalog fixture exists");
					app.mcpToolCount = 1;
					body.json.apps = [app];
					body.json.total = 1;
					await route.fulfill({ response, json: body });
				});

				await page.goto(`${server.origin}/apps`);
				const rows = page.locator(
					`[data-app-row="${width < 640 ? "mobile" : "desktop"}"]`,
				);
				await rows.first().waitFor();
				await rows.getByText(/3 tools listed/).waitFor();
				const appsText = await page.locator("body").innerText();
				assert.ok(
					appsText.includes("3 tools listed"),
					`${label}: plural count reads plainly`,
				);
				assert.ok(
					appsText.includes("2 tools listed · 1 gated"),
					`${label}: gated tools follow the count`,
				);
				assert.ok(
					appsText.includes("tool count unavailable"),
					`${label}: unknown inventory says so`,
				);
				for (const malformed of [
					"unavailable listed",
					"gated listed",
					"1 tools",
				])
					assert.ok(
						!appsText.includes(malformed),
						`${label}: no "${malformed}"`,
					);
				assert.equal(
					await page.evaluate(
						() => document.documentElement.scrollWidth - innerWidth,
					),
					0,
					`${label}: horizontal overflow`,
				);
				await page.screenshot({
					path: join(evidence, `${engine.name()}-apps-${width}-${theme}.png`),
					fullPage: true,
				});

				await page.goto(`${server.origin}/explore/apps`);
				const card = page.locator('a[href="/explore/apps/local-documents"]');
				await card.waitFor();
				await page.getByText("Showing 1–1 of 1 app", { exact: true }).waitFor();
				const catalogText = await page.locator("body").innerText();
				assert.ok(
					!catalogText.includes("1 apps"),
					`${label}: singular app count`,
				);
				assert.ok(
					catalogText.includes("1 tool"),
					`${label}: a one-tool app reads "1 tool"`,
				);
				assert.ok(!catalogText.includes("1 tools"), `${label}: no "1 tools"`);
				assert.equal(
					await page.evaluate(() => document.documentElement.dataset.mode),
					theme,
					`${label}: theme applied`,
				);
				await page.screenshot({
					path: join(
						evidence,
						`${engine.name()}-explore-${width}-${theme}.png`,
					),
					fullPage: true,
				});
				await page.unrouteAll({ behavior: "ignoreErrors" });
				await context.close();
				checks += 1;
				console.log(`tool-count copy ${label}: ok`);
			}
		}
		await browser.close();
	}
	console.log(`PASS: tool-count copy ${checks} states; shots in ${evidence}`);
} finally {
	await browser?.close();
	await server.stop();
}
