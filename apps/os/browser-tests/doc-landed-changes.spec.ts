import assert from "node:assert/strict";
import { startDocTabs } from "./doc-editor-tabs";

// Someone watches a Doc while an agent edits it. Each change lights up where
// it happens and comes into view when the watcher is idle; the watcher can
// take the agent's change back with the button or the undo shortcut, which
// saves a new change. A person's change lights up too, with no undo offer,
// and nothing scrolls under someone who is typing.
const tabs = await startDocTabs();
try {
	const viewer = await tabs.open();
	const other = await tabs.open();
	// The fixture API saves everything as the signed-in person. Tell the
	// watching tab the truth of this scenario: who saved the newest revision.
	let savedBy = "user";
	await viewer.page.route(
		"**/api/rpc/osWorkspaces/outputs/changes*",
		async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			body.json.revision.createdByKind = savedBy;
			await route.fulfill({ response, json: body });
		},
	);
	const para = (text: string) => ({
		type: "paragraph",
		content: [{ type: "text", text }],
	});
	const splice = (at: number, remove: number, ...insert: object[]) => ({
		kind: "document",
		ops: [
			{
				op: "splice",
				path: ["richText", "content"],
				hunks: [{ at, remove, insert }],
			},
		],
	});
	const lit = viewer.frame.locator(".doc-landed, .doc-landed-words");
	const offer = viewer.frame.getByRole("button", {
		name: "Undo agent change",
	});
	const scrolled = () => viewer.editor.evaluate(() => window.scrollY);
	const inView = (text: string) =>
		viewer.editor.getByText(text).evaluate((node) => {
			const box = node.getBoundingClientRect();
			return box.top >= 0 && box.bottom <= window.innerHeight;
		});

	// A document long enough that its end is off screen.
	const lines = Array.from({ length: 60 }, (_, index) =>
		para(`Line ${index + 1}`),
	);
	const start = 0;
	await tabs.writeAsAgent({
		kind: "document",
		ops: [
			{
				op: "set",
				path: ["richText"],
				value: { type: "doc", content: lines },
			},
		],
	});
	await viewer.editor.getByText("Line 60").waitFor();
	assert.equal(await scrolled(), 0, "the watcher is at the top");

	// 1. The watcher is idle: an agent rewrites a word far below and adds a line.
	await viewer.page.waitForTimeout(3_200);
	savedBy = "tedi";
	await tabs.writeAsAgent(
		splice(start + 59, 1, para("Line 60, checked"), para("Added by the agent")),
	);
	await viewer.editor.getByText("Added by the agent").waitFor();
	assert.deepEqual(await lit.allTextContents(), [
		"Line 60, checked",
		"Added by the agent",
	]);
	assert(await inView("Added by the agent"), "the change came into view");
	assert((await scrolled()) > 0);
	await offer.waitFor();
	assert.match(
		(await viewer.frame.locator(".doc-status").textContent())!,
		/An agent changed this document\./,
	);
	const agentRevision = (await tabs.saved()).revision;

	// 2. The undo shortcut takes the agent's change back as a new saved change.
	await viewer.editor.getByText("Line 59").click();
	await viewer.page.keyboard.press("ControlOrMeta+z");
	await viewer.editor.getByText("Added by the agent").waitFor({
		state: "detached",
	});
	await offer.waitFor({ state: "detached" });
	await other.editor.getByText("Added by the agent").waitFor({
		state: "detached",
		timeout: 15_000,
	});
	const undone = await tabs.saved();
	assert(undone.revision > agentRevision, "the undo is a newer revision");
	const text = JSON.stringify(undone.content.richText);
	assert.doesNotMatch(text, /Added by the agent|Line 60, checked/);
	assert.match(text, /"Line 60"/);
	// The watcher's own undo brings the agent's work back.
	await viewer.page.keyboard.press("ControlOrMeta+z");
	await viewer.editor.getByText("Added by the agent").waitFor();
	await viewer.page.keyboard.press("ControlOrMeta+Shift+z");
	await viewer.editor.getByText("Added by the agent").waitFor({
		state: "detached",
	});

	// 3. The button does the same.
	await viewer.page.waitForTimeout(1_500);
	await tabs.writeAsAgent(splice(start + 59, 1, para("Line 60, again")));
	await offer.click();
	await viewer.editor
		.getByText("Line 60, again")
		.waitFor({ state: "detached" });
	await viewer.frame.getByText("Agent change undone.").waitFor();

	// 4. The lights go out by themselves.
	await viewer.page.waitForTimeout(3_000);
	assert.equal(await lit.count(), 0, "the lights are out");

	// 5. Nothing moves under someone who is typing; a person's change is lit
	// with no offer to undo it.
	savedBy = "user";
	await viewer.editor.evaluate(() => window.scrollTo(0, 0));
	await viewer.editor.locator("p").first().click();
	await viewer.page.keyboard.type("x");
	const before = await scrolled();
	await other.editor.getByText("Line 58").click();
	await other.page.keyboard.type(" by a person");
	await viewer.editor.getByText("by a person").waitFor({ timeout: 15_000 });
	assert.equal(await scrolled(), before, "the view stayed with the typist");
	assert((await lit.count()) >= 1, "the person's change is lit");
	assert.equal(await offer.count(), 0, "no undo is offered for a person");
	console.log(
		"Doc landed changes passed: lit in place, scrolled when idle, undone by shortcut and button as a newer revision",
	);
} finally {
	await tabs.stop();
}
