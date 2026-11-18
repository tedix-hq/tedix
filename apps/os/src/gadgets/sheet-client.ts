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
	detectFilterRange,
	filterChoices,
	filterColumns,
	functionGroups,
	filteredRows,
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
	dragFill,
	fillRange,
	sortFilter,
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
import {
	FUNCTION_HELP,
	callAt,
	signatureArguments,
	cycleReference,
	functionSuggestions,
	referenceSlot,
} from "../lib/formula-assist";
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
	`[role=tab]{position:relative}[role=tab][data-touched]::after{content:"";position:absolute;top:5px;right:5px;width:5px;height:5px;border-radius:50%;background:var(--primary);animation:tab-touch 1.6s var(--ease) both}@keyframes tab-touch{0%{opacity:0;transform:scale(.4)}15%{opacity:1;transform:none}70%{opacity:1}to{opacity:0}}`,
	`.filter-btn{position:absolute;right:2px;top:50%;transform:translateY(-50%);z-index:3;width:18px;height:18px;padding:0;border:1px solid var(--line);border-radius:4px;background:var(--surface);color:var(--muted);font-size:10px;line-height:1;cursor:pointer}.filter-btn[data-active]{background:var(--primary);color:var(--bg);border-color:var(--primary)}tr[hidden]{display:none}.filter-menu{min-width:220px}.filter-sorts,.filter-actions{display:flex;gap:6px;padding:4px}.filter-values{max-height:240px;overflow:auto;padding:4px;border-block:1px solid var(--line)}.filter-values label{display:flex;gap:8px;align-items:center;padding:2px 4px}.filter-values span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.filter-values small{color:var(--muted)}`,
	`td.ref-range{box-shadow:inset 0 0 0 1.5px #3478c7;background-image:linear-gradient(color-mix(in srgb,#3478c7 9%,transparent),color-mix(in srgb,#3478c7 9%,transparent))}`,
	`.fn-menu{width:280px;max-height:60vh;overflow:auto}.fn-menu input[type=search]{width:100%;margin-bottom:6px}.fn-head,.fn-item{display:flex;gap:8px;align-items:center;width:100%;padding:5px 8px;border:0;border-radius:6px;background:none;color:var(--fg);text-align:left;cursor:pointer}.fn-head span{flex:1;font-weight:600}.fn-head small,.fn-item small{color:var(--muted)}.fn-item span{flex:1}.fn-head i{transition:transform .15s}.fn-group.open .fn-head i{transform:rotate(90deg)}.fn-group:not(.open) .fn-items{display:none}.fn-head:hover,.fn-item:hover{background:var(--tint,color-mix(in srgb,var(--fg) 8%,transparent))}.fn-empty{padding:8px;color:var(--muted)}`,
	`.formula-help{position:fixed;z-index:30;max-width:min(360px,calc(100vw - 16px));padding:4px;font-size:12.5px;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:0 6px 24px color-mix(in srgb,#000 16%,transparent)}.formula-help button{display:flex;gap:8px;width:100%;padding:4px 8px;border:0;border-radius:5px;background:none;color:var(--fg);text-align:left;cursor:pointer}.formula-help button[aria-selected=true]{background:var(--tint,color-mix(in srgb,var(--fg) 8%,transparent))}.formula-help small{color:var(--muted)}.formula-help .sig{padding:4px 8px}.formula-help .sig .current{color:var(--primary);font-weight:600}td.picking{box-shadow:inset 0 0 0 2px var(--primary);background-image:repeating-linear-gradient(45deg,transparent 0 4px,color-mix(in srgb,var(--primary) 12%,transparent) 4px 8px)}`,
	`td.find-hit{background-image:linear-gradient(color-mix(in srgb,#f0bf2c 30%,transparent),color-mix(in srgb,#f0bf2c 30%,transparent))}td.find-current{background-image:linear-gradient(color-mix(in srgb,#f0bf2c 55%,transparent),color-mix(in srgb,#f0bf2c 55%,transparent))}#find-count[data-bad]{color:var(--danger,#c0262d)}#find-options[data-on]{color:var(--primary)}`,
	`.find{display:flex;gap:6px;align-items:center;padding:6px 8px;font-size:12.5px;border:1px solid var(--line);border-radius:10px;background:var(--surface);box-shadow:0 6px 24px color-mix(in srgb,#000 16%,transparent)}.find input{width:min(240px,50vw)}#find-count{min-width:60px;color:var(--muted);font-variant-numeric:tabular-nums}.fill-grip{position:absolute;right:0;bottom:0;z-index:4;width:7px;height:7px;border-radius:2px;background:var(--primary);border:1px solid var(--bg);cursor:crosshair;touch-action:none;transition:transform .12s}.fill-grip:hover{transform:scale(1.35)}td.fill-preview{background-image:linear-gradient(color-mix(in srgb,var(--primary) 10%,transparent),color-mix(in srgb,var(--primary) 10%,transparent));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--primary) 55%,transparent)}`,
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

/** Most values one column's filter can choose. */
const MAX_FILTER_CHOICES = 500;
/** Narrowest and widest a column can be fitted to its contents. */
const FIT_MIN = 36;
const FIT_MAX = 640;
/** How long an agent's change marks a tab out of view. */
const TOUCH_MS = 1500;
/** Undo steps kept per editor. */
const UNDO_DEPTH = 200;
/** How long this tab remembers cells it saved, to say when someone replaces them. */
const RACE_WINDOW_MS = 3000;
/** A save touching more cells than this (a paste) is not followed cell by cell. */
const RACE_NOTICE_CELLS = 100;

const SHORTCUTS: [string, string][] = [
	["Arrows", "Move; hold Shift to select a range"],
	["Ctrl/⌘ Arrows", "Jump to the edge of the data"],
	["Enter or F2", "Edit the cell; Escape cancels"],
	["Tab, Enter", "Move on, staying inside a selected range"],
	["Ctrl/⌘ C, X, V", "Copy, cut and paste"],
	["Ctrl/⌘ Z, Shift Z", "Undo and redo"],
	["Ctrl/⌘ B, I, U", "Bold, italic and underline"],
	["Ctrl/⌘ D, R", "Fill down and fill right"],
	["Drag the corner square", "Fill the selection down or right"],
	["Ctrl/⌘ F", "Find in the sheet; Enter for the next match"],
	[
		"While writing a formula",
		"Pick a function with ↑ ↓ and Enter; click or drag over cells to add them",
	],
	["Ctrl/⌘ Shift L", "Lock a reference: A1 → $A$1 → A$1 → $A1"],
	["Double-click a column edge", "Fit the column to its contents"],
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
<div class="bar"><div class="toolbar" role="toolbar" aria-label="Sheet tools"><span class="group" data-priority="1">${iconButton('id="undo"', "Undo (Ctrl/⌘ Z)", "undo")}${iconButton('id="redo"', "Redo (Ctrl/⌘ Shift Z)", "redo")}</span><span class="group" data-priority="1">${formatButtons}</span><span class="group" data-priority="3"><input id="font-size" title="Font size" aria-label="Font size" type="number" min="6" max="96" value="13">${colorButton("text-color", "Text color", "textColor", "#202020")}${colorButton("fill-color", "Fill color", "fillColor", "#ffffff")}</span><span class="group" data-priority="4"><span class="hidden-field" inert><select id="align" aria-label="Alignment"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></span>${iconButton('data-align="left"', "Align left", "alignLeft")}${iconButton('data-align="center"', "Align center", "alignCenter")}${iconButton('data-align="right"', "Align right", "alignRight")}${iconButton('data-format="wrap"', "Wrap text", "wrap")}</span><span class="group" data-priority="2"><select id="number-format" title="Number format" aria-label="Number format"><option value="automatic">Automatic</option><option value="number">Number</option><option value="integer">Integer</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="scientific">Scientific</option><option value="date">Date</option><option value="time">Time</option><option value="datetime">Date & time</option><option value="text">Text</option></select><span class="hidden-field" inert><input id="decimals" aria-label="Decimal places" type="number" min="0" max="15" value="2"></span><button type="button" id="dec-less" class="icon text" title="Fewer decimals" aria-label="Fewer decimals">.0</button><button type="button" id="dec-more" class="icon text" title="More decimals" aria-label="More decimals">.00</button></span><span class="group" data-priority="5">${sheetButton('id="sum"', "Sum the selection", "sum")}<button type="button" id="fx" class="icon text" title="Insert function" aria-label="Insert function" aria-haspopup="dialog">ƒx</button><button type="button" id="lock-ref" class="icon text" title="Change locked parts ($A$1 → A$1 → $A1 → A1) (Ctrl/⌘ Shift L)" aria-label="Lock reference">$</button>${iconButton('id="fill-down"', "Fill down (Ctrl/⌘ D)", "fillDown")}${iconButton('id="fill-right"', "Fill right (Ctrl/⌘ R)", "fillRight")}${iconButton('id="sort-asc"', "Sort A to Z", "sortUp")}${iconButton('id="sort-desc"', "Sort Z to A", "sortDown")}<button type="button" id="filter-toggle" class="icon text" title="Filter" aria-label="Filter" aria-pressed="false">Filter</button></span><span class="group" data-priority="6">${iconButton('id="add-row"', "Add row", "addRow")}${iconButton('id="add-column"', "Add column", "addColumn")}${iconButton('id="clear-format"', "Clear formatting", "eraser")}${iconButton('id="clear"', "Clear cells", "clear")}</span><span class="group" data-priority="1">${sheetButton('id="more" aria-haspopup="menu"', "More actions", "more")}</span></div><div class="bar-end"><div class="status" role="status" aria-live="polite" data-state="idle"><i class="dot" aria-hidden="true"></i><span></span></div>${sheetButton('id="help" aria-haspopup="dialog"', "Keyboard shortcuts", "help")}${iconButton('id="download" aria-haspopup="menu"', "Download", "download")}</div></div>
<div class="formula"><input id="range" aria-label="Cell or range" value="A1"><label for="formula">fx</label><input id="formula" aria-label="Formula bar" autocomplete="off" spellcheck="false"></div>
<div class="stage"><div class="grid" tabindex="0" aria-label="Spreadsheet keyboard navigation"><table role="grid" aria-label="Sheet cells" aria-multiselectable="true"><colgroup></colgroup><thead></thead><tbody></tbody></table></div><div class="overlay"><div class="find" role="search" hidden><input id="find-value" type="search" placeholder="Find in sheet" aria-label="Find in sheet" autocomplete="off"><span id="find-count" role="status" aria-live="polite"></span><button type="button" id="find-previous" aria-label="Previous match" title="Previous match (⇧↵)">↑</button><button type="button" id="find-next" aria-label="Next match" title="Next match (↵)">↓</button><button type="button" id="find-options" aria-label="Search options" title="Search options" aria-haspopup="menu">…</button><button type="button" id="find-close" aria-label="Close" title="Close (Esc)">✕</button></div><div id="updates" role="status" aria-live="polite"></div><div class="command" hidden><label id="command-label" for="command-value"></label><input id="command-value"><button type="button" id="command-apply" class="primary">Apply</button><button type="button" id="command-cancel">Cancel</button></div></div></div>
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
		// Invited through a link to edit: that page cannot build an Excel file.
		visitor = false,
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
	/**
	 * Undo and redo steps. Each remembers how many changes from others had
	 * arrived when it was taken, so stepping back replays those changes on top
	 * and never reverts someone else's work.
	 */
	/**
	 * An undo or redo step: the cells an edit changed, as they were, so
	 * stepping back writes exactly those cells and nothing someone else did.
	 * An edit that changed the sheet's shape keeps the whole earlier copy.
	 */
	type CellRecord = {
		sheet: string;
		row: number;
		column: number;
		cell: OsWorkbookSheet["rows"][number][number] | undefined;
	};
	type Step = { content?: Content; seen: number; cells?: CellRecord[] };
	const undo: Step[] = [],
		redo: Step[] = [];
	// Others' changes since the oldest step, in order: the sheet before and after.
	let arrived: Array<{ before: Content; after: Content }> = [],
		arrivedFrom = 0;

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
	/** The saved sheet at `revision`, or undefined when it is no longer stored. */
	const olderSheet = (revision: number) =>
		bridge
			.call<Saved>("outputs.readRevision", { slot, revision })
			.then((value) =>
				value?.revision?.revision === revision &&
				value.revision.content?.kind === "sheet"
					? value.revision.content
					: undefined,
			)
			.catch(() => undefined);
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
		arrived = [];
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
		const before = step();
		change();
		before.cells = changedCells(before.content!, draft!);
		// A cell step needs only its cells, not the whole earlier copy.
		if (before.cells) delete before.content;
		undo.push(before);
		if (undo.length > UNDO_DEPTH) undo.shift();
		redo.length = 0;
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
	// Rows the active sheet's filter hides, recomputed when the sheet changes.
	let hiddenRows = new Set<number>();
	/** A row's height on screen: none while its filter hides it. */
	const shownHeight = (s: OsWorkbookSheet, row: number) =>
		hiddenRows.has(row) ? 0 : rowHeight(s, row);
	const columnWidth = (s: OsWorkbookSheet, column: number) =>
		s.columns[column]?.width ?? COLUMN;
	const columnLeft = (s: OsWorkbookSheet, column: number) => {
		let left = INDEX;
		for (let i = 0; i < column; i++) left += columnWidth(s, i);
		return left;
	};
	// Tabs someone else changed while this person was on another one.
	const touched = new Set<string>();
	let touchTimer: ReturnType<typeof setTimeout> | undefined;
	const fillGrip = document.createElement("span");
	fillGrip.className = "fill-grip";
	fillGrip.setAttribute("aria-hidden", "true");
	fillGrip.title = "Drag to fill";
	fillGrip.onpointerdown = (event) => {
		if (!editable() || !draft) return;
		event.preventDefault();
		event.stopPropagation();
		const start = bounds();
		let target: { row: number; column: number } | undefined;
		const marked: Element[] = [];
		fillGrip.setPointerCapture?.(event.pointerId);
		fillGrip.onpointermove = (move) => {
			const td = document
				.elementFromPoint(move.clientX, move.clientY)
				?.closest<HTMLElement>("td[data-row]");
			if (!td) return;
			target = {
				row: Number(td.dataset.row),
				column: Number(td.dataset.column),
			};
			for (const cell of marked.splice(0)) cell.classList.remove("fill-target");
			const range = fillTarget(start, target);
			for (let row = range.rowStart; row <= range.rowEnd; row++)
				for (let col = range.columnStart; col <= range.columnEnd; col++) {
					const inside =
						row >= start.rowStart &&
						row <= start.rowEnd &&
						col >= start.columnStart &&
						col <= start.columnEnd;
					const cell = inside ? undefined : cellAt(row, col);
					if (cell) {
						cell.classList.add("fill-preview");
						marked.push(cell);
					}
				}
		};
		fillGrip.onpointerup = fillGrip.onpointercancel = (end) => {
			fillGrip.onpointermove =
				fillGrip.onpointerup =
				fillGrip.onpointercancel =
					null;
			for (const cell of marked.splice(0))
				cell.classList.remove("fill-preview");
			if (end.type !== "pointerup" || !target) return;
			const range = fillTarget(start, target);
			if (
				range.rowStart === start.rowStart &&
				range.rowEnd === start.rowEnd &&
				range.columnStart === start.columnStart &&
				range.columnEnd === start.columnEnd
			)
				return;
			tabBounds = undefined;
			selection = {
				anchor: { row: range.rowStart, column: range.columnStart },
				focus: { row: range.rowEnd, column: range.columnEnd },
			};
			rangeWorkbook((w) => dragFill(w, sheet().id, start, range));
		};
	};
	/**
	 * The range a fill-handle drag covers: the selection grown up, down, left
	 * or right, whichever way the pointer went further.
	 */
	function fillTarget(
		start: ReturnType<typeof bounds>,
		to: { row: number; column: number },
	) {
		// Whichever axis the pointer went further outside the selection on.
		const vertical =
				to.row > start.rowEnd
					? to.row - start.rowEnd
					: to.row < start.rowStart
						? start.rowStart - to.row
						: 0,
			horizontal =
				to.column > start.columnEnd
					? to.column - start.columnEnd
					: to.column < start.columnStart
						? start.columnStart - to.column
						: 0;
		if (!vertical && !horizontal) return start;
		return vertical >= horizontal
			? {
					...start,
					rowStart: Math.min(start.rowStart, to.row),
					rowEnd: Math.max(start.rowEnd, to.row),
				}
			: {
					...start,
					columnStart: Math.min(start.columnStart, to.column),
					columnEnd: Math.max(start.columnEnd, to.column),
				};
	}
	/**
	 * Fit columns to what their cells show, each in its own font: the column
	 * double-clicked, or every selected whole column when it is one of them.
	 * The heading does not count; a filter heading leaves room for its button.
	 */
	function fitColumn(col: number) {
		if (!editable() || !draft) return;
		const s = sheet(),
			b = bounds(),
			whole = b.rowStart === 0 && b.rowEnd >= dimensions().rows - 1;
		const columns =
			whole && col >= b.columnStart && col <= b.columnEnd
				? Array.from(
						{ length: b.columnEnd - b.columnStart + 1 },
						(_, i) => b.columnStart + i,
					)
				: [col];
		let probe: CanvasRenderingContext2D | null = null;
		try {
			probe = document.createElement("canvas").getContext("2d");
		} catch {
			// No canvas: estimate from the number of characters.
		}
		const family = getComputedStyle(grid).fontFamily || "sans-serif";
		const measure = (text: string, font: string, size: number) => {
			if (!probe) return text.length * size * 0.55;
			probe.font = `${font} ${size}px ${family}`;
			return probe.measureText(text).width;
		};
		const sizes = columns.map((column) => {
			let widest = 0;
			for (const [row, line] of s.rows.entries()) {
				const cell = line?.[column];
				if (!cell) continue;
				const shown = formatWorkbookNumber(cell, draft!.workbook);
				if (!shown) continue;
				const f = cell.format;
				const weight = f?.bold ? 700 : isErrorValue(cell.value) ? 550 : 400;
				const font = `${f?.italic ? "italic " : ""}${weight}`;
				const lines = f?.wrap ? shown.split("\n") : [shown];
				for (const text of lines)
					widest = Math.max(widest, measure(text, font, f?.fontSize ?? 13));
			}
			if (!widest) return { column, width: COLUMN };
			const room =
				s.filter && filterColumns(s, s.filter).includes(column) ? 22 : 0;
			const width = Math.ceil(
				Math.max(FIT_MIN, Math.min(FIT_MAX, widest + 10 + 8 + room)),
			);
			return { column, width };
		});
		if (sizes.every(({ column, width }) => width === columnWidth(s, column)))
			return;
		workbook((w) => {
			ensure(0, Math.max(...columns));
			return sizes.reduce(
				(next, { column, width }) =>
					resizeColumn(next, sheet().id, column, width),
				w,
			);
		});
	}
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
			th.title = "Select column";
			th.onclick = (event) => {
				selectColumn(col, event.shiftKey);
				grid.focus();
			};
			const handle = document.createElement("span");
			handle.className = "resize";
			handle.setAttribute("aria-label", "Resize column " + letter);
			handle.onclick = (event) => event.stopPropagation();
			handle.ondblclick = (event) => {
				event.stopPropagation();
				fitColumn(col);
			};
			handle.onpointerdown = (event) => {
				if (!editable()) return;
				event.stopPropagation();
				event.preventDefault();
				const x = event.clientX,
					width = columnWidth(s, col),
					size = (to: PointerEvent) =>
						Math.round(Math.max(36, Math.min(640, width + to.clientX - x)));
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
			height = shownHeight(s, row),
			top = row < s.frozenRows ? HEAD + offsets[row]! : -1;
		tr.hidden = height === 0;
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
			td.classList.toggle("find-hit", findHits.has(row + ":" + col));
			td.classList.toggle("find-current", findCurrent === row + ":" + col);
			if (here || td.classList.contains("landed"))
				td.classList.toggle("landed", !!here?.has(row + ":" + col));
			// The filter header carries a button per column for its filter menu.
			const header =
				s.filter?.row === row && filterColumns(s, s.filter).includes(col);
			let button = td.querySelector<HTMLButtonElement>(":scope > .filter-btn");
			if (header && !button) {
				button = document.createElement("button");
				button.type = "button";
				button.className = "filter-btn";
				button.textContent = "▾";
				button.onmousedown = (event) => event.stopPropagation();
				td.append(button);
			} else if (!header && button) button.remove();
			if (button) {
				const active = !!s.filter?.criteria[String(col)]?.length;
				button.dataset.column = String(col);
				button.toggleAttribute("data-active", active);
				button.setAttribute(
					"aria-label",
					`${active ? "Change filter on column" : "Filter column"} ${columnLabel(col)}`,
				);
			}
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
		// The fill handle sits on the selection's bottom-right cell.
		const corner =
			editable() && !editing ? cellAt(b.rowEnd, b.columnEnd) : undefined;
		if (corner) {
			if (fillGrip.parentElement !== corner) corner.append(fillGrip);
		} else fillGrip.remove();
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
	/** Mark the tabs someone else changed that this person has not looked at. */
	function markTabs() {
		touched.delete(sheet().id);
		for (const button of tabButtons.querySelectorAll<HTMLElement>(
			"[data-sheet]",
		)) {
			const changed = touched.has(button.dataset.sheet!);
			button.toggleAttribute("data-touched", changed);
		}
	}
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
		markTabs();
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
		hiddenRows = filteredRows(s);
		q("#filter-toggle").setAttribute("aria-pressed", String(!!s.filter));
		offsets = [0];
		for (let row = 0; row < d.rows; row++)
			offsets.push(offsets[row]! + shownHeight(s, row));
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
		// Rows the filter hides are stepped over, in the direction of travel.
		if (hiddenRows.has(row)) {
			const step = row >= selection.focus.row ? 1 : -1;
			let next = row;
			while (hiddenRows.has(next)) next += step;
			row = next < 0 ? selection.focus.row : next;
		}
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
				height = shownHeight(s, point.row),
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
	// ---- Formula help: suggestions, argument hints, clicked cells, F4 ----
	const help = document.createElement("div");
	help.className = "formula-help";
	help.setAttribute("role", "listbox");
	help.setAttribute("aria-label", "Formula help");
	help.hidden = true;
	help.addEventListener("mousedown", (event) => event.preventDefault());
	root.append(help);
	let helpFor: HTMLInputElement | undefined,
		helpPick = 0,
		helpNames: string[] = [],
		helpStart = 0;
	/** Put `next` in the input with the caret at `caret`, as if typed. */
	function typeInto(input: HTMLInputElement, next: string, caret: number) {
		input.value = next;
		input.setSelectionRange(caret, caret);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	function closeHelp() {
		help.hidden = true;
		helpNames = [];
		helpFor = undefined;
	}
	/** Show what fits the caret: matching functions, or the current call's arguments. */
	function showHelp(input: HTMLInputElement) {
		const caret = input.selectionStart ?? input.value.length;
		const found = functionSuggestions(input.value, caret);
		help.replaceChildren();
		helpFor = input;
		if (found) {
			helpNames = found.names;
			helpStart = found.start;
			helpPick = Math.min(helpPick, helpNames.length - 1);
			help.setAttribute("role", "listbox");
			helpNames.forEach((name, index) => {
				const option = document.createElement("button");
				option.type = "button";
				option.setAttribute("role", "option");
				option.setAttribute("aria-selected", String(index === helpPick));
				option.innerHTML = `<span></span><small></small>`;
				option.firstElementChild!.textContent = name;
				option.lastElementChild!.textContent = FUNCTION_HELP[name]!.about;
				option.onclick = () => chooseHelp(index);
				help.append(option);
			});
		} else {
			helpNames = [];
			helpPick = 0;
			const call = callAt(input.value, caret);
			if (!call) return closeHelp();
			const { signature: text, about } = FUNCTION_HELP[call.name]!;
			const args = signatureArguments(text);
			const signature = document.createElement("div");
			signature.className = "sig";
			signature.setAttribute("role", "note");
			signature.append(`${call.name}(`);
			// The argument being written; past the last, the last stays marked.
			const current = Math.min(call.argument, args.length - 1);
			args.forEach((arg, index) => {
				if (index) signature.append(", ");
				if (index === current) {
					const mark = document.createElement("span");
					mark.className = "current";
					mark.textContent = arg;
					signature.append(mark);
				} else signature.append(arg);
			});
			signature.append(")");
			const line = document.createElement("small");
			line.textContent = about;
			line.style.display = "block";
			signature.append(line);
			help.setAttribute("role", "tooltip");
			help.append(signature);
		}
		help.hidden = false;
		const box = input.getBoundingClientRect();
		help.style.left = `${Math.max(8, Math.min(box.left, innerWidth - help.offsetWidth - 8))}px`;
		help.style.top = `${box.bottom + 4}px`;
	}
	function chooseHelp(index: number) {
		const input = helpFor;
		const name = helpNames[index];
		if (!input || !name) return;
		const caret = input.selectionStart ?? input.value.length;
		const next =
			input.value.slice(0, helpStart) + name + "()" + input.value.slice(caret);
		typeInto(input, next, helpStart + name.length + 1);
		input.focus();
		showHelp(input);
	}
	/** Cycle the $ form of the reference at the caret: A1 → $A$1 → A$1 → $A1 → A1. */
	function lockReference(input?: HTMLInputElement) {
		if (!input || !input.value.startsWith("="))
			return note("Choose a cell reference first");
		const caret = input.selectionStart ?? input.value.length;
		const next = cycleReference(input.value, caret);
		if (!next) return note("Put the caret inside a cell reference");
		typeInto(input, next.text, next.caret);
		input.focus();
	}
	/** The formula being written, in the cell or the formula bar, if any. */
	const formulaInput = () =>
		editing ??
		(document.activeElement === formula
			? (formula as HTMLInputElement)
			: undefined);
	/** Put a function in the formula being written, or start one in the active cell. */
	function insertFunction(name: string) {
		const input = formulaInput();
		if (input && input.value.startsWith("=")) {
			const start = input.selectionStart ?? input.value.length,
				end = input.selectionEnd ?? start;
			typeInto(
				input,
				input.value.slice(0, start) + name + "()" + input.value.slice(end),
				start + name.length + 1,
			);
			input.focus();
			return;
		}
		if (!editable()) return;
		startEdit(`=${name}()`);
		const cell = editing as HTMLInputElement | undefined;
		cell?.setSelectionRange(name.length + 2, name.length + 2);
	}
	/** The Insert function menu: groups to open, a search box, Enter for the first match. */
	function openFunctionMenu(owner: HTMLElement) {
		popover(owner, "Insert function", "dialog", (panel, close) => {
			panel.classList.add("fn-menu");
			const search = document.createElement("input");
			search.type = "search";
			search.placeholder = "Search functions";
			search.setAttribute("aria-label", "Search functions");
			panel.append(search);
			const groups = functionGroups(Object.keys(FUNCTION_HELP)).map(
				({ name, functions }, index) => {
					const group = document.createElement("section");
					group.className = "fn-group";
					const head = document.createElement("button");
					head.type = "button";
					head.className = "fn-head";
					head.innerHTML =
						'<span></span><small></small><i aria-hidden="true">›</i>';
					head.children[0]!.textContent = name;
					head.children[1]!.textContent = String(functions.length);
					const items = functions.map((fn) => {
						const item = document.createElement("button");
						item.type = "button";
						item.className = "fn-item";
						item.innerHTML = "<span></span><small></small>";
						item.children[0]!.textContent = fn;
						item.children[1]!.textContent = FUNCTION_HELP[
							fn
						]!.signature.replace(/^[^(]*/, "").slice(0, 26);
						item.onclick = () => {
							close();
							insertFunction(fn);
						};
						return { fn, item };
					});
					const list = document.createElement("div");
					list.className = "fn-items";
					list.append(...items.map(({ item }) => item));
					const toggle = (open: boolean) => {
						group.classList.toggle("open", open);
						head.setAttribute("aria-expanded", String(open));
					};
					head.onclick = () => {
						if (!search.value.trim()) toggle(!group.classList.contains("open"));
					};
					toggle(index === 0);
					group.append(head, list);
					panel.append(group);
					return { group, toggle, items, first: index === 0 };
				},
			);
			const empty = document.createElement("div");
			empty.className = "fn-empty";
			empty.textContent = "No functions found";
			empty.hidden = true;
			panel.append(empty);
			search.oninput = () => {
				const query = search.value.trim().toUpperCase();
				let found = 0;
				for (const { group, toggle, items, first } of groups) {
					let shown = 0;
					for (const { fn, item } of items) {
						const match = !query || fn.includes(query);
						item.hidden = !match;
						if (match) shown++;
					}
					group.hidden = !shown;
					toggle(query ? true : first);
					found += shown;
				}
				empty.hidden = !!found;
			};
			search.onkeydown = (event) => {
				event.stopPropagation();
				if (event.key !== "Enter" || !search.value.trim()) return;
				event.preventDefault();
				const first = groups
					.flatMap(({ items }) => items)
					.find(({ item }) => !item.hidden);
				if (first) {
					close();
					insertFunction(first.fn);
				}
			};
			requestAnimationFrame(() => search.focus());
		});
	}
	const refMarks: Element[] = [];
	/** Outline every range the formula being written refers to on this sheet. */
	function markReferences(text: string) {
		for (const cell of refMarks.splice(0)) cell.classList.remove("ref-range");
		if (!text.startsWith("=")) return;
		const pattern =
			/(?:'[^']+'!|[A-Za-z0-9_]+!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?/g;
		const index = (letters: string) =>
			[...letters.toUpperCase()].reduce(
				(sum, char) => sum * 26 + char.charCodeAt(0) - 64,
				0,
			) - 1;
		for (const match of text.matchAll(pattern)) {
			// References to other sheets are not on this grid.
			if (match[0].includes("!")) continue;
			const [, c1 = "", r1 = "", c2 = c1, r2 = r1] = match;
			const top = Math.min(Number(r1), Number(r2)) - 1,
				bottom = Math.max(Number(r1), Number(r2)) - 1,
				left = Math.min(index(c1), index(c2)),
				right = Math.max(index(c1), index(c2));
			if (bottom - top > 500 || right - left > 100) continue;
			for (let row = top; row <= bottom; row++)
				for (let column = left; column <= right; column++) {
					const cell = cellAt(row, column);
					if (cell) {
						cell.classList.add("ref-range");
						refMarks.push(cell);
					}
				}
		}
	}
	/** Give a formula input suggestions and argument hints. */
	function assist(input: HTMLInputElement) {
		const refresh = () => {
			if (input.value.startsWith("=") && document.activeElement === input)
				showHelp(input);
			else if (helpFor === input) closeHelp();
			markReferences(document.activeElement === input ? input.value : "");
		};
		input.addEventListener("input", refresh);
		input.addEventListener("click", refresh);
		input.addEventListener("keyup", (event) => {
			if (event.key.startsWith("Arrow") && !helpNames.length) refresh();
		});
		input.addEventListener("blur", () => {
			if (helpFor === input) closeHelp();
			markReferences("");
		});
		// Runs before the input's own keys, so a picked suggestion is not also
		// taken as Enter or Tab.
		input.addEventListener(
			"keydown",
			(event) => {
				if (event.isComposing) return;
				if (
					(event.ctrlKey || event.metaKey) &&
					event.shiftKey &&
					event.key.toLowerCase() === "l"
				) {
					event.preventDefault();
					event.stopImmediatePropagation();
					lockReference(input);
					return;
				}
				if (!helpNames.length || helpFor !== input) return;
				const stop = () => {
					event.preventDefault();
					event.stopImmediatePropagation();
				};
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					stop();
					helpPick =
						(helpPick +
							(event.key === "ArrowDown" ? 1 : helpNames.length - 1)) %
						helpNames.length;
					showHelp(input);
				} else if (event.key === "Enter" || event.key === "Tab") {
					stop();
					chooseHelp(helpPick);
				} else if (event.key === "Escape") {
					stop();
					closeHelp();
				}
			},
			true,
		);
	}
	/**
	 * The formula being written that a click on a cell adds to, and where its
	 * reference goes; undefined when a click should just select the cell.
	 */
	function pickTarget() {
		const input =
			editing ??
			(document.activeElement === formula
				? (formula as HTMLInputElement)
				: undefined);
		if (!input || !input.value.startsWith("=")) return undefined;
		const caret = input.selectionStart ?? input.value.length;
		const slot = referenceSlot(input.value, caret);
		return slot ? { input, slot } : undefined;
	}
	let picking:
		| {
				input: HTMLInputElement;
				start: number;
				anchor: { row: number; column: number };
				end: number;
		  }
		| undefined;
	const pickMarks: Element[] = [];
	/** Write the picked cell or range into the formula and outline it. */
	function placePick(focus: { row: number; column: number }) {
		if (!picking) return;
		const { input, start, anchor, end } = picking;
		const range =
			focus.row === anchor.row && focus.column === anchor.column
				? cellLabel(anchor)
				: `${cellLabel({ row: Math.min(anchor.row, focus.row), column: Math.min(anchor.column, focus.column) })}:${cellLabel({ row: Math.max(anchor.row, focus.row), column: Math.max(anchor.column, focus.column) })}`;
		const next = input.value.slice(0, start) + range + input.value.slice(end);
		picking.end = start + range.length;
		typeInto(input, next, picking.end);
		for (const cell of pickMarks.splice(0)) cell.classList.remove("picking");
		for (
			let row = Math.min(anchor.row, focus.row);
			row <= Math.max(anchor.row, focus.row);
			row++
		)
			for (
				let column = Math.min(anchor.column, focus.column);
				column <= Math.max(anchor.column, focus.column);
				column++
			) {
				const cell = cellAt(row, column);
				if (cell) {
					cell.classList.add("picking");
					pickMarks.push(cell);
				}
			}
	}
	function clearPickMarks() {
		for (const cell of pickMarks.splice(0)) cell.classList.remove("picking");
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
		assist(input);
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
	const step = (): Step => ({
		content: structuredClone(draft!),
		seen: arrivedFrom + arrived.length,
	});
	/** Note someone else's change, so undo steps taken before it keep it. */
	function arrive(before: Content, after: Content) {
		if (!undo.length && !redo.length) {
			arrivedFrom += arrived.length;
			arrived = [];
			return;
		}
		arrived.push({ before, after: structuredClone(after) });
		// Changes older than every remaining step are never replayed again.
		const oldest = Math.min(...[...undo, ...redo].map((entry) => entry.seen));
		if (oldest > arrivedFrom) {
			arrived = arrived.slice(oldest - arrivedFrom);
			arrivedFrom = oldest;
		}
	}
	/** A step's sheet with every change from others since it was taken. */
	function replay(entry: Step): Content {
		let content = entry.content!;
		for (const change of arrived.slice(Math.max(0, entry.seen - arrivedFrom))) {
			const result = mergeOutputContent(change.before, content, change.after, {
				prefer: "theirs",
			});
			content = result.ok ? (result.content as Content) : change.after;
		}
		return content;
	}
	/**
	 * The cells that differ between two copies of the workbook when only cell
	 * contents changed; undefined when the shape did (tabs, sizes, rows added).
	 */
	function changedCells(
		before: Content,
		after: Content,
	): CellRecord[] | undefined {
		const a = before.workbook!.sheets,
			b = after.workbook!.sheets;
		if (a.length !== b.length) return undefined;
		const records: CellRecord[] = [];
		for (let index = 0; index < b.length; index++) {
			const old = a[index]!,
				now = b[index]!;
			const { rows: oldRows, ...oldShape } = old,
				{ rows: newRows, ...newShape } = now;
			if (JSON.stringify(oldShape) !== JSON.stringify(newShape))
				return undefined;
			const height = Math.max(oldRows.length, newRows.length);
			for (let row = 0; row < height; row++) {
				const was = oldRows[row],
					is = newRows[row];
				if (
					was === is ||
					JSON.stringify(was ?? null) === JSON.stringify(is ?? null)
				)
					continue;
				const width = Math.max(was?.length ?? 0, is?.length ?? 0);
				for (let column = 0; column < width; column++)
					if (
						JSON.stringify(was?.[column] ?? null) !==
						JSON.stringify(is?.[column] ?? null)
					)
						records.push({
							sheet: now.id,
							row,
							column,
							cell: structuredClone(was?.[column] ?? undefined),
						});
			}
		}
		return records;
	}
	/** Write recorded cells back, returning what they held, for the opposite step. */
	function writeCells(records: CellRecord[]): CellRecord[] {
		return records.map(({ sheet: id, row, column, cell }) => {
			const target = draft!.workbook!.sheets.find((item) => item.id === id);
			const current = target?.rows[row]?.[column];
			if (target) {
				while (target.rows.length <= row) target.rows.push([]);
				const line = target.rows[row]!;
				while (line.length <= column) line.push(null);
				line[column] = cell ? structuredClone(cell) : null;
			}
			return {
				sheet: id,
				row,
				column,
				cell: structuredClone(current ?? undefined),
			};
		});
	}
	function history(from: Step[], to: Step[]) {
		if (!editable()) return;
		commitCell();
		commitFormula();
		if (!from.length) return;
		const entry = from.pop()!;
		if (entry.cells) {
			// Only the recorded cells change, even if someone edited them since;
			// the tab in view stays.
			const opposite = writeCells(entry.cells);
			to.push({ seen: arrivedFrom + arrived.length, cells: opposite });
		} else {
			to.push(step());
			const active = draft!.workbook!.activeSheetId;
			draft = replay(entry);
			if (draft.workbook!.sheets.some((item) => item.id === active))
				draft.workbook!.activeSheetId = active;
		}
		mark();
		syncGrid();
		scheduleCalculation();
	}
	function switchTab(id: string) {
		if (busy || !draft || !available || destroyed) return;
		commitCell();
		commitFormula();
		if (id === sheet().id) return;
		touched.delete(id);
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
	/** Set or remove the active sheet's filter, as one undo step that saves. */
	function setFilter(filter: OsWorkbookSheet["filter"]) {
		const id = sheet().id;
		workbook((w) => ({
			...w,
			sheets: w.sheets.map((item) => {
				if (item.id !== id) return item;
				const next = { ...item, filter };
				if (!filter) delete next.filter;
				return next;
			}),
		}));
	}
	/** Turn the filter on (finding the table and its header) or off. */
	function toggleFilter() {
		if (!editable() || !draft) return;
		if (sheet().filter) return setFilter(undefined);
		const found = detectFilterRange(sheet(), bounds(), selection.focus);
		if (!found)
			return note("Choose a range that includes column headings", true);
		setFilter(found);
	}
	/** One column's filter: sort, and choose which values show. */
	function openFilter(anchor: HTMLElement, column: number) {
		const s = sheet(),
			filter = s.filter;
		if (!filter) return;
		const choices = filterChoices(s, column, (cell) =>
			formatWorkbookNumber(cell, draft!.workbook),
		);
		const current = filter.criteria[String(column)] ?? [];
		const everything = !current.length;
		popover(
			anchor,
			`Column ${columnLabel(column)}`,
			"dialog",
			(panel, close) => {
				panel.classList.add("filter-menu");
				const heading = document.createElement("div");
				heading.className = "filter-head";
				heading.textContent = `Column ${columnLabel(column)}`;
				const sorts = document.createElement("div");
				sorts.className = "filter-sorts";
				const sortedBy =
					filter.sort?.column === column ? filter.sort.direction : null;
				for (const [label, direction, disabled] of [
					["Sort A → Z", "asc", false],
					["Sort Z → A", "desc", false],
					["Original order", null, !filter.sort],
				] as const) {
					const sort = document.createElement("button");
					sort.type = "button";
					sort.setAttribute("role", "menuitemcheckbox");
					sort.setAttribute(
						"aria-checked",
						String(direction !== null && sortedBy === direction),
					);
					sort.textContent = `${direction !== null && sortedBy === direction ? "✓ " : ""}${label}`;
					sort.disabled = disabled || !editable();
					sort.onclick = () => {
						close();
						workbook((w) => sortFilter(w, sheet().id, column, direction));
					};
					sorts.append(sort);
				}
				const list = document.createElement("div");
				list.className = "filter-values";
				const boxes: Array<{
					token: string;
					label: string;
					box: HTMLInputElement;
					row: HTMLElement;
				}> = [];
				if (!choices.length) {
					const empty = document.createElement("div");
					empty.className = "filter-empty";
					empty.textContent = "There are no values under this heading";
					list.append(empty);
				}
				for (const { token, label } of choices) {
					const row = document.createElement("label");
					row.title = label;
					const box = document.createElement("input");
					box.type = "checkbox";
					box.checked = everything || current.includes(token);
					const text = document.createElement("span");
					text.textContent = label;
					row.append(box, text);
					list.append(row);
					boxes.push({ token, label, box, row });
				}
				const apply = document.createElement("button");
				apply.type = "button";
				apply.className = "primary";
				apply.textContent = "Apply";
				apply.disabled = !editable();
				panel.append(heading, sorts, document.createElement("hr"));
				if (boxes.length > 6) {
					const search = document.createElement("input");
					search.type = "search";
					search.placeholder = "Search values";
					search.setAttribute("aria-label", "Search filter values");
					search.oninput = () => {
						const query = search.value.trim().toLowerCase();
						for (const entry of boxes)
							entry.row.hidden =
								!!query && !entry.label.toLowerCase().includes(query);
					};
					search.onkeydown = (event) => {
						event.stopPropagation();
						if (event.key === "Enter") {
							event.preventDefault();
							apply.click();
						}
					};
					panel.append(search);
					requestAnimationFrame(() => search.focus());
				}
				if (boxes.length > 1) {
					const links = document.createElement("div");
					links.className = "filter-links";
					const all = document.createElement("button");
					all.type = "button";
					all.textContent = `Select all ${boxes.length}`;
					all.onclick = () =>
						boxes.forEach((entry) => (entry.box.checked = true));
					const none = document.createElement("button");
					none.type = "button";
					none.textContent = "Clear";
					none.onclick = () =>
						boxes.forEach((entry) => (entry.box.checked = false));
					links.append(all, none);
					panel.append(links);
				}
				panel.append(list);
				const actions = document.createElement("div");
				actions.className = "filter-actions";
				if (current.length) {
					const reset = document.createElement("button");
					reset.type = "button";
					reset.textContent = "Reset";
					reset.onclick = () => {
						close();
						const now = sheet().filter;
						if (!now) return;
						const criteria = { ...now.criteria };
						delete criteria[String(column)];
						setFilter({ ...now, criteria });
					};
					actions.append(reset);
				}
				apply.onclick = () => {
					const now = sheet().filter;
					if (!now) return close();
					const chosen = boxes
						.filter((entry) => entry.box.checked)
						.map((entry) => entry.token);
					if (
						chosen.length !== boxes.length &&
						chosen.length > MAX_FILTER_CHOICES
					) {
						note(
							`Choose no more than ${MAX_FILTER_CHOICES} values, or clear enough choices to stay under the limit`,
							true,
						);
						return;
					}
					close();
					const criteria = { ...now.criteria };
					if (chosen.length === boxes.length) delete criteria[String(column)];
					else
						criteria[String(column)] = chosen.length ? chosen : ["x:__none__"];
					setFilter({ ...now, criteria });
				};
				actions.append(apply);
				panel.append(actions);
			},
		);
	}
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
						: "Column width (36–640)",
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
			case "filter-create":
			case "filter-remove":
				toggleFilter();
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
			sheet().filter
				? act("Remove filter", "filter-remove")
				: act("Create a filter", "filter-create"),
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
			...(visitor
				? []
				: [
						{
							label: "Excel file",
							action: "xlsx",
							run: () => void download("xlsx"),
						},
						{ label: "PDF", action: "pdf", run: () => void download("pdf") },
						{
							label: "PDF with title and revision",
							action: "pdf-revision",
							run: () => void download("pdf", true),
						},
					]),
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
		// Writing a formula: a click adds the cell to it instead of moving there.
		const target = pickTarget();
		if (target) {
			event.preventDefault();
			const at = {
				row: Number(td.dataset.row),
				column: Number(td.dataset.column),
			};
			picking = {
				input: target.input,
				start: target.slot.start,
				end: target.slot.end,
				anchor: at,
			};
			placePick(at);
			return;
		}
		commitCell();
		event.preventDefault();
		dragging = true;
		choose(Number(td.dataset.row), Number(td.dataset.column), event.shiftKey);
		grid.focus();
	});
	table.addEventListener("mouseover", (event) => {
		if (picking) {
			const td = (event.target as Element).closest<HTMLElement>("td[data-row]");
			if (td)
				placePick({
					row: Number(td.dataset.row),
					column: Number(td.dataset.column),
				});
			return;
		}
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
	table.addEventListener("click", (event) => {
		const button = (event.target as Element).closest<HTMLButtonElement>(
			".filter-btn",
		);
		if (button) openFilter(button, Number(button.dataset.column));
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
	// ---- Find: searches what cells show and hold, on this sheet or all ----
	const findBar = q(".find"),
		findInput = q<HTMLInputElement>("#find-value"),
		findCount = q("#find-count"),
		findOptions = q<HTMLButtonElement>("#find-options");
	const findState = {
		matchCase: false,
		wholeCell: false,
		formulas: false,
		allSheets: false,
	};
	let matches: Array<{ sheet: string; row: number; column: number }> = [],
		matchAt = -1,
		filteredMatches = 0;
	// Cells on the sheet in view that match, and the current one, for their tint.
	let findHits = new Set<string>(),
		findCurrent = "";
	function findTest() {
		const query = findState.matchCase
			? findInput.value
			: findInput.value.toLocaleLowerCase();
		return (text: string) => {
			const value = findState.matchCase ? text : text.toLocaleLowerCase();
			return findState.wholeCell ? value === query : value.includes(query);
		};
	}
	/** Every match in reading order: sheet order, then rows, then columns. */
	function search() {
		const query = findInput.value;
		matches = [];
		filteredMatches = 0;
		if (query && draft?.workbook) {
			const test = findTest();
			const sheets = findState.allSheets
				? draft.workbook.sheets
				: draft.workbook.sheets.filter((item) => item.id === sheet().id);
			for (const item of sheets) {
				const hidden = item.id === sheet().id ? hiddenRows : filteredRows(item);
				item.rows.forEach((line, row) =>
					line?.forEach((cell, column) => {
						if (!cell) return;
						const input = cell.input ?? "";
						const shown = formatWorkbookNumber(cell, draft!.workbook);
						const formula = input.startsWith("=");
						const hit =
							test(shown) ||
							(!formula && test(input)) ||
							(formula && findState.formulas && test(input));
						if (!hit) return;
						if (hidden.has(row)) filteredMatches++;
						else matches.push({ sheet: item.id, row, column });
					}),
				);
			}
		}
		// Typing goes to the first match at or after the active cell.
		const here = selection.focus;
		const next = matches.findIndex(
			(match) =>
				(match.sheet === sheet().id &&
					(match.row > here.row ||
						(match.row === here.row && match.column >= here.column))) ||
				(findState.allSheets &&
					draft!.workbook!.sheets.findIndex((item) => item.id === match.sheet) >
						draft!.workbook!.sheets.findIndex(
							(item) => item.id === sheet().id,
						)),
		);
		matchAt = -1;
		if (matches.length) showMatch(0, next < 0 ? 0 : next);
		else countFind();
		paintFind();
	}
	function countFind() {
		const query = findInput.value;
		findCount.removeAttribute("data-bad");
		findCount.title =
			filteredMatches === 0
				? ""
				: matches.length
					? `${filteredMatches} more ${filteredMatches === 1 ? "match is" : "matches are"} in rows hidden by a filter`
					: `${filteredMatches} ${filteredMatches === 1 ? "result is" : "results are"} in rows hidden by a filter`;
		if (!query) findCount.textContent = "";
		else if (!matches.length) {
			findCount.textContent = filteredMatches
				? "Hidden by filter"
				: "Nothing found";
			findCount.setAttribute("data-bad", "");
		} else
			findCount.textContent =
				matchAt >= 0
					? `${matchAt + 1} of ${matches.length}`
					: `${matches.length} found`;
	}
	/** Tint the matches on the sheet in view; the current one more strongly. */
	function paintFind() {
		findHits = new Set(
			findBar.hidden
				? []
				: matches
						.filter((match) => match.sheet === sheet().id)
						.map((match) => `${match.row}:${match.column}`),
		);
		const current = matches[matchAt];
		findCurrent =
			!findBar.hidden && current && current.sheet === sheet().id
				? `${current.row}:${current.column}`
				: "";
		for (const [row, tr] of rowEls)
			for (const [col, slot] of slots) {
				const td = tr.children[slot];
				if (!td) continue;
				const key = `${row}:${col}`;
				td.classList.toggle("find-hit", findHits.has(key));
				td.classList.toggle("find-current", findCurrent === key);
			}
	}
	function showMatch(by: number, at?: number) {
		if (!matches.length) return countFind();
		matchAt =
			at ??
			(Math.max(matchAt, by < 0 ? 0 : -1) + by + matches.length) %
				matches.length;
		const match = matches[matchAt]!;
		if (match.sheet !== sheet().id) switchTab(match.sheet);
		tabBounds = undefined;
		selection = {
			anchor: { row: match.row, column: match.column },
			focus: { row: match.row, column: match.column },
		};
		const d = dimensions();
		if (match.row >= d.rows || match.column >= d.columns) syncGrid();
		else selectionChanged();
		reveal();
		countFind();
		paintFind();
	}
	function openFind() {
		findBar.hidden = false;
		findInput.select();
		findInput.focus();
		if (findInput.value) search();
	}
	function closeFind() {
		findBar.hidden = true;
		matches = [];
		paintFind();
		grid.focus();
	}
	function syncFindOptions() {
		findOptions.toggleAttribute(
			"data-on",
			findState.matchCase ||
				findState.wholeCell ||
				findState.formulas ||
				findState.allSheets,
		);
		findInput.placeholder = findState.allSheets
			? "Find in all sheets"
			: "Find in sheet";
	}
	findOptions.onclick = () =>
		popover(findOptions, "Search options", "menu", (panel, close) => {
			const option = (label: string, on: boolean, run: () => void) => {
				const button = document.createElement("button");
				button.type = "button";
				button.setAttribute("role", "menuitemcheckbox");
				button.setAttribute("aria-checked", String(on));
				button.textContent = `${on ? "✓ " : ""}${label}`;
				button.onclick = () => {
					close();
					run();
					syncFindOptions();
					search();
					findInput.focus();
				};
				panel.append(button);
			};
			option(
				"Match case",
				findState.matchCase,
				() => (findState.matchCase = !findState.matchCase),
			);
			option(
				"Match entire cell",
				findState.wholeCell,
				() => (findState.wholeCell = !findState.wholeCell),
			);
			option(
				"Also search formulas",
				findState.formulas,
				() => (findState.formulas = !findState.formulas),
			);
			panel.append(document.createElement("hr"));
			option(
				"This sheet",
				!findState.allSheets,
				() => (findState.allSheets = false),
			);
			option(
				"All sheets",
				findState.allSheets,
				() => (findState.allSheets = true),
			);
		});
	findInput.oninput = search;
	findInput.onkeydown = (event) => {
		event.stopPropagation();
		const mod = event.ctrlKey || event.metaKey;
		if (event.key === "Enter" || (mod && event.key.toLowerCase() === "g")) {
			event.preventDefault();
			showMatch(event.shiftKey ? -1 : 1);
		} else if (event.key === "Escape") {
			event.preventDefault();
			closeFind();
		}
	};
	q("#find-next").onclick = () => showMatch(1);
	q("#find-previous").onclick = () => showMatch(-1);
	q("#find-close").onclick = closeFind;
	grid.onkeydown = (event) => {
		if (event.isComposing || editing || !draft || busy || !available) return;
		const mod = event.ctrlKey || event.metaKey,
			key = event.key.toLowerCase();
		if (mod && key === "f") {
			event.preventDefault();
			openFind();
			return;
		}
		if (mod && key === "g" && !findBar.hidden) {
			event.preventDefault();
			showMatch(event.shiftKey ? -1 : 1);
			return;
		}
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
	assist(formula as HTMLInputElement);
	q("#fx").addEventListener("mousedown", (event) => event.preventDefault());
	q("#lock-ref").addEventListener("mousedown", (event) =>
		event.preventDefault(),
	);
	q("#fx").onclick = (event) =>
		openFunctionMenu(event.currentTarget as HTMLElement);
	q("#filter-toggle").onclick = () => toggleFilter();
	q("#lock-ref").onclick = () => lockReference(formulaInput());
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
	function light(before: Content, agent = false) {
		const old = new Map(
			before.workbook?.sheets.map((item) => [item.id, item.rows]),
		);
		const found = new Map<string, Set<string>>();
		// A cell with nothing in it is the same as no cell: a grid that grew
		// has not changed where it is still empty.
		const print = (
			cell:
				| { input?: unknown; format?: unknown; value?: unknown }
				| null
				| undefined,
		) =>
			cell && (cell.input || cell.format || cell.value != null)
				? JSON.stringify(cell)
				: "";
		let first: { id: string; row: number; column: number } | undefined;
		for (const item of draft!.workbook!.sheets) {
			const rows = old.get(item.id);
			const cells = new Set<string>();
			item.rows.forEach((line, row) =>
				line.forEach((cell, column) => {
					if (print(rows?.[row]?.[column]) === print(cell)) return;
					cells.add(row + ":" + column);
					first ??= { id: item.id, row, column };
				}),
			);
			if (cells.size) found.set(item.id, cells);
		}
		if (!first) return;
		lit = found;
		// An agent's change to a tab out of view marks it for a moment.
		if (agent) {
			for (const id of found.keys()) if (id !== sheet().id) touched.add(id);
			markTabs();
			clearTimeout(touchTimer);
			touchTimer = setTimeout(() => {
				touched.clear();
				if (!destroyed && draft) markTabs();
			}, TOUCH_MS);
		}
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
		light(before, agent);
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
	/**
	 * Cells this tab saved a moment ago, so a later save by someone else that
	 * replaces them is said out loud instead of changing them unseen.
	 */
	const recentSaves = new Map<string, { input: string; at: number }>();
	function rememberSaved(before: Content | undefined, after: Content) {
		const now = Date.now();
		for (const [key, entry] of recentSaves)
			if (now - entry.at > RACE_WINDOW_MS) recentSaves.delete(key);
		const changed: Array<[string, string]> = [];
		for (const item of after.workbook?.sheets ?? []) {
			const old = before?.workbook?.sheets.find((row) => row.id === item.id);
			item.rows.forEach((line, row) =>
				line.forEach((cell, column) => {
					const input = cell?.input ?? "";
					if ((old?.rows[row]?.[column]?.input ?? "") !== input)
						changed.push([`${item.id}!${row}:${column}`, input]);
				}),
			);
			if (changed.length > RACE_NOTICE_CELLS) return;
		}
		for (const [key, input] of changed)
			recentSaves.set(key, { input, at: now });
	}
	/** Say so when someone else's save just replaced cells this tab saved. */
	function noticeReplaced(incoming: Content, agent: boolean) {
		if (agent || !recentSaves.size) return;
		const now = Date.now();
		const replaced: Array<{
			sheet: OsWorkbookSheet;
			row: number;
			column: number;
		}> = [];
		for (const item of incoming.workbook?.sheets ?? [])
			item.rows.forEach((line, row) =>
				line.forEach((cell, column) => {
					const key = `${item.id}!${row}:${column}`,
						saved = recentSaves.get(key);
					if (!saved || now - saved.at > RACE_WINDOW_MS) return;
					recentSaves.delete(key);
					if ((cell?.input ?? "") !== saved.input)
						replaced.push({ sheet: item, row, column });
				}),
			);
		if (!replaced.length) return;
		const first = replaced[0]!,
			ref = cellLabel({ row: first.row, column: first.column }),
			name = first.sheet.id === sheet().id ? ref : `${first.sheet.name}!${ref}`;
		note(
			replaced.length === 1
				? `${name} changed elsewhere after your edit, so the other value is shown`
				: `${replaced.length} cells changed elsewhere after your edits, so the other values are shown`,
			true,
			2200,
		);
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
			arrive(before!, draft!);
			noticeReplaced(content, savedByAgent(latest.revision));
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
			// Where both changed one cell, this unsaved edit is the later one and
			// wins, without a question.
			const result = mergeOutputContent(base, draft, theirs, {
				prefer: prefer ?? "mine",
			});
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
			arrive(before!, draft!);
			noticeReplaced(theirs, savedByAgent(latest.revision));
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
			// Changes kept from an older revision merge into the newer saved
			// sheet cell by cell; a question is left only when the same cells
			// changed or that older revision is no longer stored.
			let combined: Content | undefined;
			if (retained && kept && retained.revision !== result.revision.revision) {
				const older = await olderSheet(retained.revision);
				const merged = older
					? mergeOutputContent(await evaluate(older), kept, saved)
					: undefined;
				if (destroyed) return;
				if (merged?.ok) combined = await evaluate(merged.content as Content);
				if (destroyed) return;
			}
			retainedConflict =
				retained && retained.revision !== result.revision.revision && !combined
					? retained
					: undefined;
			const matching =
				combined ?? (retained && !retainedConflict ? kept : undefined);
			draft = matching ?? saved;
			basis = result.revision.revision;
			available = true;
			fatal = saveError = "";
			dirty = !!matching;
			formulaDirty = false;
			saveDeadline = retryDelay = retryAt = 0;
			undo.length = redo.length = 0;
			arrived = [];
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
			const sentFrom = loaded?.revision.content;
			const result = parse(await sync.save(content, basis, readSheet, flash));
			rememberSaved(sentFrom, content);
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
			} else {
				// Changes made while saving stay on top of what the server kept. Its
				// answer can hold other people's saves that it merged in; without
				// them here, the next save would put the older cells back.
				const theirs = await evaluate(result.revision.content);
				if (!destroyed && draft) {
					const merged = mergeOutputContent(content, draft, theirs, {
						prefer: "mine",
					});
					if (merged.ok) {
						const before = draft;
						adopt(merged.content as Content);
						generation++;
						arrive(before, draft);
						noticeReplaced(theirs, savedByAgent(result.revision));
						land(before, savedByAgent(result.revision));
						scheduleCalculation();
						syncGrid();
						showLanded();
					}
				}
				void retainDraft();
			}
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
	async function download(
		kind: "csv" | "xlsx" | "pdf",
		revisionHeader = false,
	) {
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
					format: kind,
					...(revisionHeader ? { revisionHeader: true } : {}),
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
		// A picked range stays outlined only while it is being chosen.
		if (picking) {
			const input = picking.input;
			picking = undefined;
			clearPickMarks();
			input.focus();
		}
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
		visitor = context.role === "edit";
		canEdit =
			(context.role === "owner" ||
				context.role === "build" ||
				context.role === "edit") &&
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
