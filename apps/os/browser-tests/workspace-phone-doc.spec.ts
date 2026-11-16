import assert from "node:assert/strict";
import { startEditorTabs } from "./doc-editor-tabs";

/*
 * Editing a document in a workspace on a phone (375 x 812), with the real
 * Doc editor:
 * - the page and the editor are exactly as wide as the phone;
 * - the open file's tab keeps its Close button reachable: no scroll arrow is
 *   left on top of it when there is nothing to scroll to;
 * - every formatting control and menu action is at least 44px tall;
 * - the More menu opens inside the screen;
 * - typed text is saved.
 */
const tabs = await startEditorTabs({
	kind: "document",
	phone: { width: 375, height: 812 },
});
try {
	const { page, frame, editor } = await tabs.open();

	assert.equal(
		await page.evaluate(() => document.documentElement.scrollWidth),
		375,
		"the page is exactly as wide as the phone",
	);

	// One open file: its tab fits, so nothing offers to scroll the tabs and a
	// tap on Close reaches Close. The tab row settles after the title loads.
	const openTabs = page.getByRole("tablist", { name: "Open workpieces" });
	await openTabs.getByRole("tab").waitFor();
	await page.waitForTimeout(1_000);
	assert.equal(await openTabs.getByRole("tab").count(), 1);
	assert.equal(
		await page.getByRole("button", { name: /^Scroll Open workpieces/ }).count(),
		0,
		"one tab that fits has no scroll arrows",
	);
	const close = page.getByRole("button", { name: /^Close Doc/ });
	const closeBox = await close.boundingBox();
	assert(closeBox, "the tab's Close is on screen");
	assert(
		closeBox.width >= 44 && closeBox.height >= 44,
		"the tab's Close is thumb-sized",
	);
	assert.match(
		await page.evaluate(
			([x, y]) =>
				document
					.elementFromPoint(x!, y!)
					?.closest("button")
					?.getAttribute("aria-label") ?? "",
			[closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2],
		),
		/^Close Doc/,
		"a tap on the tab's Close reaches it",
	);

	// The editor itself.
	const body = frame.locator("body");
	assert.deepEqual(
		await body.evaluate(() => [
			window.innerWidth,
			document.documentElement.scrollWidth,
		]),
		[375, 375],
		"the editor is exactly as wide as the phone",
	);
	const toolbar = frame.getByRole("toolbar", { name: "Document formatting" });
	for (const control of await toolbar.locator("button, select").all()) {
		if (!(await control.isVisible())) continue;
		const box = await control.boundingBox();
		assert(
			box && box.height >= 44 && box.width >= 44,
			`toolbar control ${await control.getAttribute("aria-label")} is at least 44px`,
		);
	}

	// More opens inside the screen with thumb-sized actions.
	await toolbar.locator(".doc-more").click();
	const menu = frame.getByRole("menu", { name: "More" });
	await menu.waitFor();
	// The menu scales in; measure it once it has its full size.
	await page.waitForTimeout(400);
	const menuBox = await menu.boundingBox();
	assert(menuBox, "the More menu is on screen");
	assert(
		menuBox.x >= 0 && menuBox.x + menuBox.width <= 375,
		"the More menu is inside the screen",
	);
	for (const action of await menu.locator("button").all()) {
		if (!(await action.isVisible())) continue;
		const box = await action.boundingBox();
		assert(box && box.height >= 44, "every More action is at least 44px tall");
	}
	await toolbar.locator(".doc-more").click();
	await menu.waitFor({ state: "hidden" });

	// Typing saves.
	await editor.click();
	await page.keyboard.press("ControlOrMeta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("Written on a phone");
	await page.waitForTimeout(2_000);
	assert.match(
		JSON.stringify((await tabs.saved()).content.richText),
		/Written on a phone/,
		"the typed line was saved",
	);
	assert.equal(
		await page.evaluate(() => document.documentElement.scrollWidth),
		375,
		"the page is still exactly as wide as the phone after typing",
	);

	console.log(
		"PASS a document on a phone: reachable Close, 44px controls, saved text",
	);
} finally {
	await tabs.stop();
}
