import assert from "node:assert/strict";
import { startEditorTabs } from "./doc-editor-tabs";

// Someone watches a presentation while an agent edits it. The changed element
// lights up on its slide and the slide lights up in the list; a watcher who is
// idle is taken to the changed slide. The agent's change can be taken back
// with the button or the undo shortcut, which saves a new change.
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
				slide(
					"one",
					element("a", "First slide", 80),
					element("b", "Body", 240),
				),
				slide("two", element("c", "Second slide", 80)),
			],
		},
	},
});
try {
	const viewer = await tabs.open();
	let savedBy = "tedi";
	await viewer.page.route(
		"**/api/rpc/osWorkspaces/outputs/changes*",
		async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			body.json.revision.createdByKind = savedBy;
			await route.fulfill({ response, json: body });
		},
	);
	const text = (slideId: string, id: string, value: string) => ({
		kind: "presentation",
		ops: [
			{
				op: "set",
				path: ["deck", "slides", { id: slideId }, "elements", { id }, "text"],
				value,
			},
		],
	});
	const stage = (id: string) =>
		viewer.frame.locator(`.slides-stage [data-element-id="${id}"]`);
	const thumb = (id: string) =>
		viewer.frame.locator(`.slides-thumb[data-slide-id="${id}"]`);
	const isLit = async (locator: ReturnType<typeof stage>) =>
		((await locator.getAttribute("class")) ?? "").includes("landed");
	const offer = viewer.frame.getByRole("button", {
		name: "Undo agent change",
	});
	const stored = async () =>
		(await tabs.saved()).content.deck.slides.flatMap(
			(row: { elements: { text: string }[] }) =>
				row.elements.map((item) => item.text),
		);

	// 1. Watching slide one, idle: the agent changes slide two.
	await viewer.page.waitForTimeout(3_200);
	await tabs.writeAsAgent(text("two", "c", "Changed by the agent"));
	await stage("c").getByText("Changed by the agent").waitFor();
	assert(await isLit(stage("c")), "the changed element is lit");
	assert(await isLit(thumb("two")), "its slide is lit in the list");
	assert(!(await isLit(thumb("one"))), "the other slide is not");
	assert.match((await thumb("two").getAttribute("class"))!, /current/);
	await offer.waitFor();
	const agentRevision = (await tabs.saved()).revision;

	// 2. The undo shortcut takes it back as a new saved change.
	await viewer.frame.locator(".slides-stage").press("ControlOrMeta+z");
	await stage("c").getByText("Second slide").waitFor();
	await offer.waitFor({ state: "detached" });
	await viewer.page.waitForTimeout(2_000);
	assert.deepEqual(await stored(), ["First slide", "Body", "Second slide"]);
	assert((await tabs.saved()).revision > agentRevision);
	// The watcher's own undo brings the agent's work back.
	await viewer.frame.locator("#undo").click();
	await stage("c").getByText("Changed by the agent").waitFor();
	await viewer.page.waitForTimeout(2_000);

	// 3. Just after the watcher clicked, the view stays where they are; the
	// button undoes the agent's change.
	await thumb("one").locator("button").first().click();
	await tabs.writeAsAgent(text("two", "c", "Agent again"));
	await offer.waitFor();
	assert.match((await thumb("one").getAttribute("class"))!, /current/);
	assert(await isLit(thumb("two")), "the changed slide is lit in the list");
	await offer.click();
	await viewer.frame.getByText("Agent change undone.").waitFor();
	await viewer.page.waitForTimeout(2_000);
	assert.deepEqual(await stored(), [
		"First slide",
		"Body",
		"Changed by the agent",
	]);

	// 4. A person's change is lit with no offer, and the lights go out.
	savedBy = "user";
	await tabs.writeAsAgent(text("one", "b", "Edited by a person"));
	await stage("b").getByText("Edited by a person").waitFor();
	assert(await isLit(stage("b")));
	assert(!(await isLit(stage("a"))), "an unchanged element is not lit");
	assert.equal(await offer.count(), 0);
	await viewer.page.waitForTimeout(4_300);
	assert.equal(await viewer.frame.locator(".landed").count(), 0);
	console.log(
		"Slides landed changes passed: lit on slide and list, shown when idle, undone by shortcut and button",
	);
} finally {
	await tabs.stop();
}
