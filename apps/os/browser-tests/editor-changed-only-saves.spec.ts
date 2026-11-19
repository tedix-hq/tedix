import assert from "node:assert/strict";
import { startDocTabs } from "./doc-editor-tabs";

// A Doc open in a workspace, in a real browser and the real sandbox: typing
// saves a moment later by sending only the changed block, the saved file then
// holds the text, and nothing sends or re-reads the whole document.
const tabs = await startDocTabs();
try {
	const before = await tabs.saved();
	const peerCalls: string[] = [];
	const { editor: peerEditor } = await tabs.open((peer) =>
		peer.on("request", (request) => {
			const name = /\/api\/rpc\/osWorkspaces\/outputs\/(\w+)/.exec(
				request.url(),
			)?.[1];
			if (name) peerCalls.push(name);
		}),
	);

	const calls: { name: string; bytes: number; at: number }[] = [];
	const { page, editor } = await tabs.open((page) =>
		page.on("request", (request) => {
			const match = /\/api\/rpc\/osWorkspaces\/outputs\/(\w+)/.exec(
				request.url(),
			);
			if (match)
				calls.push({
					name: match[1]!,
					bytes: request.postData()?.length ?? 0,
					at: Date.now(),
				});
		}),
	);
	const peerOpened = peerCalls.length;
	const opened = calls.length;
	await editor.click();
	await page.keyboard.press("ControlOrMeta+End");
	const typedAt = Date.now();
	await page.keyboard.type(" Typed in the browser.");
	const typedFor = Date.now() - typedAt;

	await peerEditor.getByText(/Typed in the browser\./).waitFor();
	assert(
		peerCalls.slice(peerOpened).includes("changes"),
		"the other tab fetched the save",
	);
	const after = await tabs.saved();
	assert(after.revision > before.revision, "typing stored a new revision");
	assert.match(
		JSON.stringify(after.content),
		/Typed in the browser\./,
		"the saved document holds the typed text",
	);
	const since = calls.slice(opened);
	const patches = since.filter((call) => call.name === "patch");
	assert(patches.length >= 1, "the save was a patch");
	assert.equal(
		since.filter((call) => call.name === "revise").length,
		0,
		"the whole document was never sent",
	);
	assert.equal(
		since.filter((call) => call.name === "get").length,
		0,
		"the whole document was not read again after saving",
	);
	const whole = JSON.stringify(after.content).length;
	assert.equal(
		since.filter((call) => call.name === "changes").length,
		0,
		"the saving tab does not fetch its own save",
	);
	for (const patch of patches.slice(1))
		assert(
			patch.bytes < whole,
			`a later save (${patch.bytes} bytes) is smaller than the document (${whole})`,
		);
	// The first save follows the last keystroke within the 1.2 s bound.
	assert(
		patches[0]!.at - typedAt <= typedFor + 1_200 + 800,
		`first save came ${patches[0]!.at - typedAt} ms after typing began`,
	);
	console.log(
		`Doc changed-only save passed: ${patches.length} patch save(s) of ${patches.map((patch) => patch.bytes).join(", ")} bytes for a ${whole}-byte document; first ${patches[0]!.at - typedAt} ms after typing began (${typedFor} ms of typing); calls after open: ${since.map((call) => call.name).join(", ")}`,
	);
} finally {
	await tabs.stop();
}
