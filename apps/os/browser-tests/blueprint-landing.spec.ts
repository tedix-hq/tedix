import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

// A signed-out visitor opens a shared blueprint link, reads what it does and
// needs, and follows "Use this blueprint" to the gallery's install form.
// Fixture blueprint: the local lane's catalog-visible "Revenue Ops Starter".
const BLUEPRINT = "00000050-0000-4000-8000-000000000001";
const MISSING = "00000050-0000-4000-8000-0000000000ff";
const path = `/blueprint/${BLUEPRINT}`;
const server = await startFixtureServer(path);
const browser = await chromium.launch({ headless: true });
const directory =
	process.env.TEDIX_BROWSER_ARTIFACTS_DIR ?? "/tmp/tedix-blueprint-landing";
await mkdir(directory, { recursive: true });
try {
	for (const width of [375, 1280]) {
		const context = await browser.newContext({
			viewport: { width, height: 900 },
		});
		await context.addCookies([
			{
				name: "tedix_probe",
				value: "must-not-be-sent",
				url: server.origin,
			},
		]);
		const page = await context.newPage();
		const publicReads: { cookie: string | undefined; url: string }[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname.startsWith("/api/public/"))
				publicReads.push({
					cookie: request.headers().cookie,
					url: request.url(),
				});
		});
		await page.goto(`${server.origin}${path}`, {
			waitUntil: "domcontentloaded",
		});
		await page
			.getByRole("heading", { name: "Revenue Ops Starter", level: 1 })
			.waitFor();
		const text = await page.locator("main").innerText();
		assert.match(text, /What it sets up/);
		assert.match(text, /Revenue Dashboard/);
		assert.match(text, /What it needs/);
		assert.match(text, /gmail/);
		assert.match(text, /weekly-revenue-report/);
		assert.match(text, /Featured/);
		assert.doesNotMatch(text, /Tedix local/, "no publisher name signed out");
		// Dev StrictMode may read twice; every read must go without credentials.
		assert.ok(publicReads.length >= 1, "the page read its public summary");
		for (const read of publicReads)
			assert.equal(read.cookie, undefined, "read sends no cookie");
		const overflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth,
		);
		assert.ok(overflow <= 1, `${width}px page overflows by ${overflow}px`);
		await page.screenshot({
			path: `${directory}/landing-${width}.png`,
			fullPage: true,
		});

		await page.getByRole("button", { name: "Use this blueprint" }).click();
		await page.waitForURL(`**/blueprints?install=${BLUEPRINT}`);
		await page.getByText("Pick a name to install this template").waitFor();
		await page
			.getByRole("textbox", { name: "Workspace name for Revenue Ops Starter" })
			.waitFor();
		assert.equal(
			await page.locator(".blueprint-gallery-card").count(),
			1,
			"only the shared template is offered",
		);
		await page.screenshot({
			path: `${directory}/install-${width}.png`,
			fullPage: true,
		});

		await page.getByRole("button", { name: "Show all templates" }).click();
		await page.getByRole("heading", { name: "Featured" }).waitFor();

		await page.goto(`${server.origin}/blueprint/${MISSING}`, {
			waitUntil: "domcontentloaded",
		});
		await page.getByText("This blueprint is not available").waitFor();
		await context.close();
		console.log(`blueprint landing ${width}: ok`);
	}
} finally {
	await browser.close();
	await server.stop();
}
