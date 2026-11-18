import assert from "node:assert/strict";
import { startEditorTabs } from "./doc-editor-tabs";

const headings = [
	{ level: 1, text: "Plan" },
	{ level: 2, text: "Work" },
	{ level: 3, text: "Proof" },
];
const content = {
	kind: "document",
	blocks: headings.map(({ level, text }) => ({ type: "heading", level, text })),
	richText: {
		type: "doc",
		content: headings.flatMap(({ level, text }, index) => [
			{
				type: "heading",
				attrs: { level },
				content: [{ type: "text", text }],
			},
			...(index < 2
				? Array.from({ length: 16 }, (_, line) => ({
						type: "paragraph",
						content: [{ type: "text", text: `${text} line ${line + 1}` }],
					}))
				: []),
		]),
	},
};

const tabs = await startEditorTabs({ kind: "document", content });
try {
	const { page, frame } = await tabs.open();
	await page.setViewportSize({ width: 2200, height: 900 });
	const outline = frame.locator(".doc-outline");
	await outline.waitFor({ state: "visible" });
	assert.equal(await outline.getByRole("button").count(), 3);
	const outlineLayout = await outline.evaluate((node) => {
		const box = node.getBoundingClientRect();
		return {
			height: box.height,
			middle: box.top + box.height / 2,
			viewport: innerHeight,
		};
	});
	assert(
		outlineLayout.height <= outlineLayout.viewport * 0.64 + 1,
		"the outline stays within 64vh",
	);
	assert(
		Math.abs(outlineLayout.middle - outlineLayout.viewport / 2) < 3,
		"the outline is centred",
	);
	assert.deepEqual(
		await outline
			.locator("i")
			.evaluateAll((nodes) =>
				nodes.map((node) => getComputedStyle(node).width),
			),
		["16px", "11px", "7px"],
	);
	await outline.hover();
	assert.equal(
		await outline
			.getByText("Plan")
			.evaluate((node) => getComputedStyle(node).fontSize),
		"12.5px",
	);
	assert.equal(
		await outline.locator('[aria-current="true"]').getAttribute("aria-label"),
		"Plan",
	);
	await outline.getByRole("button", { name: "Proof" }).click();
	await page.waitForTimeout(100);
	assert(
		(await frame.locator(".tiptap").evaluate(() => scrollY)) > 0,
		"an outline click scrolls to its heading",
	);
	assert.equal(
		await outline.locator('[aria-current="true"]').getAttribute("aria-label"),
		"Work",
	);

	await frame.getByRole("button", { name: "Typeface & width" }).click();
	await frame.locator('[data-typeface="serif"]').click();
	await frame.getByRole("button", { name: "Full width" }).click();
	const editor = frame.locator(".tiptap");
	assert.equal(
		await editor.evaluate((node) => getComputedStyle(node).fontSize),
		"18px",
	);
	assert.equal(
		await editor.evaluate((node) => getComputedStyle(node).lineHeight),
		"28.8px",
	);
	const pageWidth = await frame
		.locator(".doc-page")
		.evaluate((node) => node.getBoundingClientRect().width);
	assert(pageWidth > 900, "full width expands the document measure");
	await page.waitForTimeout(1_500);
	assert.deepEqual((await tabs.saved()).content.appearance, {
		typeface: "serif",
		wide: true,
	});

	console.log(
		"Doc outline and appearance passed: centred outline, heading dashes, serif metrics, full width and shared save",
	);
} finally {
	await tabs.stop();
}
