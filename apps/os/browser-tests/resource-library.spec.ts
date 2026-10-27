import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/outputs");
const browser = await chromium.launch({ headless: true });
const evidence =
	process.env.RESOURCE_LIBRARY_EVIDENCE_DIR ?? "/tmp/897af6b0-browser";
await mkdir(evidence, { recursive: true });
try {
	for (const width of [375, 1280])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			await page.route("**/userSettings/getPreferences", async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.json.preferences.theme = theme;
				await route.fulfill({ response, json: body });
			});
			for (const [surface, path] of [
				["documents", "/outputs"],
				[
					"workspace",
					"/workspace/00000030-0000-4000-8000-000000000001?pane=resources",
				],
			] as const) {
				await page.goto(`${server.origin}${path}`);
				const library = page.locator(
					surface === "documents"
						? ".outputs-library"
						: ".canvas-resource-library",
				);
				await library.locator("[data-resource-card]").first().waitFor();
				await library.getByRole("button", { name: "New", exact: true }).click();
				await page
					.getByRole("menuitem", { name: "Document", exact: true })
					.waitFor();
				assert.deepEqual(await page.getByRole("menuitem").allTextContents(), [
					"Document",
					"Sheet",
					"Slides",
					"App from template",
				]);
				assert.equal(
					await page
						.getByRole("menuitem", { name: "App from template" })
						.getAttribute("href"),
					"/blueprints",
				);
				await page.screenshot({
					path: `${evidence}/${surface}-new-${width}-${theme}.png`,
					fullPage: true,
				});
				await page.keyboard.press("Escape");
				for (const [choice, heading] of [
					["Document", "New document"],
					["Sheet", "New sheet"],
					["Slides", "New slides"],
				]) {
					await library
						.getByRole("button", { name: "New", exact: true })
						.click();
					await page
						.getByRole("menuitem", { name: choice, exact: true })
						.click();
					const dialog = page.getByRole("dialog");
					await dialog
						.getByRole("heading", { name: heading, exact: true })
						.waitFor();
					assert.equal(
						await dialog.getByText("Template", { exact: true }).count(),
						choice === "Document" ? 1 : 0,
					);
					await dialog
						.getByRole("button", { name: "Cancel", exact: true })
						.click();
				}
				assert(
					(await library.locator("[data-workspace-app]").count()) > 0,
					`${surface} includes apps`,
				);
				assert(
					(await library
						.locator("[data-resource-card]:not([data-workspace-app])")
						.count()) > 0,
					`${surface} includes native files through the shared card`,
				);
				assert.equal(
					await library
						.locator(".workspace-app-preview")
						.first()
						.evaluate((el) => getComputedStyle(el).display),
					"flex",
					"app preview styles load on both surfaces",
				);
				assert(
					(await library.locator('[data-slot="output-grid-preview"]').count()) >
						0,
					`${surface} includes previews`,
				);
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					`${surface} fits ${width}`,
				);
				for (const card of await library
					.locator("[data-resource-card]")
					.all()) {
					assert(
						await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
						"card content fits",
					);
					assert.equal(await card.locator("button button").count(), 0);
				}
				await page.screenshot({
					path: `${evidence}/${surface}-${width}-${theme}.png`,
					fullPage: true,
				});
				await library
					.locator("[data-resource-card]:not([data-workspace-app])")
					.first()
					.scrollIntoViewIfNeeded();
				await page.screenshot({
					path: `${evidence}/${surface}-native-${width}-${theme}.png`,
					fullPage: true,
				});
				if (surface === "documents") {
					await library.getByRole("tab", { name: /^Apps/ }).click();
					assert((await library.locator("[data-workspace-app]").count()) > 0);
					await library.getByRole("button", { name: "List view" }).click();
					assert.equal(
						await library.locator('[data-slot="output-grid-preview"]').count(),
						0,
					);
					assert(
						await page.evaluate(
							() => document.documentElement.scrollWidth <= innerWidth,
						),
						"app list fits the viewport",
					);
					await page.screenshot({
						path: `${evidence}/documents-list-${width}-${theme}.png`,
						fullPage: true,
					});
					await library
						.locator("[data-workspace-app]")
						.first()
						.getByRole("button", { name: /^Open / })
						.click();
					await page.waitForURL((url) =>
						url.pathname.startsWith("/workspace/"),
					);
				}
				console.log(`Resource library passed: ${surface} ${width} ${theme}`);
			}
			await page.close();
		}
} finally {
	await browser.close();
	await server.stop();
}
