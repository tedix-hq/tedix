import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * Files on a phone (390 x 844): every active file card has a "…" button with
 * the same actions as the Files list row on a wide screen. A person can rename
 * and archive a file without widening the screen; when the server refuses an
 * action, the file stays as it was and the refusal is shown.
 */
const workspace = "/workspace/00000030-0000-4000-8000-000000000001";
const WIDTH = 390;

// Renaming and archiving write fixture state, so this spec owns its server.
const server = await startFixtureServer("/", { shared: false });
const browser = await chromium.launch({ headless: true });

try {
	const context = await browser.newContext({
		viewport: { width: WIDTH, height: 844 },
		reducedMotion: "reduce",
		isMobile: true,
		hasTouch: true,
	});
	const page = await context.newPage();
	const noSidewaysScroll = async (where: string) =>
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth),
			WIDTH,
			`${where}: the page is exactly as wide as the phone`,
		);
	await page.goto(`${server.origin}${workspace}?pane=resources`, {
		waitUntil: "domcontentloaded",
	});
	const files = page.locator(".canvas-resource-outputs");
	const triggers = files.getByRole("button", { name: /^Actions for / });
	const first = triggers.first();
	await first.waitFor();
	const originalLabel = await first.getAttribute("aria-label");
	assert(originalLabel);

	// The button is a thumb-sized target and opens the full set of actions.
	await first.scrollIntoViewIfNeeded();
	const target = await first.boundingBox();
	assert(
		target && target.width >= 44 && target.height >= 44,
		`the "…" button is at least 44px: ${JSON.stringify(target)}`,
	);
	await first.tap();
	const menu = page.getByRole("menu");
	await menu.waitFor();
	const items = menu.getByRole("menuitem");
	assert.deepEqual(
		(await items.allTextContents()).map((text) => text.trim()),
		[
			"Open",
			"Rename",
			"Version history",
			"Duplicate",
			"Move to workspace…",
			"Archive",
		],
	);
	for (const item of await items.all()) {
		const box = await item.boundingBox();
		assert(box && box.height >= 44, "every action is at least 44px tall");
	}
	await noSidewaysScroll("file menu open");

	// Rename.
	await menu.getByRole("menuitem", { name: "Rename" }).tap();
	const name = page.getByRole("textbox", { name: "File name" });
	await name.fill("Renamed on a phone");
	await page.getByRole("button", { name: "Rename", exact: true }).tap();
	const renamed = files.getByRole("button", {
		name: "Actions for Renamed on a phone",
	});
	await renamed.waitFor();
	assert.equal(
		await files
			.getByRole("button", { name: originalLabel, exact: true })
			.count(),
		0,
		"the old name is gone",
	);
	await noSidewaysScroll("after rename");

	// A refusal keeps the file in the list. The same dialog can retry.
	await page.route(
		"**/api/rpc/osWorkspaces/outputs/archive*",
		(route) =>
			route.fulfill({
				status: 403,
				json: {
					json: {
						defined: false,
						code: "FORBIDDEN",
						status: 403,
						message: "You cannot archive this file",
					},
				},
			}),
		{ times: 1 },
	);
	await renamed.tap();
	await page.getByRole("menuitem", { name: "Archive" }).tap();
	const confirm = page.getByRole("alertdialog");
	const archive = confirm.getByRole("button", { name: "Archive", exact: true });
	await archive.tap();
	await confirm.locator("[data-confirm-error]").waitFor();
	assert.equal(
		await files
			.getByRole("button", {
				name: "Actions for Renamed on a phone",
				includeHidden: true,
			})
			.count(),
		1,
	);
	await noSidewaysScroll("after a refusal");
	await archive.tap();
	await confirm.waitFor({ state: "hidden" });
	await renamed.waitFor({ state: "detached" });

	await context.close();
	console.log(
		"PASS files on a phone: 44px file menu, rename, archive, refusal shown",
	);
} finally {
	await browser.close();
	await server.stop();
}
