import type {
	OsOutputContent,
	OsWorkbook,
	OsWorkbookCellFormat,
} from "@tedix/api-contract/schemas/os-workspaces";
import { formatWorkbookNumber } from "@tedix/api-contract/utils/workbook-number-format";
import {
	boundsContain,
	cellLabel,
	clampCoordinate,
	columnLabel,
	copyBounds,
	jumpToDataEdge,
	parseClipboardTable,
	parseRangeLabel,
	rangeLabel,
	selectedBounds,
	selectionStats,
	type Selection,
	type CopiedCells,
	type Bounds,
} from "../lib/sheet-grid";
import {
	autoSum,
	deleteColumns,
	deleteRows,
	deleteSheet,
	duplicateSheet,
	fillRange,
	freezePanes,
	frozenCellStyle,
	insertColumns,
	insertRows,
	moveSheet,
	offsetFormula,
	renameSheet,
	resizeColumn,
	resizeRow,
	sortRange,
} from "../lib/workbook-structure";
import {
	mergeOutputContent,
	type OutputMergePreference,
} from "@tedix/api-contract/utils/output-merge";
import { showMergeChoice } from "./merge-choice";
import { EDITOR_ICON_CSS, iconButton } from "./editor-icons";

type Content = Extract<OsOutputContent, { kind: "sheet" }>;
type Saved = {
	output: { id: string; title: string; workspaceId: string; kind: string };
	revision: { revision: number; content: Content };
};
type RetainedDraft = { revision: number; content: Content };
export interface SheetClientBridge {
	call<T = unknown>(method: string, args?: unknown): Promise<T>;
}

const css = `:root{font:13px var(--tedix-font,system-ui,sans-serif);color:var(--tedix-fg,CanvasText);background:var(--tedix-bg,Canvas)}*{box-sizing:border-box}body{margin:0;padding:0!important}button,input,select{font:inherit;color:inherit}button,select,input{background:var(--tedix-bg,Canvas);border:1px solid color-mix(in srgb,var(--tedix-fg,CanvasText) 22%,transparent);border-radius:4px;padding:6px 8px}button{cursor:pointer}button:disabled,select:disabled,input:disabled{opacity:.45;cursor:default}button[aria-pressed=true]{background:color-mix(in srgb,var(--tedix-primary,Highlight) 20%,var(--tedix-bg,Canvas))}header{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 12px}h1{font-size:15px;font-weight:600;margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}header button:not(.primary){border-color:transparent;background:transparent}header button:not(.primary):hover:not(:disabled){background:color-mix(in srgb,var(--tedix-fg,CanvasText) 8%,transparent)}.bars{display:flex;flex-wrap:wrap;align-items:center;border-top:1px solid color-mix(in srgb,var(--tedix-fg,CanvasText) 14%,transparent)}.toolbar{display:flex;gap:2px;align-items:center;flex-wrap:wrap;padding:4px 8px}.toolbar select,.toolbar input{padding:4px 6px}.toolbar label{display:flex;gap:4px;align-items:center}.toolbar input[type=color]{width:30px;padding:2px;height:29px}.toolbar input[type=number]{width:46px}.tabs>label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}#align{width:74px}#number-format{width:108px}#structure{width:88px}.formula{display:flex;gap:8px;padding:6px 10px;border-block:1px solid color-mix(in srgb,var(--tedix-fg,CanvasText) 20%,transparent)}#range{width:95px}#formula{flex:1;min-width:90px;font:13px ui-monospace,monospace}.status{flex:1;min-width:0;font-size:12px;opacity:.7;padding:2px 6px;border-radius:4px}.status[data-error=true]{opacity:1}#updates{padding:4px 12px;min-height:23px;font-size:12px}.status[data-error=true]{background:color-mix(in srgb,var(--tedix-warning,Mark) 25%,var(--tedix-bg,Canvas))}#updates:empty{display:none}.grid{height:58vh;min-height:240px;overflow:auto;outline:none;position:relative;border-block:1px solid color-mix(in srgb,var(--tedix-fg,CanvasText) 24%,transparent)}table{border-collapse:separate;border-spacing:0;table-layout:fixed;width:max-content}th,td{padding:0;border-right:1px solid color-mix(in srgb,var(--tedix-fg,CanvasText) 13%,transparent);border-bottom:1px solid color-mix(in srgb,var(--tedix-fg,CanvasText) 13%,transparent);height:28px;max-height:600px;overflow:hidden;position:relative}th{font-size:12px;font-weight:500;background:color-mix(in srgb,var(--tedix-fg,CanvasText) 6%,var(--tedix-bg,Canvas));user-select:none}thead th{height:32px;position:sticky;top:0;z-index:6}th.index{width:44px;min-width:44px;position:sticky;left:0;z-index:3}thead th.index{z-index:8}td{background:var(--tedix-bg,Canvas);user-select:none;cursor:cell}td output{display:block;padding:4px 7px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-height:27px;max-width:100%}td.selected{background:color-mix(in srgb,var(--tedix-primary,Highlight) 10%,var(--tedix-bg,Canvas))!important}td.active{outline:2px solid var(--tedix-primary,Highlight);outline-offset:-2px;z-index:5}td input.cell-edit{position:absolute;inset:0;width:100%;height:100%;border:2px solid var(--tedix-primary,Highlight);border-radius:0;padding:3px 5px;outline:none;background:var(--tedix-bg,Canvas);font:inherit;z-index:10}.resize{position:absolute;right:0;top:0;width:6px;height:100%;cursor:col-resize}.tabs{display:flex;align-items:center;gap:5px;padding:7px 10px;overflow-x:auto}.tabs button{white-space:nowrap}.tabs select{max-width:160px}.stats{font-size:12px;padding:5px 12px;min-height:25px;opacity:.8}.command{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 10px;background:color-mix(in srgb,var(--tedix-primary,Highlight) 7%,var(--tedix-bg,Canvas))}.command[hidden]{display:none}.help{font-size:12px;padding:6px 12px;opacity:.7}details{padding:4px 12px}summary{cursor:pointer}@media(max-width:600px){header{padding:8px}.toolbar{flex-wrap:nowrap;overflow-x:auto}.toolbar>*{flex-shrink:0}.grid{height:55vh}.help{font-size:11px}}`;

export async function mountSheetClient(
	root: HTMLElement,
	bridge: SheetClientBridge,
) {
	const style = document.createElement("style");
	style.textContent = css + EDITOR_ICON_CSS;
	document.head.append(style);
	root.innerHTML = `<header><h1>Sheet</h1><div class="status" role="status" aria-live="polite"></div><button id="reload">Reload</button><button id="export" title="Download the saved sheet as CSV">CSV</button><button id="xlsx" title="Download the saved sheet for Excel">Excel</button><button id="save" class="primary">Save</button></header>
<div class="bars"><div class="toolbar" role="toolbar" aria-label="Sheet formatting">${iconButton('id="undo"', "Undo (Ctrl/⌘ Z)", "undo")}${iconButton('id="redo"', "Redo (Ctrl/⌘ Shift Z)", "redo")}<span class="bar-divider" aria-hidden="true"></span><button data-format="bold" title="Bold (Ctrl/⌘ B)"><b>B</b></button><button data-format="italic" title="Italic (Ctrl/⌘ I)"><i>I</i></button><button data-format="underline" title="Underline (Ctrl/⌘ U)"><u>U</u></button><button data-format="strike" title="Strikethrough">S̶</button><label title="Font size"><input id="font-size" aria-label="Font size" type="number" min="6" max="96" value="13"></label><label title="Text colour"><span aria-hidden="true">A</span><input id="text-color" aria-label="Text color" type="color" value="#202020"></label><label title="Fill colour"><span aria-hidden="true">▧</span><input id="fill-color" aria-label="Fill color" type="color" value="#ffffff"></label><select id="align" aria-label="Alignment"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>${iconButton('data-format="wrap"', "Wrap text", "wrap")}<select id="number-format" aria-label="Number format"><option value="automatic">Automatic</option><option value="number">Number</option><option value="integer">Integer</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="scientific">Scientific</option><option value="date">Date</option><option value="time">Time</option><option value="datetime">Date & time</option><option value="text">Text</option></select><label title="Decimal places"><input id="decimals" aria-label="Decimal places" type="number" min="0" max="15" value="2"></label>${iconButton('id="clear-format"', "Clear formatting", "eraser")}</div>
<div class="toolbar" role="toolbar" aria-label="Sheet operations">${iconButton('id="add-row"', "Add row", "addRow")}${iconButton('id="add-column"', "Add column", "addColumn")}<select id="structure" aria-label="Workbook operation"><option value="">More…</option><option value="insert-row">Insert rows above</option><option value="delete-row">Delete selected rows</option><option value="insert-column">Insert columns before</option><option value="delete-column">Delete selected columns</option><option value="rename-column">Rename column</option><option value="row-height">Row height</option><option value="column-width">Column width</option><option value="add-sheet">Add sheet</option><option value="rename-sheet">Rename sheet</option><option value="duplicate-sheet">Duplicate sheet</option><option value="delete-sheet">Delete sheet</option><option value="move-left">Move sheet left</option><option value="move-right">Move sheet right</option><option value="freeze">Freeze to selection</option><option value="unfreeze">Unfreeze panes</option></select><span class="bar-divider" aria-hidden="true"></span><button id="sum" class="icon" title="Sum the selection" aria-label="Sum">Σ</button>${iconButton('id="fill-down"', "Fill down (Ctrl/⌘ D)", "fillDown")}${iconButton('id="fill-right"', "Fill right (Ctrl/⌘ R)", "fillRight")}${iconButton('id="sort-asc"', "Sort A to Z", "sortUp")}${iconButton('id="sort-desc"', "Sort Z to A", "sortDown")}${iconButton('id="clear"', "Clear cells", "clear")}</div></div>
<div class="formula"><input id="range" aria-label="Cell or range" value="A1"><label for="formula">fx</label><input id="formula" aria-label="Formula bar" autocomplete="off" spellcheck="false"></div>
<div class="command" hidden><label id="command-label" for="command-value"></label><input id="command-value"><button id="command-apply">Apply</button><button id="command-cancel">Cancel</button></div>
<div id="updates" role="status" aria-live="polite"></div><button id="review-draft" hidden>Review retained draft</button><div class="grid" tabindex="0" aria-label="Spreadsheet keyboard navigation"><table role="grid" aria-label="Sheet cells" aria-multiselectable="true"></table></div><div class="tabs"><label>Sheet <select id="tabs" aria-label="Active sheet"></select></label><div id="tab-buttons"></div>${iconButton('id="add-sheet"', "Add sheet", "plus")}</div><div class="stats"></div><details><summary>Keyboard shortcuts</summary><p class="help">Arrows move; Shift extends a range; Ctrl/⌘ + arrows jump to data edges. Tab/Enter advance within a range. Type or F2 to edit; Escape cancels. Ctrl/⌘ C/X/V copies, cuts and pastes ranges. Ctrl/⌘ Z/Shift Z undo/redo. Ctrl/⌘ D/R fill down/right. Delete clears cells. Ctrl/⌘ S saves. Select row/column headings or enter A1:C5 in the name box. Double-click a heading to rename it; drag column edges to resize. CSV exports saved values.</p></details>`;
	const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
		root.querySelector<T>(selector)!;
	const grid = q(".grid"),
		table = q<HTMLTableElement>("table"),
		formula = q<HTMLInputElement>("#formula"),
		namebox = q<HTMLInputElement>("#range"),
		tabs = q<HTMLSelectElement>("#tabs"),
		status = q(".status"),
		updates = q("#updates");
	let loaded: Saved | undefined,
		draft: Content | undefined,
		canEdit = false,
		busy = false,
		dirty = false,
		discard = false,
		slot = "",
		generation = 0,
		pendingRevision = 0,
		basis = 0,
		available = false,
		destroyed = false,
		workspaceId = "",
		// A newer saved revision that overlaps the draft, waiting for a choice.
		choice = 0;
	let selection: Selection = {
			anchor: { row: 0, column: 0 },
			focus: { row: 0, column: 0 },
		},
		dragging = false,
		editing: HTMLInputElement | undefined;
	let tabBounds: Bounds | undefined,
		formulaDirty = false,
		viewRows = 30,
		viewColumns = 8;
	let copied:
		| { data: CopiedCells; row: number; column: number; cut?: boolean }
		| undefined;
	const undo: Content[] = [],
		redo: Content[] = [];
	let retainedConflict: RetainedDraft | undefined;
	let draftQueue: Promise<unknown> = Promise.resolve(),
		draftWriteVersion = 0;
	const pendingDraftWrites = new Set<Promise<unknown>>();
	let calcTimer: ReturnType<typeof setTimeout> | undefined;
	const call = <T = Saved>(method: string, input: unknown = {}) =>
		bridge.call<T>("app.call", { method, args: [input] });
	// The host reads the bound Output directly; the app server is the fallback
	// for hosts that cannot (share links, older hosts).
	const readSheet = () =>
		bridge
			.call<Saved>("outputs.readRevision", { slot })
			.catch(() => call("readSheet"));
	const sheet = () =>
		draft!.workbook!.sheets.find(
			(s) => s.id === draft!.workbook!.activeSheetId,
		) ?? draft!.workbook!.sheets[0]!;
	const bounds = () => tabBounds ?? selectedBounds(selection);
	const dimensions = () => ({
		rows: Math.max(viewRows, sheet().rows.length),
		columns: Math.max(viewColumns, sheet().columns.length),
	});
	const message = (text: string, error = false) => {
		status.textContent = text;
		status.dataset.error = String(error);
	};
	const editable = () =>
		canEdit && available && !busy && !destroyed && !retainedConflict && !!draft;
	function controls() {
		q<HTMLButtonElement>("#save").disabled =
			!editable() || !(dirty || formulaDirty || editing);
		q<HTMLButtonElement>("#reload").disabled = busy;
		formula.disabled = !editable();
		root
			.querySelectorAll<
				HTMLButtonElement | HTMLSelectElement | HTMLInputElement
			>(
				".toolbar button,.toolbar input,.toolbar select,#add-sheet,#command-apply,#command-value",
			)
			.forEach((node) => (node.disabled = !editable()));
		q<HTMLButtonElement>("#undo").disabled = !editable() || !undo.length;
		q<HTMLButtonElement>("#redo").disabled = !editable() || !redo.length;
		tabs.disabled = busy || !available;
		q<HTMLButtonElement>("#export").disabled = busy || !available;
		q<HTMLButtonElement>("#xlsx").disabled = busy || !available;
		q<HTMLButtonElement>("#review-draft").disabled = busy || !available;
		q("#review-draft").hidden = !retainedConflict;
		grid.hidden = !available;
		table.setAttribute("aria-readonly", String(!canEdit));
	}
	const draftArgs = () => ({ slot, outputId: loaded!.output.id });
	function draftOperation<T = unknown>(method: string, args: unknown) {
		if (method === "app.draft.write") {
			draftWriteVersion++;
			const result = bridge.call<T>(method, args);
			pendingDraftWrites.add(result);
			void result
				.finally(() => pendingDraftWrites.delete(result))
				.catch(() => undefined);
			return result;
		}
		const version = draftWriteVersion;
		const result = draftQueue.then(async () => {
			await Promise.allSettled([...pendingDraftWrites]);
			if (method === "app.draft.clear" && version !== draftWriteVersion)
				return null;
			const result = await bridge.call<T>(method, args);
			if (method === "app.draft.clear" && version !== draftWriteVersion)
				void retainDraft();
			return result;
		});
		draftQueue = result.catch(() => undefined);
		return result;
	}

	function snapshotDraft() {
		const content = structuredClone(draft!);
		const input = editing?.value ?? (formulaDirty ? formula.value : undefined);
		if (input !== undefined) {
			const current = content.workbook!.sheets.find(
				(item) => item.id === content.workbook!.activeSheetId,
			)!;
			const { row, column } = selection.focus;
			while (current.columns.length <= column)
				current.columns.push({
					id: "column-" + crypto.randomUUID(),
					label: columnLabel(current.columns.length),
					width: 120,
				});
			while (current.rows.length <= row)
				current.rows.push(current.columns.map(() => null));
			for (const line of current.rows)
				while (line.length < current.columns.length) line.push(null);
			const previous = current.rows[row]![column];
			current.rows[row]![column] = { ...previous, input, value: null };
			content.columns = current.columns.map((item) => item.label);
			content.rows = current.rows.map((line) =>
				current.columns.map((_, index) => line[index]?.value ?? null),
			);
		}
		return content;
	}
	async function retainDraft() {
		if (
			!loaded ||
			!draft ||
			!available ||
			!canEdit ||
			busy ||
			destroyed ||
			retainedConflict ||
			!(dirty || formulaDirty || editing)
		)
			return;
		try {
			await draftOperation("app.draft.write", {
				...draftArgs(),
				revision: basis,
				content: snapshotDraft(),
			});
		} catch (error) {
			if (!destroyed && available)
				message(
					(error instanceof Error ? error.message : "Draft retention failed") +
						". Save before leaving this tab.",
					true,
				);
		}
	}
	function syncRetainedDraft() {
		if (!available || !loaded || !canEdit || retainedConflict) return;
		if (dirty || formulaDirty || editing) void retainDraft();
		else
			void draftOperation("app.draft.clear", draftArgs()).catch((error) => {
				if (available && !destroyed)
					message(
						(error instanceof Error ? error.message : "Draft cleanup failed") +
							". Reload to clear the retained draft.",
						true,
					);
			});
	}

	function parse(value: Saved) {
		if (
			value?.output?.workspaceId !== workspaceId ||
			value.output.kind !== "sheet" ||
			!value.output.id ||
			!Number.isInteger(value.revision?.revision) ||
			value.revision.revision < 1 ||
			value.revision.content?.kind !== "sheet"
		)
			throw new Error("The sheet response does not match this workspace");
		return value;
	}
	async function verifyAccess() {
		try {
			const current = parse(await readSheet());
			if (current.output.id !== loaded?.output.id)
				throw new Error("The sheet binding changed");
			pendingRevision = Math.max(pendingRevision, current.revision.revision);
			return true;
		} catch (error) {
			if (!destroyed) await unavailable(error);
			return false;
		}
	}

	async function unavailable(error: unknown) {
		generation++;
		available = false;
		clearTimeout(calcTimer);
		const args = loaded ? draftArgs() : undefined;
		editing = undefined;
		formulaDirty = false;
		dirty = false;
		draft = undefined;
		loaded = undefined;
		retainedConflict = undefined;
		copied = undefined;
		undo.length = redo.length = 0;
		table.replaceChildren();
		tabs.replaceChildren();
		q("#tab-buttons").replaceChildren();
		formula.value = "";
		namebox.value = "";
		q("h1").textContent = "Sheet";
		q(".stats").textContent = updates.textContent = "";
		q(".command").hidden = true;
		message(
			error instanceof Error ? error.message : "Sheet access is unavailable",
			true,
		);
		controls();
		if (args && canEdit)
			await draftOperation("app.draft.clear", args).catch(() => undefined);
	}

	function mark() {
		generation++;
		dirty = true;
		discard = false;
		q("#reload").textContent = "Reload";
		message("Unsaved changes");
		controls();
		void retainDraft();
	}
	function ensure(row: number, column: number) {
		const s = sheet();
		while (s.columns.length <= column)
			s.columns.push({
				id: "column-" + crypto.randomUUID(),
				label: columnLabel(s.columns.length),
				width: 120,
			});
		while (s.rows.length <= row) s.rows.push(s.columns.map(() => null));
		for (const line of s.rows)
			while (line.length < s.columns.length) line.push(null);
	}
	function edit(change: () => void) {
		if (!editable()) return;
		commitCell();
		commitFormula();
		undo.push(structuredClone(draft!));
		if (undo.length > 100) undo.shift();
		redo.length = 0;
		change();
		mark();
		render();
		scheduleCalculation();
	}
	function rangeWorkbook(change: (workbook: OsWorkbook) => OsWorkbook) {
		edit(() => {
			const b = bounds();
			ensure(b.rowEnd, b.columnEnd);
			draft!.workbook = change(draft!.workbook!);
		});
	}
	function workbook(change: (workbook: OsWorkbook) => OsWorkbook) {
		edit(() => {
			draft!.workbook = change(draft!.workbook!);
		});
	}
	async function calculate() {
		if (!draft) return;
		const version = generation,
			snapshot = structuredClone(draft);
		try {
			const content = await bridge.call<Content>("sheet.evaluate", {
				content: snapshot,
			});
			if (version !== generation || destroyed) return;
			draft = content;
			renderValues();
			selectionUI();
			void retainDraft();
		} catch (error) {
			message(error instanceof Error ? error.message : String(error), true);
		}
	}
	function scheduleCalculation() {
		clearTimeout(calcTimer);
		calcTimer = setTimeout(() => void calculate(), 30);
	}
	function put(
		row: number,
		column: number,
		input: string,
		format?: OsWorkbookCellFormat,
	) {
		ensure(row, column);
		const previous = sheet().rows[row]![column];
		sheet().rows[row]![column] = {
			input: input.slice(0, 8192),
			value: null,
			...(format
				? { format }
				: previous?.format
					? { format: previous.format }
					: {}),
		};
	}
	function clampSelection() {
		const d = dimensions();
		if (tabBounds)
			tabBounds = {
				rowStart: Math.min(tabBounds.rowStart, d.rows - 1),
				rowEnd: Math.min(tabBounds.rowEnd, d.rows - 1),
				columnStart: Math.min(tabBounds.columnStart, d.columns - 1),
				columnEnd: Math.min(tabBounds.columnEnd, d.columns - 1),
			};
		selection = {
			anchor: clampCoordinate(selection.anchor, d.rows, d.columns),
			focus: clampCoordinate(selection.focus, d.rows, d.columns),
		};
	}
	function selectionUI() {
		if (!draft) return;
		const selectedRange = bounds();
		table
			.querySelectorAll<HTMLTableCellElement>("td[data-row]")
			.forEach((cell) => {
				const row = Number(cell.dataset.row),
					column = Number(cell.dataset.column),
					active =
						row === selection.focus.row && column === selection.focus.column,
					selected = boundsContain(selectedRange, row, column);
				cell.classList.toggle("selected", selected);
				cell.classList.toggle("active", active);
				cell.setAttribute("aria-selected", String(selected));
			});
		namebox.value = tabBounds
			? rangeLabel({
					anchor: { row: tabBounds.rowStart, column: tabBounds.columnStart },
					focus: { row: tabBounds.rowEnd, column: tabBounds.columnEnd },
				})
			: rangeLabel(selection);
		if (!formulaDirty && !editing)
			formula.value =
				sheet().rows[selection.focus.row]?.[selection.focus.column]?.input ??
				"";
		const format =
			sheet().rows[selection.focus.row]?.[selection.focus.column]?.format ?? {};
		root
			.querySelectorAll<HTMLButtonElement>("[data-format]")
			.forEach((button) =>
				button.setAttribute(
					"aria-pressed",
					String(!!format[button.dataset.format as "bold"]),
				),
			);
		q<HTMLSelectElement>("#number-format").value =
			format.numberFormat ?? "automatic";
		q<HTMLInputElement>("#font-size").value = String(format.fontSize ?? 13);
		q<HTMLSelectElement>("#align").value = format.horizontalAlign ?? "left";
		q<HTMLInputElement>("#decimals").value = String(format.decimals ?? 2);
		const stats = selectionStats(sheet(), selectedRange);
		q(".stats").textContent =
			rangeLabel(selection) +
			" · " +
			stats.count +
			" filled" +
			(stats.numbers
				? " · Sum " + stats.sum + " · Average " + stats.average
				: "");
	}
	function choose(row: number, column: number, extend = false) {
		tabBounds = undefined;
		selection = {
			anchor: extend ? selection.anchor : { row, column },
			focus: { row, column },
		};
		clampSelection();
		selectionUI();
	}
	function renderValues() {
		if (!draft) return;
		table
			.querySelectorAll<HTMLOutputElement>("output[data-row]")
			.forEach((node) => {
				const cell =
					sheet().rows[Number(node.dataset.row)]?.[
						Number(node.dataset.column)
					] ?? null;
				node.textContent = formatWorkbookNumber(cell, draft!.workbook);
			});
	}
	function render() {
		if (!draft) return;
		clampSelection();
		renderTabs();
		renderGrid();
		controls();
	}
	function renderTabs() {
		tabs.replaceChildren();
		q("#tab-buttons").replaceChildren();
		for (const item of draft!.workbook!.sheets) {
			const option = document.createElement("option");
			option.value = item.id;
			option.textContent = item.name;
			option.selected = item.id === sheet().id;
			tabs.append(option);
			const button = document.createElement("button");
			button.textContent = item.name;
			button.setAttribute("aria-pressed", String(option.selected));
			button.onclick = () => switchTab(item.id);
			q("#tab-buttons").append(button);
		}
	}
	function renderGrid() {
		if (!draft) return;
		const s = sheet(),
			d = dimensions();
		const offsets = [0];
		for (let row = 0; row < d.rows; row++)
			offsets.push(offsets[row]! + (s.rowHeights?.[row] ?? 28));
		const scroll = Math.max(0, grid.scrollTop - 32);
		let start = 0;
		while (start < d.rows - 1 && offsets[start + 1]! < scroll) start++;
		start = Math.max(s.frozenRows, start - 3);
		let end = start;
		while (
			end < d.rows &&
			offsets[end]! < scroll + (grid.clientHeight || 420) + 160
		)
			end++;
		end = Math.min(d.rows, Math.max(end, Math.min(d.rows, start + 20)));
		const rows = [
			...Array.from({ length: Math.min(s.frozenRows, d.rows) }, (_, i) => i),
			...Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i),
		].filter((v, i, a) => a.indexOf(v) === i);
		table.replaceChildren();
		table.setAttribute("aria-rowcount", String(d.rows));
		table.setAttribute("aria-colcount", String(d.columns));
		const cols = document.createElement("colgroup");
		const first = document.createElement("col");
		first.style.width = "44px";
		cols.append(first);
		for (let col = 0; col < d.columns; col++) {
			const item = document.createElement("col");
			item.style.width = (s.columns[col]?.width ?? 120) + "px";
			cols.append(item);
		}
		table.append(cols);
		const head = document.createElement("thead"),
			tr = document.createElement("tr"),
			corner = document.createElement("th");
		corner.className = "index";
		corner.textContent = "▦";
		corner.onclick = () => {
			tabBounds = undefined;
			selection = {
				anchor: { row: 0, column: 0 },
				focus: { row: d.rows - 1, column: d.columns - 1 },
			};
			selectionUI();
			grid.focus();
		};
		tr.append(corner);
		for (let col = 0; col < d.columns; col++) {
			const th = document.createElement("th");
			// "A" alone when the column has no name of its own; "A · Amount" otherwise.
			const letter = columnLabel(col);
			const name = s.columns[col]?.label ?? letter;
			th.textContent = name === letter ? letter : letter + " · " + name;
			if (col < s.frozenColumns) {
				th.style.left =
					44 +
					s.columns
						.slice(0, col)
						.reduce((sum, column) => sum + column.width, 0) +
					"px";
				th.style.zIndex = "7";
			}
			th.title = "Select column; double-click to rename";
			th.onclick = (event) => {
				tabBounds = undefined;
				selection = {
					anchor: event.shiftKey ? selection.anchor : { row: 0, column: col },
					focus: { row: d.rows - 1, column: col },
				};
				selectionUI();
				grid.focus();
			};
			th.ondblclick = () =>
				command(
					"Column title",
					s.columns[col]?.label ?? columnLabel(col),
					(value) =>
						edit(() => {
							ensure(0, col);
							sheet().columns[col]!.label =
								value.trim().slice(0, 200) || columnLabel(col);
						}),
				);
			const handle = document.createElement("span");
			handle.className = "resize";
			handle.setAttribute("aria-label", "Resize column " + columnLabel(col));
			handle.onpointerdown = (event) => {
				if (!editable()) return;
				event.stopPropagation();
				event.preventDefault();
				const x = event.clientX,
					width = s.columns[col]?.width ?? 120;
				handle.setPointerCapture?.(event.pointerId);
				handle.onpointerup = (finish) => {
					handle.onpointerup = null;
					workbook((w) => {
						ensure(0, col);
						return resizeColumn(w, s.id, col, width + finish.clientX - x);
					});
				};
			};
			th.append(handle);
			tr.append(th);
		}
		head.append(tr);
		table.append(head);
		const body = document.createElement("tbody");
		const spacer = (height: number) => {
			if (height <= 0) return;
			const row = document.createElement("tr"),
				td = document.createElement("td");
			td.colSpan = d.columns + 1;
			td.style.height = height + "px";
			td.style.border = "0";
			row.setAttribute("aria-hidden", "true");
			row.append(td);
			body.append(row);
		};
		let last = -1;
		for (const row of rows) {
			spacer(offsets[row]! - offsets[last + 1]!);
			const tr = document.createElement("tr");
			tr.style.height = (s.rowHeights?.[row] ?? 28) + "px";
			tr.setAttribute("aria-rowindex", String(row + 1));
			const index = document.createElement("th");
			index.className = "index";
			index.textContent = String(row + 1);
			if (row < s.frozenRows) {
				index.style.top = 32 + offsets[row]! + "px";
				index.style.zIndex = "5";
			}
			index.onclick = (event) => {
				tabBounds = undefined;
				selection = {
					anchor: event.shiftKey ? selection.anchor : { row, column: 0 },
					focus: { row, column: d.columns - 1 },
				};
				selectionUI();
				grid.focus();
			};
			tr.append(index);
			for (let col = 0; col < d.columns; col++) {
				const td = document.createElement("td"),
					output = document.createElement("output"),
					cell = s.rows[row]?.[col];
				td.dataset.row = String(row);
				td.dataset.column = String(col);
				td.setAttribute("role", "gridcell");
				td.setAttribute("aria-label", cellLabel({ row, column: col }));
				output.dataset.row = String(row);
				output.dataset.column = String(col);
				output.textContent = formatWorkbookNumber(
					cell ?? null,
					draft!.workbook,
				);
				const f = cell?.format;
				if (f) {
					td.style.fontWeight = f.bold ? "bold" : "normal";
					td.style.fontStyle = f.italic ? "italic" : "normal";
					td.style.textDecoration = [
						f.underline ? "underline" : "",
						f.strike ? "line-through" : "",
					].join(" ");
					td.style.fontSize = (f.fontSize ?? 13) + "px";
					td.style.color = f.textColor ?? "";
					td.style.backgroundColor = f.fillColor ?? "";
					td.style.textAlign =
						f.horizontalAlign ??
						(typeof cell.value === "number" ? "right" : "left");
					output.style.whiteSpace = f.wrap ? "pre-wrap" : "nowrap";
				}
				const frozen = frozenCellStyle(s, row, col);
				if (frozen.position) {
					td.style.position = frozen.position;
					if (frozen.top !== undefined) td.style.top = frozen.top + "px";
					if (frozen.left !== undefined) td.style.left = frozen.left + "px";
					td.style.zIndex = String(frozen.zIndex);
				}
				td.onmousedown = (event) => {
					if (event.button !== 0 || editing === event.target) return;
					commitCell();
					event.preventDefault();
					dragging = true;
					choose(row, col, event.shiftKey);
					grid.focus();
				};
				td.onmouseenter = () => {
					if (dragging) {
						selection.focus = { row, column: col };
						selectionUI();
					}
				};
				td.ondblclick = () => startEdit();
				td.append(output);
				tr.append(td);
			}
			body.append(tr);
			last = row;
		}
		spacer(offsets[d.rows]! - offsets[last + 1]!);
		table.append(body);
		selectionUI();
	}
	function reveal() {
		const s = sheet(),
			point = selection.focus;
		let top = 0;
		for (let i = 0; i < point.row; i++) top += s.rowHeights?.[i] ?? 28;
		const height = grid.clientHeight || 420;
		if (top < grid.scrollTop) grid.scrollTop = top;
		if (top + 60 > grid.scrollTop + height) grid.scrollTop = top - height + 60;
		let left = 44;
		for (let i = 0; i < point.column; i++) left += s.columns[i]?.width ?? 120;
		const width = s.columns[point.column]?.width ?? 120;
		if (left < grid.scrollLeft + 44) grid.scrollLeft = Math.max(0, left - 44);
		if (left + width > grid.scrollLeft + (grid.clientWidth || 700))
			grid.scrollLeft = left + width - (grid.clientWidth || 700);
		renderGrid();
	}
	function startEdit(initial?: string) {
		if (!editable()) return;
		const point = selection.focus;
		reveal();
		const cell = table.querySelector<HTMLElement>(
			`td[data-row="${point.row}"][data-column="${point.column}"]`,
		);
		if (!cell) return;
		const input = document.createElement("input");
		input.className = "cell-edit";
		input.setAttribute("aria-label", "Edit " + cellLabel(point));
		input.value =
			initial ?? sheet().rows[point.row]?.[point.column]?.input ?? "";
		input.maxLength = 8192;
		editing = input;
		cell.append(input);
		input.oninput = () => {
			formula.value = input.value;
			void retainDraft();
			message("Unsaved changes");
			controls();
		};
		input.onkeydown = (event) => {
			if (event.isComposing) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				editing = undefined;
				input.remove();
				selectionUI();
				controls();
				grid.focus();
				syncRetainedDraft();
				external();
			} else if (
				(event.ctrlKey || event.metaKey) &&
				event.key.toLowerCase() === "s"
			) {
				event.preventDefault();
				event.stopPropagation();
				void save();
			} else if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				event.stopPropagation();
				commitCell();
				advance(
					event.key === "Tab" ? "horizontal" : "vertical",
					event.shiftKey ? -1 : 1,
				);
			}
		};
		input.onblur = () => commitCell();
		input.focus();
		controls();
		if (initial !== undefined) void retainDraft();
		if (initial === undefined) input.select();
	}
	function commitCell() {
		if (!editing) return;
		const input = editing,
			value = input.value,
			point = { ...selection.focus };
		editing = undefined;
		input.remove();
		if (value !== (sheet().rows[point.row]?.[point.column]?.input ?? ""))
			edit(() => put(point.row, point.column, value));
		else syncRetainedDraft();
	}
	function advance(axis: "horizontal" | "vertical", direction: 1 | -1) {
		const b = bounds();
		if (b.rowStart !== b.rowEnd || b.columnStart !== b.columnEnd) {
			tabBounds = b;
			let { row, column } = selection.focus;
			if (axis === "horizontal") {
				column += direction;
				if (column > b.columnEnd) {
					column = b.columnStart;
					row = row + 1 > b.rowEnd ? b.rowStart : row + 1;
				} else if (column < b.columnStart) {
					column = b.columnEnd;
					row = row - 1 < b.rowStart ? b.rowEnd : row - 1;
				}
			} else {
				row += direction;
				if (row > b.rowEnd) {
					row = b.rowStart;
					column = column + 1 > b.columnEnd ? b.columnStart : column + 1;
				} else if (row < b.rowStart) {
					row = b.rowEnd;
					column = column - 1 < b.columnStart ? b.columnEnd : column - 1;
				}
			}
			selection.focus = { row, column };
		} else {
			const p = selection.focus;
			choose(
				p.row + (axis === "vertical" ? direction : 0),
				p.column + (axis === "horizontal" ? direction : 0),
			);
			selection.anchor = { ...selection.focus };
		}
		selectionUI();
		reveal();
		grid.focus();
	}
	function format(patch: Partial<OsWorkbookCellFormat> | null) {
		commitCell();
		const b = bounds();
		edit(() => {
			ensure(b.rowEnd, b.columnEnd);
			for (let row = b.rowStart; row <= b.rowEnd; row++)
				for (let col = b.columnStart; col <= b.columnEnd; col++) {
					const cell = sheet().rows[row]![col] ?? { input: "", value: null };
					sheet().rows[row]![col] = {
						...cell,
						...(patch
							? { format: { ...cell.format, ...patch } }
							: { format: undefined }),
					};
				}
		});
	}
	function clear() {
		commitCell();
		const b = bounds();
		edit(() => {
			for (let row = b.rowStart; row <= b.rowEnd; row++)
				for (let col = b.columnStart; col <= b.columnEnd; col++)
					if (sheet().rows[row]?.[col]) put(row, col, "");
		});
	}
	function history(from: Content[], to: Content[]) {
		if (!editable()) return;
		commitCell();
		commitFormula();
		if (!from.length) return;
		to.push(structuredClone(draft!));
		draft = from.pop()!;
		mark();
		render();
		scheduleCalculation();
	}
	function switchTab(id: string) {
		if (busy || !draft || !available || destroyed) return;
		commitCell();
		commitFormula();
		tabBounds = undefined;
		draft.workbook!.activeSheetId = id;
		selection = { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } };
		grid.scrollTop = grid.scrollLeft = 0;
		render();
		void retainDraft();
	}
	function command(
		label: string,
		value: string,
		apply: (value: string) => void,
	) {
		if (!editable()) return;
		const panel = q(".command"),
			input = q<HTMLInputElement>("#command-value");
		panel.hidden = false;
		q("#command-label").textContent = label;
		input.value = value;
		const finish = () => {
			apply(input.value);
			panel.hidden = true;
			grid.focus();
		};
		q("#command-apply").onclick = finish;
		input.onkeydown = (event) => {
			if (event.key === "Enter") finish();
			if (event.key === "Escape") panel.hidden = true;
		};
		input.focus();
		input.select();
	}
	q("#command-cancel").onclick = () => {
		q(".command").hidden = true;
		grid.focus();
	};
	function structure(action: string) {
		commitCell();
		if (!editable()) return;
		const s = sheet(),
			b = bounds(),
			id = s.id,
			countRows = b.rowEnd - b.rowStart + 1,
			countCols = b.columnEnd - b.columnStart + 1;
		const apply = (change: (w: OsWorkbook) => OsWorkbook) => workbook(change);
		switch (action) {
			case "add-sheet":
				if (draft!.workbook!.sheets.length >= 32) {
					message("A workbook supports up to 32 sheets.", true);
					return;
				}
				command(
					"New sheet name",
					"Sheet " + (draft!.workbook!.sheets.length + 1),
					(name) => {
						const value = name.trim().slice(0, 120);
						if (
							!value ||
							draft!.workbook!.sheets.some(
								(item) => item.name.toLowerCase() === value.toLowerCase(),
							)
						) {
							message("Use a unique sheet name.", true);
							return;
						}
						edit(() => {
							const next = {
								id: "sheet-" + crypto.randomUUID(),
								name: value,
								columns: [
									{
										id: "column-" + crypto.randomUUID(),
										label: "A",
										width: 120,
									},
								],
								rows: [],
								frozenRows: 0,
								frozenColumns: 0,
							};
							draft!.workbook!.sheets.push(next);
							draft!.workbook!.activeSheetId = next.id;
							selection = {
								anchor: { row: 0, column: 0 },
								focus: { row: 0, column: 0 },
							};
						});
					},
				);
				break;
			case "rename-sheet":
				command("Sheet name", s.name, (value) =>
					apply((w) => renameSheet(w, id, value)),
				);
				break;
			case "duplicate-sheet":
				apply((w) => duplicateSheet(w, id));
				break;
			case "delete-sheet":
				if (draft!.workbook!.sheets.length === 1) {
					message("Keep at least one sheet.", true);
					return;
				}
				command('Type "delete" to delete ' + s.name, "", (value) => {
					if (value === "delete") apply((w) => deleteSheet(w, id));
				});
				break;
			case "move-left":
			case "move-right": {
				const index = draft!.workbook!.sheets.findIndex(
					(item) => item.id === id,
				);
				apply((w) =>
					moveSheet(w, index, index + (action === "move-left" ? -1 : 1)),
				);
				break;
			}
			case "insert-row":
				if (s.rows.length + countRows > 1000) {
					message("Sheets support up to 1000 rows.", true);
					return;
				}
				apply((w) =>
					insertRows(w, id, Math.min(b.rowStart, s.rows.length), countRows),
				);
				break;
			case "delete-row":
				apply((w) => deleteRows(w, id, b.rowStart, countRows));
				break;
			case "insert-column":
				if (s.columns.length + countCols > 64) {
					message("Sheets support up to 64 columns.", true);
					return;
				}
				apply((w) =>
					insertColumns(
						w,
						id,
						Math.min(b.columnStart, s.columns.length),
						countCols,
					),
				);
				break;
			case "delete-column":
				if (countCols >= s.columns.length) {
					message("Keep at least one column.", true);
					return;
				}
				apply((w) => deleteColumns(w, id, b.columnStart, countCols));
				break;
			case "rename-column":
				command(
					"Column title",
					s.columns[b.columnStart]?.label ?? columnLabel(b.columnStart),
					(value) =>
						edit(() => {
							ensure(0, b.columnStart);
							sheet().columns[b.columnStart]!.label =
								value.trim().slice(0, 200) || columnLabel(b.columnStart);
						}),
				);
				break;
			case "row-height":
			case "column-width":
				command(
					action === "row-height"
						? "Row height (20–600 px)"
						: "Column width (48–600 px)",
					String(
						action === "row-height"
							? (s.rowHeights?.[b.rowStart] ?? 28)
							: (s.columns[b.columnStart]?.width ?? 120),
					),
					(value) => {
						const size = Number(value);
						if (!Number.isFinite(size)) return;
						apply((w) => {
							ensure(b.rowEnd, b.columnEnd);
							return action === "row-height"
								? resizeRow(w, id, b.rowStart, size)
								: resizeColumn(w, id, b.columnStart, size);
						});
					},
				);
				break;
			case "freeze":
				apply((w) => freezePanes(w, id, b.rowStart, b.columnStart));
				break;
			case "unfreeze":
				apply((w) => freezePanes(w, id, 0, 0));
				break;
		}
	}
	function paste(text: string) {
		if (!editable()) return;
		commitCell();
		const cells = parseClipboardTable(text),
			origin = selection.focus,
			internal = copied?.data.tsv === text ? copied : undefined;
		const width = Math.max(...cells.map((row) => row.length));
		if (origin.row + cells.length > 1000 || origin.column + width > 64) {
			message("Paste exceeds the 1000 row × 64 column sheet limit.", true);
			return;
		}
		if (cells.some((row) => row.some((value) => value.length > 8192))) {
			message("A pasted cell exceeds 8192 characters.", true);
			return;
		}
		edit(() => {
			for (let row = 0; row < cells.length; row++)
				for (let col = 0; col < cells[row]!.length; col++) {
					const source = internal?.data.cells[row]?.[col];
					put(
						origin.row + row,
						origin.column + col,
						source
							? internal?.cut
								? source.input
								: offsetFormula(
										source.input,
										origin.row - internal!.row,
										origin.column - internal!.column,
									)
							: cells[row]![col]!,
						source?.format,
					);
					if (source && !source.format)
						delete sheet().rows[origin.row + row]![origin.column + col]!.format;
				}
			selection = {
				anchor: { ...origin },
				focus: {
					row: origin.row + cells.length - 1,
					column: origin.column + width - 1,
				},
			};
		});
	}
	grid.addEventListener("copy", (event) => {
		if (editing || !draft) return;
		const data = copyBounds(sheet(), bounds());
		const b = bounds();
		copied = { data, row: b.rowStart, column: b.columnStart };
		event.clipboardData?.setData("text/plain", data.tsv);
		event.preventDefault();
	});
	grid.addEventListener("cut", (event) => {
		if (editing || !editable()) return;
		const data = copyBounds(sheet(), bounds()),
			b = bounds();
		copied = { data, row: b.rowStart, column: b.columnStart, cut: true };
		event.clipboardData?.setData("text/plain", data.tsv);
		event.preventDefault();
		clear();
	});
	grid.addEventListener("paste", (event) => {
		if (editing) return;
		event.preventDefault();
		paste(event.clipboardData?.getData("text/plain") ?? "");
	});
	const arrows: Record<string, { row: number; column: number }> = {
		ArrowUp: { row: -1, column: 0 },
		ArrowDown: { row: 1, column: 0 },
		ArrowLeft: { row: 0, column: -1 },
		ArrowRight: { row: 0, column: 1 },
	};
	grid.onkeydown = (event) => {
		if (event.isComposing || editing || !draft || busy || !available) return;
		const mod = event.ctrlKey || event.metaKey,
			key = event.key.toLowerCase();
		if (mod && ["s", "z", "y", "a", "b", "i", "u", "d", "r"].includes(key)) {
			event.preventDefault();
			if (key === "s") void save();
			else if (key === "z")
				history(event.shiftKey ? redo : undo, event.shiftKey ? undo : redo);
			else if (key === "y") history(redo, undo);
			else if (key === "a") {
				const d = dimensions();
				selection = {
					anchor: { row: 0, column: 0 },
					focus: { row: d.rows - 1, column: d.columns - 1 },
				};
				selectionUI();
			} else if (["b", "i", "u"].includes(key)) {
				const name =
					key === "b" ? "bold" : key === "i" ? "italic" : "underline";
				format({
					[name]:
						!sheet().rows[selection.focus.row]?.[selection.focus.column]
							?.format?.[name],
				});
			} else
				workbook((w) =>
					fillRange(w, sheet().id, bounds(), key === "d" ? "down" : "right"),
				);
			return;
		}
		const delta = arrows[event.key];
		if (delta) {
			event.preventDefault();
			const point = mod
				? jumpToDataEdge(sheet(), selection.focus, delta)
				: {
						row: selection.focus.row + delta.row,
						column: selection.focus.column + delta.column,
					};
			choose(point.row, point.column, event.shiftKey);
			reveal();
		} else if (event.key === "Tab" || event.key === "Enter") {
			event.preventDefault();
			advance(
				event.key === "Tab" ? "horizontal" : "vertical",
				event.shiftKey ? -1 : 1,
			);
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			choose(
				mod
					? event.key === "Home"
						? 0
						: dimensions().rows - 1
					: selection.focus.row,
				event.key === "Home" ? 0 : dimensions().columns - 1,
				event.shiftKey,
			);
			reveal();
		} else if (event.key === "PageDown" || event.key === "PageUp") {
			event.preventDefault();
			choose(
				selection.focus.row + (event.key === "PageDown" ? 20 : -20),
				selection.focus.column,
				event.shiftKey,
			);
			reveal();
		} else if (event.key === "F2") {
			event.preventDefault();
			startEdit();
		} else if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault();
			clear();
		} else if (event.key.length === 1 && !mod && !event.altKey) {
			event.preventDefault();
			startEdit(event.key);
		}
	};
	function commitFormula() {
		if (!formulaDirty || !editable()) return;
		const p = selection.focus,
			value = formula.value;
		formulaDirty = false;
		edit(() => put(p.row, p.column, value));
	}
	formula.maxLength = 8192;
	formula.oninput = () => {
		if (!editable()) return;
		formulaDirty = true;
		void retainDraft();
		discard = false;
		message("Unsaved changes");
		controls();
	};
	formula.onkeydown = (event) => {
		if (event.isComposing) return;
		if (event.key === "Enter") {
			event.preventDefault();
			commitFormula();
			grid.focus();
		} else if (event.key === "Escape") {
			event.preventDefault();
			formulaDirty = false;
			formula.value =
				sheet().rows[selection.focus.row]?.[selection.focus.column]?.input ??
				"";
			formula.blur();
			selectionUI();
			controls();
			grid.focus();
			syncRetainedDraft();
			external();
		} else if (
			(event.ctrlKey || event.metaKey) &&
			event.key.toLowerCase() === "s"
		) {
			event.preventDefault();
			commitFormula();
			void save();
		}
	};
	root.addEventListener("keydown", (event) => {
		if (
			!event.defaultPrevented &&
			(event.ctrlKey || event.metaKey) &&
			event.key.toLowerCase() === "s"
		) {
			event.preventDefault();
			void save();
		}
	});

	formula.onchange = commitFormula;
	namebox.onkeydown = (event) => {
		if (event.key !== "Enter" || !draft) return;
		const d = dimensions(),
			next = parseRangeLabel(namebox.value, 1000, 64);
		if (next) {
			tabBounds = undefined;
			selection = next;
			selection.anchor = clampCoordinate(next.anchor, 1000, 64);
			selection.focus = clampCoordinate(next.focus, 1000, 64);
			if (
				selection.focus.row >= d.rows ||
				selection.anchor.row >= d.rows ||
				selection.focus.column >= d.columns ||
				selection.anchor.column >= d.columns
			) {
				viewRows = Math.max(
					d.rows,
					selection.focus.row + 1,
					selection.anchor.row + 1,
				);
				viewColumns = Math.max(
					d.columns,
					selection.focus.column + 1,
					selection.anchor.column + 1,
				);
			}
			selectionUI();
			reveal();
			grid.focus();
		} else message("Enter a cell or range such as A1:C5.", true);
	};
	root.querySelectorAll<HTMLButtonElement>("[data-format]").forEach(
		(button) =>
			(button.onclick = () => {
				const key = button.dataset.format as
					| "bold"
					| "italic"
					| "underline"
					| "strike"
					| "wrap";
				format({
					[key]:
						!sheet().rows[selection.focus.row]?.[selection.focus.column]
							?.format?.[key],
				});
			}),
	);
	q<HTMLInputElement>("#font-size").onchange = (event) =>
		format({
			fontSize: Math.max(
				6,
				Math.min(
					96,
					Math.round(Number((event.target as HTMLInputElement).value) || 13),
				),
			),
		});
	q<HTMLInputElement>("#text-color").onchange = (event) =>
		format({ textColor: (event.target as HTMLInputElement).value });
	q<HTMLInputElement>("#fill-color").onchange = (event) =>
		format({ fillColor: (event.target as HTMLInputElement).value });
	q<HTMLSelectElement>("#align").onchange = (event) =>
		format({
			horizontalAlign: (event.target as HTMLSelectElement).value as
				| "left"
				| "right"
				| "center",
		});
	q<HTMLSelectElement>("#number-format").onchange = (event) =>
		format({
			numberFormat: (event.target as HTMLSelectElement)
				.value as OsWorkbookCellFormat["numberFormat"],
		});
	q<HTMLInputElement>("#decimals").onchange = (event) =>
		format({
			decimals: Math.max(
				0,
				Math.min(
					15,
					Math.round(Number((event.target as HTMLInputElement).value) || 0),
				),
			),
		});
	q("#clear-format").onclick = () => format(null);
	q("#undo").onclick = () => history(undo, redo);
	q("#redo").onclick = () => history(redo, undo);
	q("#clear").onclick = clear;
	q("#add-row").onclick = () => {
		if (!editable()) return;
		if (sheet().rows.length >= 1000) {
			message("Sheets support up to 1000 rows.", true);
			return;
		}
		workbook((w) => insertRows(w, sheet().id, sheet().rows.length, 1));
	};
	q("#add-column").onclick = () => {
		if (!editable()) return;
		if (sheet().columns.length >= 64) {
			message("Sheets support up to 64 columns.", true);
			return;
		}
		workbook((w) => insertColumns(w, sheet().id, sheet().columns.length, 1));
	};
	q("#add-sheet").onclick = () => structure("add-sheet");
	q<HTMLSelectElement>("#structure").onchange = (event) => {
		const select = event.target as HTMLSelectElement;
		structure(select.value);
		select.value = "";
	};
	tabs.onchange = () => switchTab(tabs.value);
	q("#sum").onclick = () => workbook((w) => autoSum(w, sheet().id, bounds()));
	q("#fill-down").onclick = () =>
		rangeWorkbook((w) => fillRange(w, sheet().id, bounds(), "down"));
	q("#fill-right").onclick = () =>
		rangeWorkbook((w) => fillRange(w, sheet().id, bounds(), "right"));
	for (const [id, direction] of [
		["#sort-asc", "ascending"],
		["#sort-desc", "descending"],
	] as const)
		q(id).onclick = () =>
			workbook((w) =>
				sortRange(w, sheet().id, bounds(), selection.focus.column, direction),
			);
	function external() {
		if (!loaded || busy || !available || destroyed) return;
		if (retainedConflict) {
			updates.textContent =
				"A retained draft is based on revision " +
				retainedConflict.revision +
				", but the saved sheet is revision " +
				loaded.revision.revision +
				". Review it at its original revision, or Reload twice to discard it. No draft has been rebased.";
			controls();
			return;
		}
		if (dirty && choice > basis) {
			showMergeChoice(updates, choice, (prefer) => void mergeLatest(prefer));
			return;
		}
		const current = Math.max(pendingRevision, loaded.revision.revision);
		if (current <= basis) {
			pendingRevision = 0;
			updates.textContent = "";
			return;
		}
		updates.textContent =
			"Revision " +
			current +
			" is available." +
			(dirty || formulaDirty || editing
				? " Your unsaved edits are preserved and merge with it once you finish editing the cell."
				: " Loading the saved sheet…");
		if (dirty || formulaDirty || editing) {
			if (!formulaDirty && !editing && current > choice) void mergeLatest();
			return;
		}
		pendingRevision = 0;
		void load();
	}
	/**
	 * Bring someone else's newer save into the unsaved sheet. Only a draft
	 * started from the revision this editor loaded can merge here; an older
	 * retained draft merges on the server when it is saved.
	 */
	async function mergeLatest(prefer?: OutputMergePreference) {
		if (
			!loaded ||
			!draft ||
			!dirty ||
			formulaDirty ||
			editing ||
			busy ||
			destroyed ||
			retainedConflict ||
			basis !== loaded.revision.revision
		)
			return;
		busy = true;
		clearTimeout(calcTimer);
		generation++;
		controls();
		try {
			const latest = parse(await readSheet());
			if (destroyed) return;
			// Never retry in a loop: the next change notice or save tries again.
			pendingRevision = 0;
			if (latest.revision.revision <= basis) return;
			const evaluate = (content: Content) =>
				bridge.call<Content>("sheet.evaluate", { content });
			const [base, theirs] = await Promise.all([
				evaluate(loaded.revision.content),
				evaluate(latest.revision.content),
			]);
			const result = mergeOutputContent(base, draft, theirs, { prefer });
			if (!result.ok) {
				choice = latest.revision.revision;
				return;
			}
			const merged = await evaluate(result.content as Content);
			if (destroyed) return;
			choice = 0;
			loaded = latest;
			basis = latest.revision.revision;
			draft = merged;
			// Undo steps were taken against the old sheet; replaying them would
			// silently revert the other person's changes.
			undo.length = redo.length = 0;
			render();
			message(
				`Unsaved changes · merged with revision ${basis}${prefer ? `; kept ${prefer === "mine" ? "your" : "their"} version where you both edited` : ""}`,
			);
			void retainDraft();
		} catch (error) {
			pendingRevision = 0;
			message(
				(error instanceof Error ? error.message : String(error)) +
					". Your draft is still here.",
				true,
			);
		} finally {
			busy = false;
			controls();
			external();
		}
	}
	async function load(discardDraft = false) {
		busy = true;
		generation++;
		controls();
		message("Loading sheet…");
		try {
			const result = parse(await readSheet());
			if (destroyed) return;
			loaded = result;
			choice = 0;
			let retained: RetainedDraft | null = null;
			if (canEdit) {
				if (discardDraft) await draftOperation("app.draft.clear", draftArgs());
				else
					retained = await draftOperation<RetainedDraft | null>(
						"app.draft.read",
						draftArgs(),
					);
			}
			if (destroyed) return;
			if (
				retained &&
				(retained.content?.kind !== "sheet" ||
					!Number.isInteger(retained.revision) ||
					retained.revision < 1)
			)
				throw new Error("The retained sheet draft is invalid");
			retainedConflict =
				retained && retained.revision !== result.revision.revision
					? retained
					: undefined;
			const matching = retained && !retainedConflict ? retained : null;
			const content = await bridge.call<Content>("sheet.evaluate", {
				content: matching?.content ?? result.revision.content,
			});
			if (destroyed) return;
			draft = content;
			basis = result.revision.revision;
			available = true;
			dirty = !!matching;
			formulaDirty = false;
			discard = false;
			undo.length = redo.length = 0;
			q("#reload").textContent = "Reload";
			q("h1").textContent = result.output.title;
			render();
			message(
				dirty
					? "Restored your unsaved changes"
					: "Saved" + (canEdit ? "" : " · Read only"),
			);
		} catch (error) {
			if (!destroyed) await unavailable(error);
		} finally {
			busy = false;
			controls();
			external();
		}
	}
	q("#review-draft").onclick = async () => {
		if (!retainedConflict || busy || !available) return;
		const retained = retainedConflict,
			outputId = loaded!.output.id;
		busy = true;
		controls();
		try {
			const result = parse(await readSheet());
			if (result.output.id !== outputId)
				throw new Error("The sheet binding changed");
			const content = await bridge.call<Content>("sheet.evaluate", {
				content: retained.content,
			});
			if (destroyed) return;
			loaded = result;
			draft = content;
			basis = retained.revision;
			retainedConflict = undefined;
			dirty = true;
			generation++;
			render();
			message(
				"Reviewing retained draft · Save still checks original revision " +
					basis,
			);
		} catch (error) {
			if (!destroyed) await unavailable(error);
		} finally {
			busy = false;
			controls();
			external();
		}
	};

	async function save() {
		commitCell();
		commitFormula();
		if (!editable() || !(dirty || formulaDirty)) return;
		busy = true;
		controls();
		clearTimeout(calcTimer);
		generation++;
		message("Saving…");
		try {
			const content = await bridge.call<Content>("sheet.evaluate", {
				content: structuredClone(draft),
			});
			const result = await bridge.call<Saved>("outputs.replace", {
				slot,
				content,
				expectedRevision: basis,
			});
			parse(result);
			if (destroyed) return;
			loaded = result;
			basis = result.revision.revision;
			draft = result.revision.content;
			dirty = false;
			let cleanupError: unknown;
			try {
				await draftOperation("app.draft.clear", draftArgs());
			} catch (error) {
				cleanupError = error;
			}
			discard = false;
			q("#reload").textContent = "Reload";
			render();
			message(
				"Saved" +
					(cleanupError
						? ". The retained draft could not be cleared; Reload before upgrading."
						: ""),
				!!cleanupError,
			);
		} catch (error) {
			if (destroyed || !(await verifyAccess())) return;
			message(
				(error instanceof Error ? error.message : String(error)) +
					". Your draft is still here. Reload only when ready to discard it.",
				true,
			);
		} finally {
			busy = false;
			controls();
			external();
		}
	}
	q("#save").onclick = () => void save();
	q("#reload").onclick = () => {
		if (busy) return;
		commitCell();
		commitFormula();
		if ((dirty || retainedConflict) && !discard) {
			discard = true;
			q("#reload").textContent = "Discard draft & reload";
			message("Click Reload again to discard unsaved changes.", true);
			return;
		}
		void load(true);
	};
	q("#export").onclick = async () => {
		if (!available || busy) return;
		try {
			const result = await call<{
				title: string;
				revision: number;
				mimeType: string;
				text: string;
			}>("exportCsv");
			await bridge.call("app.download", {
				filename:
					(result.title || "Sheet").replace(/[\\/:*?"<>|]/g, "_") + ".csv",
				mimeType: result.mimeType,
				text: result.text,
			});
			message(
				"Exported saved revision " +
					result.revision +
					(dirty ? " · unsaved changes are not included." : ""),
			);
		} catch (error) {
			if (destroyed || !(await verifyAccess())) return;
			message(error instanceof Error ? error.message : String(error), true);
		}
	};
	q("#xlsx").onclick = async () => {
		if (!loaded || !available || busy) return;
		try {
			await bridge.call("app.exportOutput", {
				slot,
				format: "xlsx",
				expectedRevision: loaded.revision.revision,
			});
			message(
				"Exported saved revision " +
					loaded.revision.revision +
					(dirty ? " · unsaved changes are not included." : ""),
			);
		} catch (error) {
			if (destroyed || !(await verifyAccess())) return;
			message(error instanceof Error ? error.message : String(error), true);
		}
	};
	const mouseup = () => {
		dragging = false;
	};
	document.addEventListener("mouseup", mouseup);
	grid.onscroll = () => {
		if (!editing && draft) renderGrid();
	};
	const onMessage = (event: MessageEvent) => {
		if (
			event.source !== window.parent ||
			event.data?.jsonrpc !== "2.0" ||
			event.data.method !== "tedix/outputs-changed" ||
			!Array.isArray(event.data.params?.outputs)
		)
			return;
		for (const output of event.data.params.outputs)
			if (
				output.slot === slot &&
				(!loaded || output.outputId === loaded.output.id) &&
				Number.isInteger(output.revision) &&
				output.revision > 0
			)
				pendingRevision = Math.max(pendingRevision, output.revision);
		external();
	};
	window.addEventListener("message", onMessage);
	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (dirty || formulaDirty || editing) {
			void retainDraft();
			event.preventDefault();
			event.returnValue = "";
		}
	};
	window.addEventListener("beforeunload", beforeUnload);
	try {
		const context = await bridge.call<{
			role: string;
			workspaceId: string;
			grants: { slot: string; operations: string[] }[];
			settings?: { slot?: string };
		}>("context");
		workspaceId = context.workspaceId;
		slot = context.settings?.slot ?? "";
		canEdit =
			(context.role === "owner" || context.role === "build") &&
			context.grants?.some(
				(grant) =>
					grant.slot === slot && grant.operations.includes("outputs.write"),
			) === true;
		await load();
	} catch (error) {
		message(error instanceof Error ? error.message : String(error), true);
		controls();
	}
	return {
		dispose() {
			if (destroyed)
				return Promise.allSettled([...pendingDraftWrites, draftQueue]);
			void retainDraft();
			destroyed = true;
			generation++;
			clearTimeout(calcTimer);
			document.removeEventListener("mouseup", mouseup);
			window.removeEventListener("message", onMessage);
			window.removeEventListener("beforeunload", beforeUnload);
			style.remove();
			return Promise.allSettled([...pendingDraftWrites, draftQueue]);
		},
		save,
	};
}
