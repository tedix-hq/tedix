import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { startEditorTabs } from "./doc-editor-tabs";

// Two people with the same presentation open edit it at the same time.
// Different slides, or different elements of one slide: both edits are kept
// and nobody is asked anything, whether the server or the editor does the
// merging. The same element: the later writer is asked which version stays
// there, and keeps every other change from both.
const element = (id: string, text: string, y: number) => ({
	id,
	type: "title",
	x: 80,
	y,
	width: 900,
	height: 90,
	text,
	style: { fontSize: 46, fontFamily: "Georgia", color: "#123456" },
});
const slide = (id: string, ...elements: object[]) => ({
	id,
	name: id,
	layout: "blank",
	background: "#ffffff",
	elements,
});
const tabs = await startEditorTabs({
	kind: "presentation",
	ready: ".slides-stage .slides-element",
	content: {
		kind: "presentation",
		slides: [],
		deck: {
			width: 1200,
			height: 675,
			activeSlideId: "one",
			slides: [
				slide("one", element("a", "Title", 80), element("b", "Body", 240)),
				slide("two", element("c", "Second", 80), element("d", "Notes", 240)),
			],
		},
	},
});
try {
	const a = await tabs.open();
	const b = await tabs.open();
	// A presentation opens for viewing: both start editing.
	for (const tab of [a, b]) await tab.frame.locator("#mode").click();
	type Tab = typeof a;
	const stage = (tab: Tab, id: string) =>
		tab.frame.locator(`.slides-stage [data-element-id="${id}"]`);
	/** Open a slide and replace the text of one of its elements. */
	const write = async (tab: Tab, slideId: string, id: string, text: string) => {
		await tab.frame
			.locator(`.slides-thumb[data-slide-id="${slideId}"] button`)
			.first()
			.click();
		await stage(tab, id).dblclick();
		await tab.frame.locator(".slides-inline-editor").waitFor();
		await tab.page.keyboard.type(text);
		await tab.page.keyboard.press("Enter");
	};
	const shows = async (tab: Tab, slideId: string, id: string, text: string) => {
		await tab.frame
			.locator(`.slides-thumb[data-slide-id="${slideId}"] button`)
			.first()
			.click();
		await stage(tab, id)
			.getByText(text, { exact: true })
			.waitFor({ timeout: 15_000 });
	};
	const question = (tab: Tab) =>
		tab.frame.getByRole("button", { name: "Keep mine" });
	const stored = async () =>
		Object.fromEntries(
			(await tabs.saved()).content.deck.slides.flatMap(
				(row: { elements: { id: string; text: string }[] }) =>
					row.elements.map((item) => [item.id, item.text]),
			),
		) as Record<string, string>;
	/** Keep one tab's saves from reaching the server until released. */
	const hold = async (page: Page, fail = false) => {
		let release = () => {};
		const released = new Promise<void>((resolve) => (release = resolve));
		let open = false;
		const handler = async (route: Route) => {
			if (!open && fail) return route.abort("connectionfailed");
			if (!open) await released;
			await route.fallback();
		};
		await page.route("**/api/rpc/osWorkspaces/outputs/patch", handler);
		return () => {
			open = true;
			release();
		};
	};
	const expected = { a: "Title", b: "Body", c: "Second", d: "Notes" };
	const settle = async (message: string) => {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const now = await stored();
			if (JSON.stringify(now) === JSON.stringify(expected)) return;
			if (Date.now() > deadline) assert.deepEqual(now, expected, message);
			await a.page.waitForTimeout(250);
		}
	};
	const unasked = async (step: string) => {
		assert.equal(await question(a).count(), 0, `${step}: A was not asked`);
		assert.equal(await question(b).count(), 0, `${step}: B was not asked`);
	};

	// 1. Different slides. A's save is still on its way when B's lands: the
	// server merges.
	let release = await hold(a.page);
	await write(a, "one", "a", "Title by A");
	await a.page.waitForTimeout(2_500);
	await write(b, "two", "c", "Second by B");
	expected.c = "Second by B";
	await settle("B saved while A's save was held");
	release();
	expected.a = "Title by A";
	await settle("the server kept both slides' edits");
	await shows(a, "two", "c", "Second by B");
	await shows(b, "one", "a", "Title by A");
	await unasked("different slides");
	await a.page.unroute("**/api/rpc/osWorkspaces/outputs/patch");

	// 2. Different elements of one slide. A cannot save for a moment and B's
	// change arrives meanwhile: A's editor merges it into the unsaved slide,
	// then saves both.
	release = await hold(a.page, true);
	await write(a, "one", "a", "Title again");
	await a.page.waitForTimeout(2_500);
	await write(b, "one", "b", "Body by B");
	await shows(a, "one", "b", "Body by B");
	await shows(a, "one", "a", "Title again");
	assert.equal(await question(a).count(), 0, "A was not asked");
	release();
	expected.a = "Title again";
	expected.b = "Body by B";
	await settle("the editor merged and saved both elements");
	await shows(b, "one", "a", "Title again");
	await unasked("different elements");
	await a.page.unroute("**/api/rpc/osWorkspaces/outputs/patch");

	// 3. Both change the same element, and each another one too.
	release = await hold(a.page, true);
	await write(a, "two", "c", "Second, says A");
	await write(a, "two", "d", "Notes by A");
	await a.page.waitForTimeout(2_500);
	await write(b, "two", "c", "Second, says B");
	await write(b, "one", "b", "Body, final");
	await question(a).waitFor({ timeout: 15_000 });
	assert.equal(await question(b).count(), 0, "only the later writer is asked");
	// Nothing of A's is saved or dropped while the question is open.
	await shows(a, "two", "c", "Second, says A");
	assert.equal((await stored()).c, "Second, says B");
	release();
	await question(a).click();
	expected.c = "Second, says A";
	expected.d = "Notes by A";
	expected.b = "Body, final";
	await settle("A's text won the shared element; the rest is kept");
	await shows(a, "one", "b", "Body, final");
	await shows(b, "two", "c", "Second, says A");
	await shows(b, "two", "d", "Notes by A");
	console.log(
		"Slides concurrent edits passed: server merge, editor merge, and a choice only for the same element",
	);
} finally {
	await tabs.stop();
}
