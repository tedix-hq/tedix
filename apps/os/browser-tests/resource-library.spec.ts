import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/outputs");
const browser = await chromium.launch({ headless: true });
const evidence =
	process.env.RESOURCE_LIBRARY_EVIDENCE_DIR ?? "/tmp/897af6b0-browser";
const previewImage =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4YQAAAAASUVORK5CYII=";
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
			let withPreview = true;
			await page.route(
				"**/api/rpc/osWorkspaces/gadgets/get*",
				async (route) => {
					const response = await route.fetch();
					const body = await response.json();
					const manifest = (body.json ?? body).currentRevision?.manifest;
					if (manifest && withPreview)
						manifest.preview = {
							image: previewImage,
							alt: "Saved app preview",
						};
					else if (manifest) {
						delete manifest.preview;
						manifest.description = "App without a saved preview";
					}
					await route.fulfill({ response, json: body });
				},
			);
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
					.getByRole("menuitem", { name: "Doc", exact: true })
					.waitFor();
				assert.deepEqual(await page.getByRole("menuitem").allTextContents(), [
					"Doc",
					"Sheet",
					"Slides",
					"Browse templates",
					"Document from a template",
				]);
				assert.equal(
					await page
						.getByRole("menuitem", { name: "Browse templates" })
						.getAttribute("href"),
					"/blueprints",
				);
				await page.screenshot({
					path: `${evidence}/${surface}-new-${width}-${theme}.png`,
					fullPage: true,
				});
				await page.keyboard.press("Escape");
				for (const choice of ["Doc", "Sheet", "Slides"]) {
					await library
						.getByRole("button", { name: "New", exact: true })
						.click();
					await page
						.getByRole("menuitem", { name: choice, exact: true })
						.click();
					const dialog = page.getByRole("dialog");
					await dialog
						.getByRole("heading", { name: `New ${choice}`, exact: true })
						.waitFor();
					await dialog
						.getByRole("button", { name: "Close", exact: true })
						.click();
				}
				await library.getByRole("button", { name: "New", exact: true }).click();
				await page
					.getByRole("menuitem", {
						name: "Document from a template",
						exact: true,
					})
					.click();
				const templateDialog = page.getByRole("dialog");
				await templateDialog
					.getByRole("heading", { name: "New document", exact: true })
					.waitFor();
				assert.equal(
					await templateDialog.getByText("Template", { exact: true }).count(),
					1,
				);
				await templateDialog
					.getByRole("button", { name: "Cancel", exact: true })
					.click();
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
				const preview = library.getByRole("img", { name: "Saved app preview" });
				await preview.first().waitFor();
				assert(
					await preview.first().evaluate(async (el: HTMLImageElement) => {
						await el.decode();
						return el.complete && el.naturalWidth > 0 && el.naturalHeight > 0;
					}),
					`${surface} shows a decoded saved raster preview`,
				);
				assert.equal(
					await preview
						.first()
						.evaluate((el) => getComputedStyle(el).objectFit),
					"cover",
					"app preview styles load on both surfaces",
				);
				assert.equal(
					await library.locator("[data-workspace-app] iframe").count(),
					0,
					"the library does not run an app to show its preview",
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
				} else {
					const appId = await preview
						.first()
						.locator("xpath=ancestor::*[@data-workspace-app]")
						.getAttribute("data-workspace-app");
					withPreview = false;
					// The card renders the record's own description until the
					// detail query lands, so prove the rewritten manifest
					// reached the page before asserting on its text.
					const detailResponse = page.waitForResponse(
						(response) =>
							new URL(response.url()).pathname ===
							"/api/rpc/osWorkspaces/gadgets/get",
					);
					await page.reload();
					const detailBody = await detailResponse.then((response) =>
						response.json(),
					);
					assert.equal(
						(detailBody.json ?? detailBody).currentRevision?.manifest
							?.description,
						"App without a saved preview",
					);
					const compact = library.locator(`[data-workspace-app="${appId}"]`);
					await compact.waitFor();
					await compact.getByText("App without a saved preview").waitFor();
					assert.equal(
						await compact.locator('[data-slot="output-grid-preview"]').count(),
						0,
						"an app without a saved screenshot has no empty preview panel",
					);
					await compact.getByRole("button", { name: /^Open / }).waitFor();
				}
				console.log(`Resource library passed: ${surface} ${width} ${theme}`);
			}
			await page.close();
		}
} finally {
	await browser.close();
	await server.stop();
}
