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
		outputId = "output";
	const outputsRead = vi.fn(async () => ({
		output: {
			id: outputId,
			title: "Budget",
			workspaceId: "workspace",
			kind: "sheet",
		},
		revision: { revision, content: structuredClone(saved) },
	}));
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
	const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
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
		if (method === "sheet.evaluate") return calculate(args!.content as Sheet);
		if (method === "outputs.replace") {
			await outputsWrite(
				String(args!.slot),
				args as { content: Sheet; expectedRevision: number },
			);
			return outputsRead();
		}
		if (method === "app.exportOutput") return null;
		if (method === "app.download") {
			download(args);
			return null;
		}
		if (method === "app.call")
			return app[args!.method as string](...(args!.args as unknown[]));
		throw new Error("Unknown host operation");
	});
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
		changeExternal(value: number) {
			saved.workbook!.sheets[0]!.rows[0]![0]!.input = String(value);
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
	change("#structure", value);
}
function apply(value: string) {
	q<HTMLInputElement>("#command-value").value = value;
	click("#command-apply");
}
const display = (address: string) =>
	cell(address)?.querySelector("output")?.textContent;
async function saved(app: Awaited<ReturnType<typeof editor>>, revision = 2) {
	click("#save");
	await vi.waitFor(() => expect(app.revision()).toBe(revision));
}

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
		await saved(app);
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
			"outputs.replace",
			expect.objectContaining({ slot: "sheet", expectedRevision: 1 }),
		);
		click("#export");
		await vi.waitFor(() =>
			expect(app.download).toHaveBeenCalledWith({
				filename: "Budget.csv",
				mimeType: "text/csv;charset=utf-8",
				text: "Amount,Rate,Total\r\n5,4,20\r\n",
			}),
		);
		click("#xlsx");
		await vi.waitFor(() =>
			expect(app.call).toHaveBeenCalledWith("app.exportOutput", {
				slot: "sheet",
				format: "xlsx",
				expectedRevision: 2,
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
		await saved(app);
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
		change("#align", "right");
		click("#undo");
		click("#redo");
		await saved(app);
		const s = app.saved().workbook!.sheets[0]!;
		expect(s.rows[1]![1]!.format).toMatchObject({
			italic: true,
			numberFormat: "percent",
			fontSize: 18,
			fillColor: "#abcdee",
			horizontalAlign: "right",
		});
		expect(s.rows[0]![2]!.input).toBe("=SUM(A1:B1)");
		range("A1:B2");
		click("#clear-format");
		await saved(app, 3);
		expect(
			app.saved().workbook!.sheets[0]!.rows[0]![0]!.format,
		).toBeUndefined();
	});
	it("inserts/deletes rows and columns with reference rewrites and supports tab operations", async () => {
		const app = await editor();
		select("A1");
		operation("insert-row");
		operation("insert-column");
		await saved(app);
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
		await saved(app, 3);
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
		await saved(app);
		const s = app.saved().workbook!.sheets[0]!;
		expect(s.rows[2]![2]!.input).toBe("=SUM(A3:B3)");
		expect(s.columns[1]!.width).toBe(220);
		expect(s.rowHeights?.[1]).toBe(45);
		expect(s.frozenRows).toBe(1);
		expect(s.frozenColumns).toBe(1);
		range("A2:B3");
		click("#sort-desc");
		await saved(app, 3);
		expect(
			app
				.saved()
				.workbook!.sheets[0]!.rows.slice(1)
				.map((row) => row[1]!.value),
		).toEqual([4, 3]);
	});
	it("refreshes clean editors, asks which value wins when both edited one cell, and allows explicit discard", async () => {
		const app = await editor();
		app.changeExternal(3);
		await vi.waitFor(() => expect(display("C1")).toBe("5"));
		edit("A1", "8");
		await vi.waitFor(() => expect(display("C1")).toBe("10"));
		app.changeExternal(4);
		await vi.waitFor(() =>
			expect(q("#updates").textContent).toContain(
				"Choose which version to keep",
			),
		);
		expect(app.saved().rows[0]![0]).toBe(4);
		expect(display("C1")).toBe("10");
		click("#reload");
		expect(display("C1")).toBe("10");
		click("#reload");
		await vi.waitFor(() => expect(display("C1")).toBe("6"));
		expect(q("#updates").textContent).toBe("");
	});
	it("keeps the chosen value for a cell both people edited, then saves the merge", async () => {
		const app = await editor();
		edit("A1", "8");
		await vi.waitFor(() => expect(display("C1")).toBe("10"));
		app.changeExternal(4);
		await vi.waitFor(() =>
			expect(q("#updates").textContent).toContain("Keep mine"),
		);
		[...document.querySelectorAll<HTMLButtonElement>("#updates button")]
			.find((button) => button.textContent === "Keep mine")!
			.click();
		await vi.waitFor(() =>
			expect(q(".status").textContent).toContain("merged with revision 2"),
		);
		expect(display("C1")).toBe("10");
		click("#save");
		await vi.waitFor(() => expect(app.revision()).toBe(3));
		expect(app.saved().rows[0]![0]).toBe(8);
	});
	it("merges someone else's save into an unsaved draft that changed a different cell", async () => {
		const app = await editor();
		edit("B1", "5");
		await vi.waitFor(() => expect(display("C1")).toBe("6"));
		app.changeExternal(4);
		await vi.waitFor(() => expect(display("C1")).toBe("9"));
		expect(q(".status").textContent).toContain("merged with revision 2");
		click("#save");
		await vi.waitFor(() => expect(app.revision()).toBe(3));
		expect(app.saved().rows[0]).toEqual([4, 5, 9]);
	});
	it("preserves an uncommitted formula bar draft on external updates, then merges it", async () => {
		const app = await editor();
		select("C1");
		const formula = q<HTMLInputElement>("#formula");
		formula.focus();
		formula.value = "=A1*10";
		formula.dispatchEvent(new Event("input"));
		app.changeExternal(9);
		expect(formula.value).toBe("=A1*10");
		expect(q("#updates").textContent).toContain("preserved");
		key("Enter", {}, formula);
		click("#save");
		await vi.waitFor(() =>
			expect(q(".status").textContent).toContain("merged with revision 2"),
		);
		expect(display("C1")).toBe("90");
		click("#save");
		await vi.waitFor(() => expect(app.revision()).toBe(3));
		expect(app.saved().workbook!.sheets[0]!.rows[0]![2]!.input).toBe("=A1*10");
	});
	it("virtualizes a full workbook and rejects an out-of-bounds paste without a partial write", async () => {
		const app = await editor("owner", (content) => {
			const s = content.workbook!.sheets[0]!;
			s.rows = Array.from({ length: 1000 }, (_, i) => [
				{ input: String(i), value: i },
				null,
				null,
			]);
			return content;
		});
		expect(document.querySelectorAll("td[data-row]").length).toBeLessThan(400);
		range("C1000");
		expect(cell("C1000")).toBeTruthy();
		clipboard("paste", "1\n2");
		expect(q(".status").textContent).toContain("Paste exceeds");
		expect(q<HTMLButtonElement>("#save").disabled).toBe(true);
		expect(app.outputsWrite).not.toHaveBeenCalled();
	});
	it("keeps use-role sessions read-only while permitting tab navigation and export", async () => {
		const app = await editor("use");
		expect(q<HTMLInputElement>("#formula").disabled).toBe(true);
		select("A1");
		key("9");
		expect(document.querySelector(".cell-edit")).toBeNull();
		clipboard("paste", "9");
		click("#add-row");
		change("#tabs", "archive");
		expect(q<HTMLSelectElement>("#tabs").value).toBe("archive");
		expect(app.outputsWrite).not.toHaveBeenCalled();
		expect(q<HTMLButtonElement>("#save").disabled).toBe(true);
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
		await saved(app);
		expect(app.saved().rows[0]).toEqual([9, 2, 11]);
	});
	it("awaits Save recalculation and disables concurrent edits and duplicate saves", async () => {
		const app = await editor(),
			original = app.call.getMockImplementation()!;
		let finish: ((content: Sheet) => void) | undefined,
			snapshot: Sheet | undefined;
		app.call.mockImplementation(async (method, args) => {
			if (method === "sheet.evaluate") {
				snapshot = args!.content as Sheet;
				return new Promise<Sheet>((resolve) => {
					finish = resolve;
				});
			}
			return original(method, args);
		});
		edit("A1", "12");
		click("#save");
		click("#save");
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		expect(app.outputsWrite).not.toHaveBeenCalled();
		expect(q<HTMLInputElement>("#formula").disabled).toBe(true);
		key("9");
		expect(document.querySelector(".cell-edit")).toBeNull();
		finish!(app.calculate(snapshot!));
		await vi.waitFor(() => expect(app.revision()).toBe(2));
		expect(app.outputsWrite).toHaveBeenCalledTimes(1);
		expect(app.saved().rows[0]).toEqual([12, 2, 14]);
	});
	it("cuts formula source and removes destination styles absent from an internal copy", async () => {
		const app = await editor();
		select("C1");
		const text = clipboard("cut");
		select("A2");
		clipboard("paste", text);
		await saved(app);
		const s = app.saved().workbook!.sheets[0]!;
		expect(s.rows[0]![2]!.input).toBe("");
		expect(s.rows[1]![0]!.input).toBe("=SUM(A1:B1)");
		expect(s.rows[1]![0]!.value).toBe(3);
		select("B1");
		const copy = clipboard("copy");
		select("A1");
		clipboard("paste", copy);
		await saved(app, 3);
		expect(
			app.saved().workbook!.sheets[0]!.rows[0]![0]!.format,
		).toBeUndefined();
	});
	it("fills a newly addressed range and keeps a rejected large save draft available", async () => {
		const app = await editor();
		range("C1:C8");
		click("#fill-down");
		await vi.waitFor(() => expect(display("C8")).toBe("0"));
		const original = app.call.getMockImplementation()!;
		app.call.mockImplementation(async (method, args) => {
			if (method === "outputs.replace") throw new Error("Content exceeds 1 MB");
			return original(method, args);
		});
		click("#save");
		await vi.waitFor(() =>
			expect(q(".status").textContent).toContain("Content exceeds"),
		);
		expect(q(".status").textContent).toContain("draft is still here");
		expect(app.revision()).toBe(1);
		expect(display("C8")).toBe("0");
		range("Z99");
		key("7");
		q<HTMLInputElement>(".cell-edit").value = "7";
		key("Enter", {}, q(".cell-edit"));
		await vi.waitFor(() => expect(display("Z99")).toBe("7"));
		expect(app.outputsWrite).not.toHaveBeenCalled();
	});

	it("saves an active cell without requiring Enter and commits pending cells before formatting", async () => {
		const app = await editor();
		select("A1");
		key("8");
		const input = q<HTMLInputElement>(".cell-edit");
		input.value = "8";
		input.dispatchEvent(new Event("input"));
		expect(q<HTMLButtonElement>("#save").disabled).toBe(false);
		key("s", { ctrlKey: true }, input);
		await vi.waitFor(() => expect(app.revision()).toBe(2));
		expect(app.saved().rows[0]).toEqual([8, 2, 10]);
		select("B2");
		key("7");
		q<HTMLInputElement>(".cell-edit").value = "7";
		click('[data-format="bold"]');
		await saved(app, 3);
		expect(app.saved().workbook!.sheets[0]!.rows[1]![1]).toMatchObject({
			input: "7",
			value: 7,
			format: { bold: true },
		});
	});

	it("retains complete formatted workbook drafts across tab unmounts and clears them after Save", async () => {
		const app = await editor();
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
		await app.reopen();
		expect(q(".status").textContent).toContain("Restored draft");
		expect(q<HTMLSelectElement>("#tabs").value).toBe("archive");
		expect(display("B2")).toBe("Archive draft");
		change("#tabs", app.saved().workbook!.sheets[0]!.id);
		select("C1");
		expect(q<HTMLInputElement>("#formula").value).toBe("=B1*8");
		expect(cell("C1").style.fontSize).toBe("22px");
		await saved(app);
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
		expect(app.saved().workbook!.sheets[0]!.rows[0]![2]!.format).toMatchObject({
			fontSize: 22,
			fillColor: "#abcdee",
		});
		expect(app.saved().workbook!.sheets[1]!.rows[1]![1]!.input).toBe(
			"Archive draft",
		);
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
		expect(display("C1")).toBe("18");
		click("#reload");
		click("#reload");
		await vi.waitFor(() => expect(q(".status").textContent).toContain("Saved"));
		select("C1");
		const formula = q<HTMLInputElement>("#formula");
		formula.focus();
		formula.value = "=A1*17";
		formula.dispatchEvent(new Event("input"));
		await app.reopen();
		expect(display("C1")).toBe("17");
		click("#reload");
		click("#reload");
		await vi.waitFor(() => expect(q(".status").textContent).toContain("Saved"));
		select("A2");
		key("7");
		key("Escape", {}, q(".cell-edit"));
		await app.reopen();
		expect(display("A2")).toBe("");
		expect(app.drafts.size).toBe(0);
	});
	it("does not silently restore or rebase a draft after a concurrent revision", async () => {
		const app = await editor();
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		app.changeExternal(9);
		await app.reopen();
		expect(display("C1")).toBe("11");
		expect(q("#updates").textContent).toContain(
			"retained draft is based on revision 1",
		);
		expect(q<HTMLButtonElement>("#save").disabled).toBe(true);
		expect(q("#review-draft").hidden).toBe(false);
		click("#review-draft");
		await vi.waitFor(() => expect(display("C1")).toBe("9"));
		click("#save");
		await vi.waitFor(() =>
			expect(q(".status").textContent).toContain("Revision conflict"),
		);
		expect(app.drafts.get("output")?.revision).toBe(1);
		expect(app.saved().rows[0]![0]).toBe(9);
		click("#reload");
		click("#reload");
		await vi.waitFor(() => expect(display("C1")).toBe("11"));
		expect(app.drafts.size).toBe(0);
	});
	it("never applies a retained draft to a different output binding", async () => {
		const app = await editor();
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		app.retarget("different-output");
		await app.reopen();
		expect(display("C1")).toBe("3");
		expect(q(".status").textContent).not.toContain("Restored");
		expect(q<HTMLButtonElement>("#save").disabled).toBe(true);
		expect(app.drafts.get("different-output")).toBeUndefined();
	});
	it("clears stale content and locks writes, copies and exports after source access is denied", async () => {
		const app = await editor();
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		app.outputsRead.mockRejectedValue(
			new Error("Output source access unavailable"),
		);
		click("#reload");
		click("#reload");
		await vi.waitFor(() => expect(q(".grid").hidden).toBe(true));
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
		expect(document.querySelectorAll("td[data-row]")).toHaveLength(0);
		expect(q<HTMLInputElement>("#formula").value).toBe("");
		expect(q<HTMLInputElement>("#formula").disabled).toBe(true);
		expect(q<HTMLButtonElement>("#save").disabled).toBe(true);
		expect(q<HTMLButtonElement>("#export").disabled).toBe(true);
		expect(q<HTMLButtonElement>("#xlsx").disabled).toBe(true);
		key("9");
		clipboard("paste", "secret");
		expect(clipboard("copy")).toBe("");
		click("#save");
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
		edit("A1", "7");
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		click("#save");
		await vi.waitFor(() => expect(app.revision()).toBe(2));
		finish!();
		await vi.waitFor(() => expect(q(".status").textContent).toContain("Saved"));
		expect(app.drafts.size).toBe(0);
		await app.reopen();
		expect(display("C1")).toBe("9");
		expect(q(".status").textContent).not.toContain("Restored");
	});
	it("locks a draft on Save rejection when a fresh read confirms source revocation", async () => {
		const app = await editor();
		edit("A1", "7");
		await vi.waitFor(() => expect(app.drafts.has("output")).toBe(true));
		app.outputsWrite.mockRejectedValue(new Error("FORBIDDEN"));
		app.outputsRead.mockRejectedValue(
			new Error("Output source access unavailable"),
		);
		click("#save");
		await vi.waitFor(() => expect(q(".grid").hidden).toBe(true));
		await vi.waitFor(() => expect(app.drafts.size).toBe(0));
		expect(q(".status").textContent).toContain("source access");
		expect(q<HTMLButtonElement>("#save").disabled).toBe(true);
	});

	it("posts each raw input immediately while an earlier retention response is pending", async () => {
		const app = await editor(),
			original = app.call.getMockImplementation()!;
		let finish: (() => void) | undefined,
			blocked = false;
		app.call.mockImplementation(async (method, args) => {
			const result = await original(method, args);
			if (method === "app.draft.write" && !blocked) {
				blocked = true;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
			}
			return result;
		});
		select("C1");
		key("=");
		const input = q<HTMLInputElement>(".cell-edit");
		input.value = "=A1*19";
		input.dispatchEvent(new Event("input"));
		expect(
			app.call.mock.calls.filter(([method]) => method === "app.draft.write"),
		).toHaveLength(2);
		expect(
			app.drafts.get("output")?.content.workbook!.sheets[0]!.rows[0]![2]!.input,
		).toBe("=A1*19");
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		finish!();
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
		await vi.waitFor(() =>
			expect(q(".status").textContent).toContain("revision 7"),
		);
		expect(q("h1").textContent).toBe("Portable");
		expect(SHEET_CLIENT_SOURCE).not.toContain("OutputSheetEditor");
		expect(SHEET_CLIENT_SOURCE).not.toMatch(/\bimport\s/);
	});
});
