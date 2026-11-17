import assert from "node:assert/strict";
import { startDocTabs } from "./doc-editor-tabs";

// Every block of a Doc shows a handle beside it on hover: dragging the handle
// moves the block, and clicking it offers Turn into, Duplicate and Delete.
const tabs = await startDocTabs();
try {
	const { page, frame, editor } = await tabs.open();
	const handle = frame.locator(".doc-handle");
	const blocks = () => editor.locator("> p, > h2").allTextContents();

	await editor.click();
	await page.keyboard.press("ControlOrMeta+End");
	for (const line of ["Second", "Third"]) {
		await page.keyboard.press("Enter");
		await page.keyboard.type(line);
	}
	const before = await blocks();
	const last = editor.locator("> p").last();

	// Hover the last block and drag its handle above the first one.
	await last.hover();
	await handle.waitFor();
	const grip = (await handle.boundingBox())!;
	const first = (await editor.locator("> *").first().boundingBox())!;
	await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
	await page.mouse.down();
	await page.mouse.move(grip.x + 4, first.y + 4, { steps: 8 });
	await frame.locator(".doc-drop").waitFor();
	await page.mouse.up();
	const moved = await blocks();
	assert.equal(moved[0], "Third", "the dragged block is first");
	assert.equal(moved.length, before.length, "nothing was lost or doubled");

	// Click the handle of the first block: turn it into a heading.
	await editor.locator("> *").first().hover();
	await handle.click();
	const menu = frame.locator(".doc-block-menu");
	await menu.waitFor();
	await menu.getByRole("menuitem", { name: "Heading 2" }).click();
	await editor.locator("> h2", { hasText: "Third" }).waitFor();

	// And duplicate it from the same menu.
	await editor.locator("> h2").hover();
	await handle.click();
	await menu.getByRole("menuitem", { name: /^Duplicate/ }).click();
	assert.equal(await editor.locator("> h2", { hasText: "Third" }).count(), 2);
	// "+" adds a line below and opens the insert menu on it (a narrow pane
	// has no room for "+" in the margin, so it only shows when there is).
	await editor.locator("> p").last().hover();
	if (await frame.locator(".doc-add").isVisible()) {
		await frame.locator(".doc-add").click();
		await frame.locator(".doc-slash").waitFor();
		await page.keyboard.press("Escape");
		await page.keyboard.press("Backspace");
		await page.keyboard.press("Backspace");
	}

	// Esc selects the block; Shift+arrow extends; Backspace deletes both.
	const count = await editor.locator("> *").count();
	await editor.locator("> p").last().click();
	await page.keyboard.press("Escape");
	await frame.locator(".doc-block-selected").first().waitFor();
	await page.keyboard.press("Shift+ArrowUp");
	assert.equal(await frame.locator(".doc-block-selected").count(), 2);
	await page.keyboard.press("Backspace");
	assert.equal(await editor.locator("> *").count(), count - 2);
	console.log(
		"Doc block handle passed: drag, turn into, duplicate, +, block selection",
	);
} finally {
	await tabs.stop();
}
