import "./output-editor.css";
import { CaretDown, CaretUp, Table } from "@phosphor-icons/react";
import type {
	OsOutputContent,
	OsWorkbookCell,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useMemo, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
import { SearchInput } from "@/components/kumo/search-input";
import {
	activeWorkbookSheet,
	normalizeSheetContent,
} from "@/lib/output-models";
import {
	columnLabel,
	isErrorValue,
	type ViewSort,
	viewRowOrder,
} from "@/lib/sheet-grid";
import {
	DEFAULT_ROW_HEIGHT,
	frozenCellStyle,
	HEADER_HEIGHT,
	ROW_HEADER_WIDTH,
} from "@/lib/workbook-structure";
import { evaluateWorkbook, formatWorkbookValue } from "@/lib/workbook-formulas";

/** Rows above which the read view offers a filter box. */
const FILTER_FROM_ROWS = 8;

type WorkbookContext = Parameters<typeof formatWorkbookValue>[1];

/** Inline paint for a cell's own format; the grid's CSS owns everything else. */
export function sheetCellPaint(cell: OsWorkbookCell | null | undefined) {
	const format = cell?.format;
	const decoration = [
		format?.underline ? "underline" : "",
		format?.strike ? "line-through" : "",
	]
		.filter(Boolean)
		.join(" ");
	return {
		background: format?.fillColor,
		color: format?.textColor,
		fontWeight: format?.bold ? 700 : undefined,
		fontStyle: format?.italic ? "italic" : undefined,
		textDecoration: decoration || undefined,
		textAlign:
			format?.horizontalAlign ??
			(isErrorValue(cell?.value)
				? "center"
				: typeof cell?.value === "number"
					? "right"
					: undefined),
	} as const;
}

/** `data-kind` drives number, error and wrap styling in `output-editor.css`. */
export function sheetCellKind(cell: OsWorkbookCell | null | undefined) {
	if (isErrorValue(cell?.value)) return "error";
	if (typeof cell?.value === "number") return "number";
	if (typeof cell?.value === "boolean") return "boolean";
	return undefined;
}

/** The column header text: its letter, plus its name when it has one. */
export function SheetColumnHeading({
	index,
	label,
}: {
	index: number;
	label: string;
}) {
	const letter = columnLabel(index);
	const named = label.trim() !== "" && label !== letter;
	return (
		<span className="sheet-column-heading">
			<span className="sheet-column-letter" aria-hidden={named || undefined}>
				{letter}
			</span>
			{named ? <span className="sheet-column-name">{label}</span> : null}
		</span>
	);
}

function isEmptySheet(sheet: OsWorkbookSheet) {
	return sheet.rows.every((row) => row.every((cell) => !cell?.input));
}

/**
 * The committed revision of a sheet. Read-only, but not inert: headers stay put
 * while the grid scrolls, columns sort and rows filter as view state, and
 * numbers read as numbers (right-aligned, tabular, in the workbook's currency
 * and locale). Nothing here writes to the workbook.
 */
export function WorkbookView({
	content,
}: {
	content: Extract<OsOutputContent, { kind: "sheet" }>;
}) {
	// Evaluate formulas once per content, not on every tab click.
	const workbook = useMemo(
		() => evaluateWorkbook(normalizeSheetContent(content).workbook!),
		[content],
	);
	const [activeSheetId, setActiveSheetId] = useState(workbook.activeSheetId);
	const [sort, setSort] = useState<ViewSort | null>(null);
	const [query, setQuery] = useState("");
	const sheet =
		workbook.sheets.find((candidate) => candidate.id === activeSheetId) ??
		activeWorkbookSheet(workbook);
	const context: WorkbookContext = workbook;
	const display = (row: number, column: number) =>
		formatWorkbookValue(sheet.rows[row]?.[column] ?? null, context);
	const order = viewRowOrder(sheet, { sort, query, display });
	const empty = isEmptySheet(sheet);
	const filterable = sheet.rows.length > FILTER_FROM_ROWS;
	const filtered = query.trim() !== "";
	const bodyRows =
		sheet.rows.length - Math.min(sheet.frozenRows, sheet.rows.length);
	const shownRows = order.length - (sheet.rows.length - bodyRows);

	const openSheet = (id: string) => {
		setActiveSheetId(id);
		setSort(null);
		setQuery("");
	};
	const cycleSort = (column: number) =>
		setSort((current) =>
			current?.column !== column
				? { column, direction: "ascending" }
				: current.direction === "ascending"
					? { column, direction: "descending" }
					: null,
		);

	return (
		<div className="grid gap-2">
			<div className="sheet-read-desk">
				<div className="sheet-page sheet-read-page" data-sheet-view="">
					{filterable && !empty ? (
						<div className="sheet-read-bar">
							<SearchInput
								aria-label="Filter rows"
								placeholder="Filter rows"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								containerClassName="sheet-read-filter"
							/>
						</div>
					) : null}
					<div
						className="sheet-read-grid"
						// The grid scrolls on its own; a keyboard user reaches it as one stop.
						tabIndex={0}
						role="region"
						aria-label={`${sheet.name} cells`}
					>
						{empty ? (
							<Empty
								appearance="quiet"
								className="sheet-read-empty border-0!"
								icon={
									<Table size={28} aria-hidden className="text-kumo-subtle" />
								}
								title="This sheet is empty"
								description="Nothing has been entered on this sheet yet. Open the editor to add rows, or ask in chat to fill it."
							/>
						) : (
							<table
								className="sheet-grid-table border-separate border-spacing-0"
								aria-rowcount={sheet.rows.length + 1}
								aria-colcount={sheet.columns.length + 1}
							>
								<thead>
									<tr style={{ height: HEADER_HEIGHT }}>
										<th
											className="sheet-corner"
											style={{ width: ROW_HEADER_WIDTH }}
										>
											<span className="sr-only">Row</span>
										</th>
										{sheet.columns.map((column, columnIndex) => {
											const sorted =
												sort?.column === columnIndex
													? sort.direction
													: undefined;
											return (
												<th
													key={column.id}
													scope="col"
													aria-sort={sorted ?? "none"}
													className="sheet-column-header"
													data-sorted={sorted}
													style={{
														...frozenCellStyle(
															sheet,
															sheet.rows.length,
															columnIndex,
														),
														width: column.width,
														minWidth: column.width,
														maxWidth: column.width,
													}}
												>
													<Button
														variant="ghost"
														size="xs"
														className="sheet-column-sort"
														title={`Sort by ${column.label}`}
														onClick={() => cycleSort(columnIndex)}
													>
														<SheetColumnHeading
															index={columnIndex}
															label={column.label}
														/>
														{sorted === "ascending" ? (
															<CaretUp size={11} aria-hidden />
														) : sorted === "descending" ? (
															<CaretDown size={11} aria-hidden />
														) : null}
													</Button>
												</th>
											);
										})}
									</tr>
								</thead>
								<tbody>
									{order.map((rowIndex) => {
										const row = sheet.rows[rowIndex] ?? [];
										return (
											<tr
												key={`row-${rowIndex}`}
												aria-rowindex={rowIndex + 2}
												style={{
													height:
														sheet.rowHeights?.[rowIndex] ?? DEFAULT_ROW_HEIGHT,
												}}
											>
												<th
													scope="row"
													className="sheet-row-header"
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
												</th>
												{sheet.columns.map((column, columnIndex) => {
													const cell = row[columnIndex] ?? null;
													return (
														<td
															key={column.id}
															className="sheet-cell"
															data-kind={sheetCellKind(cell)}
															data-wrap={cell?.format?.wrap ? "" : undefined}
															data-frozen-row={
																rowIndex < sheet.frozenRows ? "" : undefined
															}
															style={{
																...frozenCellStyle(
																	sheet,
																	rowIndex,
																	columnIndex,
																),
																width: column.width,
																minWidth: column.width,
																maxWidth: column.width,
																...sheetCellPaint(cell),
															}}
														>
															{formatWorkbookValue(cell, context)}
														</td>
													);
												})}
											</tr>
										);
									})}
								</tbody>
							</table>
						)}
						{filtered && shownRows === 0 ? (
							<p className="sheet-read-no-match type-tedix-label">
								No rows match “{query.trim()}”.
							</p>
						) : null}
					</div>
					{/* Tabs live INSIDE the page, as they do in the editor: the grid
					    scrolls beneath them and the page stays one object. */}
					<div className="sheet-footer">
						<div
							className="sheet-tab-strip"
							role="group"
							aria-label="Workbook sheets"
						>
							{workbook.sheets.map((candidate) => (
								<Button
									key={candidate.id}
									type="button"
									variant="ghost"
									size="xs"
									className="sheet-tab !h-full"
									aria-pressed={candidate.id === sheet.id}
									onClick={() => openSheet(candidate.id)}
								>
									{candidate.name}
								</Button>
							))}
						</div>
						<span className="sheet-status type-tedix-label" aria-live="polite">
							{empty
								? "Empty"
								: filtered
									? `${shownRows} of ${bodyRows} rows`
									: `${sheet.rows.length} ${sheet.rows.length === 1 ? "row" : "rows"} · ${sheet.columns.length} ${sheet.columns.length === 1 ? "column" : "columns"}`}
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}
