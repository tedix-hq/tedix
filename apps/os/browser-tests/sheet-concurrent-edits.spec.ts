import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { startEditorTabs } from "./doc-editor-tabs";

// Two people with the same Sheet open edit it at the same time. Different
// cells: both edits are kept and nobody is asked anything, whether the server
// or the editor does the merging. The same cell: the later writer is asked
// which value stays there, and keeps every other change from both.
const cell = (value: string | number) => ({ input: String(value), value });
const rows = Array.from({ length: 6 }, (_, row) => [
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
	const a = await tabs.open();
	const b = await tabs.open();
	type Tab = typeof a;
	const at = (tab: Tab, row: number, column: number) =>
		tab.frame.locator(`td[data-row="${row}"][data-column="${column}"]`);
	const type = async (tab: Tab, row: number, column: number, value: string) => {
		await at(tab, row, column).click();
		await tab.page.keyboard.type(value);
		await tab.page.keyboard.press("Enter");
	};
	const shows = (tab: Tab, row: number, column: number, value: string) =>
		at(tab, row, column)
			.getByText(value, { exact: true })
			.waitFor({ timeout: 15_000 });
	const question = (tab: Tab) =>
		tab.frame.getByRole("button", { name: "Keep mine" });
	const stored = async () =>
		(
			(await tabs.saved()).content.workbook.sheets[0].rows as {
				input: string;
			}[][]
		).map((row) => row.map((item) => item?.input ?? ""));
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
	const settle = async (expected: string[][], message: string) => {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const now = await stored();
			if (JSON.stringify(now) === JSON.stringify(expected)) return;
			if (Date.now() > deadline) assert.deepEqual(now, expected, message);
			await a.page.waitForTimeout(250);
		}
	};
	const expected = rows.map((row) => row.map((item) => item.input));

	// 1. A's save is still on its way when B's lands: the server merges.
	let release = await hold(a.page);
	await type(a, 0, 1, "100");
	await a.page.waitForTimeout(1_500);
	await type(b, 3, 0, "Bolts");
	expected[3]![0] = "Bolts";
	await settle(expected, "B saved while A's save was held");
	release();
	expected[0]![1] = "100";
	await settle(expected, "the server kept both cells");
	await shows(a, 3, 0, "Bolts");
	await shows(b, 0, 1, "100");
	assert.equal(await question(a).count(), 0, "A was not asked");
	assert.equal(await question(b).count(), 0, "B was not asked");
	await a.page.unroute("**/api/rpc/osWorkspaces/outputs/patch");

	// 2. A cannot save for a moment and B's change arrives meanwhile: A's
	// editor merges it into the unsaved sheet, then saves both.
	release = await hold(a.page, true);
	await type(a, 1, 1, "200");
	await a.page.waitForTimeout(1_500);
	await type(b, 4, 0, "Nuts");
	await shows(a, 4, 0, "Nuts");
	await shows(a, 1, 1, "200");
	assert.equal(await question(a).count(), 0, "A was not asked");
	release();
	expected[1]![1] = "200";
	expected[4]![0] = "Nuts";
	await settle(expected, "the editor merged and saved both cells");
	await shows(b, 1, 1, "200");
	assert.equal(await question(b).count(), 0, "B was not asked");
	await a.page.unroute("**/api/rpc/osWorkspaces/outputs/patch");

	// 3. Both change the same cell, and each another cell too.
	release = await hold(a.page, true);
	await type(a, 2, 1, "300");
	await type(a, 5, 0, "Washers");
	await a.page.waitForTimeout(1_500);
	await type(b, 2, 1, "333");
	await type(b, 5, 1, "66");
	await question(a).waitFor({ timeout: 15_000 });
	assert.equal(await question(b).count(), 0, "only the later writer is asked");
	// Nothing of A's is saved or dropped while the question is open.
	await shows(a, 2, 1, "300");
	assert.equal((await stored())[2]![1], "333");
	release();
	await question(a).click();
	expected[2]![1] = "300";
	expected[5] = ["Washers", "66"];
	await settle(expected, "A's value won the shared cell; the rest is kept");
	await shows(a, 5, 1, "66");
	await shows(b, 2, 1, "300");
	await shows(b, 5, 0, "Washers");
	await a.page.unroute("**/api/rpc/osWorkspaces/outputs/patch");

	// 4. Both type outside the sheet's stored rows and columns. Each new cell
	// stays at the position it was typed in, whether the editor merges (A's
	// save fails for a moment) or the server does (A's save is held).
	for (const [fail, at] of [
		[true, 9],
		[false, 14],
	] as const) {
		release = await hold(a.page, fail);
		await type(a, at, 0, "Far A");
		await type(a, 1, 3, `Wide A ${at}`);
		await a.page.waitForTimeout(1_500);
		await type(b, at - 2, 1, "Far B");
		await type(b, 2, 4, `Wide B ${at}`);
		if (fail) await shows(a, at - 2, 1, "Far B");
		else await a.page.waitForTimeout(1_500);
		assert.equal(await question(a).count(), 0, "A was not asked");
		release();
		const grown = Array.from({ length: at + 1 }, (_, row) =>
			Array.from({ length: 5 }, (_, column) => expected[row]?.[column] ?? ""),
		);
		expected.splice(0, expected.length, ...grown);
		expected[at]![0] = "Far A";
		expected[1]![3] = `Wide A ${at}`;
		expected[at - 2]![1] = "Far B";
		expected[2]![4] = `Wide B ${at}`;
		await settle(expected, "every new cell is where it was typed");
		await shows(b, at, 0, "Far A");
		await shows(a, 2, 4, `Wide B ${at}`);
		assert.equal(await question(a).count(), 0, "A was not asked");
		assert.equal(await question(b).count(), 0, "B was not asked");
		assert.equal(
			(await tabs.saved()).content.workbook.sheets[0].columns.length,
			5,
			"a column both added is one column",
		);
		await a.page.unroute("**/api/rpc/osWorkspaces/outputs/patch");
	}
	console.log(
		"Sheet concurrent edits passed: server merge, editor merge, new rows and columns, and a choice only for the same cell",
	);
} finally {
	await tabs.stop();
}
