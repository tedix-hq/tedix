import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * Stalled work shows one row per cause. Three pauses of one Work Item are one
 * row that names the Work Item, says why it stalled and how often, and offers
 * one next step; the three records open on request.
 */
const server = await startFixtureServer("/browser-tests/feed-deck-polish.html");
const { origin } = server;
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	const { width, height, theme } = {
		width: 390,
		height: 844,
		theme: "dark",
	} as const;
	const page = await browser.newPage({
		viewport: { width, height },
		colorScheme: theme,
	});
	await page.goto(
		`${origin}/browser-tests/feed-deck-polish.html?shell&surface=feed&stalled&theme=${theme}`,
	);
	const list = page.getByRole("list", {
		name: "Stalled work, one row per cause",
	});
	await list.waitFor();
	const rows = list.locator(".ft-stalled");
	assert.equal(await rows.count(), 2, "one row per repeated cause");
	assert.equal(await page.locator(".ft-day-label").count(), 0);

	const paused = page.getByRole("article", {
		name: "Workspace file: Paused, 3 times",
	});
	await paused.waitFor();
	assert.equal(
		await paused.locator(".ft-sentence").textContent(),
		"Workspace file",
	);
	const why = await paused.locator(".ft-stalled-why").textContent();
	assert.match(why ?? "", /Paused · 3 times/);
	assert.match(
		why ?? "",
		/The Attempt stopped reporting before it delivered a result\./,
	);
	assert.equal(
		await paused
			.getByRole("link", { name: "Pine Studio", exact: true })
			.count(),
		1,
		"the row names its Project",
	);
	const next = paused.getByRole("link", {
		name: "Open Work Item: Workspace file",
	});
	assert.equal(
		await next.getAttribute("href"),
		"/work/items/33333333-3333-4333-8333-333333333333",
	);

	const failed = page.getByRole("article", {
		name: "March ledger: Didn't finish, 2 times",
	});
	assert.match(
		(await failed.locator(".ft-stalled-why").textContent()) ?? "",
		/Last report: The bank export was empty, so nothing could be matched\./,
	);
	// A stall that happened once keeps its own record row.
	await page
		.getByRole("article", {
			name: "Supplier review — paused before finishing.",
		})
		.waitFor();

	// The repeats are counted, not listed, until someone asks for them.
	assert.equal(await page.locator("[data-focus-row]").count(), 3);
	const toggle = paused.getByRole("button", {
		name: "Show all 3 records",
	});
	await toggle.click();
	await paused.getByRole("button", { name: "Hide the records" }).waitFor();
	assert.equal(await page.locator("[data-focus-row]").count(), 6);
	await paused.getByRole("button", { name: "Hide the records" }).click();
	assert.equal(await page.locator("[data-focus-row]").count(), 3);

	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth > innerWidth,
		),
		false,
		`Stalled work overflows at ${width}/${theme}`,
	);
	if (process.env.TEDIX_SCREENSHOT_DIR)
		await page.screenshot({
			path: `${process.env.TEDIX_SCREENSHOT_DIR}/stalled-${width}-${theme}.png`,
		});
	await page.close();
	console.log(
		`Stalled work ${width}x${height} ${theme}: one row per cause, reason, count, next step and expand passed`,
	);
} finally {
	await browser?.close();
	await server.stop();
}
