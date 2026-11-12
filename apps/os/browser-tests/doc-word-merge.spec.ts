import assert from "node:assert/strict";
import type { Locator, Page, Route } from "playwright";
import { startDocTabs } from "./doc-editor-tabs";

// Two people with the same Doc open change one paragraph at the same time.
// Different words: both changes are kept and nobody is asked anything, whether
// the server or the editor does the merging. The same word: the later writer
// is asked which version stays there, and keeps everything else from both.
const tabs = await startDocTabs();
try {
	const a = await tabs.open();
	const b = await tabs.open();
	const question = (tab: typeof a) =>
		tab.frame.locator(".doc-status").getByText("Keep mine");
	/** Select one word of the document, as a double-click on it would. */
	const select = (editor: Locator, word: string) =>
		editor.evaluate((element, wanted) => {
			const { editor } = element as HTMLElement & {
				editor: {
					state: {
						doc: {
							descendants(
								visit: (node: { text?: string }, pos: number) => void,
							): void;
						};
					};
					chain(): {
						focus(): {
							setTextSelection(range: { from: number; to: number }): {
								run(): boolean;
							};
						};
					};
				};
			};
			let from = -1;
			editor.state.doc.descendants((node, pos) => {
				const index = node.text?.indexOf(wanted) ?? -1;
				if (index >= 0 && from < 0) from = pos + index;
			});
			if (from < 0) throw new Error(`No "${wanted}" in the document`);
			editor
				.chain()
				.focus()
				.setTextSelection({ from, to: from + wanted.length })
				.run();
		}, word);
	const replace = async (tab: typeof a, word: string, next: string) => {
		await select(tab.editor, word);
		await tab.page.keyboard.type(next);
	};
	const shows = (tab: typeof a, text: string) =>
		tab.editor.getByText(text).waitFor({ timeout: 15_000 });
	const paragraph = async () => {
		const blocks = (await tabs.saved()).content.richText.content as {
			content?: { text?: string }[];
		}[];
		return blocks
			.map((block) => (block.content ?? []).map((run) => run.text).join(""))
			.find((text) => text.includes("launch"));
	};
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

	await a.editor.click();
	await a.page.keyboard.press("ControlOrMeta+End");
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.type("The launch is on Monday and the owner is Ada.");
	await shows(b, "The launch is on Monday and the owner is Ada.");

	// 1. A's save is still on its way when B's lands: the server merges.
	let release = await hold(a.page);
	await replace(a, "Monday", "Friday");
	await a.page.waitForTimeout(600);
	await replace(b, "Ada", "Bob");
	await shows(a, "Friday");
	await b.page.waitForTimeout(1_500);
	assert.equal(
		await paragraph(),
		"The launch is on Monday and the owner is Bob.",
		"B saved while A's save was held",
	);
	release();
	await shows(a, "The launch is on Friday and the owner is Bob.");
	await shows(b, "The launch is on Friday and the owner is Bob.");
	assert.equal(
		await paragraph(),
		"The launch is on Friday and the owner is Bob.",
	);
	assert.equal(await question(a).count(), 0, "A was not asked");
	assert.equal(await question(b).count(), 0, "B was not asked");
	await a.page.unroute("**/api/rpc/osWorkspaces/outputs/patch");

	// 2. A cannot save for a moment and B's change arrives meanwhile: A's
	// editor merges it into the unsaved text, then saves both.
	release = await hold(a.page, true);
	await replace(a, "launch", "release");
	await a.page.waitForTimeout(600);
	await replace(b, "owner", "lead");
	await shows(a, "The release is on Friday and the lead is Bob.");
	assert.equal(await question(a).count(), 0, "A was not asked");
	release();
	await shows(b, "The release is on Friday and the lead is Bob.");
	await a.page.unroute("**/api/rpc/osWorkspaces/outputs/patch");

	// 3. Both change the same word, and each another word too.
	release = await hold(a.page, true);
	await replace(a, "Friday", "Tuesday");
	await replace(a, "release", "launch");
	await a.page.waitForTimeout(600);
	await replace(b, "Friday", "Sunday");
	await replace(b, "Bob", "Cy");
	await question(a).waitFor({ timeout: 15_000 });
	assert.equal(await question(b).count(), 0, "only the later writer is asked");
	assert.match(
		(await a.frame.locator(".doc-status").textContent())!,
		/same words/,
	);
	release();
	await question(a).click();
	await shows(a, "The launch is on Tuesday and the lead is Cy.");
	await shows(b, "The launch is on Tuesday and the lead is Cy.");
	assert.equal(
		await paragraph(),
		"The launch is on Tuesday and the lead is Cy.",
	);
	console.log(
		"Doc word merge passed: server merge, editor merge, and a choice only for the same word",
	);
} finally {
	await tabs.stop();
}
