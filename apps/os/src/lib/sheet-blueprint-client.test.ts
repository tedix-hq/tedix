import {
	applyOutputPatch,
	diffOutputContent,
	type OutputPatch,
} from "@tedix/api-contract/utils/output-patch";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	SHEET_CLIENT_SOURCE,
	SHEET_SERVER_SOURCE,
} from "@tedix/api-contract/assets/sheet-blueprint";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { normalizeSheetContent, projectWorkbook } from "./output-models";
import { evaluateWorkbook } from "./workbook-formulas";
import {
	mountSheetClient,
	type SheetClientBridge,
} from "../gadgets/sheet-client";

type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

async function editor(role = "owner", transform?: (sheet: Sheet) => Sheet) {
	document.body.innerHTML = '<div id="app"></div>';
	const calculate = (content: Sheet) =>
		projectWorkbook(evaluateWorkbook(normalizeSheetContent(content).workbook!));
	let saved = calculate({
		kind: "sheet",
		columns: ["Amount", "Rate", "Total"],
		rows: [[1, 2, "=SUM(A1:B1)"]],
	});
	const sheet = saved.workbook!.sheets[0]!;
	sheet.rows[0]![0]!.format = {
		bold: true,
		numberFormat: "currency",
		fillColor: "#eeeeee",
	};
	sheet.columns[0]!.width = 180;
	saved.workbook!.sheets.push({
		...structuredClone(sheet),
		id: "archive",
		name: "Archive",
	});
	if (transform) saved = transform(saved);
	let revision = 1,
		outputId = "output",
		// Saves follow an edit within a quarter second. A test about changes
		// that were never saved keeps them unsaved by going offline.
		offline = false;
	// What the server holds at each revision a client has read or saved.
	const stored = new Map<number, Sheet>();
	const output = () => ({
		id: outputId,
		title: "Budget",
		workspaceId: "workspace",
		kind: "sheet",
	});
	// Who saved the newest revision: a person, or an agent.
	let savedBy = "user";
	const outputsRead = vi.fn(async () => {
		stored.set(revision, structuredClone(saved));
		return {
			output: output(),
			revision: { revision, content: structuredClone(saved) },
		};
	});
	const outputsWrite = vi.fn(
		async (
			_slot: string,
			input: { content: Sheet; expectedRevision: number },
		) => {
			if (input.expectedRevision !== revision)
				throw new Error("Revision conflict");
			saved = structuredClone(input.content);
			revision++;
		},
	);
	const App = new Function(
		SHEET_SERVER_SOURCE.replace("export class App", "class App") +
			"\nreturn App;",
	)();
	const app = new App(
		{},
		{
			CONFIG: { version: 1, settings: { slot: "sheet" } },
			TEDIX: { outputsRead, outputsWrite },
		},
	);
	const drafts = new Map<string, { revision: number; content: Sheet }>();
	const download = vi.fn();
	let inFlight = 0;
	const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
		inFlight++;
		try {
			return await answer(method, args);
		} finally {
			inFlight--;
		}
	});
	const answer = async (method: string, args?: Record<string, unknown>) => {
		if (method === "context")
			return {
				role,
				workspaceId: "workspace",
				grants: [
					{ slot: "sheet", operations: ["outputs.read", "outputs.write"] },
				],
				settings: { slot: "sheet" },
			};
		if (method === "app.draft.read") {
			await outputsRead();
			return drafts.get(String(args!.outputId)) ?? null;
		}
		if (method === "app.draft.clear") {
			drafts.delete(String(args!.outputId));
			return null;
		}
		if (method === "app.draft.write") {
			drafts.set(
				String(args!.outputId),
				structuredClone({
					revision: Number(args!.revision),
					content: args!.content as Sheet,
				}),
			);
			return null;
		}
		// The real host answers across a frame boundary, so with a copy.
		if (method === "sheet.evaluate")
			return calculate(structuredClone(args!.content as Sheet));
		if (method === "outputs.patch") {
			if (offline) throw new Error("Network unreachable");
			// Only the changed parts arrive; the server applies them to its copy.
			const { baseRevision, patch } = args as {
				baseRevision: number;
				patch: OutputPatch;
			};
			await outputsWrite(String(args!.slot), {
				content: applyOutputPatch(saved, patch),
				expectedRevision: baseRevision,
			});
			stored.set(revision, structuredClone(saved));
			return {
				output: output(),
				revision: { revision },
				mergedWith: null,
				catchUp: null,
			};
		}
		if (method === "outputs.changes") {
			// The same access check as a full read.
			await outputsRead();
			const since = stored.get(Number(args!.sinceRevision));
			return {
				output: output(),
				revision: { revision, createdByKind: savedBy },
				patch: since ? diffOutputContent(since, saved) : null,
				...(since ? {} : { content: structuredClone(saved) }),
			};
		}
		if (method === "outputs.readRevision" && args?.revision !== undefined) {
			const content = stored.get(Number(args.revision));
			if (!content) throw new Error("That version is no longer available");
			return {
				output: output(),
				revision: {
					revision: Number(args.revision),
					content: structuredClone(content),
				},
			};
		}
		if (method === "outputs.replace")
			throw new Error("The editor must not send the whole sheet");
		if (method === "app.exportOutput") return null;
		if (method === "app.download") {
			download(args);
			return null;
		}
		if (method === "app.call")
			return app[args!.method as string](...(args!.args as unknown[]));
		throw new Error("Unknown host operation");
	};
	let mounted = await mountSheetClient(document.getElementById("app")!, {
		call,
	} as SheetClientBridge);
	cleanups.push(() => mounted.dispose());
	return {
		call,
		drafts,
		retarget(id: string) {
			outputId = id;
		},
		offline(on: boolean) {
			offline = on;
		},
		/** Wait until the editor has no call to the host in flight. */
		async settle() {
			do await new Promise((resolve) => setTimeout(resolve, 5));
			while (inFlight > 0);
		},
		async reopen() {
			await mounted.dispose();
			document.body.innerHTML = '<div id="app"></div>';
			mounted = await mountSheetClient(document.getElementById("app")!, {
				call,
			} as SheetClientBridge);
		},
		calculate,
		outputsRead,
		outputsWrite,
		download,
		saved: () => structuredClone(saved),
		revision: () => revision,
		changeExternal(value: number, by = "user", grow = false) {
			savedBy = by;
			saved.workbook!.sheets[0]!.rows[0]![0]!.input = String(value);
			// Someone wrote a cell beyond the grid: the rows in between are padded.
			if (grow) {
				const { rows, columns } = saved.workbook!.sheets[0]!;
				while (rows.length < 4) rows.push(rows[0]!.map(() => null));
				// Padding arrives as empty cells or as no cell at all.
				for (const row of rows) row.push({ input: "", value: null }, null);
				for (const label of ["D", "E"])
					columns.push({ ...columns[0]!, id: label, label });
				rows[3]![4] = { input: "far", value: "far" };
			}
			saved = calculate(saved);
			revision++;
			window.dispatchEvent(
				new MessageEvent("message", {
					source: window.parent,
					data: {
						jsonrpc: "2.0",
						method: "tedix/outputs-changed",
						params: {
							outputs: [
								{
									slot: "sheet",
									outputId: "output",
									revisionId: `r${revision}`,
									revision,
								},
							],
						},
					},
				}),
			);
		},
	};
}

const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
	document.querySelector<T>(selector)!;
const cell = (address: string) =>
	q<HTMLTableCellElement>(`td[aria-label="${address}"]`);
const click = (selector: string) => q<HTMLButtonElement>(selector).click();
function key(
	key: string,
	options: KeyboardEventInit = {},
	target: HTMLElement = q(".grid"),
) {
	target.dispatchEvent(
		new KeyboardEvent("keydown", {
			key,
			bubbles: true,
			cancelable: true,
			...options,
		}),
	);
}
function select(address: string, shiftKey = false) {
	cell(address).dispatchEvent(
		new MouseEvent("mousedown", { bubbles: true, button: 0, shiftKey }),
	);
	document.dispatchEvent(new MouseEvent("mouseup"));
}
function edit(address: string, value: string) {
	select(address);
	cell(address).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
	const input = q<HTMLInputElement>(".cell-edit");
	input.value = value;
	input.dispatchEvent(new Event("input"));
	key("Enter", {}, input);
}
function range(value: string) {
	const input = q<HTMLInputElement>("#range");
	input.value = value;
	key("Enter", {}, input);
}
function change(selector: string, value: string) {
	const input = q<HTMLInputElement | HTMLSelectElement>(selector);
	input.value = value;
	input.dispatchEvent(new Event("change"));
}
function clipboard(type: string, text = "") {
	const data = {
		text,
		setData(_type: string, value: string) {
			this.text = value;
		},
		getData() {
			return this.text;
		},
	};
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", { value: data });
	q(".grid").dispatchEvent(event);
	return data.text;
}
function operation(value: string) {
	click("#more");
	click(`.menu [data-action="${value}"]`);
}
function apply(value: string) {
	q<HTMLInputElement>("#command-value").value = value;
	click("#command-apply");
}
function download(kind: "csv" | "xlsx") {
	click("#download");
	click(`.menu [data-action="${kind}"]`);
}
const display = (address: string) =>
	cell(address)?.querySelector("output")?.textContent;
const state = () => q(".status").dataset.state;
const choose = (name: string) => click(`#updates [data-choice="${name}"]`);
/** Ask for a save now and wait until the editor reports it. */
async function saved() {
	key("s", { ctrlKey: true });
	await vi.waitFor(() => expect(state()).toBe("saved"));
}
const draftWrites = (app: Awaited<ReturnType<typeof editor>>) =>
	app.call.mock.calls.filter(([method]) => method === "app.draft.write");

describe("Portable Sheet grid", () => {
	it("recalculates and saves canonical inputs, display values, other tabs and formats", async () => {
		const app = await editor(),
			archive = app.saved().workbook!.sheets[1];
		expect(display("C1")).toBe("3");
		edit("A1", "5");
		await vi.waitFor(() => expect(display("C1")).toBe("7"));
		edit("B1", "4");
		await vi.waitFor(() => expect(display("C1")).toBe("9"));
		edit("C1", "=A1*B1");
		await saved();
		expect(app.saved().rows[0]).toEqual([5, 4, 20]);
		expect(app.saved().workbook!.sheets[0]!.rows[0]![2]!.input).toBe("=A1*B1");
		expect(app.saved().workbook!.sheets[0]!.rows[0]![0]!.format).toEqual({
			bold: true,
			numberFormat: "currency",
			fillColor: "#eeeeee",
		});
		expect(app.saved().workbook!.sheets[0]!.columns[0]!.width).toBe(180);
		expect(app.saved().workbook!.sheets[1]).toEqual(archive);
		expect(app.call).toHaveBeenCalledWith(
			"outputs.patch",
			expect.objectContaining({ slot: "sheet", baseRevision: 1 }),
		);
		download("csv");
		await vi.waitFor(() =>
			expect(app.download).toHaveBeenCalledWith({
				filename: "Budget.csv",
				mimeType: "text/csv;charset=utf-8",
				text: "Amount,Rate,Total\r\n5,4,20\r\n",
			}),
		);
		download("xlsx");
		await vi.waitFor(() =>
			expect(app.call).toHaveBeenCalledWith("app.exportOutput", {
				slot: "sheet",
				format: "xlsx",
				expectedRevision: app.revision(),
			}),
		);
	});
	it("supports keyboard navigation, extending ranges, typing, cancellation and range traversal", async () => {
		await editor();
		select("A1");
		key("ArrowRight", { shiftKey: true });
		key("ArrowDown", { shiftKey: true });
		expect(q<HTMLInputElement>("#range").value).toBe("A1:B2");
		expect(document.querySelectorAll("td.selected")).toHaveLength(4);
		key("Tab");
		expect(cell("A1").classList.contains("active")).toBe(true);
		key("Tab");
		expect(cell("B1").classList.contains("active")).toBe(true);
		key("Tab");
		expect(cell("A2").classList.contains("active")).toBe(true);
		expect(document.querySelectorAll("td.selected")).toHaveLength(4);
		select("B2");
		key("9");
		expect(q<HTMLInputElement>(".cell-edit").value).toBe("9");
		key("Escape", {}, q(".cell-edit"));
		expect(document.querySelector(".cell-edit")).toBeNull();
		expect(display("B2")).toBe("");
		key("F2");
		q<HTMLInputElement>(".cell-edit").value = "8";
		key("Enter", {}, q(".cell-edit"));
		await vi.waitFor(() => expect(display("B2")).toBe("8"));
	});
	it("pastes quoted multi-cell data and internally copies formula-relative sources and styles", async () => {
		const app = await editor();
		select("A2");
		clipboard("paste", '4\t"two\nlines"\n5\t6');
		await vi.waitFor(() => expect(display("A2")).toBe("4"));
		expect(display("B2")).toBe("two\nlines");
		range("A1:C1");
		const copied = clipboard("copy");
		select("A4");
		clipboard("paste", copied);
		await saved();
		const s = app.saved().workbook!.sheets[0]!;
		expect(s.rows[3]![2]!.input).toBe("=SUM(A4:B4)");
		expect(s.rows[3]![2]!.value).toBe(3);
		expect(s.rows[3]![0]!.format?.numberFormat).toBe("currency");
	});
	it("formats selected ranges and undoes/redoes workbook edits without losing formulas", async () => {
		const app = await editor();
		range("A1:B2");
		click('[data-format="italic"]');
		change("#number-format", "percent");
		change("#font-size", "18");
		change("#fill-color", "#abcdee");
		click('[data-align="right"]');
		expect(q('[data-align="right"]').getAttribute("aria-pressed")).toBe("true");
		click("#dec-more");
		click("#undo");
		click("#redo");
		await saved();
		const s = app.saved().workbook!.sheets[0]!;
		expect(s.rows[1]![1]!.format).toMatchObject({
			italic: true,
			numberFormat: "percent",
			fontSize: 18,
			fillColor: "#abcdee",
			horizontalAlign: "right",
			decimals: 3,
		});
		expect(s.rows[0]![2]!.input).toBe("=SUM(A1:B1)");
		range("A1:B2");
		click("#clear-format");
		await saved();
		expect(
			app.saved().workbook!.sheets[0]!.rows[0]![0]!.format,
		).toBeUndefined();
	});
	it("inserts/deletes rows and columns with reference rewrites and supports tab operations", async () => {
		const app = await editor();
		select("A1");
		operation("insert-row");
		operation("insert-column");
		await saved();
		let s = app.saved().workbook!.sheets[0]!;
		expect(s.rows[1]![3]!.input).toBe("=SUM(B2:C2)");
		operation("delete-row");
		operation("delete-column");
		operation("rename-column");
		apply("Amount revised");
		operation("rename-sheet");
		apply("Forecast");
		operation("duplicate-sheet");
		operation("move-left");
		operation("add-sheet");
		apply("Next year");
		await saved();
		expect(app.saved().workbook!.sheets.map((s) => s.name)).toEqual([
			"Forecast copy",
			"Forecast",
			"Archive",
			"Next year",
		]);
		change("#tabs", app.saved().workbook!.sheets[1]!.id);
		expect(display("C1")).toBe("3");
	});
	it("fills relative formulas, sorts bounded tables, resizes and freezes panes", async () => {
		const app = await editor();
		select("A2");
		clipboard("paste", "2\t3\n1\t4");
		range("C1:C3");
		click("#fill-down");
		await vi.waitFor(() => expect(display("C3")).toBe("5"));
		select("B2");
		operation("column-width");
		apply("220");
		operation("row-height");
		apply("45");
		operation("freeze");
		await saved();
		const s = app.saved().workbook!.sheets[0]!;
		expect(s.rows[2]![2]!.input).toBe("=SUM(A3:B3)");
		expect(s.columns[1]!.width).toBe(220);
		expect(s.rowHeights?.[1]).toBe(45);
		expect(s.frozenRows).toBe(1);
		expect(s.frozenColumns).toBe(1);
		range("A2:B3");
		click("#sort-desc");
		await saved();
		expect(
			app
				.saved()
				.workbook!.sheets[0]!.rows.slice(1)
				.map((row) => row[1]!.value),
		).toEqual([4, 3]);
	});
	it("shows another person's save in place, and asks only when both changed one cell", async () => {
		const app = await editor();
		const first = cell("A1");
		select("B2");
		app.changeExternal(3);
		await vi.waitFor(() => expect(display("C1")).toBe("5"));
		// The update lands in the same cells: nothing is rebuilt or deselected.
		expect(cell("A1")).toBe(first);
		expect(cell("B2").classList.contains("active")).toBe(true);
		edit("A1", "8");
		await vi.waitFor(() => expect(display("C1")).toBe("10"));
		app.changeExternal(4);
		await vi.waitFor(() =>
			expect(q("#updates").textContent).toContain(
				"Choose which version to keep",
			),
		);
		expect(q("#updates").textContent).not.toMatch(/revision/i);
		expect(app.saved().rows[0]![0]).toBe(4);
		expect(display("C1")).toBe("10");
		expect(q<HTMLInputElement>("#formula").disabled).toBe(false);
		choose("theirs");
		await vi.waitFor(() => expect(display("C1")).toBe("6"));
		await vi.waitFor(() => expect(q("#updates").textContent).toBe(""));
	});
	describe("changes someone else makes while the sheet is open", () => {
		const lit = () =>
			[...document.querySelectorAll("td.landed")]
				.map((td) => td.getAttribute("aria-label"))
				.sort();
		const offer = () => q("#updates").querySelector('[data-choice="undo"]');
		it("lights the changed cell and the cells that follow from it, then lets go", async () => {
			const app = await editor();
			app.changeExternal(3);
			await vi.waitFor(() => expect(display("C1")).toBe("5"));
			expect(lit()).toEqual(
				[cell("A1"), cell("C1")]
					.map((td) => td.getAttribute("aria-label"))
					.sort(),
			);
			// A person's change: nothing to undo here.
			expect(offer()).toBeNull();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			app.changeExternal(4);
			await vi.waitFor(() => expect(display("C1")).toBe("6"));
			expect(lit()).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(2_500);
			expect(lit()).toEqual([]);
			vi.useRealTimers();
		});
		it("lights only what changed when the change makes the grid larger", async () => {
			const app = await editor();
			app.changeExternal(3, "user", true);
			await vi.waitFor(() => expect(display("E4")).toBe("far"));
			expect(lit()).toEqual(
				[cell("A1"), cell("C1"), cell("E4")]
					.map((td) => td.getAttribute("aria-label"))
					.sort(),
			);
		});
		it("offers to undo an agent's change and undoes it as a new saved change", async () => {
			const app = await editor();
			const before = display("A1");
			app.changeExternal(7, "tedi");
			await vi.waitFor(() => expect(display("A1")).toBe("$7.00"));
			expect(q("#updates").textContent).toContain(
				"An agent changed this sheet.",
			);
			choose("undo");
			await vi.waitFor(() => expect(display("A1")).toBe(before));
			expect(offer()).toBeNull();
			await vi.waitFor(() =>
				expect(
					String(app.saved().workbook!.sheets[0]!.rows[0]![0]!.input),
				).toBe("1"),
			);
			// It was the person's own edit: their undo brings the agent's work back.
			click("#undo");
			await vi.waitFor(() => expect(display("A1")).toBe("$7.00"));
		});
		it("undoes the agent's change with the undo shortcut, and stops offering once the person edits", async () => {
			const app = await editor();
			const before = display("A1");
			app.changeExternal(7, "external_agent");
			await vi.waitFor(() => expect(offer()).not.toBeNull());
			key("z", { ctrlKey: true });
			await vi.waitFor(() => expect(display("A1")).toBe(before));
			await vi.waitFor(() => expect(q("#updates").textContent).toBe(""));
			await saved();
			app.changeExternal(9, "tedi");
			await vi.waitFor(() => expect(offer()).not.toBeNull());
			edit("B2", "mine");
			expect(offer()).toBeNull();
			expect(display("A1")).toBe("$9.00");
		});
	});
	it("keeps the chosen value for a cell both people edited, then saves the merge", async () => {
		const app = await editor();
		edit("A1", "8");
		await vi.waitFor(() => expect(display("C1")).toBe("10"));
		app.changeExternal(4);
		await vi.waitFor(() =>
			expect(q("#updates").textContent).toContain("Keep mine"),
		);
		choose("mine");
		await vi.waitFor(() => expect(app.revision()).toBe(3));
		expect(display("C1")).toBe("10");
		expect(app.saved().rows[0]![0]).toBe(8);
	});
	it("merges someone else's save into unsaved changes to a different cell and saves both", async () => {
		const app = await editor();
		edit("B1", "5");
		await vi.waitFor(() => expect(display("C1")).toBe("6"));
		app.changeExternal(4);
		await vi.waitFor(() => expect(display("C1")).toBe("9"));
		await vi.waitFor(() => expect(app.revision()).toBe(3));
		expect(app.saved().rows[0]).toEqual([4, 5, 9]);
	});
	it("leaves text being typed alone when an update arrives, then merges it", async () => {
		const app = await editor();
		select("C1");
		const formula = q<HTMLInputElement>("#formula");
		formula.focus();
		formula.value = "=A1*10";
		formula.dispatchEvent(new Event("input"));
		app.changeExternal(9);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(formula.value).toBe("=A1*10");
		expect(display("C1")).toBe("3");
		key("Enter", {}, formula);
		await vi.waitFor(() => expect(display("C1")).toBe("90"));
		await vi.waitFor(() => expect(app.revision()).toBe(3));
		expect(app.saved().workbook!.sheets[0]!.rows[0]![2]!.input).toBe("=A1*10");
		expect(app.saved().rows[0]![0]).toBe(9);
	});
	it("opens a 50,000-row sheet, draws only the rows in view, saves one cell and rejects an out-of-bounds paste", async () => {
		const app = await editor("owner", (content) => {
			const s = content.workbook!.sheets[0]!;
			s.rows = Array.from({ length: 50_000 }, (_, i) => [
				{ input: String(i), value: i },
				null,
				null,
			]);
			return content;
		});
		expect(document.querySelectorAll("td[data-row]").length).toBeLessThan(400);
		range("C50000");
		expect(cell("C50000")).toBeTruthy();
		clipboard("paste", "1\n2");
		expect(q(".status").textContent).toContain("Paste exceeds");
		expect(state()).toBe("error");
		key("s", { ctrlKey: true });
		expect(app.outputsWrite).not.toHaveBeenCalled();
		edit("C50000", "last");
		key("s", { ctrlKey: true });
		await vi.waitFor(() => expect(app.revision()).toBe(2));
		const rows = app.saved().workbook!.sheets[0]!.rows;
		expect(rows).toHaveLength(50_000);
		expect(rows[49_999]![2]!.input).toBe("last");
		expect(rows[49_998]![0]!.input).toBe("49998");
		expect(document.querySelectorAll("td[data-row]").length).toBeLessThan(400);
	}, 60_000);
	it("draws only the columns near the view of a 702-column sheet and follows the selection", async () => {
		await editor("owner", (content) => {
			const s = content.workbook!.sheets[0]!;
			s.columns = Array.from({ length: 702 }, (_, i) => ({
				id: `c${i}`,
				label: `Column ${i + 1}`,
				width: 120,
			}));
			s.rows = Array.from({ length: 40 }, (_, row) =>
				Array.from({ length: 702 }, (_, column) =>
					column === 701 ? { input: `end ${row}`, value: `end ${row}` } : null,
				),
			);
			s.frozenColumns = 1;
			return content;
		});
		const drawn = () =>
			new Set(
				[...document.querySelectorAll<HTMLElement>("td[data-row]")].map(
					(td) => td.dataset.column,
				),
			);
		// Far fewer than 702 columns are in the page, with the frozen one kept.
		expect(drawn().size).toBeLessThan(80);
		expect(drawn().has("0")).toBe(true);
		expect(cell("ZZ1")).toBeFalsy();
		expect(q("table").getAttribute("aria-colcount")).toBe("702");
		// Jumping to the last column draws it and keeps the frozen column.
		range("ZZ3");
		expect(cell("ZZ3")).toBeTruthy();
		expect(cell("ZZ3").textContent).toBe("end 2");
		expect(cell("ZZ3").classList.contains("active")).toBe(true);
		expect(drawn().has("0")).toBe(true);
		expect(drawn().size).toBeLessThan(80);
		expect(q<HTMLInputElement>("#range").value).toBe("ZZ3");
	});
	it("keeps use-role sessions read-only while permitting tab navigation and export", async () => {
		const app = await editor("use");
		expect(q<HTMLInputElement>("#formula").disabled).toBe(true);
		expect(q(".status").textContent).toBe("View only");
		select("A1");
		key("9");
		expect(document.querySelector(".cell-edit")).toBeNull();
		clipboard("paste", "9");
		click("#add-row");
		change("#tabs", "archive");
		expect(q<HTMLSelectElement>("#tabs").value).toBe("archive");
		click("#tab-buttons button");
		expect(q<HTMLSelectElement>("#tabs").value).not.toBe("archive");
		key("s", { ctrlKey: true });
		download("csv");
		await vi.waitFor(() => expect(app.download).toHaveBeenCalled());
		expect(app.outputsWrite).not.toHaveBeenCalled();
	});
	it("ignores delayed calculations from older edits and saves the latest formula values", async () => {
		const app = await editor(),
			original = app.call.getMockImplementation()!;
		let resolveOld: ((content: Sheet) => void) | undefined,
			oldSnapshot: Sheet | undefined;
		app.call.mockImplementation(async (method, args) => {
			if (method === "sheet.evaluate" && !oldSnapshot) {
				oldSnapshot = args!.content as Sheet;
				return new Promise<Sheet>((resolve) => {
					resolveOld = resolve;
				});
			}
			return original(method, args);
		});
		edit("A1", "5");
		await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
		edit("A1", "9");
		await vi.waitFor(() => expect(display("C1")).toBe("11"));
		resolveOld!(app.calculate(oldSnapshot!));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(display("C1")).toBe("11");
		await saved();
		expect(app.saved().rows[0]).toEqual([9, 2, 11]);
	});
	it("shows a typed value at once and keeps a formula's last result until the new one arrives", async () => {
		const app = await editor(),
			original = app.call.getMockImplementation()!;
		const held: Array<() => void> = [];
		app.call.mockImplementation(async (method, args) => {
			if (method === "sheet.evaluate")
				await new Promise<void>((resolve) => held.push(resolve));
			return original(method, args);
		});
		edit("B2", "8.50");
		expect(display("B2")).toBe("8.5");
		expect(cell("B2").style.textAlign).toBe("right");
		edit("A2", "hello");
		expect(display("A2")).toBe("hello");
		edit("C1", "=A1*B1");
		expect(display("C1")).toBe("3");
		app.call.mockImplementation(original);
		held.forEach((release) => release());
		await vi.waitFor(() => expect(display("C1")).toBe("2"));
	});
	it("moves the selection and applies edits without rebuilding the grid", async () => {
		await editor();
		const first = cell("A1"),
			head = q("thead th:nth-child(2)"),
			rows = document.querySelectorAll("tbody tr").length;
		select("B2");
		key("ArrowDown");
		key("ArrowRight", { shiftKey: true });
		expect(cell("A1")).toBe(first);
		expect(cell("B3").classList.contains("selected")).toBe(true);
		expect(cell("C3").classList.contains("active")).toBe(true);
		expect(cell("B2").classList.contains("selected")).toBe(false);
		expect(cell("B3").getAttribute("aria-selected")).toBe("true");
		// Headings of the selected rows and columns light up.
		expect(q("thead th:nth-child(3)").classList.contains("sel")).toBe(true);
		expect(head.classList.contains("sel")).toBe(false);
		expect(q('th[data-head="2"]').classList.contains("sel")).toBe(true);
		edit("A2", "4");
		await vi.waitFor(() => expect(display("A2")).toBe("4"));
		expect(cell("A1")).toBe(first);
		expect(q("thead th:nth-child(2)")).toBe(head);
		expect(document.querySelectorAll("tbody tr")).toHaveLength(rows);
		head.click();
		expect(head.classList.contains("all")).toBe(true);
		expect(q<HTMLInputElement>("#range").value).toMatch(/^A1:A\d+$/);
	});
	it("offers cell actions on right-click and renames a sheet from its tab", async () => {
		const app = await editor();
		cell("B1").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
		);
		expect(cell("B1").classList.contains("active")).toBe(true);
		expect(
			[...document.querySelectorAll(".menu [role=menuitem]")].map(
				(item) => item.textContent,
			),
		).toEqual(
			expect.arrayContaining(["Cut", "Copy", "Paste", "Insert rows above"]),
		);
		click('.menu [data-action="insert-row"]');
		expect(document.querySelector(".menu")).toBeNull();
		q('[data-sheet="archive"]').dispatchEvent(
			new MouseEvent("dblclick", { bubbles: true }),
		);
		apply("Old numbers");
		await saved();
		const book = app.saved().workbook!;
		expect(book.sheets[0]!.rows[1]![2]!.input).toBe("=SUM(A2:B2)");
		expect(book.sheets[1]!.name).toBe("Old numbers");
		click("#help");
		expect(q(".menu.keys").textContent).toContain("Keyboard shortcuts");
	});
	it("saves on its own after a pause, quietly", async () => {
		const app = await editor();
		edit("A1", "6");
		expect(state()).toBe("idle");
		await vi.waitFor(() => expect(app.revision()).toBe(2), { timeout: 4000 });
		expect(app.saved().rows[0]).toEqual([6, 2, 8]);
		expect(q(".status").textContent).toBe("");
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
		expect(app.call).toHaveBeenCalledWith(
			"outputs.patch",
			expect.objectContaining({ slot: "sheet", baseRevision: 1 }),
		);
	});
	it("keeps the grid editable during a save, runs one save at a time and sends later edits next", async () => {
		const app = await editor(),
			original = app.call.getMockImplementation()!;
		edit("A1", "12");
		await vi.waitFor(() => expect(display("C1")).toBe("14"));
		let finish: (() => void) | undefined;
		app.call.mockImplementation(async (method, args) => {
			if (method === "outputs.patch" && !finish)
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
			return original(method, args);
		});
		key("s", { ctrlKey: true });
		key("s", { ctrlKey: true });
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		expect(app.outputsWrite).not.toHaveBeenCalled();
		expect(q<HTMLInputElement>("#formula").disabled).toBe(false);
		edit("B1", "5");
		expect(display("B1")).toBe("5");
		finish!();
		await vi.waitFor(() => expect(app.revision()).toBe(3));
		expect(app.outputsWrite).toHaveBeenCalledTimes(2);
		expect(app.saved().rows[0]).toEqual([12, 5, 17]);
		expect(cell("B1").classList.contains("active")).toBe(false);
	});
	it("cuts formula source and removes destination styles absent from an internal copy", async () => {
		const app = await editor();
		select("C1");
		const text = clipboard("cut");
		select("A2");
		clipboard("paste", text);
		await saved();
		const s = app.saved().workbook!.sheets[0]!;
		expect(s.rows[0]![2]!.input).toBe("");
		expect(s.rows[1]![0]!.input).toBe("=SUM(A1:B1)");
		expect(s.rows[1]![0]!.value).toBe(3);
		select("B1");
		const copy = clipboard("copy");
		select("A1");
		clipboard("paste", copy);
		await saved();
		expect(
			app.saved().workbook!.sheets[0]!.rows[0]![0]!.format,
		).toBeUndefined();
	});
	it("saves a quarter second after the last edit, within 1.2 s while edits keep coming, and sends only the changed cells", async () => {
		const app = await editor();
		const patches = () =>
			app.call.mock.calls
				.filter(([method]) => method === "outputs.patch")
				.map(([, args]) => (args as { patch: OutputPatch }).patch);
		vi.useFakeTimers();
		cleanups.unshift(() => vi.useRealTimers());
		edit("B1", "5");
		await vi.advanceTimersByTimeAsync(200);
		expect(patches()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(40);
		expect(patches()).toHaveLength(1);
		// The edited cell and the total that depends on it; no other cell, no
		// other tab and none of the sheet's flat copy.
		const cells = new Set(
			patches()[0]!.ops.map((op) => JSON.stringify(op.path.slice(0, 6))),
		);
		const tab = { id: app.saved().workbook!.sheets[0]!.id };
		expect(cells).toEqual(
			new Set(
				[1, 2].map((column) =>
					JSON.stringify(["workbook", "sheets", tab, "rows", 0, column]),
				),
			),
		);
		expect(app.saved().rows[0]).toEqual([1, 5, 6]);
		// An edit every 200 ms never leaves a 220 ms pause; the save still goes
		// out 1.2 s after the first of them.
		for (let index = 0; index < 5; index++) {
			edit("A2", String(index));
			await vi.advanceTimersByTimeAsync(200);
		}
		expect(patches()).toHaveLength(1);
		edit("A2", "last");
		await vi.advanceTimersByTimeAsync(200);
		expect(patches()).toHaveLength(2);
		// A failed save that may pass is tried again 40 ms later, then 80 ms.
		app.offline(true);
		edit("A3", "retry");
		await vi.advanceTimersByTimeAsync(230);
		expect(patches()).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(20);
		expect(patches()).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(25);
		expect(patches()).toHaveLength(4);
		app.offline(false);
		await vi.advanceTimersByTimeAsync(90);
		expect(patches()).toHaveLength(5);
		expect(app.saved().workbook!.sheets[0]!.rows[2]![0]!.input).toBe("retry");
	});
	it("says once why a file over the limit is not saved and waits for the next change", async () => {
		const app = await editor();
		expect(state()).toBe("idle");
		expect(q(".status").title).toBe("All changes saved");
		const original = app.call.getMockImplementation()!;
		const writes = () =>
			app.call.mock.calls.filter(([method]) => method === "outputs.patch")
				.length;
		app.call.mockImplementation(async (method, args) => {
			if (method === "outputs.patch")
				throw Object.assign(new Error("too_large"), { code: "too_large" });
			return original(method, args);
		});
		vi.useFakeTimers();
		cleanups.unshift(() => vi.useRealTimers());
		edit("A1", "Big");
		expect(q(".status").title).toBe("Changes not saved yet");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(state()).toBe("error");
		expect(q(".status").textContent).toBe(
			"Not saved. This file is over the 8 MB limit, so new changes are not saved. Remove or shrink large images.",
		);
		const attempts = writes();
		expect(attempts).toBeGreaterThan(0);
		// No retry, however long the sheet is left alone.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(writes()).toBe(attempts);
		// The next change is tried, and a save that works clears the notice.
		app.call.mockImplementation(original);
		edit("A2", "Smaller");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(writes()).toBe(attempts + 1);
		expect(state()).not.toBe("error");
	});
	it("fills a newly addressed range, keeps working when a save fails and saves once it can", async () => {
		const app = await editor();
		range("C1:C8");
		click("#fill-down");
		await vi.waitFor(() => expect(display("C8")).toBe("0"));
		const original = app.call.getMockImplementation()!;
		app.call.mockImplementation(async (method, args) => {
			if (method === "outputs.patch") throw new Error("Content exceeds 1 MB");
			return original(method, args);
		});
		key("s", { ctrlKey: true });
		await vi.waitFor(() => expect(state()).toBe("error"));
		expect(q(".status").textContent).toContain("Couldn't save");
		expect(q(".status").title).toContain("Content exceeds");
		expect(app.revision()).toBe(1);
		expect(display("C8")).toBe("0");
		range("Z99");
		key("7");
		q<HTMLInputElement>(".cell-edit").value = "7";
		key("Enter", {}, q(".cell-edit"));
		expect(display("Z99")).toBe("7");
		expect(app.outputsWrite).not.toHaveBeenCalled();
		app.call.mockImplementation(original);
		await vi.waitFor(() => expect(app.revision()).toBe(2), { timeout: 8000 });
		await vi.waitFor(() => expect(q(".status").textContent).toBe("Saved"));
		expect(app.saved().workbook!.sheets[0]!.rows[98]![25]!.input).toBe("7");
	}, 12000);

	it("saves an active cell without requiring Enter and commits pending cells before formatting", async () => {
		const app = await editor();
		select("A1");
		key("8");
		const input = q<HTMLInputElement>(".cell-edit");
		input.value = "8";
		input.dispatchEvent(new Event("input"));
		key("s", { ctrlKey: true }, input);
		await vi.waitFor(() => expect(app.revision()).toBe(2));
		expect(app.saved().rows[0]).toEqual([8, 2, 10]);
		select("B2");
		key("7");
		q<HTMLInputElement>(".cell-edit").value = "7";
		click('[data-format="bold"]');
		await saved();
		expect(app.saved().workbook!.sheets[0]!.rows[1]![1]).toMatchObject({
			input: "7",
			value: 7,
			format: { bold: true },
		});
	});

	it("saves finished changes when the editor closes and leaves no draft behind", async () => {
		const app = await editor();
		app.offline(true);
		edit("C1", "=B1*8");
		select("C1");
		change("#font-size", "22");
		change("#fill-color", "#abcdee");
		change("#tabs", "archive");
		edit("B2", "Archive draft");
		await vi.waitFor(() =>
			expect(app.drafts.get("output")?.content.workbook?.activeSheetId).toBe(
				"archive",
			),
		);
		expect(app.outputsWrite).not.toHaveBeenCalled();
		app.offline(false);
		await app.settle();
		await app.reopen();
		expect(app.revision()).toBe(2);
		expect(app.drafts.size).toBe(0);
		expect(q(".status").textContent).not.toContain("Restored");
		expect(q<HTMLSelectElement>("#tabs").value).toBe("archive");
		expect(display("B2")).toBe("Archive draft");
		change("#tabs", app.saved().workbook!.sheets[0]!.id);
		select("C1");
		expect(q<HTMLInputElement>("#formula").value).toBe("=B1*8");
		expect(cell("C1").style.fontSize).toBe("22px");
		expect(app.saved().workbook!.sheets[0]!.rows[0]![2]!.format).toMatchObject({
			fontSize: 22,
			fillColor: "#abcdee",
		});
		expect(app.saved().workbook!.sheets[1]!.rows[1]![1]!.input).toBe(
			"Archive draft",
		);
	});
	it("restores changes that could not be saved before closing, then saves them", async () => {
		const app = await editor(),
			original = app.call.getMockImplementation()!;
		app.call.mockImplementation(async (method, args) => {
			if (method === "outputs.patch") throw new Error("Network unreachable");
			return original(method, args);
		});
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		await app.reopen();
		expect(app.revision()).toBe(1);
		expect(q(".status").textContent).toContain("Restored your unsaved changes");
		expect(display("C1")).toBe("9");
		app.call.mockImplementation(original);
		await vi.waitFor(() => expect(app.revision()).toBe(2), { timeout: 4000 });
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
		expect(app.saved().rows[0]).toEqual([7, 2, 9]);
	});
	it("retains raw cell and formula bar input before Enter and removes canceled raw drafts", async () => {
		const app = await editor();
		select("C1");
		key("=");
		const input = q<HTMLInputElement>(".cell-edit");
		input.value = "=B1*9";
		input.dispatchEvent(new Event("input"));
		await vi.waitFor(() =>
			expect(
				app.drafts.get("output")?.content.workbook!.sheets[0]!.rows[0]![2]!
					.input,
			).toBe("=B1*9"),
		);
		await app.reopen();
		expect(app.revision()).toBe(1);
		expect(display("C1")).toBe("18");
		select("C1");
		const formula = q<HTMLInputElement>("#formula");
		formula.focus();
		formula.value = "=A1*17";
		formula.dispatchEvent(new Event("input"));
		// Closing saves the finished change and keeps the text still being typed.
		await app.reopen();
		expect(app.revision()).toBe(2);
		expect(app.saved().workbook!.sheets[0]!.rows[0]![2]!.input).toBe("=B1*9");
		expect(display("C1")).toBe("17");
		await saved();
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
		select("A2");
		key("7");
		key("Escape", {}, q(".cell-edit"));
		await app.reopen();
		expect(display("A2")).toBe("");
		expect(app.drafts.size).toBe(0);
	});
	it("does not silently restore or rebase a draft after a concurrent revision", async () => {
		const app = await editor();
		app.offline(true);
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		app.changeExternal(9);
		await app.reopen();
		app.offline(false);
		expect(display("C1")).toBe("11");
		expect(q("#updates").textContent).toContain("earlier visit");
		expect(q<HTMLInputElement>("#formula").disabled).toBe(true);
		choose("review");
		await vi.waitFor(() => expect(display("C1")).toBe("9"));
		expect(q("#updates").textContent).toContain("Keep mine");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(app.drafts.get("output")?.revision).toBe(1);
		expect(app.saved().rows[0]![0]).toBe(9);
		choose("theirs");
		await vi.waitFor(() => expect(display("C1")).toBe("11"));
		expect(app.drafts.size).toBe(0);
		expect(app.revision()).toBe(2);
	});
	it("saves earlier unsaved changes over a newer version only when asked to keep them", async () => {
		const app = await editor();
		app.offline(true);
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		app.changeExternal(9);
		await app.reopen();
		app.offline(false);
		choose("review");
		await vi.waitFor(() => expect(display("C1")).toBe("9"));
		choose("mine");
		await vi.waitFor(() => expect(app.revision()).toBe(3));
		expect(app.saved().rows[0]).toEqual([7, 2, 9]);
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
	});
	it("never applies a retained draft to a different output binding", async () => {
		const app = await editor();
		app.outputsWrite.mockRejectedValue(new Error("Network unreachable"));
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		app.retarget("different-output");
		await app.reopen();
		expect(display("C1")).toBe("3");
		expect(q(".status").textContent).not.toContain("Restored");
		expect(app.drafts.get("different-output")).toBeUndefined();
	});
	it("clears stale content and locks writes, copies and exports after source access is denied", async () => {
		const app = await editor();
		app.offline(true);
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		app.outputsRead.mockRejectedValue(
			new Error("Output source access unavailable"),
		);
		app.changeExternal(5);
		await vi.waitFor(() => expect(q(".grid").hidden).toBe(true));
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
		expect(document.querySelectorAll("td[data-row]")).toHaveLength(0);
		expect(q<HTMLInputElement>("#formula").value).toBe("");
		expect(q<HTMLInputElement>("#formula").disabled).toBe(true);
		expect(q<HTMLButtonElement>("#download").disabled).toBe(true);
		expect(state()).toBe("error");
		key("9");
		clipboard("paste", "secret");
		expect(clipboard("copy")).toBe("");
		key("s", { ctrlKey: true });
		expect(app.outputsWrite).not.toHaveBeenCalled();
		await app.reopen();
		expect(q(".grid").hidden).toBe(true);
		expect(app.drafts.size).toBe(0);
	});
	it("orders draft clear after pending retention writes during Save", async () => {
		const app = await editor(),
			original = app.call.getMockImplementation()!;
		let finish: (() => void) | undefined,
			blocked = false;
		app.call.mockImplementation(async (method, args) => {
			if (method === "app.draft.write" && !blocked) {
				blocked = true;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
			}
			return original(method, args);
		});
		app.offline(true);
		edit("A1", "7");
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		app.offline(false);
		key("s", { ctrlKey: true });
		await vi.waitFor(() => expect(app.revision()).toBe(2));
		finish!();
		await vi.waitFor(() => expect(q(".status").textContent).toBe("Saved"));
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
		await app.reopen();
		expect(display("C1")).toBe("9");
		expect(q(".status").textContent).not.toContain("Restored");
	});
	it("locks a draft on Save rejection when a fresh read confirms source revocation", async () => {
		const app = await editor();
		app.offline(true);
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		app.offline(false);
		app.outputsWrite.mockRejectedValue(new Error("FORBIDDEN"));
		app.outputsRead.mockRejectedValue(
			new Error("Output source access unavailable"),
		);
		key("s", { ctrlKey: true });
		await vi.waitFor(() => expect(q(".grid").hidden).toBe(true));
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
		expect(q(".status").textContent).toContain("source access");
	});

	it("writes one safety copy after a burst of typing", async () => {
		const app = await editor();
		select("C1");
		key("=");
		const input = q<HTMLInputElement>(".cell-edit");
		for (const value of ["=A", "=A1", "=A1*1", "=A1*19"]) {
			input.value = value;
			input.dispatchEvent(new Event("input"));
		}
		expect(draftWrites(app)).toHaveLength(0);
		await vi.waitFor(() => expect(draftWrites(app)).toHaveLength(1));
		expect(
			app.drafts.get("output")?.content.workbook!.sheets[0]!.rows[0]![2]!.input,
		).toBe("=A1*19");
		await app.reopen();
		expect(display("C1")).toBe("19");
	});

	it("ships an executable isolated bundle without native editor dispatch or imports", async () => {
		document.body.innerHTML = '<div id="app"></div>';
		const calculate = (content: Sheet) =>
			projectWorkbook(
				evaluateWorkbook(normalizeSheetContent(content).workbook!),
			);
		const bridge = {
			call: vi.fn(async (method: string) =>
				method === "context"
					? {
							role: "use",
							workspaceId: "workspace",
							grants: [],
							settings: { slot: "sheet" },
						}
					: method === "sheet.evaluate"
						? calculate({ kind: "sheet", columns: ["A"], rows: [[1]] })
						: {
								output: {
									id: "o",
									title: "Portable",
									workspaceId: "workspace",
									kind: "sheet",
								},
								revision: {
									revision: 7,
									content: { kind: "sheet", columns: ["A"], rows: [[1]] },
								},
							},
			),
		};
		Object.defineProperty(window, "tedix", {
			value: bridge,
			configurable: true,
		});
		const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
		const add = window.addEventListener.bind(window);
		vi.spyOn(window, "addEventListener").mockImplementation(
			(name, listener, options) => {
				listeners.push([name, listener]);
				add(name, listener, options);
			},
		);
		cleanups.push(() => {
			for (const [name, listener] of listeners)
				window.removeEventListener(name, listener);
			document.querySelectorAll("style").forEach((style) => style.remove());
			Reflect.deleteProperty(window, "tedix");
		});
		new Function(SHEET_CLIENT_SOURCE)();
		await vi.waitFor(() => expect(q("h1").textContent).toBe("Portable"));
		expect(q(".status").textContent).toBe("View only");
		expect(display("A1")).toBe("1");
		expect(SHEET_CLIENT_SOURCE).not.toContain("OutputSheetEditor");
		expect(SHEET_CLIENT_SOURCE).not.toMatch(/\bimport\s/);
	});
});
