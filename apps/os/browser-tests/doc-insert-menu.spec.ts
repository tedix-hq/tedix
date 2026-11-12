import assert from "node:assert/strict";
import { startDocTabs } from "./doc-editor-tabs";

// Typing "/" on an empty line of a Doc opens a list of things to insert. It
// filters as you type, is driven with the arrow keys and Enter, closes on
// Escape, and what was chosen is saved in place of the typed text.
const tabs = await startDocTabs();
try {
	const { page, frame, editor } = await tabs.open();
	const list = frame.locator(".doc-slash");
	const options = () => list.locator('[role="option"]').allTextContents();
	const picked = () => list.locator('[aria-selected="true"]').textContent();

	await editor.click();
	await page.keyboard.press("ControlOrMeta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/");
	await list.waitFor();
	assert.deepEqual(await options(), [
		"Heading 1",
		"Heading 2",
		"Heading 3",
		"Bulleted list",
		"Numbered list",
		"To-do list",
		"Table",
		"Image",
		"Divider",
		"Collapsible section",
	]);
	// The list sits under the line that was typed on, inside the page.
	const box = (await list.boundingBox())!;
	const caret = (await editor.locator("p").last().boundingBox())!;
	assert(box.y >= caret.y, "the list opens below the typed line");
	assert(box.x >= 0 && box.x + box.width <= 1280, "the list is on screen");

	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	assert.equal(await picked(), "Heading 3");
	await page.keyboard.press("ArrowUp");
	assert.equal(await picked(), "Heading 2");

	await page.keyboard.press("Escape");
	await list.waitFor({ state: "hidden" });
	await page.keyboard.type("x");
	assert(await list.isHidden(), "a dismissed list stays closed on that line");
	await page.keyboard.press("Backspace");
	await page.keyboard.press("Backspace");

	await page.keyboard.type("/tab");
	await list.waitFor();
	assert.deepEqual(await options(), ["Table"]);
	await page.keyboard.press("Enter");
	await list.waitFor({ state: "hidden" });
	await editor.locator("table").waitFor();
	assert.equal(
		await editor.getByText("/tab").count(),
		0,
		"the typed text made way for the table",
	);
	// The caret is in the table: typing fills its first cell.
	await page.keyboard.type("First cell");
	assert.equal(
		await editor.locator("table th").first().textContent(),
		"First cell",
	);

	// The empty line the editor keeps after a table.
	await editor.locator("> p").last().click();
	await page.keyboard.type("/to");
	await list.waitFor();
	assert.deepEqual(await options(), ["To-do list", "Collapsible section"]);
	await list.getByText("To-do list").click();
	await editor.locator('ul[data-type="taskList"]').waitFor();
	await page.keyboard.type("Call Ada");

	await page.waitForTimeout(2_000);
	const saved = JSON.stringify((await tabs.saved()).content.richText);
	assert.match(saved, /"type":"table"/, "the table was saved");
	assert.match(saved, /"type":"taskList"/, "the to-do list was saved");
	assert.match(saved, /Call Ada/);
	assert.doesNotMatch(saved, /\/tab|\/to/, "no typed command was saved");
	console.log(
		"Doc insert menu passed: open, filter, arrows, Escape, Enter, click, saved",
	);
} finally {
	await tabs.stop();
}
