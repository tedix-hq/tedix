import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { webkit, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
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
const evidenceDir = process.env.TEDIS_EVIDENCE_DIR;
let browser: Browser | undefined;
try {
	await waitForFixtureServer(`${origin}/team`, { server });
	if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
	browser = await webkit.launch();
	for (const [width, height] of [
		[375, 667],
		[390, 844],
		[1280, 900],
	] as const)
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height },
				colorScheme: theme,
				hasTouch: width < 640,
			});
			page.setDefaultTimeout(60_000);
			await page.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			await page.goto(`${origin}/team`);
			const row = page.locator(".tedi-roster > li").first();
			await row.waitFor();
			await row.getByText("Setup · not needed", { exact: true }).waitFor();
			const search = page.getByRole("searchbox", {
				name: "Search digital workers",
			});
			const filter = page.getByRole("combobox", {
				name: "Filter digital worker status",
			});
			assert.equal(await filter.innerText(), "All statuses");
			assert(await search.isVisible());
			const searchBox = (await page
				.locator('[data-kumo-component="SearchInput"]')
				.boundingBox())!;
			const filterBox = (await filter.boundingBox())!;
			assert(
				Math.abs(searchBox.y - filterBox.y) < 3,
				"search and status share one row",
			);
			assert(
				Math.abs(searchBox.height - filterBox.height) < 3,
				"filter controls have consistent heights",
			);
			const actions = row.locator(".tedi-row-actions");
			const buttons = actions.locator("[data-slot=button]");
			assert.equal(
				await buttons.count(),
				2,
				"one detail action and one setup action",
			);
			const [setupBox, detailBox] = await Promise.all([
				buttons.nth(0).boundingBox(),
				buttons.nth(1).boundingBox(),
			]);
			assert(setupBox && detailBox);
			assert(Math.abs(setupBox.y - detailBox.y) < 2, "actions do not wrap");
			assert.equal(setupBox.height, detailBox.height);
			assert(
				detailBox.x + detailBox.width <=
					(await row.boundingBox())!.x + (await row.boundingBox())!.width,
				"actions fit inside the row",
			);
			const toggle = row.getByRole("button", { name: /^Expand / });
			assert.equal(
				await row.locator(".tedi-row-meta [data-tone]").innerText(),
				"Active",
			);
			assert.equal(
				await toggle.locator(".truncate").count(),
				0,
				"identity and role are not truncated",
			);
			assert(
				!(await toggle.innerText()).includes("reddit-scout"),
				"slug does not repeat the name",
			);
			const clippedHints = await page
				.locator(".tedi-row-toggle .break-words")
				.evaluateAll((items) =>
					items.some(
						(el) =>
							el.scrollWidth > el.clientWidth + 1 ||
							el.scrollHeight > el.clientHeight + 1,
					),
				);
			assert.equal(
				clippedHints,
				false,
				"long names and role descriptions remain readable",
			);
			const overflow = () =>
				page
					.locator("[data-slot=page]")
					.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
			assert.equal(
				await overflow(),
				false,
				"roster has no horizontal overflow",
			);
			await page.keyboard.press("Tab");
			await toggle.focus();
			const focus = await toggle.evaluate((el) => ({
				shadow: getComputedStyle(el).boxShadow,
				outline: getComputedStyle(el).outlineStyle,
			}));
			assert(
				focus.shadow.includes("inset"),
				"focus thickens the existing edge in both directions",
			);
			assert.equal(focus.outline, "none");
			const padding = await row
				.locator("..")
				.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft));
			assert(padding >= 2, "collection leaves room for focus rings");
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-roster-${width}-${theme}.png`,
					animations: "disabled",
					timeout: 120_000,
				});
			await toggle.click();
			await row.getByText("Workload", { exact: true }).waitFor();
			assert.equal(
				await row.locator(".truncate").count(),
				0,
				"expanded task titles and blockers wrap",
			);
			assert.equal(
				await overflow(),
				false,
				"expanded roster has no horizontal overflow",
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-expanded-${width}-${theme}.png`,
					animations: "disabled",
					timeout: 120_000,
				});
			await row.getByText("Open details", { exact: true }).click();
			await page
				.getByRole("heading", { name: "Wiring", exact: true })
				.waitFor();
			const meta = page.locator(".tedi-header-meta");
			const metaRows = await meta
				.locator("li")
				.evaluateAll((items) =>
					items.map((el) => el.getBoundingClientRect().y),
				);
			assert.equal(
				new Set(metaRows).size,
				1,
				"runtime metadata stays on one quiet line",
			);
			assert.equal(await meta.locator("[data-slot=badge]").count(), 0);
			const activity = page.getByRole("button", {
				name: "Activity and authority",
				exact: true,
			});
			assert.equal(await activity.getAttribute("aria-expanded"), "false");
			await activity.click();
			await page.getByText("1 active entrustment", { exact: true }).waitFor();
			assert(
				await page.getByText(/6 decisions/).isVisible(),
				"activity remains available on demand",
			);
			await activity.click();
			const technical = page.getByRole("button", {
				name: "Technical details",
				exact: true,
			});
			assert.equal(await technical.getAttribute("aria-expanded"), "false");
			assert.equal(
				await page.getByText("Operational identity", { exact: true }).count(),
				0,
			);
			assert.equal(
				await overflow(),
				false,
				"detail has no horizontal overflow",
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-detail-${width}-${theme}.png`,
					animations: "disabled",
					timeout: 120_000,
				});
			await technical.click();
			await page.getByText(/^Tedi ID:/).waitFor();
			assert(
				await page.getByText(/^Tedi ID:/).isVisible(),
				"technical identity remains accessible",
			);
			await page.close();
			console.log(`PASS WebKit tedis ${width}×${height} ${theme}`);
		}
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		server.kill();
	}
	await server.exited;
}
