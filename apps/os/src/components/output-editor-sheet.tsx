import {
	ArrowElbowDownLeft,
	ArrowUDownLeft,
	ArrowUDownRight,
	Copy,
	Function as FunctionIcon,
	PaintBucket,
	Plus,
	SortAscending,
	SortDescending,
	TextAa,
	TextAlignCenter,
	TextAlignLeft,
	TextAlignRight,
	TextB,
	TextItalic,
	TextStrikethrough,
	TextUnderline,
	Trash,
} from "@phosphor-icons/react";
import type {
	OsWorkbook,
	OsWorkbookCell,
	OsWorkbookCellFormat,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { CollabParticipant, CollabSelection } from "@/collab/presence";
import { collabParticipantColor } from "@/components/canvas-presence";
import { EditorTextDialog } from "@/components/editor-text-dialog";
import { Button } from "@/components/kumo/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/kumo/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Input } from "@/components/kumo/input";
import { Textarea } from "@/components/kumo/textarea";
import {
	EditorHistoryNotice,
	EditorToolbar,
	EditorToolbarButton,
	EditorToolbarColorButton,
	EditorToolbarDivider,
} from "@/components/output-editor-toolbar";
import {
	WorkbookResizeHandle,
	WorkbookStructureControls,
} from "@/components/workbook-structure-controls";
import { isImeComposing } from "@/lib/keyboard";
import {
	activeWorkbookSheet,
	createOutputNodeId,
	normalizeSheetContent,
	projectWorkbook,
	type SheetContent,
} from "@/lib/output-models";
import {
	boundsContain,
	type Bounds,
	cellLabel,
	clampCoordinate,
	columnLabel,
	type Coordinate,
	type CopiedCells,
	copyBounds,
	functionGroups,
	jumpToDataEdge,
	moveWithinSelection,
	parseClipboardTable,
	parseRangeLabel,
	presenceToSheetSelection,
	rangeLabel,
	type Selection,
	selectedBounds,
	sheetSelectionToPresence,
} from "@/lib/sheet-grid";
import { SheetNumberFormatToolbar } from "@/components/sheet-number-format-toolbar";
import { osSpreadsheetLocale } from "@/lib/format";
import { SHEET_HISTORY } from "@/lib/output-history";
import { useEditorHistory } from "@/lib/use-editor-history";
import {
	autoSum,
	DEFAULT_ROW_HEIGHT,
	deleteColumns,
	deleteRows,
	deleteSheet,
	duplicateSheet,
	frozenCellStyle,
	HEADER_HEIGHT,
	insertColumns,
	insertRows,
	renameSheet,
	resizeColumn,
	resizeRow,
	sortRange,
} from "@/lib/workbook-structure";
import {
	evaluateWorkbook,
	formatWorkbookValue,
	WORKBOOK_FUNCTION_NAMES,
	WORKBOOK_SUPPORTED_FORMULA_COUNT,
} from "@/lib/workbook-formulas";

const SHEET_MAX_ROWS = 1000;
const SHEET_MAX_COLUMNS = 64;
const SHEET_CELL_MAX_LENGTH = 4000;
const PAGE_ROWS = 20;

type RenameTarget =
	| { kind: "column"; index: number; value: string }
	| { kind: "sheet"; id: string; value: string };

/** An open cell edit. `origin` is where the user is typing. */
interface EditState {
	coordinate: Coordinate;
	text: string;
	origin: "cell" | "formula";
}

type Advance = "down" | "up" | "right" | "left" | "none";
type DragMode = "cell" | "row" | "column";

const ADVANCE: Record<Advance, Coordinate> = {
	down: { row: 1, column: 0 },
	up: { row: -1, column: 0 },
	right: { row: 0, column: 1 },
	left: { row: 0, column: -1 },
	none: { row: 0, column: 0 },
};

const ARROWS: Record<string, Coordinate> = {
	ArrowUp: { row: -1, column: 0 },
	ArrowDown: { row: 1, column: 0 },
	ArrowLeft: { row: 0, column: -1 },
	ArrowRight: { row: 0, column: 1 },
};

const FUNCTION_GROUPS = functionGroups(WORKBOOK_FUNCTION_NAMES);

function emptyCell(): OsWorkbookCell {
	return { input: "", value: null };
}

function ensureGrid(workbook: OsWorkbook): OsWorkbook {
	return {
		...workbook,
		sheets: workbook.sheets.map((sheet) => {
			const columns = [...sheet.columns];
			while (columns.length < 10) {
				const index = columns.length;
				columns.push({
					id: `column-${index + 1}`,
					label: columnLabel(index),
					width: 120,
				});
			}
			const rows = sheet.rows.map((row) =>
				columns.map((_, index) => row[index] ?? emptyCell()),
			);
			while (rows.length < 30) rows.push(columns.map(() => emptyCell()));
			return { ...sheet, columns, rows };
		}),
	};
}

function replaceSheet(
	workbook: OsWorkbook,
	nextSheet: OsWorkbookSheet,
): OsWorkbook {
	return {
		...workbook,
		sheets: workbook.sheets.map((sheet) =>
			sheet.id === nextSheet.id ? nextSheet : sheet,
		),
	};
}

function updateCells(
	workbook: OsWorkbook,
	bounds: Bounds,
	update: (cell: OsWorkbookCell, row: number, column: number) => OsWorkbookCell,
): OsWorkbook {
	const sheet = activeWorkbookSheet(workbook);
	const rows = sheet.rows.map((row, rowIndex) =>
		row.map((cell, columnIndex) =>
			boundsContain(bounds, rowIndex, columnIndex)
				? update(cell ?? emptyCell(), rowIndex, columnIndex)
				: cell,
		),
	);
	return replaceSheet(workbook, { ...sheet, rows });
}

function workbookWithCell(
	workbook: OsWorkbook,
	coordinate: Coordinate,
	input: string,
	format?: OsWorkbookCellFormat,
): OsWorkbook {
	return updateCells(
		workbook,
		{
			rowStart: coordinate.row,
			rowEnd: coordinate.row,
			columnStart: coordinate.column,
			columnEnd: coordinate.column,
		},
		(cell) => ({
			...cell,
			input: input.slice(0, SHEET_CELL_MAX_LENGTH),
			...(format ? { format } : {}),
		}),
	);
}

function cellStyle(cell: OsWorkbookCell) {
	const format = cell.format;
	return {
		background: format?.fillColor ?? "var(--tedix-sheet-paper)",
		color: format?.textColor,
		textAlign:
			format?.horizontalAlign ??
			(typeof cell.value === "number" ? "right" : undefined),
		fontWeight: format?.bold ? 700 : undefined,
		fontStyle: format?.italic ? "italic" : undefined,
		textDecoration:
			[
				format?.underline ? "underline" : "",
				format?.strike ? "line-through" : "",
			]
				.filter(Boolean)
				.join(" ") || undefined,
	} as const;
}

function dataIndex(element: Element | null, name: string): number | null {
	const value = element?.getAttribute(name);
	return value === null || value === undefined ? null : Number(value);
}

/** Collab presence for a sheet: peers' selections in, ours out. */
export interface SheetEditorPresence {
	participants: CollabParticipant[];
	onSelectionChange: (selection: CollabSelection | null) => void;
}

interface SheetEditorProps {
	value: SheetContent;
	onChange: (next: SheetContent) => void;
	disabled?: boolean;
	presence?: SheetEditorPresence;
}

export function SheetEditor({
	value,
	onChange,
	disabled = false,
	presence,
}: SheetEditorProps) {
	const normalized = useMemo(() => normalizeSheetContent(value), [value]);
	const storedWorkbook = useMemo(
		() =>
			value.workbook ? normalized.workbook! : ensureGrid(normalized.workbook!),
		[normalized.workbook, value.workbook],
	);
	// Which tab is open is view state, not a document edit: switching tabs must
	// not recalculate, snapshot, diff or sync the whole workbook.
	const [viewSheetId, setViewSheetId] = useState(storedWorkbook.activeSheetId);
	const workbook = useMemo(
		() =>
			storedWorkbook.sheets.some((item) => item.id === viewSheetId)
				? { ...storedWorkbook, activeSheetId: viewSheetId }
				: storedWorkbook,
		[storedWorkbook, viewSheetId],
	);
	const sheet = activeWorkbookSheet(workbook);
	const rowCount = sheet.rows.length;
	const columnCount = sheet.columns.length;
	const [selection, setSelection] = useState<Selection>({
		anchor: { row: 0, column: 0 },
		focus: { row: 0, column: 0 },
	});
	const [editing, setEditingState] = useState<EditState | null>(null);
	const editingRef = useRef<EditState | null>(null);
	const [nameDraft, setNameDraft] = useState<string | null>(null);
	const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
	const [menuTabId, setMenuTabId] = useState<string | null>(null);
	const gridRef = useRef<HTMLTableElement>(null);
	const focusCellRef = useRef(false);
	const dragRef = useRef<DragMode | null>(null);
	// The last in-sheet copy. A paste whose text matches it restores inputs and
	// formats instead of the computed values the system clipboard carries.
	const copiedRef = useRef<CopiedCells | null>(null);
	const history = useEditorHistory(normalized, onChange, SHEET_HISTORY);
	const [sortHasHeader, setSortHasHeader] = useState(false);
	const bounds = selectedBounds(selection);
	const selectedCell =
		sheet.rows[selection.focus.row]?.[selection.focus.column] ?? emptyCell();

	const setEditing = (next: EditState | null) => {
		editingRef.current = next;
		setEditingState(next);
	};

	const commitWorkbook = (next: OsWorkbook) => {
		// A structure change can shrink the sheet under the selection.
		const active = activeWorkbookSheet(next);
		const clamp = (point: Coordinate) =>
			clampCoordinate(point, active.rows.length, active.columns.length);
		setSelection((current) => ({
			anchor: clamp(current.anchor),
			focus: clamp(current.focus),
		}));
		history.commit(projectWorkbook(evaluateWorkbook(next)));
	};
	const commitFormat = (format: Partial<OsWorkbookCellFormat>) => {
		if (disabled) return;
		const located = {
			...workbook,
			locale: workbook.locale ?? osSpreadsheetLocale() ?? navigator.language,
		};
		commitWorkbook(
			updateCells(located, bounds, (cell) => ({
				...cell,
				format: { ...cell.format, ...format },
			})),
		);
	};

	// Return keyboard focus to the active cell after the render that moved it.
	useEffect(() => {
		if (!focusCellRef.current || editing) return;
		focusCellRef.current = false;
		gridRef.current
			?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')
			?.focus();
	});

	useEffect(() => {
		const stop = () => {
			dragRef.current = null;
		};
		window.addEventListener("mouseup", stop);
		return () => window.removeEventListener("mouseup", stop);
	}, []);

	const publishSelection = presence?.onSelectionChange;
	const sheetId = sheet.id;
	const { row: anchorRow, column: anchorColumn } = selection.anchor;
	const { row: focusRow, column: focusColumn } = selection.focus;
	useEffect(() => {
		publishSelection?.(
			sheetSelectionToPresence(sheetId, {
				anchor: { row: anchorRow, column: anchorColumn },
				focus: { row: focusRow, column: focusColumn },
			}),
		);
	}, [
		publishSelection,
		sheetId,
		anchorRow,
		anchorColumn,
		focusRow,
		focusColumn,
	]);
	useEffect(() => () => publishSelection?.(null), [publishSelection]);

	const select = (next: Selection) => {
		setSelection({
			anchor: clampCoordinate(next.anchor, rowCount, columnCount),
			focus: clampCoordinate(next.focus, rowCount, columnCount),
		});
		setNameDraft(null);
		focusCellRef.current = true;
	};
	const moveTo = (point: Coordinate, extend = false) =>
		select(
			extend
				? { anchor: selection.anchor, focus: point }
				: { anchor: point, focus: point },
		);

	const startEdit = (
		origin: EditState["origin"],
		seed?: string,
		coordinate = selection.focus,
	) => {
		if (disabled) return;
		const cell = sheet.rows[coordinate.row]?.[coordinate.column];
		setEditing({ coordinate, origin, text: seed ?? cell?.input ?? "" });
	};

	const commitEdit = (advance: Advance) => {
		const current = editingRef.current;
		if (!current) return;
		setEditing(null);
		const previous =
			sheet.rows[current.coordinate.row]?.[current.coordinate.column]?.input ??
			"";
		// One undo step per edit: the workbook changes only here, never per key.
		if (current.text !== previous) {
			commitWorkbook(
				workbookWithCell(workbook, current.coordinate, current.text),
			);
			history.seal();
		}
		const multi =
			bounds.rowStart !== bounds.rowEnd ||
			bounds.columnStart !== bounds.columnEnd;
		if (multi && (advance === "down" || advance === "up")) {
			select(
				moveWithinSelection(selection, advance === "down" ? 1 : -1, "row"),
			);
		} else if (multi && (advance === "right" || advance === "left")) {
			select(
				moveWithinSelection(selection, advance === "right" ? 1 : -1, "column"),
			);
		} else {
			const delta = ADVANCE[advance];
			moveTo({
				row: current.coordinate.row + delta.row,
				column: current.coordinate.column + delta.column,
			});
		}
	};

	const cancelEdit = () => {
		if (!editingRef.current) return;
		setEditing(null);
		focusCellRef.current = true;
	};

	const updateEditText = (text: string) => {
		const current = editingRef.current;
		if (current) setEditing({ ...current, text });
	};

	const clearSelection = () => {
		if (disabled) return;
		commitWorkbook(
			updateCells(workbook, bounds, (cell) => ({ ...cell, input: "" })),
		);
	};

	const copySelection = () => {
		const copied = copyBounds(sheet, bounds);
		copiedRef.current = copied;
		return copied.tsv;
	};

	const writeClipboard = (text: string) =>
		void navigator.clipboard?.writeText(text).catch(() => undefined);

	const pasteText = (text: string) => {
		if (disabled) return;
		const copied = copiedRef.current?.tsv === text ? copiedRef.current : null;
		const table = copied
			? copied.cells.map((row) => row.map((cell) => cell.input))
			: parseClipboardTable(text);
		const origin = { row: bounds.rowStart, column: bounds.columnStart };
		let next = workbook;
		let lastRow = origin.row;
		let lastColumn = origin.column;
		for (const [rowOffset, row] of table.entries()) {
			for (const [columnOffset, input] of row.entries()) {
				const coordinate = {
					row: origin.row + rowOffset,
					column: origin.column + columnOffset,
				};
				if (coordinate.row >= rowCount || coordinate.column >= columnCount)
					continue;
				next = workbookWithCell(
					next,
					coordinate,
					input,
					copied?.cells[rowOffset]?.[columnOffset]?.format,
				);
				lastRow = Math.max(lastRow, coordinate.row);
				lastColumn = Math.max(lastColumn, coordinate.column);
			}
		}
		commitWorkbook(next);
		select({ anchor: origin, focus: { row: lastRow, column: lastColumn } });
	};

	const pasteFromClipboard = async () => {
		try {
			const text = await navigator.clipboard.readText();
			pasteText(text);
		} catch {
			// Clipboard read was refused; Cmd+V still works through the paste event.
		}
	};

	const addSheet = () => {
		const id = createOutputNodeId("sheet");
		const nextSheet: OsWorkbookSheet = {
			id,
			name: `Sheet${workbook.sheets.length + 1}`,
			columns: sheet.columns.map((column, index) => ({
				...column,
				id: `${id}-column-${index + 1}`,
			})),
			rows: Array.from({ length: 30 }, () =>
				sheet.columns.map(() => emptyCell()),
			),
			frozenRows: 0,
			frozenColumns: 0,
		};
		commitWorkbook({
			...workbook,
			activeSheetId: id,
			sheets: [...workbook.sheets, nextSheet],
		});
		openSheet(id);
	};

	const openSheet = (id: string) => {
		commitEdit("none");
		setViewSheetId(id);
		setSelection({
			anchor: { row: 0, column: 0 },
			focus: { row: 0, column: 0 },
		});
	};

	const removeSheet = (id: string) => {
		if (disabled || workbook.sheets.length <= 1) return;
		const next = deleteSheet(workbook, id);
		commitWorkbook(next);
		if (next.activeSheetId !== sheet.id) openSheet(next.activeSheetId);
	};

	const copySheet = (id: string) => {
		if (disabled || workbook.sheets.length >= 32) return;
		const next = duplicateSheet(workbook, id);
		commitWorkbook(next);
		openSheet(next.activeSheetId);
	};

	const sortRows = (direction: 1 | -1) => {
		if (disabled) return;
		commitWorkbook(
			sortRange(
				workbook,
				sheet.id,
				bounds,
				selection.focus.column,
				direction === 1 ? "ascending" : "descending",
				sortHasHeader,
			),
		);
	};

	const rowSpan = bounds.rowEnd - bounds.rowStart + 1;
	const columnSpan = bounds.columnEnd - bounds.columnStart + 1;
	const structure = (next: () => OsWorkbook) => {
		if (!disabled) commitWorkbook(next());
	};

	const applyRename = (value: string) => {
		if (!renameTarget) return;
		if (renameTarget.kind === "column") {
			commitWorkbook(
				replaceSheet(workbook, {
					...sheet,
					columns: sheet.columns.map((item, index) =>
						index === renameTarget.index ? { ...item, label: value } : item,
					),
				}),
			);
			return;
		}
		commitWorkbook(renameSheet(workbook, renameTarget.id, value));
	};

	const onGridKeyDown = (event: ReactKeyboardEvent<HTMLTableElement>) => {
		if (
			editingRef.current ||
			(event.target as HTMLElement).getAttribute("role") !== "gridcell" ||
			isImeComposing(event)
		)
			return;
		const meta = event.metaKey || event.ctrlKey;
		const key = event.key;
		const focus = selection.focus;
		if (meta) {
			const arrow = ARROWS[key];
			if (arrow) {
				event.preventDefault();
				moveTo(jumpToDataEdge(sheet, focus, arrow), event.shiftKey);
				return;
			}
			const shortcuts: Record<string, () => void> = {
				a: () =>
					select({
						anchor: { row: 0, column: 0 },
						focus: { row: rowCount - 1, column: columnCount - 1 },
					}),
				b: () => commitFormat({ bold: !selectedCell.format?.bold }),
				i: () => commitFormat({ italic: !selectedCell.format?.italic }),
				u: () => commitFormat({ underline: !selectedCell.format?.underline }),
				z: () =>
					disabled
						? undefined
						: event.shiftKey
							? history.redo()
							: history.undo(),
				y: () => (disabled ? undefined : history.redo()),
			};
			const action = shortcuts[key.toLowerCase()];
			if (action) {
				event.preventDefault();
				action();
			}
			// Cmd+C / X / V travel through the copy, cut and paste events.
			return;
		}
		const arrow = ARROWS[key];
		if (arrow) {
			event.preventDefault();
			if (
				key === "ArrowDown" &&
				focus.row === rowCount - 1 &&
				!disabled &&
				rowCount < 1000
			) {
				commitWorkbook(insertRows(workbook, sheet.id, rowCount));
				const next = { row: rowCount, column: focus.column };
				setSelection({
					anchor: event.shiftKey ? selection.anchor : next,
					focus: next,
				});
				setNameDraft(null);
				focusCellRef.current = true;
				return;
			}
			moveTo(
				{ row: focus.row + arrow.row, column: focus.column + arrow.column },
				event.shiftKey,
			);
			return;
		}
		const multi =
			bounds.rowStart !== bounds.rowEnd ||
			bounds.columnStart !== bounds.columnEnd;
		switch (key) {
			case "Tab":
				event.preventDefault();
				if (multi)
					select(
						moveWithinSelection(selection, event.shiftKey ? -1 : 1, "column"),
					);
				else
					moveTo({
						row: focus.row,
						column: focus.column + (event.shiftKey ? -1 : 1),
					});
				return;
			case "Enter":
				event.preventDefault();
				if (multi)
					select(
						moveWithinSelection(selection, event.shiftKey ? -1 : 1, "row"),
					);
				else startEdit("cell");
				return;
			case "F2":
				event.preventDefault();
				startEdit("cell");
				return;
			case "Home":
				event.preventDefault();
				moveTo({ row: focus.row, column: 0 }, event.shiftKey);
				return;
			case "End":
				event.preventDefault();
				moveTo({ row: focus.row, column: columnCount - 1 }, event.shiftKey);
				return;
			case "PageDown":
				event.preventDefault();
				moveTo(
					{ row: focus.row + PAGE_ROWS, column: focus.column },
					event.shiftKey,
				);
				return;
			case "PageUp":
				event.preventDefault();
				moveTo(
					{ row: focus.row - PAGE_ROWS, column: focus.column },
					event.shiftKey,
				);
				return;
			case "Delete":
			case "Backspace":
				event.preventDefault();
				clearSelection();
				return;
		}
		if (key.length === 1 && !event.altKey && !disabled) {
			// Typing into a selected cell replaces it, as in every spreadsheet.
			event.preventDefault();
			startEdit("cell", key);
		}
	};

	const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
		event.stopPropagation();
		if (isImeComposing(event)) return;
		if (event.key === "Enter" && event.altKey) {
			event.preventDefault();
			const target = event.currentTarget as
				| HTMLTextAreaElement
				| HTMLInputElement;
			const text = editingRef.current?.text ?? "";
			const start = target.selectionStart ?? text.length;
			const end = target.selectionEnd ?? text.length;
			updateEditText(`${text.slice(0, start)}\n${text.slice(end)}`);
			requestAnimationFrame(() =>
				target.setSelectionRange(start + 1, start + 1),
			);
		} else if (event.key === "Enter") {
			event.preventDefault();
			commitEdit(event.shiftKey ? "up" : "down");
		} else if (event.key === "Tab") {
			event.preventDefault();
			commitEdit(event.shiftKey ? "left" : "right");
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancelEdit();
		}
	};

	const coordinateOf = (target: EventTarget | null) => {
		const cell = (target as Element | null)?.closest?.("[data-cell-row]");
		const row = dataIndex(cell ?? null, "data-cell-row");
		const column = dataIndex(cell ?? null, "data-cell-column");
		return row === null || column === null ? null : { row, column };
	};

	const onGridMouseDown = (event: ReactMouseEvent<HTMLTableElement>) => {
		if (event.button !== 0) return;
		const target = event.target as Element;
		if (target.closest('textarea, input, [role="separator"]')) return;
		const lastRow = rowCount - 1;
		const lastColumn = columnCount - 1;
		if (target.closest("[data-select-all]")) {
			event.preventDefault();
			commitEdit("none");
			select({
				anchor: { row: 0, column: 0 },
				focus: { row: lastRow, column: lastColumn },
			});
			return;
		}
		const columnHeader = dataIndex(
			target.closest("[data-column-header]"),
			"data-column-header",
		);
		if (columnHeader !== null) {
			event.preventDefault();
			commitEdit("none");
			const anchorColumn = event.shiftKey
				? selection.anchor.column
				: columnHeader;
			select({
				anchor: { row: 0, column: anchorColumn },
				focus: { row: lastRow, column: columnHeader },
			});
			dragRef.current = "column";
			return;
		}
		const rowHeader = dataIndex(
			target.closest("[data-row-header]"),
			"data-row-header",
		);
		if (rowHeader !== null) {
			event.preventDefault();
			commitEdit("none");
			const anchorRow = event.shiftKey ? selection.anchor.row : rowHeader;
			select({
				anchor: { row: anchorRow, column: 0 },
				focus: { row: rowHeader, column: lastColumn },
			});
			dragRef.current = "row";
			return;
		}
		const coordinate = coordinateOf(target);
		if (!coordinate) return;
		event.preventDefault();
		commitEdit("none");
		moveTo(coordinate, event.shiftKey);
		dragRef.current = "cell";
	};

	const onGridMouseOver = (event: ReactMouseEvent<HTMLTableElement>) => {
		const mode = dragRef.current;
		if (!mode) return;
		const target = event.target as Element;
		const coordinate = coordinateOf(target);
		const columnHeader = dataIndex(
			target.closest("[data-column-header]"),
			"data-column-header",
		);
		const rowHeader = dataIndex(
			target.closest("[data-row-header]"),
			"data-row-header",
		);
		let next: Selection | null = null;
		if (mode === "column") {
			const column = coordinate?.column ?? columnHeader;
			if (column !== null && column !== undefined)
				next = {
					anchor: selection.anchor,
					focus: { row: rowCount - 1, column },
				};
		} else if (mode === "row") {
			const row = coordinate?.row ?? rowHeader;
			if (row !== null && row !== undefined)
				next = {
					anchor: selection.anchor,
					focus: { row, column: columnCount - 1 },
				};
		} else if (coordinate) {
			next = { anchor: selection.anchor, focus: coordinate };
		}
		if (
			next &&
			(next.focus.row !== selection.focus.row ||
				next.focus.column !== selection.focus.column)
		)
			select(next);
	};

	const onGridContextMenu = (event: ReactMouseEvent<HTMLTableElement>) => {
		commitEdit("none");
		const coordinate = coordinateOf(event.target);
		if (coordinate && !boundsContain(bounds, coordinate.row, coordinate.column))
			moveTo(coordinate);
	};

	const onNameBoxKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (isImeComposing(event)) return;
		if (event.key === "Enter") {
			event.preventDefault();
			const parsed = parseRangeLabel(nameDraft ?? "", rowCount, columnCount);
			if (parsed) select(parsed);
			else setNameDraft(null);
		} else if (event.key === "Escape") {
			event.preventDefault();
			setNameDraft(null);
			focusCellRef.current = true;
		}
	};

	const peers = (presence?.participants ?? []).flatMap((participant) => {
		const peerSelection = presenceToSheetSelection(
			participant.selection,
			sheet.id,
		);
		return peerSelection
			? [
					{
						key: participant.key,
						name: participant.displayName,
						color: collabParticipantColor(participant.key),
						bounds: selectedBounds(peerSelection),
						label: rangeLabel(peerSelection),
					},
				]
			: [];
	});

	const insertFunction = (name: string) => startEdit("cell", `=${name}(`);
	const menuTab = workbook.sheets.find((tab) => tab.id === menuTabId);

	return (
		<div
			className="sheet-editor grid min-w-0 gap-0"
			data-editor="workbook"
			// Leaving a cell or the formula bar ends its undo step.
			onBlur={history.seal}
		>
			<EditorToolbar>
				<EditorToolbarButton
					label="Undo"
					disabled={disabled || !history.canUndo}
					onClick={history.undo}
				>
					<ArrowUDownLeft size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Redo"
					disabled={disabled || !history.canRedo}
					onClick={history.redo}
				>
					<ArrowUDownRight size={15} />
				</EditorToolbarButton>
				<EditorHistoryNotice notice={history.notice} />
				<EditorToolbarDivider />
				<EditorToolbarButton
					label="Bold"
					active={selectedCell.format?.bold}
					disabled={disabled}
					onClick={() => commitFormat({ bold: !selectedCell.format?.bold })}
				>
					<TextB size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Italic"
					active={selectedCell.format?.italic}
					disabled={disabled}
					onClick={() => commitFormat({ italic: !selectedCell.format?.italic })}
				>
					<TextItalic size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Underline"
					active={selectedCell.format?.underline}
					disabled={disabled}
					onClick={() =>
						commitFormat({ underline: !selectedCell.format?.underline })
					}
				>
					<TextUnderline size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Strikethrough"
					active={selectedCell.format?.strike}
					disabled={disabled}
					onClick={() => commitFormat({ strike: !selectedCell.format?.strike })}
				>
					<TextStrikethrough size={15} />
				</EditorToolbarButton>
				<EditorToolbarDivider />
				{/*
				 * Cell colours are chosen against the sheet's fixed-light paper, so
				 * the swatch bar is ringed in that paper token rather than a shell
				 * token.
				 */}
				<EditorToolbarColorButton
					label="Cell text color"
					swatchRingClassName="ring-(--tedix-sheet-paper)"
					disabled={disabled}
					color={selectedCell.format?.textColor ?? "#1d1d20"}
					onChange={(textColor) => commitFormat({ textColor })}
				>
					<TextAa size={14} />
				</EditorToolbarColorButton>
				<EditorToolbarColorButton
					label="Cell fill color"
					swatchRingClassName="ring-(--tedix-sheet-paper)"
					disabled={disabled}
					color={selectedCell.format?.fillColor ?? "#ffffff"}
					onChange={(fillColor) => commitFormat({ fillColor })}
				>
					<PaintBucket size={14} />
				</EditorToolbarColorButton>
				<EditorToolbarDivider />
				{(
					[
						["Align left", "left", TextAlignLeft],
						["Align center", "center", TextAlignCenter],
						["Align right", "right", TextAlignRight],
					] as const
				).map(([label, align, Icon]) => (
					<EditorToolbarButton
						key={align}
						label={label}
						active={selectedCell.format?.horizontalAlign === align}
						disabled={disabled}
						onClick={() => commitFormat({ horizontalAlign: align })}
					>
						<Icon size={15} />
					</EditorToolbarButton>
				))}
				<EditorToolbarButton
					label="Wrap text"
					active={selectedCell.format?.wrap}
					disabled={disabled}
					onClick={() =>
						commitFormat({ wrap: selectedCell.format?.wrap ? undefined : true })
					}
				>
					<ArrowElbowDownLeft size={15} />
				</EditorToolbarButton>
				<EditorToolbarDivider />
				<SheetNumberFormatToolbar
					context={workbook}
					format={selectedCell.format}
					disabled={disabled}
					onChange={commitFormat}
				/>
				<EditorToolbarDivider />
				<EditorToolbarButton
					label="Auto sum"
					disabled={disabled}
					onClick={() => commitWorkbook(autoSum(workbook, sheet.id, bounds))}
				>
					<FunctionIcon size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Sort ascending"
					disabled={disabled}
					onClick={() => sortRows(1)}
				>
					<SortAscending size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Sort descending"
					disabled={disabled}
					onClick={() => sortRows(-1)}
				>
					<SortDescending size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Copy selection"
					onClick={() => writeClipboard(copySelection())}
				>
					<Copy size={15} />
				</EditorToolbarButton>
			</EditorToolbar>
			{/*
			 * The desk is deliberately OUTSIDE the fixed-light page below.
			 * `--tedix-desk` is a `light-dark()` token, so a desk nested
			 * inside `color-scheme: light` would resolve to its light branch in a
			 * dark shell and the recess would vanish.
			 *
			 * Formula bar, grid and tabs are one page, not three rows. Splitting
			 * the formula bar off left a dark desk band sandwiched between light
			 * chrome and a light grid, which reads as a rendering bug rather than
			 * a design: shell-polarity toolbar, desk, then the whole sheet.
			 */}
			<div className="sheet-editor-desk">
				<div className="sheet-page sheet-editor-page">
					<div className="sheet-editor-formula grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-1">
						<div className="col-span-full flex flex-wrap items-center gap-2">
							<Button
								size="xs"
								variant="ghost"
								disabled={disabled}
								aria-pressed={sortHasHeader}
								onClick={() => setSortHasHeader(!sortHasHeader)}
							>
								Selection has header
							</Button>
							<WorkbookStructureControls
								workbook={workbook}
								range={bounds}
								disabled={disabled}
								onChange={commitWorkbook}
							/>
						</div>
						<Input
							aria-label="Selected cell"
							value={nameDraft ?? rangeLabel(selection)}
							onFocus={(event) => {
								setNameDraft(rangeLabel(selection));
								event.currentTarget.select();
							}}
							onChange={(event) => setNameDraft(event.target.value)}
							onBlur={() => setNameDraft(null)}
							onKeyDown={onNameBoxKeyDown}
							className="font-mono"
							size="sm"
						/>
						<div className="flex min-w-0 items-center gap-1">
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											aria-label="Insert function"
											size="icon-xs"
											variant="ghost"
											disabled={disabled}
										>
											<FunctionIcon size={15} />
										</Button>
									}
								/>
								<DropdownMenuContent align="start" className="max-h-96">
									{FUNCTION_GROUPS.map((group) => (
										<DropdownMenuGroup key={group.name}>
											<DropdownMenuLabel className="text-kumo-subtle type-tedix-label">
												{group.name}
											</DropdownMenuLabel>
											{group.functions.map((name) => (
												<DropdownMenuItem
													key={name}
													className="font-mono"
													onClick={() => insertFunction(name)}
												>
													{name}
												</DropdownMenuItem>
											))}
										</DropdownMenuGroup>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
							<Input
								aria-label="Formula bar"
								value={editing ? editing.text : selectedCell.input}
								disabled={disabled}
								onFocus={() => {
									const current = editingRef.current;
									if (!current) startEdit("formula");
									else if (current.origin !== "formula")
										setEditing({ ...current, origin: "formula" });
								}}
								onChange={(event) => updateEditText(event.target.value)}
								onKeyDown={onEditorKeyDown}
								onBlur={(event) => {
									if (
										!(event.relatedTarget as Element | null)?.closest?.(
											".sheet-editor-cell-editor",
										)
									)
										commitEdit("none");
								}}
								className="font-mono"
								size="sm"
							/>
						</div>
					</div>
					<ContextMenu>
						<ContextMenuTrigger className="sheet-editor-grid max-h-[68vh] overflow-auto border border-kumo-line bg-kumo-base">
							<table
								ref={gridRef}
								role="grid"
								aria-label="Spreadsheet grid"
								aria-multiselectable="true"
								aria-rowcount={rowCount + 1}
								aria-colcount={columnCount + 1}
								className="border-collapse type-tedix-control select-none"
								style={{
									width: sheet.columns.reduce(
										(sum, column) => sum + column.width,
										44,
									),
								}}
								onKeyDown={onGridKeyDown}
								onMouseDown={onGridMouseDown}
								onMouseOver={onGridMouseOver}
								onContextMenu={onGridContextMenu}
								onDoubleClick={(event) => {
									const coordinate = coordinateOf(event.target);
									if (coordinate && !editingRef.current)
										startEdit("cell", undefined, coordinate);
								}}
								onCopy={(event) => {
									if (editingRef.current) return;
									event.preventDefault();
									event.clipboardData.setData("text/plain", copySelection());
								}}
								onCut={(event) => {
									if (editingRef.current) return;
									event.preventDefault();
									event.clipboardData.setData("text/plain", copySelection());
									clearSelection();
								}}
								onPaste={(event) => {
									if (editingRef.current) return;
									event.preventDefault();
									pasteText(event.clipboardData.getData("text/plain"));
								}}
							>
								<thead className="sticky top-0 z-[5] bg-kumo-elevated">
									<tr
										role="row"
										aria-rowindex={1}
										style={{ height: HEADER_HEIGHT }}
									>
										<th
											role="columnheader"
											aria-colindex={1}
											aria-label="Select all"
											data-select-all=""
											className="sticky left-0 z-[3] w-11 border border-kumo-line bg-kumo-elevated"
										/>
										{sheet.columns.map((column, columnIndex) => {
											const columnSelected =
												columnIndex >= bounds.columnStart &&
												columnIndex <= bounds.columnEnd;
											return (
												<th
													key={column.id}
													role="columnheader"
													aria-colindex={columnIndex + 2}
													data-column-header={columnIndex}
													className={`relative cursor-default border border-kumo-line px-2 py-1 font-medium ${columnSelected ? "bg-kumo-tint" : ""}`}
													style={{
														...frozenCellStyle(
															sheet,
															sheet.rows.length,
															columnIndex,
														),
														width: column.width,
														minWidth: column.width,
														...(columnSelected
															? {}
															: { background: "var(--tedix-sheet-paper)" }),
													}}
													title={`${columnLabel(columnIndex)} · ${column.label}. Double-click to rename.`}
													onDoubleClick={() =>
														!disabled &&
														setRenameTarget({
															kind: "column",
															index: columnIndex,
															value: column.label,
														})
													}
												>
													<span className="sheet-editor-column-button block truncate">
														{columnLabel(columnIndex)} · {column.label}
													</span>
													<WorkbookResizeHandle
														label={`Column ${columnIndex + 1} width`}
														axis="column"
														value={column.width}
														disabled={disabled}
														onResize={(width) =>
															commitWorkbook(
																resizeColumn(
																	workbook,
																	sheet.id,
																	columnIndex,
																	width,
																),
															)
														}
													/>
												</th>
											);
										})}
									</tr>
								</thead>
								<tbody>
									{sheet.rows.map((row, rowIndex) => {
										const rowSelected =
											rowIndex >= bounds.rowStart && rowIndex <= bounds.rowEnd;
										const rowHeight =
											sheet.rowHeights?.[rowIndex] ?? DEFAULT_ROW_HEIGHT;
										return (
											<tr
												key={`row-${rowIndex}`}
												role="row"
												aria-rowindex={rowIndex + 2}
												style={{ height: rowHeight }}
											>
												<th
													role="rowheader"
													aria-colindex={1}
													data-row-header={rowIndex}
													className={`sticky left-0 cursor-default border border-kumo-line px-2 text-right font-normal text-kumo-subtle ${rowSelected ? "bg-kumo-tint" : "bg-kumo-elevated"}`}
													style={{
														top: frozenCellStyle(
															sheet,
															rowIndex,
															sheet.columns.length,
														).top,
														zIndex: rowIndex < sheet.frozenRows ? 4 : 3,
													}}
												>
													{rowIndex + 1}
													<WorkbookResizeHandle
														label={`Row ${rowIndex + 1} height`}
														axis="row"
														value={rowHeight}
														disabled={disabled}
														onResize={(height) =>
															commitWorkbook(
																resizeRow(workbook, sheet.id, rowIndex, height),
															)
														}
													/>
												</th>
												{sheet.columns.map((column, columnIndex) => {
													const cell = row[columnIndex] ?? emptyCell();
													const selected = boundsContain(
														bounds,
														rowIndex,
														columnIndex,
													);
													const active =
														selection.focus.row === rowIndex &&
														selection.focus.column === columnIndex;
													const isEditing =
														editing?.coordinate.row === rowIndex &&
														editing.coordinate.column === columnIndex;
													const peer = peers.find((item) =>
														boundsContain(item.bounds, rowIndex, columnIndex),
													);
													const peerLabel =
														peer &&
														peer.bounds.rowStart === rowIndex &&
														peer.bounds.columnStart === columnIndex;
													return (
														<td
															key={`${rowIndex}-${columnIndex}`}
															role="gridcell"
															aria-colindex={columnIndex + 2}
															aria-selected={selected}
															aria-label={`${cellLabel({ row: rowIndex, column: columnIndex })} ${formatWorkbookValue(cell, workbook)}`.trim()}
															tabIndex={active ? 0 : -1}
															data-cell-row={rowIndex}
															data-cell-column={columnIndex}
															className={`relative border border-kumo-line p-0 align-top outline-none ${active ? "ring-2 ring-inset ring-kumo-focus" : ""}`}
															style={{
																...frozenCellStyle(
																	sheet,
																	rowIndex,
																	columnIndex,
																),
																width: column.width,
																minWidth: column.width,
																maxWidth: column.width,
																...cellStyle(cell),
																...(peer
																	? {
																			boxShadow: `inset 0 0 0 2px ${peer.color}`,
																		}
																	: {}),
															}}
														>
															<div
																className="sheet-editor-cell overflow-hidden px-2 py-1"
																style={{
																	[cell.format?.wrap ? "minHeight" : "height"]:
																		rowHeight - 1,
																	whiteSpace: cell.format?.wrap
																		? "pre-wrap"
																		: "nowrap",
																	overflowWrap: cell.format?.wrap
																		? "anywhere"
																		: undefined,
																	textOverflow: cell.format?.wrap
																		? undefined
																		: "ellipsis",
																}}
															>
																{formatWorkbookValue(cell, workbook)}
															</div>
															{selected && !active ? (
																<span
																	aria-hidden="true"
																	className="pointer-events-none absolute inset-0 bg-kumo-focus/10"
																/>
															) : null}
															{peerLabel ? (
																<span
																	className="pointer-events-none absolute top-0 right-0 z-[1] max-w-full truncate rounded-bl px-1 text-white type-tedix-label"
																	style={{ backgroundColor: peer.color }}
																>
																	{peer.name} · {peer.label}
																</span>
															) : null}
															{isEditing && editing ? (
																<Textarea
																	aria-label={`Edit ${cellLabel(editing.coordinate)}`}
																	className="sheet-editor-cell-editor absolute top-0 left-0 z-[4] !min-h-full min-w-full max-w-[32rem] resize-none rounded-none bg-kumo-base px-2 py-1 shadow-tedix-floating ring-2 ring-kumo-focus"
																	style={
																		{
																			fieldSizing: "content",
																			...cellStyle(cell),
																		} as CSSProperties
																	}
																	value={editing.text}
																	ref={(element) => {
																		if (
																			element &&
																			editing.origin === "cell" &&
																			document.activeElement !== element
																		) {
																			element.focus();
																			const end = element.value.length;
																			element.setSelectionRange(end, end);
																		}
																	}}
																	onChange={(event) =>
																		updateEditText(event.target.value)
																	}
																	onKeyDown={onEditorKeyDown}
																	onFocus={() => {
																		const current = editingRef.current;
																		if (current && current.origin !== "cell")
																			setEditing({
																				...current,
																				origin: "cell",
																			});
																	}}
																	onMouseDown={(event) =>
																		event.stopPropagation()
																	}
																	onBlur={(event) => {
																		if (
																			(
																				event.relatedTarget as Element | null
																			)?.getAttribute?.("aria-label") !==
																			"Formula bar"
																		)
																			commitEdit("none");
																	}}
																/>
															) : null}
														</td>
													);
												})}
											</tr>
										);
									})}
								</tbody>
							</table>
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem
								shortcut="⌘X"
								disabled={disabled}
								onClick={() => {
									writeClipboard(copySelection());
									clearSelection();
								}}
							>
								Cut
							</ContextMenuItem>
							<ContextMenuItem
								shortcut="⌘C"
								onClick={() => writeClipboard(copySelection())}
							>
								Copy
							</ContextMenuItem>
							<ContextMenuItem
								shortcut="⌘V"
								disabled={disabled}
								onClick={() => void pasteFromClipboard()}
							>
								Paste
							</ContextMenuItem>
							<ContextMenuSeparator />
							<ContextMenuItem
								disabled={disabled || sheet.rows.length >= SHEET_MAX_ROWS}
								onClick={() =>
									structure(() =>
										insertRows(workbook, sheet.id, bounds.rowStart, rowSpan),
									)
								}
							>
								Insert {rowSpan === 1 ? "row" : `${rowSpan} rows`} above
							</ContextMenuItem>
							<ContextMenuItem
								disabled={disabled || sheet.rows.length >= SHEET_MAX_ROWS}
								onClick={() =>
									structure(() =>
										insertRows(workbook, sheet.id, bounds.rowEnd + 1, rowSpan),
									)
								}
							>
								Insert {rowSpan === 1 ? "row" : `${rowSpan} rows`} below
							</ContextMenuItem>
							<ContextMenuItem
								disabled={disabled || sheet.columns.length >= SHEET_MAX_COLUMNS}
								onClick={() =>
									structure(() =>
										insertColumns(
											workbook,
											sheet.id,
											bounds.columnStart,
											columnSpan,
										),
									)
								}
							>
								Insert {columnSpan === 1 ? "column" : `${columnSpan} columns`}{" "}
								left
							</ContextMenuItem>
							<ContextMenuItem
								disabled={disabled || sheet.columns.length >= SHEET_MAX_COLUMNS}
								onClick={() =>
									structure(() =>
										insertColumns(
											workbook,
											sheet.id,
											bounds.columnEnd + 1,
											columnSpan,
										),
									)
								}
							>
								Insert {columnSpan === 1 ? "column" : `${columnSpan} columns`}{" "}
								right
							</ContextMenuItem>
							<ContextMenuSeparator />
							<ContextMenuItem
								variant="danger"
								disabled={disabled || rowSpan >= sheet.rows.length}
								onClick={() =>
									structure(() =>
										deleteRows(workbook, sheet.id, bounds.rowStart, rowSpan),
									)
								}
							>
								Delete {rowSpan === 1 ? "row" : `${rowSpan} rows`}
							</ContextMenuItem>
							<ContextMenuItem
								variant="danger"
								disabled={disabled || columnSpan >= sheet.columns.length}
								onClick={() =>
									structure(() =>
										deleteColumns(
											workbook,
											sheet.id,
											bounds.columnStart,
											columnSpan,
										),
									)
								}
							>
								Delete {columnSpan === 1 ? "column" : `${columnSpan} columns`}
							</ContextMenuItem>
							<ContextMenuSeparator />
							<ContextMenuItem disabled={disabled} onClick={() => sortRows(1)}>
								Sort ascending
							</ContextMenuItem>
							<ContextMenuItem disabled={disabled} onClick={() => sortRows(-1)}>
								Sort descending
							</ContextMenuItem>
							<ContextMenuItem
								shortcut="Del"
								disabled={disabled}
								onClick={clearSelection}
							>
								Clear contents
							</ContextMenuItem>
						</ContextMenuContent>
					</ContextMenu>
					<div className="sheet-editor-tabs flex flex-wrap items-center justify-between gap-2">
						<ContextMenu>
							<ContextMenuTrigger
								className="flex min-w-0 flex-wrap items-center gap-1"
								onContextMenuCapture={() => setMenuTabId(null)}
							>
								{workbook.sheets.map((tab) => (
									<div key={tab.id} className="flex items-center gap-0.5">
										<Button
											type="button"
											size="xs"
											variant={
												tab.id === workbook.activeSheetId
													? "secondary"
													: "ghost"
											}
											aria-pressed={tab.id === workbook.activeSheetId}
											onClick={() => {
												if (tab.id !== workbook.activeSheetId)
													openSheet(tab.id);
											}}
											onContextMenu={() => setMenuTabId(tab.id)}
											onDoubleClick={() =>
												!disabled &&
												setRenameTarget({
													kind: "sheet",
													id: tab.id,
													value: tab.name,
												})
											}
										>
											{tab.name}
										</Button>
										<Button
											size="icon-xs"
											variant="ghost"
											aria-label={`Duplicate ${tab.name}`}
											disabled={disabled || workbook.sheets.length >= 32}
											onClick={() => copySheet(tab.id)}
										>
											<Copy size={13} />
										</Button>
										<Button
											size="icon-xs"
											variant="ghost"
											aria-label={`Delete ${tab.name}`}
											disabled={disabled || workbook.sheets.length <= 1}
											onClick={() => removeSheet(tab.id)}
										>
											<Trash size={13} />
										</Button>
									</div>
								))}
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									aria-label="Add sheet"
									disabled={disabled || workbook.sheets.length >= 32}
									onClick={addSheet}
								>
									<Plus size={14} />
								</Button>
							</ContextMenuTrigger>
							{menuTab ? (
								<ContextMenuContent>
									<ContextMenuItem
										disabled={disabled}
										onClick={() =>
											setRenameTarget({
												kind: "sheet",
												id: menuTab.id,
												value: menuTab.name,
											})
										}
									>
										Rename
									</ContextMenuItem>
									<ContextMenuItem
										disabled={disabled || workbook.sheets.length >= 32}
										onClick={() => copySheet(menuTab.id)}
									>
										Duplicate
									</ContextMenuItem>
									{workbook.sheets.length > 1 ? (
										<>
											<ContextMenuSeparator />
											<ContextMenuItem
												variant="danger"
												disabled={disabled}
												onClick={() => removeSheet(menuTab.id)}
											>
												Delete
											</ContextMenuItem>
										</>
									) : null}
								</ContextMenuContent>
							) : null}
						</ContextMenu>
						<div className="flex flex-wrap items-center gap-2 text-kumo-subtle type-tedix-label">
							<span>
								{WORKBOOK_SUPPORTED_FORMULA_COUNT}+ Excel-style functions
							</span>
						</div>
					</div>
				</div>
			</div>
			<EditorTextDialog
				open={renameTarget !== null}
				title={
					renameTarget?.kind === "column" ? "Rename column" : "Rename sheet"
				}
				description="Choose a concise name that remains readable in the spreadsheet."
				fieldLabel={
					renameTarget?.kind === "column" ? "Column name" : "Sheet name"
				}
				initialValue={renameTarget?.value ?? ""}
				submitLabel="Rename"
				maxLength={renameTarget?.kind === "column" ? 200 : 120}
				onOpenChange={(open) => {
					if (!open) setRenameTarget(null);
				}}
				onSubmit={applyRename}
			/>
		</div>
	);
}
