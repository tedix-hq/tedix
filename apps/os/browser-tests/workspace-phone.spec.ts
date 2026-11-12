import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * A workspace on a phone (375 x 812):
 * - a menu opens as a sheet across the bottom edge with thumb-sized actions,
 *   not as a small box beside its button;
 * - the workspace reopens on the tab (Chat, Canvas, Files) it was left on;
 * - the browser's install prompt becomes one "Add to Home Screen" notice that
 *   is not shown a second time;
 * - nothing scrolls sideways.
 */
const workspace = "/workspace/00000030-0000-4000-8000-000000000001";

const server = await startFixtureServer("/");
const browser = await chromium.launch({ headless: true });

try {
	const context = await browser.newContext({
		viewport: { width: 375, height: 812 },
		reducedMotion: "reduce",
		isMobile: true,
		hasTouch: true,
	});
	// Other specs rely on automation hiding the install notice; this one checks
	// the notice, so it looks like a person's browser.
	await context.addInitScript(() =>
		Object.defineProperty(Navigator.prototype, "webdriver", {
			get: () => false,
		}),
	);
	const page = await context.newPage();
	const noSidewaysScroll = async (where: string) =>
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth),
			375,
			`${where}: the page is exactly as wide as the phone`,
		);

	// Files, then its menu as a bottom sheet.
	await page.goto(`${server.origin}${workspace}?pane=resources`, {
		waitUntil: "domcontentloaded",
	});
	await page.getByRole("button", { name: "Workspace actions" }).click();
	const menu = page.getByRole("menu");
	await menu.waitFor();
	const sheet = await menu.boundingBox();
	assert(sheet, "the menu is on screen");
	assert.equal(Math.round(sheet.x), 0, "the sheet starts at the left edge");
	assert.equal(Math.round(sheet.width), 375, "the sheet spans the phone");
	assert.equal(
		Math.round(sheet.y + sheet.height),
		812,
		"the sheet sits on the bottom edge",
	);
	for (const item of await menu.getByRole("menuitem").all()) {
		const box = await item.boundingBox();
		assert(box && box.height >= 44, "every action is at least 44px tall");
		assert(box.width >= 300, "every action spans the sheet");
	}
	await noSidewaysScroll("menu open");
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });

	// Left on Files: a plain workspace link comes back to Files.
	await page.goto(`${server.origin}${workspace}`, {
		waitUntil: "domcontentloaded",
	});
	await page.waitForFunction(
		() =>
			document.querySelector<HTMLElement>(".canvas-surface")?.dataset
				.mobilePane === "resources",
	);
	assert.match(page.url(), /pane=resources/);

	// Left on Chat: a plain workspace link stays on Chat and opens no file.
	await page
		.getByRole("group", { name: "Canvas pane" })
		.getByRole("button", { name: "Chat" })
		.click();
	await page.waitForURL(/pane=chat/);
	await page.goto(`${server.origin}${workspace}`, {
		waitUntil: "domcontentloaded",
	});
	await page.getByRole("group", { name: "Canvas pane" }).waitFor();
	await page.waitForTimeout(1500);
	assert.equal(
		await page.evaluate(
			() =>
				document.querySelector<HTMLElement>(".canvas-surface")?.dataset
					.mobilePane,
		),
		"chat",
	);
	assert.doesNotMatch(page.url(), /workpiece=/);
	await noSidewaysScroll("chat");

	// The browser offers to install: one notice, with an Install button.
	const offerInstall = () =>
		page.evaluate(() => {
			const event = new Event("beforeinstallprompt", { cancelable: true });
			Object.assign(event, {
				prompt: () => {
					document.documentElement.dataset.installPrompted = "true";
					return Promise.resolve();
				},
			});
			window.dispatchEvent(event);
		});
	await offerInstall();
	const notice = page.getByText("Add Tedix to your Home Screen");
	await notice.waitFor();
	await page.getByRole("button", { name: "Install", exact: true }).click();
	await page.waitForFunction(
		() => document.documentElement.dataset.installPrompted === "true",
	);
	await notice.waitFor({ state: "hidden" });

	// It was shown once; a later offer on a later visit says nothing.
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByRole("group", { name: "Canvas pane" }).waitFor();
	await offerInstall();
	await page.waitForTimeout(1000);
	assert.equal(await notice.count(), 0, "the notice is not shown again");

	await context.close();
	console.log(
		"PASS workspace on a phone: sheet menu, last tab, one install notice",
	);
} finally {
	await browser.close();
	await server.stop();
}
