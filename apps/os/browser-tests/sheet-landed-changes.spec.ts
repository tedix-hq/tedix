import assert from "node:assert/strict";
import { startEditorTabs } from "./doc-editor-tabs";

// Someone watches a sheet while an agent edits it. The changed cell lights up
// and, for a watcher who is idle, comes into view. The agent's change can be
// taken back with the button or the undo shortcut, which saves a new change.
const cell = (value: string | number) => ({ input: String(value), value });
const rows = Array.from({ length: 300 }, (_, row) => [
	cell(`Item ${row + 1}`),
	cell(row + 1),
]);
const tabs = await startEditorTabs({
	kind: "sheet",
	ready: "td[data-row]",
	content: {
		kind: "sheet",
		columns: ["Name", "Amount"],
		rows: rows.map((row) => row.map((item) => item.value)),
		workbook: {
			activeSheetId: "s1",
			sheets: [
				{
					id: "s1",
					name: "Sheet1",
					columns: ["Name", "Amount"].map((label, index) => ({
						id: `c${index}`,
						label,
						width: 160,
					})),
					rows,
					frozenRows: 0,
					frozenColumns: 0,
				},
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
	const write = (row: number, value: number) =>
		tabs.writeAsAgent({
			kind: "sheet",
			ops: [
				{
					op: "set",
					path: ["workbook", "sheets", { id: "s1" }, "rows", row, 1],
					value: cell(value),
				},
			],
		});
	const at = (row: number) =>
		viewer.frame.locator(`td[data-row="${row}"][data-column="1"]`);
	const lit = viewer.frame.locator("td.landed");
	const offer = viewer.frame.getByRole("button", {
		name: "Undo agent change",
	});
	const amount = async (row: number) =>
		(await tabs.saved()).content.workbook.sheets[0].rows[row][1].input;

	// 1. Idle at the top: the agent changes a cell far below.
	assert.equal(await at(250).count(), 0, "row 251 is not drawn yet");
	await viewer.page.waitForTimeout(3_200);
	await write(250, 9001);
	await at(250).getByText("9001").waitFor();
	assert(await at(250).isVisible(), "the changed cell came into view");
	assert.deepEqual(await lit.allTextContents(), ["9001"]);
	await offer.waitFor();
	const agentRevision = (await tabs.saved()).revision;

	// 2. The undo shortcut takes it back as a new saved change.
	await viewer.frame.locator(".grid").press("ControlOrMeta+z");
	await at(250).getByText("251").waitFor();
	await offer.waitFor({ state: "detached" });
	await viewer.page.waitForTimeout(2_000);
	assert.equal(await amount(250), "251");
	assert((await tabs.saved()).revision > agentRevision);
	// The watcher's own undo brings the agent's work back.
	await viewer.frame.locator("#undo").click();
	await at(250).getByText("9001").waitFor();
	await viewer.page.waitForTimeout(2_000);
	assert.equal(await amount(250), "9001");

	// 3. The button does the same; the view stays with someone who just clicked.
	await at(248).click();
	const scrolled = await viewer.frame
		.locator(".grid")
		.evaluate((grid) => grid.scrollTop);
	await write(2, 42);
	await offer.waitFor();
	assert.equal(
		await viewer.frame.locator(".grid").evaluate((grid) => grid.scrollTop),
		scrolled,
		"the grid did not move",
	);
	await offer.click();
	await viewer.frame.getByText("Agent change undone.").waitFor();
	await viewer.page.waitForTimeout(2_000);
	assert.equal(await amount(2), "3");

	// 4. A person's change is lit with no offer, and the lights go out.
	savedBy = "user";
	await write(249, 77);
	await at(249).getByText("77").waitFor();
	assert.deepEqual(await lit.allTextContents(), ["77"]);
	assert.equal(await offer.count(), 0);
	await viewer.page.waitForTimeout(2_800);
	assert.equal(await lit.count(), 0);
	console.log(
		"Sheet landed changes passed: lit in place, shown when idle, undone by shortcut and button",
	);
} finally {
	await tabs.stop();
}
