import type {
	OsOutputContent,
	OsWorkbook,
	OsWorkbookCellFormat,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";
import { formatWorkbookNumber } from "@tedix/api-contract/utils/workbook-number-format";
import {
	cellLabel,
	clampCoordinate,
	columnLabel,
	copyBounds,
	isErrorValue,
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
	insertColumns,
	insertRows,
	moveSheet,
	offsetFormula,
	renameSheet,
	resizeColumn,
	sortRange,
} from "../lib/workbook-structure";
import {
	mergeOutputContent,
	type OutputMergePreference,
} from "@tedix/api-contract/utils/output-merge";
import { iconButton } from "./editor-icons";
import { lastingSaveFailure } from "../lib/save-failure";
import { createOutputSync } from "../lib/output-sync";
import {
	createLandedChanges,
	savedByAgent,
	watchForInput,
	LANDED_SHOWN_MS,
	LANDED_UNDO_MS,
} from "../lib/landed-changes";
import {
	OS_EDITOR_UNDO_STEPS,
	OS_SHEET_MAX_COLUMNS,
	OS_SHEET_MAX_ROWS,
} from "@tedix/api-contract/utils/os-output-limits";

type Content = Extract<OsOutputContent, { kind: "sheet" }>;
type Saved = {
	output: { id: string; title: string; workspaceId: string; kind: string };
	revision: { revision: number; content: Content };
};
type RetainedDraft = { revision: number; content: Content };
export interface SheetClientBridge {
	call<T = unknown>(method: string, args?: unknown): Promise<T>;
}

/** Grid metrics in CSS pixels. */
const ROW = 24,
	HEAD = 22,
	INDEX = 40,
	COLUMN = 100;
/** Autosave waits for a pause in editing, but never longer than the cap. */
/** Sheets wider than this draw only the columns near the viewport. */
const COLUMN_WINDOW_MIN = 64,
	COLUMN_WINDOW_MARGIN = 12;
const MAX_ROWS = OS_SHEET_MAX_ROWS,
	MAX_COLUMNS = OS_SHEET_MAX_COLUMNS,
	ROWS_TEXT = MAX_ROWS.toLocaleString("en-US");
// A save sends only the changed cells, so it follows a short pause in editing
// and never waits long while someone keeps editing. A failed save that may
// pass is tried again quickly at first, then less and less often.
const SAVE_PAUSE = 220,
	SAVE_CAP = 1200,
	SAVE_SLOW = 900,
	SAVED_FLASH = 1600,
	RETRY_FIRST = 40,
	RETRY_CAP = 10000,
	RETAIN_PAUSE = 400,
	NOTE_TIME = 6000;

/** Icons only the Sheet toolbar uses, drawn like the shared editor icons. */
const ICONS = {
	bold: "M5 3h4a2.5 2.5 0 0 1 0 5H5zM5 8h4.5a2.5 2.5 0 0 1 0 5H5z",
	italic: "M7 3h4M5 13h4M9.5 3l-3 10",
	underline: "M4.5 3v4.5a3.5 3.5 0 0 0 7 0V3M3.5 13.5h9",
	strike:
		"M2.5 8h11M11 5.2C10.6 3.9 9.5 3 8 3 6.3 3 5 4 5 5.4c0 .5.1.9.4 1.2M5 10.8c.4 1.3 1.5 2.2 3 2.2 1.7 0 3-1 3-2.4",
	textColor: "M4.5 11 8 2.5l3.5 8.5M5.8 8h4.4",
	fillColor: "M3 8.5 8 3.5l4 4L7.5 12a1.4 1.4 0 0 1-2 0zM6.5 2 8 3.5",
	sum: "M12 4V3H4l4 5-4 5h8v-1",
	more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
	help: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM6.2 6.2a1.9 1.9 0 1 1 2.9 1.6c-.7.4-1.1.8-1.1 1.6M8 11.6h.01",
} as const;
const glyph = (name: keyof typeof ICONS) =>
	`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
const sheetButton = (attrs: string, label: string, name: keyof typeof ICONS) =>
	`<button type="button" ${attrs} class="icon" title="${label}" aria-label="${label}">${glyph(name)}</button>`;

const css = [
	`:root{--bg:var(--tedix-bg,Canvas);--fg:var(--tedix-fg,CanvasText);--line:var(--tedix-border,color-mix(in srgb,var(--fg) 14%,transparent));--surface:var(--tedix-surface,color-mix(in srgb,var(--fg) 3%,var(--bg)));--muted:var(--tedix-muted,color-mix(in srgb,var(--fg) 6%,var(--bg)));--muted-fg:var(--tedix-muted-fg,color-mix(in srgb,var(--fg) 62%,var(--bg)));--primary:var(--tedix-primary,Highlight);--on-primary:var(--tedix-on-primary,HighlightText);--danger:var(--tedix-danger,#d92d20);--success:var(--tedix-success,#16a34a);--hover:color-mix(in srgb,var(--fg) 8%,transparent);--ease:cubic-bezier(.23,1,.32,1);font:13px var(--tedix-font,system-ui,sans-serif);color:var(--fg);background:var(--bg)}`,
	`*{box-sizing:border-box}html,body{height:100%}body{margin:0;padding:0!important;overflow:hidden}[hidden]{display:none!important}`,
	`button,input,select{font:inherit;color:inherit}`,
	`.sheet-app{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--bg);overflow-wrap:normal}`,
	`.sr,.hidden-field{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}`,
	`:focus-visible{outline:2px solid var(--primary);outline-offset:1px}`,
	// Toolbar: one row that scrolls sideways instead of wrapping.
	`.bar{flex:none;display:flex;align-items:center;gap:4px;height:36px;padding:0 6px;border-bottom:1px solid var(--line)}`,
	`.toolbar{flex:1;min-width:0;display:flex;flex-wrap:nowrap;align-items:center;overflow-x:auto;scrollbar-width:none}.toolbar::-webkit-scrollbar{display:none}`,
	`.group{flex:none;display:flex;align-items:center;gap:1px}.group+.group{margin-left:4px;padding-left:4px;border-left:1px solid var(--line)}`,
	`.bar-end{flex:none;display:flex;align-items:center;gap:1px}`,
	`button.icon,label.icon{flex:none;display:inline-grid;place-items:center;position:relative;min-width:28px;height:28px;padding:0 5px;border:0;border-radius:6px;background:transparent;cursor:pointer;transition:background-color .12s var(--ease),transform .12s var(--ease),opacity .12s var(--ease)}`,
	`button.icon:hover:not(:disabled),label.icon:hover{background:var(--hover)}button.icon:active:not(:disabled){transform:scale(.94)}`,
	`button.icon:disabled{opacity:.4;cursor:default}button.icon[aria-pressed=true],button.icon[aria-expanded=true]{background:color-mix(in srgb,var(--primary) 18%,transparent)}`,
	`button.icon.text{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}`,
	`label.icon input[type=color]{position:absolute;inset:0;width:100%;height:100%;opacity:0;padding:0;border:0;cursor:pointer}label.icon:has(input:disabled){opacity:.4;cursor:default}label.icon:has(input:focus-visible){outline:2px solid var(--primary);outline-offset:1px}`,
	`label.icon svg{margin-top:-3px}.swatch{position:absolute;left:7px;right:7px;bottom:4px;height:3px;border-radius:1px;background:currentColor;pointer-events:none}.swatch.none{background:transparent;box-shadow:inset 0 0 0 1px var(--line)}`,
	`.toolbar select,.toolbar input[type=number]{flex:none;height:28px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;transition:background-color .12s var(--ease),border-color .12s var(--ease)}`,
	`.toolbar select:hover:not(:disabled),.toolbar input[type=number]:hover:not(:disabled){background:var(--hover)}.toolbar select:disabled,.toolbar input:disabled{opacity:.4}`,
	`#number-format{width:104px}#font-size{width:44px;text-align:center}`,
	// Status: a dot and a word. While everything is fine an editor sees the dot
	// alone; its title says the changes are saved.
	`.status{display:flex;align-items:center;gap:6px;max-width:260px;padding:0 6px;font-size:12px;color:var(--muted-fg);white-space:nowrap;transition:opacity .15s var(--ease)}.status span{overflow:hidden;text-overflow:ellipsis}`,
	`.status[data-state=idle][title=""]{opacity:0;width:0;padding:0;overflow:hidden}.status[data-state=idle] .dot{background:var(--success);opacity:.7}.status[data-state=idle][data-unsaved=true] .dot{background:var(--muted-fg)}.dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--muted-fg)}`,
	`.status[data-state=saving] .dot{background:var(--primary);animation:pulse 1.1s ease-in-out infinite}.status[data-state=saved] .dot{background:var(--success)}.status[data-state=error]{max-width:440px;color:var(--danger)}.status[data-state=error] .dot{background:var(--danger)}`,
	`@keyframes pulse{50%{opacity:.3;transform:scale(.75)}}`,
	// Formula row.
	`.formula{flex:none;display:flex;align-items:center;height:28px;border-bottom:1px solid var(--line)}.formula input{height:100%;border:0;border-radius:0;background:transparent;padding:0 8px;outline-offset:-2px}`,
	`#range{width:84px;text-align:center;border-right:1px solid var(--line);font-variant-numeric:tabular-nums}.formula label{padding:0 4px 0 8px;color:var(--muted-fg);font-style:italic;font-size:12px}#formula{flex:1;min-width:60px;font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}.formula input:disabled{opacity:.5}`,
	// The grid is the only part that grows and scrolls.
	`.stage{flex:1;min-height:0;position:relative;display:flex}`,
	`.grid{flex:1;min-width:0;overflow:auto;outline:none;position:relative;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--fg) 24%,transparent) transparent;overscroll-behavior:contain}`,
	`table{border-collapse:separate;border-spacing:0;table-layout:fixed;width:max-content}`,
	`th,td{padding:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);height:${ROW}px;overflow:hidden;position:relative}`,
	`th{font-size:11.5px;font-weight:500;color:var(--muted-fg);background:var(--muted);user-select:none;transition:background-color .1s var(--ease),color .1s var(--ease)}`,
	`thead th{height:${HEAD}px;position:sticky;top:0;z-index:6;white-space:nowrap;text-overflow:ellipsis;padding:0 6px}thead th:hover,th.index:hover{color:var(--fg)}`,
	`th.index{width:${INDEX}px;min-width:${INDEX}px;position:sticky;left:0;z-index:3;font-variant-numeric:tabular-nums;padding:0}thead th.index{z-index:8}`,
	`th.sel{color:var(--fg);background:color-mix(in srgb,var(--primary) 16%,var(--muted))}th.all{color:var(--on-primary);background:var(--primary)}`,
	`td{background-color:var(--bg);user-select:none;cursor:cell}:is(td,th).gap{border:0;background:none;cursor:default}td output{display:block;padding:0 6px;height:var(--h,${ROW - 1}px);line-height:var(--h,${ROW - 1}px);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:100%}td.wrap output{white-space:pre-wrap;line-height:1.35;padding-block:2px}`,
	`td.error{color:var(--danger)}td.selected{background-image:linear-gradient(color-mix(in srgb,var(--primary) 12%,transparent),color-mix(in srgb,var(--primary) 12%,transparent))}`,
	`td.active{background-image:none;box-shadow:inset 0 0 0 2px var(--primary)}`,
	`@keyframes landed{0%,30%{box-shadow:inset 0 0 0 2px var(--primary),inset 0 0 0 99px color-mix(in srgb,var(--primary) 20%,transparent)}to{box-shadow:inset 0 0 0 2px transparent,inset 0 0 0 99px transparent}}td.landed{animation:landed 2.4s var(--ease) both}@media(prefers-reduced-motion:reduce){td.landed{animation:none;box-shadow:inset 0 0 0 99px color-mix(in srgb,var(--primary) 20%,transparent)}}`,
	`td input.cell-edit{position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:0;padding:0 6px;outline:none;box-shadow:inset 0 0 0 2px var(--primary);background:var(--bg);color:var(--fg);font:inherit;z-index:10}`,
	`.resize{position:absolute;right:-1px;top:0;width:7px;height:100%;cursor:col-resize;z-index:1}.resize:hover,.resize.on{background:color-mix(in srgb,var(--primary) 55%,transparent)}`,
	// Notices and prompts float over the grid instead of pushing it down.
	`.overlay{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:20;display:flex;flex-direction:column;gap:6px;align-items:center;width:max-content;max-width:calc(100% - 24px);pointer-events:none}.overlay>*{pointer-events:auto}`,
	`#updates,.command{display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:100%;padding:6px 8px 6px 12px;font-size:12.5px;border:1px solid var(--line);border-radius:10px;background:var(--surface);box-shadow:0 6px 24px color-mix(in srgb,#000 16%,transparent);animation:drop .14s var(--ease)}#updates:empty{display:none}`,
	`#updates button,.command button{height:26px;padding:0 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);cursor:pointer;transition:background-color .12s var(--ease),transform .12s var(--ease)}#updates button:hover,.command button:hover{background:var(--hover)}#updates button:active,.command button:active{transform:scale(.97)}`,
	`#updates button.primary,.command button.primary{background:var(--primary);border-color:transparent;color:var(--on-primary)}.command input{height:26px;width:180px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg)}`,
	`@keyframes drop{from{opacity:0;transform:translateY(-4px)}}`,
	// Bottom strip: sheet tabs and what the selection adds up to.
	`.strip{flex:none;display:flex;align-items:center;gap:4px;height:30px;padding:0 6px;border-top:1px solid var(--line);background:var(--surface)}`,
	`#tab-buttons{display:flex;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:none}#tab-buttons::-webkit-scrollbar{display:none}`,
	`#tab-buttons button{flex:none;height:22px;max-width:180px;padding:0 10px;border:0;border-radius:5px;background:transparent;color:var(--muted-fg);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background-color .12s var(--ease),color .12s var(--ease)}#tab-buttons button:hover{background:var(--hover);color:var(--fg)}#tab-buttons button[aria-selected=true]{background:var(--bg);color:var(--fg);font-weight:600;box-shadow:inset 0 0 0 1px var(--line),inset 0 -2px 0 var(--primary)}`,
	`.stats{margin-left:auto;flex:none;max-width:55%;padding-left:8px;font-size:11.5px;color:var(--muted-fg);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
	// Menus and the shortcuts card.
	`.menu{position:fixed;z-index:40;min-width:176px;max-width:min(320px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--surface);box-shadow:0 10px 32px color-mix(in srgb,#000 20%,transparent);transform-origin:top left;animation:menu .12s var(--ease);scrollbar-width:thin}`,
	`@keyframes menu{from{opacity:0;transform:scale(.96)}}.menu button{display:block;width:100%;height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background-color .1s var(--ease)}`,
	`.menu button:hover:not(:disabled),.menu button:focus-visible{background:var(--hover);outline:none}.menu button:disabled{opacity:.4;cursor:default}.menu button.danger{color:var(--danger)}.menu hr{border:0;border-top:1px solid var(--line);margin:4px 2px}`,
	`.menu.keys{padding:10px 12px;font-size:12px;line-height:1.5}.keys h2{margin:0 0 6px;font-size:12px;font-weight:600}.keys dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0}.keys dt{color:var(--muted-fg);white-space:nowrap}.keys dd{margin:0}`,
	`@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}`,
].join("");

const SHORTCUTS: [string, string][] = [
	["Arrows", "Move; hold Shift to select a range"],
	["Ctrl/⌘ Arrows", "Jump to the edge of the data"],
	["Enter or F2", "Edit the cell; Escape cancels"],
	["Tab, Enter", "Move on, staying inside a selected range"],
	["Ctrl/⌘ C, X, V", "Copy, cut and paste"],
	["Ctrl/⌘ Z, Shift Z", "Undo and redo"],
	["Ctrl/⌘ B, I, U", "Bold, italic and underline"],
	["Ctrl/⌘ D, R", "Fill down and fill right"],
	["Delete", "Clear the selected cells"],
	["Ctrl/⌘ S", "Save now (changes also save on their own)"],
	["Right-click", "More actions for cells, headings and tabs"],
];

type MenuItem =
	| "-"
	| {
			label: string;
			action: string;
			run: () => void;
			disabled?: boolean;
			danger?: boolean;
	  };

export async function mountSheetClient(
	root: HTMLElement,
	bridge: SheetClientBridge,
) {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.append(style);
	root.classList.add("sheet-app");
	const formatButtons =
		sheetButton('data-format="bold"', "Bold (Ctrl/⌘ B)", "bold") +
		sheetButton('data-format="italic"', "Italic (Ctrl/⌘ I)", "italic") +
		sheetButton(
			'data-format="underline"',
			"Underline (Ctrl/⌘ U)",
			"underline",
		) +
		sheetButton('data-format="strike"', "Strikethrough", "strike");
	const colorButton = (
		id: string,
		label: string,
		name: "textColor" | "fillColor",
		value: string,
	) =>
		`<label class="icon" title="${label}">${glyph(name)}<i class="swatch" aria-hidden="true"></i><input id="${id}" aria-label="${label}" type="color" value="${value}"></label>`;
	root.innerHTML = `<h1 class="sr">Sheet</h1>
<div class="bar"><div class="toolbar" role="toolbar" aria-label="Sheet tools"><span class="group" data-priority="1">${iconButton('id="undo"', "Undo (Ctrl/⌘ Z)", "undo")}${iconButton('id="redo"', "Redo (Ctrl/⌘ Shift Z)", "redo")}</span><span class="group" data-priority="1">${formatButtons}</span><span class="group" data-priority="3"><input id="font-size" title="Font size" aria-label="Font size" type="number" min="6" max="96" value="13">${colorButton("text-color", "Text color", "textColor", "#202020")}${colorButton("fill-color", "Fill color", "fillColor", "#ffffff")}</span><span class="group" data-priority="4"><span class="hidden-field" inert><select id="align" aria-label="Alignment"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></span>${iconButton('data-align="left"', "Align left", "alignLeft")}${iconButton('data-align="center"', "Align center", "alignCenter")}${iconButton('data-align="right"', "Align right", "alignRight")}${iconButton('data-format="wrap"', "Wrap text", "wrap")}</span><span class="group" data-priority="2"><select id="number-format" title="Number format" aria-label="Number format"><option value="automatic">Automatic</option><option value="number">Number</option><option value="integer">Integer</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="scientific">Scientific</option><option value="date">Date</option><option value="time">Time</option><option value="datetime">Date & time</option><option value="text">Text</option></select><span class="hidden-field" inert><input id="decimals" aria-label="Decimal places" type="number" min="0" max="15" value="2"></span><button type="button" id="dec-less" class="icon text" title="Fewer decimals" aria-label="Fewer decimals">.0</button><button type="button" id="dec-more" class="icon text" title="More decimals" aria-label="More decimals">.00</button></span><span class="group" data-priority="5">${sheetButton('id="sum"', "Sum the selection", "sum")}${iconButton('id="fill-down"', "Fill down (Ctrl/⌘ D)", "fillDown")}${iconButton('id="fill-right"', "Fill right (Ctrl/⌘ R)", "fillRight")}${iconButton('id="sort-asc"', "Sort A to Z", "sortUp")}${iconButton('id="sort-desc"', "Sort Z to A", "sortDown")}</span><span class="group" data-priority="6">${iconButton('id="add-row"', "Add row", "addRow")}${iconButton('id="add-column"', "Add column", "addColumn")}${iconButton('id="clear-format"', "Clear formatting", "eraser")}${iconButton('id="clear"', "Clear cells", "clear")}</span><span class="group" data-priority="1">${sheetButton('id="more" aria-haspopup="menu"', "More actions", "more")}</span></div><div class="bar-end"><div class="status" role="status" aria-live="polite" data-state="idle"><i class="dot" aria-hidden="true"></i><span></span></div>${sheetButton('id="help" aria-haspopup="dialog"', "Keyboard shortcuts", "help")}${iconButton('id="download" aria-haspopup="menu"', "Download", "download")}</div></div>
<div class="formula"><input id="range" aria-label="Cell or range" value="A1"><label for="formula">fx</label><input id="formula" aria-label="Formula bar" autocomplete="off" spellcheck="false"></div>
<div class="stage"><div class="grid" tabindex="0" aria-label="Spreadsheet keyboard navigation"><table role="grid" aria-label="Sheet cells" aria-multiselectable="true"><colgroup></colgroup><thead></thead><tbody></tbody></table></div><div class="overlay"><div id="updates" role="status" aria-live="polite"></div><div class="command" hidden><label id="command-label" for="command-value"></label><input id="command-value"><button type="button" id="command-apply" class="primary">Apply</button><button type="button" id="command-cancel">Cancel</button></div></div></div>
<div class="strip">${iconButton('id="add-sheet"', "Add sheet", "plus")}<div id="tab-buttons" role="tablist" aria-label="Sheets"></div><span class="hidden-field"><label>Sheet <select id="tabs" aria-label="Active sheet"></select></label></span><div class="stats"></div></div>`;
	const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
		root.querySelector<T>(selector)!;
	const grid = q(".grid"),
		table = q<HTMLTableElement>("table"),
		colgroup = q("colgroup"),
		thead = q("thead"),
		tbody = q("tbody"),
		toolbar = q(".toolbar"),
		formula = q<HTMLInputElement>("#formula"),
		namebox = q<HTMLInputElement>("#range"),
		tabs = q<HTMLSelectElement>("#tabs"),
		tabButtons = q("#tab-buttons"),
		status = q(".status"),
		statusText = q(".status span"),
		statsBox = q(".stats"),
		updates = q("#updates");
	const toolControls = [
		...root.querySelectorAll<
			HTMLButtonElement | HTMLSelectElement | HTMLInputElement
		>(
			".toolbar button,.toolbar input,.toolbar select,#add-sheet,#command-apply,#command-value",
		),
	];
	const formatToggles = [
			...root.querySelectorAll<HTMLButtonElement>("[data-format]"),
		],
		alignToggles = [
			...root.querySelectorAll<HTMLButtonElement>("[data-align]"),
		];
	let loaded: Saved | undefined,
		draft: Content | undefined,
		canEdit = false,
		// Only the first load and an explicit reload block the grid.
		busy = false,
		dirty = false,
		slot = "",
		// Counts every change to the unsaved sheet, so late answers can be dropped.
		generation = 0,
		pendingRevision = 0,
		basis = 0,
		available = false,
		destroyed = false,
		workspaceId = "",
		// A newer saved version that overlaps the unsaved changes, awaiting a choice.
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
	let retainedConflict: RetainedDraft | undefined,
		// Looking at changes from an earlier visit that were never saved.
		reviewing = false;
	let draftQueue: Promise<unknown> = Promise.resolve(),
		draftWriteVersion = 0;
	const pendingDraftWrites = new Set<Promise<unknown>>();
	let calcTimer: ReturnType<typeof setTimeout> | undefined,
		retainTimer: ReturnType<typeof setTimeout> | undefined,
		saveTimer: ReturnType<typeof setTimeout> | undefined,
		slowTimer: ReturnType<typeof setTimeout> | undefined,
		statusTimer: ReturnType<typeof setTimeout> | undefined;
	// What someone else changed while the sheet was open here: the cells to
	// light up, by tab, the one to bring into view, and whether undoing an
	// agent's change is on offer.
	const landed = createLandedChanges<Content>(),
		input = watchForInput(window);
	let lit = new Map<string, Set<string>>(),
		shown: { row: number; column: number } | undefined,
		litTimer: typeof statusTimer,
		offerTimer: typeof statusTimer,
		offering = false;
	/** Bring the first changed cell into view, once the grid shows the change. */
	const showLanded = () => {
		if (shown) reveal(shown);
		shown = undefined;
	};
	let saving: Promise<void> | undefined,
		saveQueued = false,
		saveDeadline = 0,
		retryDelay = 0,
		retryAt = 0,
		saveError = "",
		// Why the last save cannot succeed as it is; empty while saving may recover.
		lasting = "",
		fatal = "",
		slow = false,
		flash = false,
		merging = false,
		refreshing = false,
		// A short message is on screen; a quiet save must not wipe it early.
		noting = false,
		// What to keep for the next visit when the editor closes mid-save.
		closing: { content: Content; raw: boolean; version: number } | undefined;

	const call = <T = Saved>(method: string, input: unknown = {}) =>
		bridge.call<T>("app.call", { method, args: [input] });
	// The host reads the bound Output directly; the app server is the fallback
	// for hosts that cannot (share links, older hosts).
	const readSheet = () =>
		bridge
			.call<Saved>("outputs.readRevision", { slot })
			.catch(() => call("readSheet"));
	// Saves send only what changed and catching up fetches only what changed.
	// The slot is known once the host has answered, hence the late start.
	let sync: ReturnType<typeof createOutputSync<Content, Saved>>;
	const readLatest = () => sync.latest(readSheet);
	const evaluate = (content: Content) =>
		bridge.call<Content>("sheet.evaluate", { content });
	const sheet = () =>
		draft!.workbook!.sheets.find(
			(s) => s.id === draft!.workbook!.activeSheetId,
		) ?? draft!.workbook!.sheets[0]!;
	const bounds = () => tabBounds ?? selectedBounds(selection);
	const dimensions = () => ({
		rows: Math.max(viewRows, sheet().rows.length),
		columns: Math.max(viewColumns, sheet().columns.length),
	});
	const text = (error: unknown) =>
		error instanceof Error ? error.message : String(error);
	const frame = (run: () => void) =>
		typeof requestAnimationFrame === "function"
			? requestAnimationFrame(run)
			: setTimeout(run, 16);
	const editable = () =>
		canEdit && available && !busy && !destroyed && !retainedConflict && !!draft;
	const unsaved = () => dirty || formulaDirty || !!editing;

	// ---- Status -------------------------------------------------------------

	function setStatus(state: string, value = "", detail = "") {
		clearTimeout(statusTimer);
		noting = false;
		status.dataset.state = state;
		status.dataset.error = String(state === "error");
		statusText.textContent = value;
		status.title = detail;
	}
	/** Show whatever is true right now; nothing at all when everything is fine. */
	function restStatus() {
		if (fatal) setStatus("error", fatal);
		else if (saveError)
			setStatus(
				"error",
				lasting
					? "Not saved. " + lasting
					: typeof navigator !== "undefined" && navigator.onLine === false
						? "Offline. Your changes will save when you are back online."
						: "Couldn't save. Trying again…",
				saveError,
			);
		else if (saving && slow) setStatus("saving", "Saving…");
		else if (busy) setStatus("loading", "Loading…");
		else if (available && !canEdit) setStatus("readonly", "View only");
		else {
			setStatus(
				"idle",
				"",
				!available ? "" : dirty ? "Changes not saved yet" : "All changes saved",
			);
			status.dataset.unsaved = String(dirty);
		}
	}
	/** A short message about what just happened; it clears on its own. */
	function note(value: string, error = false, time = NOTE_TIME) {
		setStatus(error ? "error" : "note", value);
		noting = true;
		statusTimer = setTimeout(restStatus, time);
	}
	function banner(value = "", actions: [string, string, () => void][] = []) {
		updates.replaceChildren();
		if (!value) return;
		const label = document.createElement("span");
		label.textContent = value;
		updates.append(label);
		actions.forEach(([name, key, run], index) => {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = name;
			button.dataset.choice = key;
			if (index === 0) button.className = "primary";
			button.onclick = run;
			updates.append(button);
		});
	}

	function historyButtons() {
		q<HTMLButtonElement>("#undo").disabled = !editable() || !undo.length;
		q<HTMLButtonElement>("#redo").disabled = !editable() || !redo.length;
	}
	function controls() {
		const on = editable();
		formula.disabled = !on;
		for (const node of toolControls) node.disabled = !on;
		historyButtons();
		tabs.disabled = busy || !available;
		q<HTMLButtonElement>("#download").disabled = busy || !available;
		grid.hidden = !available;
		table.setAttribute("aria-readonly", String(!canEdit));
	}

	// ---- Draft kept by the host as a safety net -------------------------------

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
	const blankColumn = (index: number) => ({
		id: "column-" + crypto.randomUUID(),
		label: columnLabel(index),
		width: COLUMN,
	});
	function pad(target: OsWorkbookSheet, row: number, column: number) {
		while (target.columns.length <= column)
			target.columns.push(blankColumn(target.columns.length));
		while (target.rows.length <= row)
			target.rows.push(target.columns.map(() => null));
		for (const line of target.rows)
			while (line.length < target.columns.length) line.push(null);
	}
	/** The unsaved sheet including text still being typed into a cell. */
	function snapshotDraft() {
		const content = structuredClone(draft!);
		const input = editing?.value ?? (formulaDirty ? formula.value : undefined);
		if (input !== undefined) {
			const current = content.workbook!.sheets.find(
				(item) => item.id === content.workbook!.activeSheetId,
			)!;
			const { row, column } = selection.focus;
			pad(current, row, column);
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
		clearTimeout(retainTimer);
		retainTimer = undefined;
		if (
			!loaded ||
			!draft ||
			!available ||
			!canEdit ||
			busy ||
			destroyed ||
			retainedConflict ||
			!unsaved()
		)
			return;
		try {
			await draftOperation("app.draft.write", {
				...draftArgs(),
				revision: basis,
				content: snapshotDraft(),
			});
		} catch {
			// Autosave is the main path; a missed safety copy needs no alarm.
		}
	}
	function retainSoon() {
		if (retainTimer) return;
		retainTimer = setTimeout(() => void retainDraft(), RETAIN_PAUSE);
	}
	function syncRetainedDraft() {
		if (!available || !loaded || !canEdit || retainedConflict) return;
		if (unsaved()) void retainDraft();
		else {
			clearTimeout(retainTimer);
			retainTimer = undefined;
			void draftOperation("app.draft.clear", draftArgs()).catch(
				() => undefined,
			);
		}
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
	/** True when the host says this person may no longer open the sheet. */
	const denied = (error: unknown) =>
		/denied|forbidden|not_permitted|slot_unbound|access unavailable|binding changed|does not match/i.test(
			text(error),
		);
	/**
	 * After a failed call, find out whether the sheet can still be opened. Only
	 * a clear refusal locks the editor; a dropped connection keeps the work.
	 */
	async function verifyAccess() {
		try {
			const current = parse(await readLatest());
			if (current.output.id !== loaded?.output.id)
				throw new Error("The sheet binding changed");
			pendingRevision = Math.max(pendingRevision, current.revision.revision);
			return true;
		} catch (error) {
			if (destroyed) return false;
			if (!denied(error)) return true;
			await unavailable(error);
			return false;
		}
	}

	async function unavailable(error: unknown) {
		generation++;
		available = false;
		for (const timer of [calcTimer, retainTimer, saveTimer, slowTimer])
			clearTimeout(timer);
		retainTimer = undefined;
		const args = loaded ? draftArgs() : undefined;
		closeMenu?.();
		editing = undefined;
		formulaDirty = false;
		dirty = false;
		reviewing = false;
		draft = undefined;
		loaded = undefined;
		retainedConflict = undefined;
		copied = undefined;
		saveError = "";
		undo.length = redo.length = 0;
		resetGrid();
		tabs.replaceChildren();
		tabButtons.replaceChildren();
		tabsShown = "";
		formula.value = "";
		namebox.value = "";
		q("h1").textContent = "Sheet";
		statsBox.textContent = "";
		banner();
		q(".command").hidden = true;
		fatal =
			error instanceof Error ? error.message : "This sheet can't be opened";
		restStatus();
		controls();
		if (args && canEdit)
			await draftOperation("app.draft.clear", args).catch(() => undefined);
	}

	// ---- Editing the unsaved sheet --------------------------------------------

	function mark() {
		// The person's own edit is now the newest change.
		landed.clear();
		if (offering) {
			offering = false;
			banner();
		}
		generation++;
		dirty = true;
		if (status.dataset.state === "idle") restStatus();
		retainSoon();
		scheduleSave();
	}
	const ensure = (row: number, column: number) => pad(sheet(), row, column);
	function edit(change: () => void) {
		if (!editable()) return;
		commitCell();
		commitFormula();
		undo.push(structuredClone(draft!));
		if (undo.length > OS_EDITOR_UNDO_STEPS) undo.shift();
		redo.length = 0;
		change();
		mark();
		syncGrid();
		scheduleCalculation();
		if (pendingRevision > basis) external();
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
	/** Take a newer copy of the sheet without leaving the tab this person is on. */
	function adopt(content: Content) {
		const active = draft?.workbook?.activeSheetId;
		if (active && content.workbook?.sheets.some((item) => item.id === active))
			content.workbook.activeSheetId = active;
		draft = content;
	}
	async function calculate() {
		if (!draft) return;
		const version = generation;
		try {
			const content = await evaluate(structuredClone(draft));
			if (version !== generation || destroyed) return;
			adopt(content);
			paintWindow();
			syncChrome();
		} catch (error) {
			if (!destroyed) note(text(error), true);
		}
	}
	function scheduleCalculation() {
		clearTimeout(calcTimer);
		calcTimer = setTimeout(() => void calculate(), 10);
	}
	/** What a typed value shows as before the formulas are worked out again. */
	function literal(input: string) {
		const trimmed = input.trim();
		if (!trimmed) return null;
		const lower = trimmed.toLowerCase();
		if (lower === "true") return true;
		if (lower === "false") return false;
		const numeric = Number(trimmed);
		return Number.isFinite(numeric) ? numeric : input;
	}
	function put(
		row: number,
		column: number,
		input: string,
		format?: OsWorkbookCellFormat,
	) {
		ensure(row, column);
		const previous = sheet().rows[row]![column],
			value = input.slice(0, 8192),
			kept = format ?? previous?.format;
		sheet().rows[row]![column] = {
			input: value,
			// A typed value shows at once; a formula keeps its last result until
			// the new one arrives.
			value:
				kept?.numberFormat === "text"
					? value
					: value.startsWith("=")
						? (previous?.value ?? null)
						: literal(value),
			...(kept ? { format: kept } : {}),
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

	// ---- Grid drawing ---------------------------------------------------------
	//
	// The table keeps its header and column list between draws. Scrolling adds
	// and removes whole rows at the edges of the visible window; moving the
	// selection only switches classes on the cells already there.

	const rowEls = new Map<number, HTMLTableRowElement>();
	let offsets: number[] = [0],
		headerShown = "",
		tabsShown = "",
		windowShown = "",
		// Indexed by column; a column outside the drawn window has no entry.
		headCells: HTMLTableCellElement[] = [],
		cols: HTMLTableColElement[] = [],
		// A wide sheet draws its frozen columns plus [colFrom, colTo), the
		// columns near the viewport. `slots` maps a drawn column to its place
		// in a row; `rowSlots` counts the cells of a row, spacers included.
		colFrom = 0,
		colTo = 0,
		rowSlots = 0,
		slots = new Map<number, number>(),
		gaps: { slot: number; width: number }[] = [],
		shownBounds: Bounds | undefined,
		shownWhole = "",
		activeCell: Element | undefined,
		scrollQueued = false,
		statsQueued = false;
	const rowHeight = (s: OsWorkbookSheet, row: number) =>
		s.rowHeights?.[row] ?? ROW;
	const columnWidth = (s: OsWorkbookSheet, column: number) =>
		s.columns[column]?.width ?? COLUMN;
	const columnLeft = (s: OsWorkbookSheet, column: number) => {
		let left = INDEX;
		for (let i = 0; i < column; i++) left += columnWidth(s, i);
		return left;
	};
	const cellAt = (row: number, column: number) => {
		const slot = slots.get(column);
		return slot === undefined ? undefined : rowEls.get(row)?.children[slot];
	};
	/**
	 * The columns to draw besides the frozen ones. A sheet of up to
	 * COLUMN_WINDOW_MIN columns draws them all. A wider one draws those in
	 * view plus a margin, and keeps that window until the view leaves it.
	 */
	function columnWindow(s: OsWorkbookSheet, columns: number): [number, number] {
		const frozen = Math.min(s.frozenColumns, columns);
		if (columns <= COLUMN_WINDOW_MIN) return [frozen, columns];
		if (editing && colTo > colFrom) return [colFrom, Math.min(colTo, columns)];
		const left = grid.scrollLeft,
			right = left + (grid.clientWidth || 700);
		let x = INDEX,
			first = columns - 1,
			last = columns - 1,
			found = false;
		for (let col = 0; col < columns; col++) {
			const width = columnWidth(s, col);
			if (!found && x + width > left) {
				first = col;
				found = true;
			}
			if (x >= right) {
				last = col;
				break;
			}
			x += width;
		}
		first = Math.max(frozen, first);
		last = Math.max(first, last);
		if (colTo > colFrom && first >= colFrom && last < colTo && colTo <= columns)
			return [colFrom, colTo];
		return [
			Math.max(frozen, first - COLUMN_WINDOW_MARGIN),
			Math.min(columns, last + 1 + COLUMN_WINDOW_MARGIN),
		];
	}
	/** After a scroll: redraw the columns if the view left them, then the rows. */
	function follow() {
		if (!draft) return;
		const [from, to] = columnWindow(sheet(), dimensions().columns);
		if (from === colFrom && to === colTo) return updateWindow();
		syncHeader();
		updateWindow(true);
		paintSelection(true);
	}
	function resetGrid() {
		colgroup.replaceChildren();
		thead.replaceChildren();
		tbody.replaceChildren();
		rowEls.clear();
		headerShown = windowShown = shownWhole = "";
		shownBounds = activeCell = undefined;
		headCells = [];
		cols = [];
		slots = new Map();
		gaps = [];
		rowSlots = 0;
	}
	function selectAll() {
		const d = dimensions();
		tabBounds = undefined;
		selection = {
			anchor: { row: 0, column: 0 },
			focus: { row: d.rows - 1, column: d.columns - 1 },
		};
		selectionChanged();
	}
	function selectColumn(column: number, extend = false) {
		tabBounds = undefined;
		selection = {
			anchor: extend ? selection.anchor : { row: 0, column },
			focus: { row: dimensions().rows - 1, column },
		};
		selectionChanged();
	}
	function selectRow(row: number, extend = false) {
		tabBounds = undefined;
		selection = {
			anchor: extend ? selection.anchor : { row, column: 0 },
			focus: { row, column: dimensions().columns - 1 },
		};
		selectionChanged();
	}
	function renameColumn(column: number) {
		command(
			"Column title",
			sheet().columns[column]?.label ?? columnLabel(column),
			(value) =>
				edit(() => {
					ensure(0, column);
					sheet().columns[column]!.label =
						value.trim().slice(0, 200) || columnLabel(column);
				}),
		);
	}
	/** Rebuild the header and column list, only when their shape changed. */
	function syncHeader() {
		const s = sheet(),
			d = dimensions();
		const [from, to] = columnWindow(s, d.columns);
		const shape = JSON.stringify([
			s.id,
			d.columns,
			s.frozenRows,
			s.frozenColumns,
			from,
			to,
			s.columns.map((item) => [item.label, item.width]),
		]);
		if (shape === headerShown) return;
		// Cells carry their frozen position, so a new shape starts the rows afresh.
		resetGrid();
		headerShown = shape;
		table.setAttribute("aria-colcount", String(d.columns));
		const first = document.createElement("col");
		first.style.width = INDEX + "px";
		colgroup.append(first);
		const tr = document.createElement("tr"),
			corner = document.createElement("th");
		corner.className = "index";
		corner.title = "Select everything";
		corner.onclick = () => {
			selectAll();
			grid.focus();
		};
		tr.append(corner);
		colFrom = from;
		colTo = to;
		const frozen = Math.min(s.frozenColumns, d.columns);
		/** One empty column as wide as the undrawn columns it stands for. */
		const gap = (start: number, end: number) => {
			let width = 0;
			for (let col = start; col < end; col++) width += columnWidth(s, col);
			if (width <= 0) return;
			const item = document.createElement("col");
			item.style.width = width + "px";
			colgroup.append(item);
			const th = document.createElement("th");
			th.className = "gap";
			th.setAttribute("aria-hidden", "true");
			tr.append(th);
			gaps.push({ slot: tr.children.length - 1, width });
		};
		for (let col = 0; col < d.columns; col++) {
			if (col === frozen) gap(frozen, from);
			if (col >= frozen && col < from) continue;
			if (col >= to) break;
			slots.set(col, tr.children.length);
			const item = document.createElement("col");
			item.style.width = columnWidth(s, col) + "px";
			colgroup.append(item);
			cols.push(item);
			const th = document.createElement("th");
			// "A" alone when the column has no name of its own; "A · Amount" otherwise.
			const letter = columnLabel(col);
			const name = s.columns[col]?.label ?? letter;
			th.textContent = name === letter ? letter : letter + " · " + name;
			th.scope = "col";
			if (col < s.frozenColumns) {
				th.style.left = columnLeft(s, col) + "px";
				th.style.zIndex = "7";
			}
			th.title = "Select column; double-click to rename";
			th.onclick = (event) => {
				selectColumn(col, event.shiftKey);
				grid.focus();
			};
			th.ondblclick = () => renameColumn(col);
			const handle = document.createElement("span");
			handle.className = "resize";
			handle.setAttribute("aria-label", "Resize column " + letter);
			handle.onclick = handle.ondblclick = (event) => event.stopPropagation();
			handle.onpointerdown = (event) => {
				if (!editable()) return;
				event.stopPropagation();
				event.preventDefault();
				const x = event.clientX,
					width = columnWidth(s, col),
					size = (to: PointerEvent) =>
						Math.round(Math.max(48, Math.min(600, width + to.clientX - x)));
				handle.setPointerCapture?.(event.pointerId);
				handle.classList.add("on");
				// The column follows the pointer; the sheet changes once, on release.
				handle.onpointermove = (move) => {
					item.style.width = size(move) + "px";
				};
				handle.onpointerup = handle.onpointercancel = (finish) => {
					handle.onpointermove =
						handle.onpointerup =
						handle.onpointercancel =
							null;
					handle.classList.remove("on");
					const next = finish.type === "pointerup" ? size(finish) : width;
					if (next === width) item.style.width = width + "px";
					else
						workbook((w) => {
							ensure(0, col);
							return resizeColumn(w, sheet().id, col, next);
						});
				};
			};
			th.append(handle);
			tr.append(th);
			headCells[col] = th;
		}
		gap(Math.max(to, frozen), d.columns);
		rowSlots = tr.children.length - 1;
		thead.append(tr);
	}
	function makeRow(row: number) {
		const tr = document.createElement("tr");
		tr.setAttribute("aria-rowindex", String(row + 1));
		const index = document.createElement("th");
		index.className = "index";
		index.scope = "row";
		index.dataset.head = String(row);
		index.textContent = String(row + 1);
		tr.append(index);
		const cells: HTMLTableCellElement[] = [];
		for (const [col, slot] of slots) {
			const td = document.createElement("td");
			cells[slot] = td;
			td.dataset.row = String(row);
			td.dataset.column = String(col);
			td.setAttribute("role", "gridcell");
			td.setAttribute("aria-label", cellLabel({ row, column: col }));
			td.setAttribute("aria-selected", "false");
			td.append(document.createElement("output"));
		}
		for (const { slot } of gaps) {
			const td = document.createElement("td");
			td.className = "gap";
			td.setAttribute("aria-hidden", "true");
			cells[slot] = td;
		}
		for (let slot = 1; slot <= rowSlots; slot++) tr.append(cells[slot]!);
		return tr;
	}
	/** Bring one row's values, formats and frozen position up to date. */
	function paintRow(tr: HTMLTableRowElement, row: number) {
		const s = sheet(),
			line = s.rows[row],
			height = rowHeight(s, row),
			top = row < s.frozenRows ? HEAD + offsets[row]! : -1;
		if (tr.style.height !== height + "px") {
			tr.style.height = height + "px";
			tr.style.setProperty("--h", height - 1 + "px");
		}
		const here = lit.get(s.id);
		const index = tr.firstElementChild as HTMLElement;
		index.style.top = top < 0 ? "" : top + "px";
		index.style.zIndex = top < 0 ? "" : "5";
		for (const [col, slot] of slots) {
			const td = tr.children[slot] as HTMLTableCellElement,
				output = td.firstElementChild as HTMLElement,
				cell = line?.[col] ?? null,
				f = cell?.format,
				shown = formatWorkbookNumber(cell, draft!.workbook),
				left = col < s.frozenColumns ? columnLeft(s, col) : -1;
			if (output.textContent !== shown) output.textContent = shown;
			// Numbers line up on the right unless the cell says otherwise.
			const align =
				f?.horizontalAlign ?? (typeof cell?.value === "number" ? "right" : "");
			const look =
				(f?.bold ? "font-weight:bold;" : "") +
				(f?.italic ? "font-style:italic;" : "") +
				(f?.underline || f?.strike
					? `text-decoration:${f.underline ? "underline " : ""}${f.strike ? "line-through" : ""};`
					: "") +
				(f?.fontSize ? `font-size:${f.fontSize}px;` : "") +
				(align ? `text-align:${align};` : "") +
				(top >= 0 || left >= 0
					? `position:sticky;${top >= 0 ? `top:${top}px;` : ""}${left >= 0 ? `left:${left}px;` : ""}z-index:${top >= 0 && left >= 0 ? 4 : 2};`
					: "");
			const key =
				look + "|" + (f?.textColor ?? "") + "|" + (f?.fillColor ?? "");
			if (td.dataset.look !== key) {
				td.dataset.look = key;
				td.style.cssText = look;
				if (f?.textColor) td.style.color = f.textColor;
				if (f?.fillColor) td.style.backgroundColor = f.fillColor;
			}
			td.classList.toggle("wrap", !!f?.wrap);
			td.classList.toggle("error", isErrorValue(cell?.value));
			if (here || td.classList.contains("landed"))
				td.classList.toggle("landed", !!here?.has(row + ":" + col));
		}
	}
	function markRow(
		tr: HTMLTableRowElement,
		row: number,
		b: Bounds,
		from: number,
		to: number,
		whole: boolean,
	) {
		const inRow = row >= b.rowStart && row <= b.rowEnd,
			head = tr.firstElementChild!;
		head.classList.toggle("sel", inRow);
		head.classList.toggle("all", inRow && whole);
		for (const [col, slot] of slots) {
			if (col < from || col > to) continue;
			const td = tr.children[slot]!;
			const selected = inRow && col >= b.columnStart && col <= b.columnEnd;
			if (td.classList.contains("selected") !== selected) {
				td.classList.toggle("selected", selected);
				td.setAttribute("aria-selected", String(selected));
			}
		}
	}
	/** Show the selection by switching classes; nothing is rebuilt. */
	function paintSelection(everything = false) {
		if (!draft) return;
		const b = bounds(),
			d = dimensions(),
			wholeRows = b.columnStart === 0 && b.columnEnd >= d.columns - 1,
			wholeColumns = b.rowStart === 0 && b.rowEnd >= d.rows - 1,
			whole = `${wholeRows}${wholeColumns}`,
			old = everything || whole !== shownWhole ? undefined : shownBounds;
		const rowFrom = old ? Math.min(old.rowStart, b.rowStart) : 0,
			rowTo = old ? Math.max(old.rowEnd, b.rowEnd) : d.rows,
			from = old ? Math.min(old.columnStart, b.columnStart) : 0,
			to = old ? Math.max(old.columnEnd, b.columnEnd) : d.columns - 1;
		for (const [row, tr] of rowEls)
			if (row >= rowFrom && row <= rowTo)
				markRow(tr, row, b, from, to, wholeRows);
		for (let col = from; col <= to; col++) {
			const th = headCells[col];
			if (!th) continue;
			const inColumn = col >= b.columnStart && col <= b.columnEnd;
			th.classList.toggle("sel", inColumn);
			th.classList.toggle("all", inColumn && wholeColumns);
		}
		const next = cellAt(selection.focus.row, selection.focus.column);
		if (next !== activeCell) {
			activeCell?.classList.remove("active");
			activeCell = next;
		}
		next?.classList.add("active");
		shownBounds = { ...b };
		shownWhole = whole;
	}
	/**
	 * Keep exactly the rows near the viewport in the table. Rows already there
	 * are reused; `repaint` also refreshes what they show.
	 */
	function updateWindow(repaint = false) {
		if (!draft) return;
		const s = sheet(),
			d = dimensions();
		const view = grid.clientHeight || 420,
			scroll = Math.max(0, grid.scrollTop - HEAD);
		let low = 0,
			high = d.rows - 1;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (offsets[middle + 1]! < scroll) low = middle + 1;
			else high = middle;
		}
		const start = Math.max(Math.min(s.frozenRows, d.rows), low - 4);
		let end = start;
		while (end < d.rows && offsets[end]! < scroll + view + 120) end++;
		end = Math.min(d.rows, Math.max(end, start + 20));
		const pinned = editing ? selection.focus.row : -1,
			shape = `${start}:${end}:${pinned}:${d.rows}:${d.columns}`;
		if (shape === windowShown && !repaint) return;
		const fresh = shape !== windowShown;
		windowShown = shape;
		if (fresh) {
			const wanted: number[] = [];
			for (let row = 0; row < Math.min(s.frozenRows, d.rows); row++)
				wanted.push(row);
			for (let row = start; row < end; row++) wanted.push(row);
			// The row being typed in stays, however far the view scrolls.
			if (pinned >= 0 && !wanted.includes(pinned)) {
				wanted.push(pinned);
				wanted.sort((a, b) => a - b);
			}
			const keep = new Set(wanted);
			for (const [row, tr] of rowEls)
				if (!keep.has(row)) {
					tr.remove();
					rowEls.delete(row);
				}
			tbody
				.querySelectorAll("tr[aria-hidden]")
				.forEach((spacer) => spacer.remove());
			const b = bounds(),
				whole = b.columnStart === 0 && b.columnEnd >= d.columns - 1;
			let cursor = tbody.firstChild,
				last = -1;
			const gap = (height: number, before: ChildNode | null) => {
				if (height <= 0) return;
				const row = document.createElement("tr"),
					td = document.createElement("td");
				td.colSpan = rowSlots + 1;
				td.style.height = height + "px";
				td.style.border = "0";
				row.setAttribute("aria-hidden", "true");
				row.append(td);
				tbody.insertBefore(row, before);
			};
			for (const row of wanted) {
				let tr = rowEls.get(row);
				const made = !tr;
				if (!tr) {
					tr = makeRow(row);
					rowEls.set(row, tr);
				}
				if (tr === cursor) cursor = cursor.nextSibling;
				else tbody.insertBefore(tr, cursor);
				gap(offsets[row]! - offsets[last + 1]!, tr);
				if (made) {
					if (!repaint) paintRow(tr, row);
					markRow(tr, row, b, 0, d.columns - 1, whole);
				}
				last = row;
			}
			gap(offsets[d.rows]! - offsets[last + 1]!, null);
			const active = cellAt(selection.focus.row, selection.focus.column);
			if (active !== activeCell) {
				activeCell?.classList.remove("active");
				activeCell = active;
				active?.classList.add("active");
			}
		}
		if (repaint) for (const [row, tr] of rowEls) paintRow(tr, row);
	}
	const paintWindow = () => updateWindow(true);
	function renderTabs() {
		const list = draft!.workbook!.sheets,
			active = sheet().id,
			shape = JSON.stringify([
				active,
				list.map((item) => [item.id, item.name]),
			]);
		if (shape === tabsShown) return;
		tabsShown = shape;
		tabs.replaceChildren();
		tabButtons.replaceChildren();
		for (const item of list) {
			const option = document.createElement("option");
			option.value = item.id;
			option.textContent = item.name;
			option.selected = item.id === active;
			tabs.append(option);
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = item.name;
			button.title = item.name;
			button.dataset.sheet = item.id;
			button.setAttribute("role", "tab");
			button.setAttribute("aria-selected", String(option.selected));
			tabButtons.append(button);
		}
	}
	/** Everything outside the grid that follows the selection. */
	function syncChrome() {
		if (!draft) return;
		const s = sheet();
		namebox.value = tabBounds
			? rangeLabel({
					anchor: { row: tabBounds.rowStart, column: tabBounds.columnStart },
					focus: { row: tabBounds.rowEnd, column: tabBounds.columnEnd },
				})
			: rangeLabel(selection);
		const cell = s.rows[selection.focus.row]?.[selection.focus.column];
		if (!formulaDirty && !editing) formula.value = cell?.input ?? "";
		const format = cell?.format ?? {};
		for (const button of formatToggles)
			button.setAttribute(
				"aria-pressed",
				String(!!format[button.dataset.format as "bold"]),
			);
		q<HTMLSelectElement>("#number-format").value =
			format.numberFormat ?? "automatic";
		q<HTMLInputElement>("#font-size").value = String(format.fontSize ?? 13);
		q<HTMLSelectElement>("#align").value = format.horizontalAlign ?? "left";
		for (const button of alignToggles)
			button.setAttribute(
				"aria-pressed",
				String(button.dataset.align === (format.horizontalAlign ?? "left")),
			);
		q<HTMLInputElement>("#decimals").value = String(format.decimals ?? 2);
		// Each colour button underlines itself with the cell's current colour.
		for (const [id, color] of [
			["#text-color", format.textColor],
			["#fill-color", format.fillColor],
		] as const) {
			const swatch = q(id).previousElementSibling as HTMLElement;
			swatch.style.background = color ?? "";
			swatch.classList.toggle("none", id === "#fill-color" && !color);
		}
		if (statsQueued) return;
		statsQueued = true;
		frame(() => {
			statsQueued = false;
			if (!draft || destroyed) return;
			const b = bounds();
			if (b.rowStart === b.rowEnd && b.columnStart === b.columnEnd) {
				statsBox.textContent = "";
				return;
			}
			const stats = selectionStats(sheet(), b),
				show = (value: number) =>
					value.toLocaleString(undefined, { maximumFractionDigits: 2 });
			statsBox.textContent = stats.numbers
				? `Sum ${show(stats.sum)} · Average ${show(stats.average ?? 0)} · Count ${stats.count}`
				: stats.count
					? `Count ${stats.count}`
					: "";
		});
	}
	function selectionChanged() {
		paintSelection();
		syncChrome();
	}
	/** Redraw after the sheet itself changed. Scroll and selection stay put. */
	function syncGrid() {
		if (!draft) return;
		clampSelection();
		renderTabs();
		syncHeader();
		const s = sheet(),
			d = dimensions();
		table.setAttribute("aria-rowcount", String(d.rows));
		offsets = [0];
		for (let row = 0; row < d.rows; row++)
			offsets.push(offsets[row]! + rowHeight(s, row));
		updateWindow(true);
		paintSelection(true);
		syncChrome();
		historyButtons();
	}
	/** Let the grid cover the pane, and grow it when the pane does. */
	function measure() {
		const rows = Math.min(MAX_ROWS, Math.ceil(grid.clientHeight / ROW) + 2),
			columns = Math.min(MAX_COLUMNS, Math.ceil(grid.clientWidth / COLUMN) + 1);
		if (!editing && (rows > viewRows || columns > viewColumns)) {
			viewRows = Math.max(viewRows, rows);
			viewColumns = Math.max(viewColumns, columns);
			syncGrid();
		} else follow();
	}
	function choose(row: number, column: number, extend = false) {
		tabBounds = undefined;
		// Walking past the last row or column opens more of the sheet.
		const d = draft ? dimensions() : undefined,
			grow =
				!!d &&
				((row >= d.rows && row < MAX_ROWS) ||
					(column >= d.columns && column < MAX_COLUMNS));
		if (grow) {
			viewRows = Math.max(viewRows, Math.min(MAX_ROWS, row + 1));
			viewColumns = Math.max(viewColumns, Math.min(MAX_COLUMNS, column + 1));
		}
		selection = {
			anchor: extend ? selection.anchor : { row, column },
			focus: { row, column },
		};
		clampSelection();
		if (grow) syncGrid();
		else selectionChanged();
	}
	/** Scroll just enough to bring the active cell into view. */
	function reveal(point = selection.focus) {
		const s = sheet();
		if (point.row >= s.frozenRows) {
			const frozen = offsets[Math.min(s.frozenRows, offsets.length - 1)] ?? 0,
				top = offsets[point.row] ?? 0,
				height = rowHeight(s, point.row),
				view = (grid.clientHeight || 420) - HEAD;
			if (top - frozen < grid.scrollTop) grid.scrollTop = top - frozen;
			else if (top + height > grid.scrollTop + view)
				grid.scrollTop = top + height - view;
		}
		if (point.column >= s.frozenColumns) {
			const frozen = columnLeft(s, s.frozenColumns),
				left = columnLeft(s, point.column),
				width = columnWidth(s, point.column),
				view = grid.clientWidth || 700;
			if (left - frozen < grid.scrollLeft) grid.scrollLeft = left - frozen;
			else if (left + width > grid.scrollLeft + view)
				grid.scrollLeft = left + width - view;
		}
		follow();
	}
	function startEdit(initial?: string) {
		if (!editable()) return;
		const point = selection.focus;
		reveal();
		const cell = cellAt(point.row, point.column);
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
			retainSoon();
		};
		input.onkeydown = (event) => {
			if (event.isComposing) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				editing = undefined;
				input.remove();
				syncChrome();
				grid.focus();
				syncRetainedDraft();
				external();
			} else if (
				(event.ctrlKey || event.metaKey) &&
				event.key.toLowerCase() === "s"
			) {
				event.preventDefault();
				event.stopPropagation();
				void save(true);
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
		if (initial !== undefined) retainSoon();
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
		else {
			syncChrome();
			syncRetainedDraft();
		}
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
			selectionChanged();
		} else {
			const p = selection.focus;
			choose(
				p.row + (axis === "vertical" ? direction : 0),
				p.column + (axis === "horizontal" ? direction : 0),
			);
		}
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
		syncGrid();
		scheduleCalculation();
	}
	function switchTab(id: string) {
		if (busy || !draft || !available || destroyed) return;
		commitCell();
		commitFormula();
		if (id === sheet().id) return;
		tabBounds = undefined;
		draft.workbook!.activeSheetId = id;
		selection = { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } };
		grid.scrollTop = grid.scrollLeft = 0;
		syncGrid();
		if (dirty) retainSoon();
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
			panel.hidden = true;
			grid.focus();
			apply(input.value);
		};
		q("#command-apply").onclick = finish;
		input.onkeydown = (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				finish();
			}
			if (event.key === "Escape") {
				event.stopPropagation();
				panel.hidden = true;
				grid.focus();
			}
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
					note("A workbook can hold up to 32 sheets.", true);
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
							note("Give the sheet a name no other sheet has.", true);
							return;
						}
						edit(() => {
							const next = {
								id: "sheet-" + crypto.randomUUID(),
								name: value,
								columns: [{ ...blankColumn(0), label: "A" }],
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
							grid.scrollTop = grid.scrollLeft = 0;
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
					note("A workbook needs at least one sheet.", true);
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
				if (s.rows.length + countRows > MAX_ROWS) {
					note(`A sheet can hold up to ${ROWS_TEXT} rows.`, true);
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
				if (s.columns.length + countCols > MAX_COLUMNS) {
					note(`A sheet can hold up to ${MAX_COLUMNS} columns.`, true);
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
					note("A sheet needs at least one column.", true);
					return;
				}
				apply((w) => deleteColumns(w, id, b.columnStart, countCols));
				break;
			case "rename-column":
				renameColumn(b.columnStart);
				break;
			case "row-height":
			case "column-width":
				command(
					action === "row-height"
						? "Row height (20–600)"
						: "Column width (48–600)",
					String(
						action === "row-height"
							? rowHeight(s, b.rowStart)
							: columnWidth(s, b.columnStart),
					),
					(value) => {
						const size = Number(value);
						if (!Number.isFinite(size)) return;
						apply((w) => {
							ensure(b.rowEnd, b.columnEnd);
							if (action === "column-width")
								return resizeColumn(w, id, b.columnStart, size);
							// Rows without a height of their own keep the grid's default.
							const current = sheet();
							current.rowHeights = current.rows.map((_, i) =>
								i === b.rowStart
									? Math.round(Math.max(20, Math.min(600, size)))
									: rowHeight(current, i),
							);
							return w;
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
	function paste(value: string) {
		if (!editable()) return;
		commitCell();
		const cells = parseClipboardTable(value),
			origin = selection.focus,
			internal = copied?.data.tsv === value ? copied : undefined;
		const width = Math.max(...cells.map((row) => row.length));
		if (
			origin.row + cells.length > MAX_ROWS ||
			origin.column + width > MAX_COLUMNS
		) {
			note(
				`Paste exceeds the ${ROWS_TEXT} row × ${MAX_COLUMNS} column sheet limit.`,
				true,
			);
			return;
		}
		if (cells.some((row) => row.some((item) => item.length > 8192))) {
			note("A pasted cell exceeds 8192 characters.", true);
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
	function copySelection(cut = false) {
		const b = bounds(),
			data = copyBounds(sheet(), b);
		copied = { data, row: b.rowStart, column: b.columnStart, cut };
		return data.tsv;
	}
	grid.addEventListener("copy", (event) => {
		if (editing || !draft) return;
		event.clipboardData?.setData("text/plain", copySelection());
		event.preventDefault();
	});
	grid.addEventListener("cut", (event) => {
		if (editing || !editable()) return;
		event.clipboardData?.setData("text/plain", copySelection(true));
		event.preventDefault();
		clear();
	});
	grid.addEventListener("paste", (event) => {
		if (editing) return;
		event.preventDefault();
		paste(event.clipboardData?.getData("text/plain") ?? "");
	});
	/** Copy, cut and paste from a menu, where no clipboard event is at hand. */
	function menuCopy(cut = false) {
		if (!draft || (cut && !editable())) return;
		const value = copySelection(cut);
		void navigator.clipboard?.writeText(value).catch(() => undefined);
		if (cut) clear();
	}
	async function menuPaste() {
		let value: string | undefined;
		try {
			value = await navigator.clipboard.readText();
		} catch {
			value = copied?.data.tsv;
		}
		if (value) paste(value);
		else note("Press Ctrl/⌘ V to paste.");
	}

	// ---- Menus ----------------------------------------------------------------

	let closeMenu: (() => void) | undefined,
		reopenGuard: { anchor: Element; until: number } | undefined;
	function popover(
		at: HTMLElement | { x: number; y: number },
		label: string,
		role: string,
		fill: (panel: HTMLElement, close: () => void) => void,
	) {
		closeMenu?.();
		const anchor = at instanceof HTMLElement ? at : undefined;
		// A second press on the button that opened a menu only closes it.
		if (
			anchor &&
			reopenGuard?.anchor === anchor &&
			Date.now() < reopenGuard.until
		)
			return;
		const panel = document.createElement("div");
		panel.className = "menu";
		panel.setAttribute("role", role);
		panel.setAttribute("aria-label", label);
		const close = () => {
			panel.remove();
			document.removeEventListener("mousedown", outside, true);
			window.removeEventListener("blur", close);
			anchor?.setAttribute("aria-expanded", "false");
			closeMenu = undefined;
		};
		const outside = (event: Event) => {
			if (panel.contains(event.target as Node)) return;
			if (anchor?.contains(event.target as Node))
				reopenGuard = { anchor, until: Date.now() + 400 };
			close();
		};
		fill(panel, close);
		panel.addEventListener("keydown", (event) => {
			const items = [
				...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
			];
			const index = items.indexOf(document.activeElement as HTMLButtonElement);
			if (event.key === "Escape" || event.key === "Tab") {
				event.preventDefault();
				event.stopPropagation();
				close();
				(anchor ?? grid).focus();
			} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				event.stopPropagation();
				items[
					(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
						items.length
				]?.focus();
			}
		});
		root.append(panel);
		const box = anchor?.getBoundingClientRect(),
			x = box ? box.left : (at as { x: number }).x,
			y = box ? box.bottom + 4 : (at as { y: number }).y;
		panel.style.left =
			Math.max(8, Math.min(x, window.innerWidth - panel.offsetWidth - 8)) +
			"px";
		panel.style.top =
			Math.max(8, Math.min(y, window.innerHeight - panel.offsetHeight - 8)) +
			"px";
		anchor?.setAttribute("aria-expanded", "true");
		document.addEventListener("mousedown", outside, true);
		window.addEventListener("blur", close);
		closeMenu = close;
		panel.tabIndex = -1;
		(panel.querySelector<HTMLElement>("button:not(:disabled)") ?? panel).focus({
			preventScroll: true,
		});
	}
	function openMenu(
		at: HTMLElement | { x: number; y: number },
		label: string,
		items: MenuItem[],
	) {
		popover(at, label, "menu", (panel, close) => {
			for (const item of items) {
				if (item === "-") {
					if (panel.lastElementChild?.tagName === "BUTTON")
						panel.append(document.createElement("hr"));
					continue;
				}
				const button = document.createElement("button");
				button.type = "button";
				button.textContent = item.label;
				button.dataset.action = item.action;
				button.disabled = !!item.disabled;
				button.setAttribute("role", "menuitem");
				if (item.danger) button.className = "danger";
				button.onclick = () => {
					close();
					grid.focus();
					item.run();
				};
				panel.append(button);
			}
		});
	}
	const act = (
		label: string,
		action: string,
		extra: Partial<Exclude<MenuItem, "-">> = {},
	): MenuItem => ({
		label,
		action,
		run: () => structure(action),
		disabled: !editable(),
		...extra,
	});
	const clipboardItems = (): MenuItem[] => [
		{
			label: "Cut",
			action: "cut",
			run: () => menuCopy(true),
			disabled: !editable(),
		},
		{ label: "Copy", action: "copy", run: () => menuCopy() },
		{
			label: "Paste",
			action: "paste",
			run: () => void menuPaste(),
			disabled: !editable(),
		},
	];
	const clearItem = (): MenuItem => ({
		label: "Clear cells",
		action: "clear",
		run: clear,
		disabled: !editable(),
	});
	const rowItems = (): MenuItem[] => [
		act("Insert rows above", "insert-row"),
		act("Delete selected rows", "delete-row", { danger: true }),
	];
	const columnItems = (): MenuItem[] => [
		act("Insert columns before", "insert-column"),
		act("Delete selected columns", "delete-column", { danger: true }),
	];
	const sheetItems = (): MenuItem[] => [
		act("Rename sheet", "rename-sheet"),
		act("Duplicate sheet", "duplicate-sheet"),
		act("Move sheet left", "move-left"),
		act("Move sheet right", "move-right"),
		act("Delete sheet", "delete-sheet", { danger: true }),
	];
	const sortItems = (): MenuItem[] =>
		(
			[
				["Sort A to Z", "ascending"],
				["Sort Z to A", "descending"],
			] as const
		).map(([label, direction]) => ({
			label,
			action: "sort-" + direction,
			disabled: !editable(),
			run: () =>
				workbook((w) =>
					sortRange(w, sheet().id, bounds(), selection.focus.column, direction),
				),
		}));
	/** Tools the toolbar had no room for stay reachable from More actions. */
	const overflowItems = (): MenuItem[] =>
		[
			...toolbar.querySelectorAll<HTMLButtonElement>(
				".group[hidden] button[title]",
			),
		].map((button) => ({
			label: button.title.replace(/ \(.*\)$/, ""),
			action: "tool-" + (button.id || button.dataset.format || button.title),
			disabled: button.disabled,
			run: () => button.click(),
		}));
	q("#more").onclick = (event) =>
		openMenu(event.currentTarget as HTMLElement, "More actions", [
			...overflowItems(),
			"-",
			...rowItems(),
			...columnItems(),
			"-",
			act("Rename column", "rename-column"),
			act("Row height", "row-height"),
			act("Column width", "column-width"),
			"-",
			act("Freeze up to the selection", "freeze"),
			act("Unfreeze", "unfreeze"),
			"-",
			act("Add sheet", "add-sheet"),
			...sheetItems(),
		]);
	q("#help").onclick = (event) =>
		popover(
			event.currentTarget as HTMLElement,
			"Keyboard shortcuts",
			"dialog",
			(panel) => {
				panel.classList.add("keys");
				const title = document.createElement("h2"),
					list = document.createElement("dl");
				title.textContent = "Keyboard shortcuts";
				for (const [keys, what] of SHORTCUTS) {
					const term = document.createElement("dt"),
						detail = document.createElement("dd");
					term.textContent = keys;
					detail.textContent = what;
					list.append(term, detail);
				}
				panel.append(title, list);
			},
		);
	q("#download").onclick = (event) =>
		openMenu(event.currentTarget as HTMLElement, "Download", [
			{ label: "CSV file", action: "csv", run: () => void download("csv") },
			{ label: "Excel file", action: "xlsx", run: () => void download("xlsx") },
		]);
	function gridMenu(target: Element | null, at: { x: number; y: number }) {
		if (!draft || !available) return;
		const td = target?.closest<HTMLElement>("td[data-row]"),
			rowHead = target?.closest<HTMLElement>("th[data-head]"),
			columnHead = target?.closest("thead th"),
			column = columnHead
				? headCells.indexOf(columnHead as HTMLTableCellElement)
				: -1,
			b = bounds();
		if (td) {
			const row = Number(td.dataset.row),
				col = Number(td.dataset.column);
			// Right-clicking outside the selection moves it, like a normal click.
			if (
				row < b.rowStart ||
				row > b.rowEnd ||
				col < b.columnStart ||
				col > b.columnEnd
			) {
				commitCell();
				choose(row, col);
			}
			openMenu(at, "Cell actions", [
				...clipboardItems(),
				"-",
				...rowItems(),
				...columnItems(),
				"-",
				clearItem(),
			]);
		} else if (rowHead) {
			const row = Number(rowHead.dataset.head);
			if (row < b.rowStart || row > b.rowEnd) selectRow(row);
			openMenu(at, "Row actions", [
				...clipboardItems(),
				"-",
				...rowItems(),
				act("Row height", "row-height"),
				act("Freeze up to the selection", "freeze"),
				"-",
				clearItem(),
			]);
		} else if (column >= 0) {
			if (column < b.columnStart || column > b.columnEnd) selectColumn(column);
			openMenu(at, "Column actions", [
				...clipboardItems(),
				"-",
				...columnItems(),
				act("Rename column", "rename-column"),
				act("Column width", "column-width"),
				act("Freeze up to the selection", "freeze"),
				"-",
				...sortItems(),
				"-",
				clearItem(),
			]);
		}
	}
	table.addEventListener("contextmenu", (event) => {
		if (event.target === editing) return;
		event.preventDefault();
		gridMenu(event.target as Element, { x: event.clientX, y: event.clientY });
	});
	// Toolbar buttons act on the selection, so pressing one must not move focus
	// out of the grid or close the cell being typed in.
	q(".bar").addEventListener("mousedown", (event) => {
		if ((event.target as Element).closest("button")) event.preventDefault();
	});

	// ---- Pointer and keyboard -------------------------------------------------

	table.addEventListener("mousedown", (event) => {
		const td = (event.target as Element).closest<HTMLElement>("td[data-row]");
		if (!td || event.button !== 0 || event.target === editing) return;
		commitCell();
		event.preventDefault();
		dragging = true;
		choose(Number(td.dataset.row), Number(td.dataset.column), event.shiftKey);
		grid.focus();
	});
	table.addEventListener("mouseover", (event) => {
		if (!dragging) return;
		const td = (event.target as Element).closest<HTMLElement>("td[data-row]");
		if (!td) return;
		const row = Number(td.dataset.row),
			column = Number(td.dataset.column);
		if (row === selection.focus.row && column === selection.focus.column)
			return;
		selection.focus = { row, column };
		selectionChanged();
	});
	table.addEventListener("dblclick", (event) => {
		if ((event.target as Element).closest("td[data-row]")) startEdit();
	});
	tbody.addEventListener("click", (event) => {
		const head = (event.target as Element).closest<HTMLElement>(
			"th[data-head]",
		);
		if (!head) return;
		selectRow(Number(head.dataset.head), event.shiftKey);
		grid.focus();
	});
	const tabId = (event: Event) =>
		(event.target as Element).closest<HTMLElement>("[data-sheet]")?.dataset
			.sheet;
	tabButtons.addEventListener("click", (event) => {
		const id = tabId(event);
		if (id) switchTab(id);
	});
	tabButtons.addEventListener("dblclick", (event) => {
		const id = tabId(event);
		if (!id) return;
		switchTab(id);
		structure("rename-sheet");
	});
	tabButtons.addEventListener("contextmenu", (event) => {
		const id = tabId(event);
		if (!id) return;
		event.preventDefault();
		switchTab(id);
		openMenu({ x: event.clientX, y: event.clientY }, "Sheet actions", [
			act("Rename", "rename-sheet"),
			act("Duplicate", "duplicate-sheet"),
			act("Move left", "move-left"),
			act("Move right", "move-right"),
			"-",
			act("Delete", "delete-sheet", { danger: true }),
		]);
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
			if (key === "s") void save(true);
			else if (key === "z" && !event.shiftKey && offering && landed.undoable)
				// The agent's change is the newest one: undo takes that back first.
				undoLanded();
			else if (key === "z")
				history(event.shiftKey ? redo : undo, event.shiftKey ? undo : redo);
			else if (key === "y") history(redo, undo);
			else if (key === "a") selectAll();
			else if (["b", "i", "u"].includes(key)) {
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
			const page = Math.max(
				1,
				Math.floor(((grid.clientHeight || 420) - HEAD) / ROW) - 1,
			);
			choose(
				Math.max(
					0,
					selection.focus.row + (event.key === "PageDown" ? page : -page),
				),
				selection.focus.column,
				event.shiftKey,
			);
			reveal();
		} else if (event.key === "F2") {
			event.preventDefault();
			startEdit();
		} else if (
			event.key === "ContextMenu" ||
			(event.key === "F10" && event.shiftKey)
		) {
			event.preventDefault();
			reveal();
			const cell = cellAt(selection.focus.row, selection.focus.column),
				box = cell?.getBoundingClientRect();
			if (cell && box) gridMenu(cell, { x: box.left + 8, y: box.bottom });
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
		if (value === (sheet().rows[p.row]?.[p.column]?.input ?? "")) {
			syncRetainedDraft();
			return;
		}
		edit(() => put(p.row, p.column, value));
	}
	formula.maxLength = 8192;
	formula.oninput = () => {
		if (!editable()) return;
		formulaDirty = true;
		retainSoon();
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
			formula.blur();
			syncChrome();
			grid.focus();
			syncRetainedDraft();
			external();
		} else if (
			(event.ctrlKey || event.metaKey) &&
			event.key.toLowerCase() === "s"
		) {
			event.preventDefault();
			void save(true);
		}
	};
	root.addEventListener("keydown", (event) => {
		if (
			!event.defaultPrevented &&
			(event.ctrlKey || event.metaKey) &&
			event.key.toLowerCase() === "s"
		) {
			event.preventDefault();
			void save(true);
		}
	});

	formula.onchange = commitFormula;
	namebox.onkeydown = (event) => {
		if (event.key !== "Enter" || !draft) return;
		const d = dimensions(),
			next = parseRangeLabel(namebox.value, MAX_ROWS, MAX_COLUMNS);
		if (next) {
			tabBounds = undefined;
			selection = next;
			selection.anchor = clampCoordinate(next.anchor, MAX_ROWS, MAX_COLUMNS);
			selection.focus = clampCoordinate(next.focus, MAX_ROWS, MAX_COLUMNS);
			const rows = Math.max(selection.focus.row, selection.anchor.row) + 1,
				columns = Math.max(selection.focus.column, selection.anchor.column) + 1;
			if (rows > d.rows || columns > d.columns) {
				viewRows = Math.max(d.rows, rows);
				viewColumns = Math.max(d.columns, columns);
				syncGrid();
			} else selectionChanged();
			reveal();
			grid.focus();
		} else note("Enter a cell or range such as A1:C5.", true);
	};
	for (const button of formatToggles)
		button.onclick = () => {
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
		};
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
	// The icon buttons drive the same fields the dropdown and number box did.
	const setField = (selector: string, value: string) => {
		const field = q<HTMLInputElement | HTMLSelectElement>(selector);
		field.value = value;
		field.dispatchEvent(new Event("change", { bubbles: true }));
	};
	for (const button of alignToggles)
		button.onclick = () => setField("#align", button.dataset.align!);
	const stepDecimals = (by: number) =>
		setField(
			"#decimals",
			String(
				Math.max(
					0,
					Math.min(15, Number(q<HTMLInputElement>("#decimals").value) + by),
				),
			),
		);
	q("#dec-less").onclick = () => stepDecimals(-1);
	q("#dec-more").onclick = () => stepDecimals(1);
	q("#clear-format").onclick = () => format(null);
	q("#undo").onclick = () => history(undo, redo);
	q("#redo").onclick = () => history(redo, undo);
	q("#clear").onclick = clear;
	q("#add-row").onclick = () => {
		if (!editable()) return;
		if (sheet().rows.length >= MAX_ROWS) {
			note(`A sheet can hold up to ${ROWS_TEXT} rows.`, true);
			return;
		}
		workbook((w) => insertRows(w, sheet().id, sheet().rows.length, 1));
	};
	q("#add-column").onclick = () => {
		if (!editable()) return;
		if (sheet().columns.length >= MAX_COLUMNS) {
			note(`A sheet can hold up to ${MAX_COLUMNS} columns.`, true);
			return;
		}
		workbook((w) => insertColumns(w, sheet().id, sheet().columns.length, 1));
	};
	q("#add-sheet").onclick = () => structure("add-sheet");
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

	// ---- Other people's saves ---------------------------------------------------

	/** Decide what to do about a newer saved version, if there is one. */
	/**
	 * Light up the cells that differ from `before` on screen. Someone who is
	 * only watching is taken to the first of them, on its tab.
	 */
	function light(before: Content) {
		const old = new Map(
			before.workbook?.sheets.map((item) => [item.id, item.rows]),
		);
		const found = new Map<string, Set<string>>();
		let first: { id: string; row: number; column: number } | undefined;
		for (const item of draft!.workbook!.sheets) {
			const rows = old.get(item.id);
			const cells = new Set<string>();
			item.rows.forEach((line, row) =>
				line.forEach((cell, column) => {
					const was = rows?.[row]?.[column] ?? null;
					if (was === cell || JSON.stringify(was) === JSON.stringify(cell))
						return;
					cells.add(row + ":" + column);
					first ??= { id: item.id, row, column };
				}),
			);
			if (cells.size) found.set(item.id, cells);
		}
		if (!first) return;
		lit = found;
		clearTimeout(litTimer);
		litTimer = setTimeout(() => {
			lit = new Map();
			if (!destroyed && draft) paintWindow();
		}, LANDED_SHOWN_MS);
		if (!input.watching || unsaved()) return;
		const at = found.has(sheet().id)
			? [...found.get(sheet().id)!][0]!.split(":").map(Number)
			: [first.row, first.column];
		if (!found.has(sheet().id)) {
			tabBounds = undefined;
			draft!.workbook!.activeSheetId = first.id;
		}
		shown = { row: at[0]!, column: at[1]! };
	}
	/** Someone else's save replaced `before` on screen: show it, and offer undo for an agent's. */
	function land(before: Content, agent: boolean) {
		landed.add(before, structuredClone(draft!), agent);
		light(before);
		offering = agent && canEdit;
		clearTimeout(offerTimer);
		if (offering)
			offerTimer = setTimeout(() => {
				offering = false;
				external();
			}, LANDED_UNDO_MS);
	}
	/**
	 * Take the agent's change set back out as an edit of the person's own: it
	 * saves as a new change and their own undo brings the agent's work back.
	 */
	function undoLanded() {
		if (!editable()) return;
		const before = draft!,
			content = landed.undo(structuredClone(before));
		if (!content) return;
		edit(() => adopt(content));
		light(before);
		paintWindow();
		note("Agent change undone.");
	}
	function external() {
		if (!loaded || busy || !available || destroyed) return;
		if (retainedConflict) {
			banner(
				"You have changes from an earlier visit that were never saved, and this sheet has changed since.",
				[
					["Show my changes", "review", () => void review()],
					["Discard them", "discard", () => void load(true)],
				],
			);
			return;
		}
		if (reviewing) {
			banner(
				"These are your earlier changes. Keeping them replaces what others changed in this sheet since.",
				[
					["Keep mine", "mine", keepReviewed],
					["Use theirs", "theirs", () => void load(true)],
				],
			);
			return;
		}
		if (dirty && choice > basis) {
			banner(
				"Someone else changed the same cells you just edited. Choose which version to keep there; all other changes from both of you are kept.",
				[
					["Keep mine", "mine", () => void mergeLatest("mine")],
					["Use theirs", "theirs", () => void mergeLatest("theirs")],
				],
			);
			return;
		}
		if (offering && landed.undoable)
			banner("An agent changed this sheet.", [
				["Undo agent change", "undo", undoLanded],
			]);
		else {
			offering = false;
			banner();
		}
		const current = Math.max(pendingRevision, loaded.revision.revision);
		if (current <= basis) {
			pendingRevision = 0;
			return;
		}
		if (saving || merging || refreshing) return;
		// Text still being typed waits; the update merges once the cell is done.
		if (formulaDirty || editing) return;
		if (dirty) {
			if (current > choice) void mergeLatest();
		} else void refresh();
	}
	/** Show someone else's save in place when nothing here is unsaved. */
	async function refresh() {
		if (!loaded || !draft) return;
		refreshing = true;
		const version = generation;
		let again = false;
		try {
			const latest = parse(await readLatest());
			if (latest.output.id !== loaded?.output.id)
				throw new Error("The sheet binding changed");
			if (destroyed) return;
			pendingRevision = 0;
			if (latest.revision.revision <= basis) return;
			const content = await evaluate(latest.revision.content);
			if (destroyed) return;
			if (version !== generation || unsaved()) {
				// Edited meanwhile: the merge path takes it from here.
				pendingRevision = latest.revision.revision;
				again = true;
				return;
			}
			const before = draft;
			loaded = latest;
			basis = latest.revision.revision;
			adopt(content);
			// Undo steps were taken against the old sheet; replaying them would
			// silently revert the other person's changes.
			undo.length = redo.length = 0;
			q("h1").textContent = latest.output.title;
			land(before, savedByAgent(latest.revision));
			syncGrid();
			showLanded();
			external();
		} catch (error) {
			pendingRevision = 0;
			if (!destroyed && denied(error)) await unavailable(error);
		} finally {
			refreshing = false;
			if (again) external();
		}
	}
	/**
	 * Bring someone else's newer save into the unsaved sheet, without locking
	 * the grid. Only changes made on top of the version this editor loaded can
	 * merge here.
	 */
	async function mergeLatest(prefer?: OutputMergePreference) {
		if (
			!loaded ||
			!draft ||
			!dirty ||
			formulaDirty ||
			editing ||
			busy ||
			merging ||
			saving ||
			destroyed ||
			retainedConflict ||
			reviewing ||
			basis !== loaded.revision.revision
		)
			return;
		merging = true;
		const version = generation;
		let again = false;
		try {
			const latest = parse(await readLatest());
			if (destroyed) return;
			// Never retry in a loop: the next change notice or save tries again.
			pendingRevision = 0;
			if (latest.revision.revision <= basis) {
				choice = 0;
				return;
			}
			const [base, theirs] = await Promise.all([
				evaluate(loaded.revision.content),
				evaluate(latest.revision.content),
			]);
			if (destroyed) return;
			const stale = () => {
				if (version === generation) return false;
				pendingRevision = latest.revision.revision;
				again = true;
				return true;
			};
			if (stale()) return;
			const result = mergeOutputContent(base, draft, theirs, { prefer });
			if (!result.ok) {
				choice = latest.revision.revision;
				return;
			}
			const merged = await evaluate(result.content as Content);
			if (destroyed || stale()) return;
			choice = 0;
			const before = draft;
			loaded = latest;
			basis = latest.revision.revision;
			adopt(merged);
			generation++;
			// Undo steps were taken against the old sheet; replaying them would
			// silently revert the other person's changes.
			undo.length = redo.length = 0;
			land(before, savedByAgent(latest.revision));
			syncGrid();
			showLanded();
			void retainDraft();
			scheduleSave(0);
		} catch (error) {
			pendingRevision = 0;
			if (destroyed) return;
			if (denied(error)) await unavailable(error);
			else {
				note(
					"Couldn't bring in the latest changes yet. Your work is still here.",
					true,
				);
				status.title = text(error);
			}
		} finally {
			merging = false;
			// Typing during the merge restarts it shortly, not in a tight loop.
			if (again) setTimeout(external, 300);
			else external();
		}
	}
	const sameCells = (a: Content, b: Content) =>
		JSON.stringify(
			a.workbook?.sheets.map((item) => ({
				...item,
				rows: item.rows.map((row) =>
					row.map((cell) =>
						cell && (cell.input || cell.format)
							? [cell.input, cell.format]
							: null,
					),
				),
			})),
		) ===
		JSON.stringify(
			b.workbook?.sheets.map((item) => ({
				...item,
				rows: item.rows.map((row) =>
					row.map((cell) =>
						cell && (cell.input || cell.format)
							? [cell.input, cell.format]
							: null,
					),
				),
			})),
		);
	async function load(discardDraft = false) {
		busy = true;
		generation++;
		clearTimeout(saveTimer);
		controls();
		restStatus();
		try {
			// Opening reads the whole sheet once; everything after is changes only.
			sync.forget();
			const result = sync.remember(parse(await readSheet()));
			if (destroyed) return;
			loaded = result;
			choice = 0;
			reviewing = false;
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
			const [saved, kept] = await Promise.all([
				evaluate(result.revision.content),
				retained ? evaluate(retained.content) : undefined,
			]);
			if (destroyed) return;
			// A copy that already made it into the saved sheet needs no question.
			if (kept && sameCells(kept, saved)) {
				retained = null;
				void draftOperation("app.draft.clear", draftArgs()).catch(
					() => undefined,
				);
			}
			retainedConflict =
				retained && retained.revision !== result.revision.revision
					? retained
					: undefined;
			const matching = retained && !retainedConflict ? kept : undefined;
			draft = matching ?? saved;
			basis = result.revision.revision;
			available = true;
			fatal = saveError = "";
			dirty = !!matching;
			formulaDirty = false;
			saveDeadline = retryDelay = retryAt = 0;
			undo.length = redo.length = 0;
			q("h1").textContent = result.output.title;
			busy = false;
			controls();
			syncGrid();
			restStatus();
			if (dirty) {
				note("Restored your unsaved changes");
				scheduleSave();
			}
		} catch (error) {
			if (!destroyed) await unavailable(error);
		} finally {
			busy = false;
			controls();
			if (status.dataset.state === "loading") restStatus();
			external();
		}
	}
	/** Put the earlier, never-saved changes on screen so they can be judged. */
	async function review() {
		if (!retainedConflict || busy || !available) return;
		const retained = retainedConflict,
			outputId = loaded!.output.id;
		busy = true;
		controls();
		try {
			const result = parse(await readLatest());
			if (result.output.id !== outputId)
				throw new Error("The sheet binding changed");
			const content = await evaluate(retained.content);
			if (destroyed) return;
			loaded = result;
			draft = content;
			basis = retained.revision;
			retainedConflict = undefined;
			reviewing = true;
			dirty = true;
			generation++;
			busy = false;
			controls();
			syncGrid();
		} catch (error) {
			if (!destroyed) await unavailable(error);
		} finally {
			busy = false;
			controls();
			external();
		}
	}
	function keepReviewed() {
		if (!reviewing || !loaded) return;
		reviewing = false;
		basis = loaded.revision.revision;
		banner();
		void save(true);
	}

	// ---- Saving -----------------------------------------------------------------

	/** Save after a pause in editing, at the latest a few seconds after the first change. */
	function scheduleSave(pause = SAVE_PAUSE) {
		if (!canEdit || !available || destroyed) return;
		const now = Date.now();
		if (!saveDeadline) saveDeadline = now + SAVE_CAP;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(
			() => void save(),
			Math.max(0, Math.min(pause, saveDeadline - now), retryAt - now),
		);
	}
	/**
	 * Save the sheet. One save runs at a time; changes made meanwhile go out
	 * with the next one. `now` is someone asking for it (Ctrl/⌘ S): it also
	 * takes the cell being typed and confirms with a short "Saved".
	 */
	function save(now = false): Promise<void> {
		if (now) {
			commitCell();
			commitFormula();
			flash = true;
			retryAt = 0;
		}
		if (saving) {
			saveQueued = true;
			return saving;
		}
		if (!editable() || reviewing || !dirty || choice > basis || merging) {
			if (flash && editable() && !dirty && !saveError) {
				setStatus("saved", "Saved");
				statusTimer = setTimeout(restStatus, SAVED_FLASH);
			}
			if (!dirty) flash = false;
			return Promise.resolve();
		}
		saving = run().finally(() => {
			saving = undefined;
			after();
		});
		return saving;
	}
	let saveOutcome: "saved" | "failed" | "conflict" | "stopped" = "stopped";
	async function run() {
		clearTimeout(saveTimer);
		saveDeadline = 0;
		saveQueued = false;
		saveOutcome = "stopped";
		slow = false;
		if (status.dataset.state === "saved") restStatus();
		slowTimer = setTimeout(() => {
			slow = true;
			restStatus();
		}, SAVE_SLOW);
		const version = generation;
		try {
			const content = await evaluate(structuredClone(draft!));
			const result = parse(await sync.save(content, basis, readSheet, flash));
			if (destroyed) {
				// The editor closed mid-save: leave the next visit a clean start, or
				// exactly what was still unsaved, on top of what was just saved.
				if (closing)
					await (
						version === closing.version && !closing.raw
							? bridge.call("app.draft.clear", draftArgs())
							: bridge.call("app.draft.write", {
									...draftArgs(),
									revision: result.revision.revision,
									content: closing.content,
								})
					).catch(() => undefined);
				return;
			}
			loaded = result;
			basis = result.revision.revision;
			saveOutcome = "saved";
			if (version === generation) {
				dirty = false;
				// The saved copy stays as stored: later saves compare against it,
				// and edits here change cells in place.
				adopt(structuredClone(result.revision.content));
				paintWindow();
				syncChrome();
				syncRetainedDraft();
			} else void retainDraft();
		} catch (error) {
			if (destroyed || !(await verifyAccess())) return;
			if (pendingRevision > basis) saveOutcome = "conflict";
			else {
				saveOutcome = "failed";
				lasting = lastingSaveFailure(error);
				saveError = lasting || text(error);
			}
		} finally {
			clearTimeout(slowTimer);
		}
	}
	/** Report the save and line up whatever comes next. */
	function after() {
		if (destroyed || !available) return;
		const recovered = !!saveError && saveOutcome === "saved";
		if (saveOutcome === "saved") {
			saveError = lasting = "";
			retryDelay = retryAt = 0;
			if (flash || recovered || slow) {
				setStatus("saved", "Saved");
				statusTimer = setTimeout(restStatus, SAVED_FLASH);
			} else if (!noting) restStatus();
			flash = false;
			if (dirty) scheduleSave(saveQueued ? 0 : SAVE_PAUSE);
		} else if (saveOutcome === "failed" && lasting) {
			// Sending the same sheet again cannot work: say why once and wait
			// for the next change.
			retryDelay = retryAt = 0;
			restStatus();
		} else if (saveOutcome === "failed") {
			retryDelay = Math.min(
				RETRY_CAP,
				retryDelay ? retryDelay * 2 : RETRY_FIRST,
			);
			retryAt = Date.now() + retryDelay;
			restStatus();
			scheduleSave(retryDelay);
		} else if (!noting) restStatus();
		slow = false;
		// A conflict merges the newer version in, then saves again.
		external();
	}
	async function download(kind: "csv" | "xlsx") {
		if (!loaded || !available || busy) return;
		try {
			// Download what is on screen, not the version from a moment ago.
			commitCell();
			commitFormula();
			if (dirty) await save();
			if (!loaded) return;
			if (kind === "csv") {
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
			} else
				await bridge.call("app.exportOutput", {
					slot,
					format: "xlsx",
					expectedRevision: loaded.revision.revision,
				});
			if (dirty) note("Downloaded the last saved version.");
		} catch (error) {
			if (destroyed || !(await verifyAccess())) return;
			note("Couldn't download the sheet. " + text(error), true);
		}
	}

	// ---- Page wiring ------------------------------------------------------------

	const mouseup = () => {
		dragging = false;
	};
	document.addEventListener("mouseup", mouseup);
	grid.addEventListener(
		"scroll",
		() => {
			closeMenu?.();
			if (scrollQueued) return;
			scrollQueued = true;
			// One window update per frame, however many scroll events arrive.
			frame(() => {
				scrollQueued = false;
				if (draft && !destroyed) follow();
			});
		},
		{ passive: true },
	);
	/** Hide the least needed tool groups until the toolbar fits on one row. */
	function fitToolbar() {
		const groups = [...toolbar.querySelectorAll<HTMLElement>(".group")];
		for (const group of groups) group.hidden = false;
		for (let priority = 6; priority > 1; priority--) {
			if (toolbar.scrollWidth <= toolbar.clientWidth) break;
			for (const group of groups)
				if (Number(group.dataset.priority) === priority) group.hidden = true;
		}
	}
	const observer =
		typeof ResizeObserver === "function"
			? new ResizeObserver(() => {
					fitToolbar();
					if (draft && available && !destroyed) measure();
				})
			: undefined;
	observer?.observe(grid);
	observer?.observe(toolbar);
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
	/** Leaving the page: keep a safety copy and save what is finished. */
	const leaving = () => {
		if (!unsaved()) return;
		void retainDraft();
		if (dirty) {
			retryAt = 0;
			void save();
		}
	};
	const onVisibility = () => {
		if (document.visibilityState === "hidden") leaving();
	};
	const onOnline = () => {
		if (!saveError || !dirty) return;
		retryAt = 0;
		void save();
	};
	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (!unsaved()) return;
		leaving();
		event.preventDefault();
		event.returnValue = "";
	};
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("pagehide", leaving);
	window.addEventListener("online", onOnline);
	window.addEventListener("beforeunload", beforeUnload);
	const settled = () =>
		Promise.allSettled([saving, ...pendingDraftWrites, draftQueue]);
	try {
		const context = await bridge.call<{
			role: string;
			workspaceId: string;
			grants: { slot: string; operations: string[] }[];
			settings?: { slot?: string };
		}>("context");
		workspaceId = context.workspaceId;
		slot = context.settings?.slot ?? "";
		sync = createOutputSync<Content, Saved>(bridge, slot);
		canEdit =
			(context.role === "owner" || context.role === "build") &&
			context.grants?.some(
				(grant) =>
					grant.slot === slot && grant.operations.includes("outputs.write"),
			) === true;
		await load();
		fitToolbar();
		if (available) measure();
	} catch (error) {
		fatal = text(error);
		restStatus();
		controls();
	}
	return {
		dispose() {
			if (destroyed) return settled();
			closeMenu?.();
			// Finished changes are saved on the way out; text still being typed is
			// kept as a draft for the next visit.
			if (editable() && unsaved()) {
				closing = {
					content: snapshotDraft(),
					raw: !!editing || formulaDirty,
					version: generation,
				};
				void retainDraft();
				if (dirty && !reviewing) {
					retryAt = 0;
					void save();
				}
			}
			destroyed = true;
			generation++;
			for (const timer of [
				calcTimer,
				retainTimer,
				saveTimer,
				slowTimer,
				statusTimer,
				litTimer,
				offerTimer,
			])
				clearTimeout(timer);
			input.stop();
			observer?.disconnect();
			document.removeEventListener("mouseup", mouseup);
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("message", onMessage);
			window.removeEventListener("pagehide", leaving);
			window.removeEventListener("online", onOnline);
			window.removeEventListener("beforeunload", beforeUnload);
			style.remove();
			return settled();
		},
		save: () => save(true),
	};
}
