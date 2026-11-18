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
	await triggers.first().waitFor();
	assert(
		(await triggers.count()) >= 2,
		"the workspace has two files to act on",
	);
	const titleOf = async (index: number) =>
		((await triggers.nth(index).getAttribute("aria-label")) ?? "").replace(
			"Actions for ",
			"",
		);
	const first = await titleOf(0);
	const second = await titleOf(1);

	// The button is a thumb-sized target and opens the full set of actions.
	await triggers.first().scrollIntoViewIfNeeded();
	const target = await triggers.first().boundingBox();
	assert(
		target && target.width >= 44 && target.height >= 44,
		`the "…" button is at least 44px: ${JSON.stringify(target)}`,
	);
	await triggers.first().tap();
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
			.getByRole("button", { name: `Actions for ${first}`, exact: true })
			.count(),
		0,
		"the old name is gone",
	);
	await noSidewaysScroll("after rename");

	// Archive, after a confirmation.
	await renamed.tap();
	await page.getByRole("menuitem", { name: "Archive" }).tap();
	const confirm = page.getByRole("alertdialog");
	await confirm.getByRole("button", { name: "Archive", exact: true }).tap();
	await renamed.waitFor({ state: "detached" });

	// A refused archive leaves the file where it was and says why.
	await page.route("**/api/rpc/osWorkspaces/outputs/archive*", (route) =>
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
	);
	const kept = files.getByRole("button", {
		name: `Actions for ${second}`,
		exact: true,
	});
	await kept.tap();
	await page.getByRole("menuitem", { name: "Archive" }).tap();
	await confirm.getByRole("button", { name: "Archive", exact: true }).tap();
	await confirm.locator("[data-confirm-error]").waitFor();
	await confirm.getByRole("button", { name: "Cancel" }).tap();
	await confirm.waitFor({ state: "hidden" });
	await kept.waitFor();
	await noSidewaysScroll("after a refusal");

	await context.close();
	console.log(
		"PASS files on a phone: 44px file menu, rename, archive, refusal shown",
	);
} finally {
	await browser.close();
	await server.stop();
}
