import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import { webkit, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = process.env.OUTPUTS_TEST_ORIGIN ?? `http://127.0.0.1:${port}`;
const server = process.env.OUTPUTS_TEST_ORIGIN
	? undefined
	: Bun.spawn(
			[
				"../../node_modules/.bin/vp",
				"dev",
				"--port",
				String(port),
				"--strictPort",
				"--host",
				"127.0.0.1",
			],
			{ cwd, stdout: "inherit", stderr: "inherit", detached: true },
		);
const evidenceDir = process.env.OUTPUTS_EVIDENCE_DIR;
let browser: Browser | undefined;
try {
	await waitForFixtureServer(`${origin}/outputs`, { server });
	if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
	browser = await webkit.launch();
	for (const [width, height] of [
		[375, 667],
		[390, 844],
		[1280, 900],
	] as const) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height },
				colorScheme: theme,
				hasTouch: width < 640,
			});
			await page.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			await page.goto(`${origin}/outputs`);
			const library = page.locator(".outputs-library");
			const card = library.locator(".output-grid-card").first();
			await card.waitFor();
			const title = card.locator("strong");
			assert.equal(
				await title.evaluate((el) => getComputedStyle(el).webkitLineClamp),
				"none",
				"title is never clamped",
			);
			const provenance = card
				.locator(".output-card-footer > span > span")
				.filter({ hasText: /Shared by|Created by/ })
				.last();
			assert.notEqual(
				await provenance.evaluate((el) => getComputedStyle(el).textOverflow),
				"ellipsis",
				"provenance stays readable",
			);
			assert(
				await card.locator("time").isVisible(),
				"updated time is visible in grid",
			);
			const search = library.getByRole("searchbox", { name: "Search outputs" });
			assert(await search.isVisible(), "output search is visible");
			const scope = library.getByRole("button", {
				name: width < 640 ? "All sharing" : "Yours and shared",
				exact: true,
			});
			if (width < 640) {
				assert.equal(
					Math.round(
						(await library
							.locator('[data-kumo-component="SearchInput"]')
							.boundingBox())!.y,
					),
					Math.round((await scope.boundingBox())!.y),
					"search and sharing use one row",
				);
			}
			await page.keyboard.press("Tab");
			await card.focus();
			assert.equal(
				await card.evaluate((el) => getComputedStyle(el).outlineOffset),
				"-1px",
				"focus straddles the retained border",
			);
			assert.equal(
				await card.evaluate((el) => getComputedStyle(el).borderTopWidth),
				"1px",
			);
			assert.equal(
				await library
					.locator(".output-library-items")
					.evaluate((el) => getComputedStyle(el).paddingTop),
				"2px",
				"list leaves room for focus",
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-grid-${width}-${theme}.png`,
				});
			await library
				.getByRole("button", { name: "List view", exact: true })
				.click();
			const row = library.locator(".output-list-row").first();
			await row.waitFor();
			assert.equal(
				await row
					.locator("strong")
					.evaluate((el) => getComputedStyle(el).textOverflow),
				"clip",
				"list titles wrap",
			);
			if (width < 640)
				assert(
					await row.locator("time").first().isVisible(),
					"phone list shows updated time",
				);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-list-${width}-${theme}.png`,
				});
			await row.getByRole("button", { name: /^Actions for/ }).click();
			await page
				.getByRole("menuitem", { name: "Open standalone", exact: true })
				.click();
			const actions = page.locator(".output-detail-actions");
			await actions.waitFor();
			const edit = actions.getByRole("button", { name: "Edit", exact: true });
			const share = actions.getByRole("button", { name: "Share", exact: true });
			const overflow = actions.getByRole("button", {
				name: "Output actions",
				exact: true,
			});
			const editBox = (await edit.boundingBox())!;
			const shareBox = (await share.boundingBox())!;
			assert.equal(editBox.y, shareBox.y, "primary and secondary align");
			assert.equal(editBox.height, shareBox.height, "action heights match");
			assert(
				editBox.x >= 0 && editBox.x + editBox.width <= width,
				"Edit is fully inside the viewport",
			);
			if (width < 640) {
				assert.equal(
					await actions.getByRole("button").filter({ visible: true }).count(),
					3,
					"phone has Edit, Share and overflow",
				);
				assert.equal(
					(await overflow.boundingBox())!.y,
					editBox.y,
					"overflow stays on the same row",
				);
			}
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-detail-${width}-${theme}.png`,
				});
			await overflow.click();
			await page
				.getByRole("menuitem", { name: "Word (.docx)", exact: true })
				.waitFor();
			if (width < 640)
				await page
					.getByRole("menuitem", { name: "Open in workspace", exact: true })
					.waitFor();
			await page.keyboard.press("Escape");
			await share.click();
			await page.getByRole("heading", { name: "Share this file" }).waitFor();
			await page.keyboard.press("Escape");
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				"no horizontal document overflow",
			);
			assert(
				await page
					.locator('[data-slot="page"]')
					.evaluate((el) => el.scrollWidth <= el.clientWidth),
				"no clipped page content",
			);
			await page.close();
			console.log(`Outputs WebKit passed: ${width}x${height} ${theme}`);
		}
	}
} finally {
	await browser?.close();
	if (server)
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
}
