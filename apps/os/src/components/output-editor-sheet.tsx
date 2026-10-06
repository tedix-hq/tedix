import {
	ArrowDown,
	ArrowUDownLeft,
	ArrowUDownRight,
	ArrowUp,
	Copy,
	CurrencyDollar,
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
import { useMemo, useState } from "react";
import { EditorTextDialog } from "@/components/editor-text-dialog";
import { isImeComposing } from "@/lib/keyboard";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	EditorToolbar,
	EditorToolbarButton,
	EditorToolbarColorButton,
	EditorToolbarDivider,
} from "@/components/output-editor-toolbar";
import {
	activeWorkbookSheet,
	createOutputNodeId,
	normalizeSheetContent,
	projectWorkbook,
	type SheetContent,
} from "@/lib/output-models";
import { useEditorHistory } from "@/lib/use-editor-history";
import {
	evaluateWorkbook,
	formatWorkbookValue,
	WORKBOOK_SUPPORTED_FORMULA_COUNT,
} from "@/lib/workbook-formulas";

const SHEET_MAX_COLUMNS = 64;
const SHEET_MAX_ROWS = 1000;
const SHEET_CELL_MAX_LENGTH = 4000;

interface Coordinate {
	row: number;
	column: number;
}
interface Selection {
	anchor: Coordinate;
	focus: Coordinate;
}

type RenameTarget =
	| { kind: "column"; index: number; value: string }
	| { kind: "sheet"; id: string; value: string };

function columnLabel(index: number): string {
	let value = index + 1;
	let label = "";
	while (value > 0) {
		value -= 1;
		label = String.fromCharCode(65 + (value % 26)) + label;
		value = Math.floor(value / 26);
	}
	return label;
}

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

function selectedBounds(selection: Selection) {
	return {
		rowStart: Math.min(selection.anchor.row, selection.focus.row),
		rowEnd: Math.max(selection.anchor.row, selection.focus.row),
		columnStart: Math.min(selection.anchor.column, selection.focus.column),
		columnEnd: Math.max(selection.anchor.column, selection.focus.column),
	};
}

function updateCells(
	workbook: OsWorkbook,
	selection: Selection,
	update: (cell: OsWorkbookCell, row: number, column: number) => OsWorkbookCell,
): OsWorkbook {
	const sheet = activeWorkbookSheet(workbook);
	const bounds = selectedBounds(selection);
	const rows = sheet.rows.map((row, rowIndex) =>
		row.map((cell, columnIndex) =>
			rowIndex >= bounds.rowStart &&
			rowIndex <= bounds.rowEnd &&
			columnIndex >= bounds.columnStart &&
			columnIndex <= bounds.columnEnd
				? update(cell ?? emptyCell(), rowIndex, columnIndex)
				: cell,
		),
	);
	return replaceSheet(workbook, { ...sheet, rows });
}

function applyFormat(
	workbook: OsWorkbook,
	selection: Selection,
	format: Partial<OsWorkbookCellFormat>,
): OsWorkbook {
	return updateCells(workbook, selection, (cell) => ({
		...cell,
		format: { ...cell.format, ...format },
	}));
}

function workbookWithCell(
	workbook: OsWorkbook,
	coordinate: Coordinate,
	input: string,
): OsWorkbook {
	return updateCells(
		workbook,
		{ anchor: coordinate, focus: coordinate },
		(cell) => ({ ...cell, input: input.slice(0, SHEET_CELL_MAX_LENGTH) }),
	);
}

interface SheetEditorProps {
	value: SheetContent;
	onChange: (next: SheetContent) => void;
	disabled?: boolean;
}

export function SheetEditor({
	value,
	onChange,
	disabled = false,
}: SheetEditorProps) {
	const normalized = normalizeSheetContent(value);
	const workbook = useMemo(
		() => ensureGrid(normalized.workbook!),
		[normalized.workbook],
	);
	const sheet = activeWorkbookSheet(workbook);
	const [selection, setSelection] = useState<Selection>({
		anchor: { row: 0, column: 0 },
		focus: { row: 0, column: 0 },
	});
	const [editing, setEditing] = useState<Coordinate | null>(null);
	const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
	const history = useEditorHistory(normalized, onChange);
	const bounds = selectedBounds(selection);
	const selectedCell =
		sheet.rows[selection.focus.row]?.[selection.focus.column] ?? emptyCell();

	const commitWorkbook = (next: OsWorkbook) =>
		history.commit(projectWorkbook(evaluateWorkbook(next)));
	const commitFormat = (format: Partial<OsWorkbookCellFormat>) =>
		commitWorkbook(applyFormat(workbook, selection, format));
	const setSelectedInput = (input: string) =>
		commitWorkbook(workbookWithCell(workbook, selection.focus, input));
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
		commitWorkbook({
			...workbook,
			sheets: workbook.sheets.map((item) =>
				item.id === renameTarget.id ? { ...item, name: value } : item,
			),
		});
	};

	const copySelection = () => {
		const text = sheet.rows
			.slice(bounds.rowStart, bounds.rowEnd + 1)
			.map((row) =>
				row
					.slice(bounds.columnStart, bounds.columnEnd + 1)
					.map((cell) => cell?.input ?? "")
					.join("\t"),
			)
			.join("\n");
		void navigator.clipboard?.writeText(text);
	};

	const pasteText = (text: string) => {
		const source = text
			.replace(/\r/g, "")
			.split("\n")
			.map((row) => row.split("\t"));
		let next = workbook;
		for (const [rowOffset, row] of source.entries()) {
			for (const [columnOffset, input] of row.entries()) {
				const coordinate = {
					row: selection.focus.row + rowOffset,
					column: selection.focus.column + columnOffset,
				};
				if (
					coordinate.row < SHEET_MAX_ROWS &&
					coordinate.column < sheet.columns.length
				)
					next = workbookWithCell(next, coordinate, input);
			}
		}
		commitWorkbook(next);
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
		setSelection({
			anchor: { row: 0, column: 0 },
			focus: { row: 0, column: 0 },
		});
	};

	const sortRows = (direction: 1 | -1) => {
		const column = selection.focus.column;
		const rows = [...sheet.rows].sort(
			(a, b) =>
				String(a[column]?.value ?? "").localeCompare(
					String(b[column]?.value ?? ""),
					undefined,
					{ numeric: true },
				) * direction,
		);
		commitWorkbook(replaceSheet(workbook, { ...sheet, rows }));
	};

	return (
		<div
			className="sheet-editor grid min-w-0 gap-0"
			data-editor="workbook"
			onPaste={(event) => {
				if (!disabled) {
					event.preventDefault();
					pasteText(event.clipboardData.getData("text/plain"));
				}
			}}
			onKeyDown={(event) => {
				if (editing || disabled) return;
				const movement: Record<string, Coordinate> = {
					ArrowUp: { row: -1, column: 0 },
					ArrowDown: { row: 1, column: 0 },
					ArrowLeft: { row: 0, column: -1 },
					ArrowRight: { row: 0, column: 1 },
				};
				const delta = movement[event.key];
				if (delta) {
					event.preventDefault();
					const focus = {
						row: Math.max(
							0,
							Math.min(sheet.rows.length - 1, selection.focus.row + delta.row),
						),
						column: Math.max(
							0,
							Math.min(
								sheet.columns.length - 1,
								selection.focus.column + delta.column,
							),
						),
					};
					setSelection(
						event.shiftKey ? { ...selection, focus } : { anchor: focus, focus },
					);
				}
			}}
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
				<EditorToolbarDivider />
				<Select
					disabled={disabled}
					value={selectedCell.format?.numberFormat ?? "automatic"}
					onValueChange={(value) =>
						commitFormat({
							numberFormat: value as OsWorkbookCellFormat["numberFormat"],
						})
					}
				>
					<SelectTrigger aria-label="Number format" className="w-32" size="sm">
						<SelectValue>
							{(value) =>
								value
									? `${String(value).charAt(0).toUpperCase()}${String(value).slice(1)}`
									: "Automatic"
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="automatic">Automatic</SelectItem>
						<SelectItem value="number">Number</SelectItem>
						<SelectItem value="currency">Currency</SelectItem>
						<SelectItem value="percent">Percent</SelectItem>
						<SelectItem value="scientific">Scientific</SelectItem>
						<SelectItem value="date">Date</SelectItem>
						<SelectItem value="time">Time</SelectItem>
					</SelectContent>
				</Select>
				<EditorToolbarButton
					label="Currency"
					disabled={disabled}
					onClick={() => commitFormat({ numberFormat: "currency" })}
				>
					<CurrencyDollar size={15} />
				</EditorToolbarButton>
				<EditorToolbarDivider />
				<EditorToolbarButton
					label="Auto sum"
					disabled={disabled}
					onClick={() => {
						const row = selection.focus.row;
						setSelectedInput(
							`=SUM(${columnLabel(selection.focus.column)}1:${columnLabel(selection.focus.column)}${Math.max(1, row)})`,
						);
					}}
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
				<EditorToolbarButton label="Copy selection" onClick={copySelection}>
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
					<div className="sheet-editor-formula grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-1">
						<Input
							aria-label="Selected cell"
							readOnly
							value={`${columnLabel(selection.focus.column)}${selection.focus.row + 1}`}
							className="font-mono"
							size="sm"
						/>
						<div className="flex min-w-0 items-center gap-2">
							<FunctionIcon size={15} className="text-kumo-subtle" />
							<Input
								aria-label="Formula bar"
								value={selectedCell.input}
								disabled={disabled}
								onChange={(event) => setSelectedInput(event.target.value)}
								className="font-mono"
								size="sm"
							/>
						</div>
					</div>
					<div
						className="sheet-editor-grid max-h-[68vh] overflow-auto border border-kumo-line bg-kumo-base"
						tabIndex={0}
						aria-label="Spreadsheet grid"
					>
						<table
							className="border-collapse type-tedix-control"
							style={{
								width: sheet.columns.reduce(
									(sum, column) => sum + column.width,
									44,
								),
							}}
						>
							<thead className="sticky top-0 z-[2] bg-kumo-elevated">
								<tr>
									<th className="sticky left-0 z-[3] w-11 border border-kumo-line bg-kumo-elevated" />
									{sheet.columns.map((column, columnIndex) => (
										<th
											key={column.id}
											className="relative border border-kumo-line px-2 py-1 font-medium"
											style={{ width: column.width, minWidth: column.width }}
										>
											<Button
												className="sheet-editor-column-button w-full justify-center px-1"
												size="xs"
												variant="ghost"
												title={`${columnLabel(columnIndex)} · ${column.label}`}
												onDoubleClick={() =>
													setRenameTarget({
														kind: "column",
														index: columnIndex,
														value: column.label,
													})
												}
											>
												<span className="truncate">
													{columnLabel(columnIndex)} · {column.label}
												</span>
											</Button>
											<Input
												aria-label={`Column ${columnIndex + 1} width`}
												type="range"
												min="48"
												max="600"
												value={column.width}
												disabled={disabled}
												className="absolute right-0 bottom-0 h-1 w-full rounded-none p-0 opacity-0 shadow-none ring-0 hover:opacity-100 focus:opacity-100"
												onChange={(event) =>
													commitWorkbook(
														replaceSheet(workbook, {
															...sheet,
															columns: sheet.columns.map((item, index) =>
																index === columnIndex
																	? {
																			...item,
																			width: Number(event.target.value),
																		}
																	: item,
															),
														}),
													)
												}
											/>
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{sheet.rows.map((row, rowIndex) => (
									<tr key={`row-${rowIndex}`}>
										<th className="sticky left-0 z-[1] border border-kumo-line bg-kumo-elevated px-2 text-right font-normal text-kumo-subtle">
											{rowIndex + 1}
										</th>
										{sheet.columns.map((column, columnIndex) => {
											const cell = row[columnIndex] ?? emptyCell();
											const selected =
												rowIndex >= bounds.rowStart &&
												rowIndex <= bounds.rowEnd &&
												columnIndex >= bounds.columnStart &&
												columnIndex <= bounds.columnEnd;
											const isEditing =
												editing?.row === rowIndex &&
												editing.column === columnIndex;
											return (
												<td
													key={`${rowIndex}-${columnIndex}`}
													className={`border border-kumo-line p-0 ${selected ? "ring-2 ring-inset ring-kumo-focus" : ""}`}
													style={{
														width: column.width,
														minWidth: column.width,
														background: cell.format?.fillColor,
														color: cell.format?.textColor,
														textAlign: cell.format?.horizontalAlign,
														fontWeight: cell.format?.bold ? 700 : undefined,
														fontStyle: cell.format?.italic
															? "italic"
															: undefined,
														textDecoration:
															[
																cell.format?.underline ? "underline" : "",
																cell.format?.strike ? "line-through" : "",
															]
																.filter(Boolean)
																.join(" ") || undefined,
													}}
												>
													<Input
														aria-label={`${column.label} row ${rowIndex + 1}`}
														className="h-7 w-full rounded-none border-0 bg-transparent px-2 shadow-none ring-0 outline-none"
														style={{
															whiteSpace: cell.format?.wrap
																? "normal"
																: "nowrap",
														}}
														value={
															isEditing ? cell.input : formatWorkbookValue(cell)
														}
														readOnly={!isEditing || disabled}
														onClick={(event) => {
															const coordinate = {
																row: rowIndex,
																column: columnIndex,
															};
															setSelection(
																event.shiftKey
																	? { ...selection, focus: coordinate }
																	: { anchor: coordinate, focus: coordinate },
															);
														}}
														onDoubleClick={() =>
															setEditing({ row: rowIndex, column: columnIndex })
														}
														onChange={(event) =>
															commitWorkbook(
																workbookWithCell(
																	workbook,
																	{ row: rowIndex, column: columnIndex },
																	event.target.value,
																),
															)
														}
														onBlur={() => setEditing(null)}
														onKeyDown={(event) => {
															if (
																event.key === "Enter" &&
																!isImeComposing(event)
															) {
																event.currentTarget.blur();
																setEditing(null);
															}
														}}
													/>
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<div className="sheet-editor-tabs flex flex-wrap items-center justify-between gap-2">
						<div className="flex min-w-0 flex-wrap items-center gap-1">
							{workbook.sheets.map((tab) => (
								<Button
									key={tab.id}
									type="button"
									size="xs"
									variant={
										tab.id === workbook.activeSheetId ? "secondary" : "ghost"
									}
									onClick={() =>
										commitWorkbook({ ...workbook, activeSheetId: tab.id })
									}
									onDoubleClick={() =>
										setRenameTarget({
											kind: "sheet",
											id: tab.id,
											value: tab.name,
										})
									}
								>
									{tab.name}
								</Button>
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
							{workbook.sheets.length > 1 && (
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									aria-label="Delete active sheet"
									disabled={disabled}
									onClick={() => {
										const sheets = workbook.sheets.filter(
											(item) => item.id !== sheet.id,
										);
										commitWorkbook({
											...workbook,
											sheets,
											activeSheetId: sheets[0]!.id,
										});
									}}
								>
									<Trash size={14} />
								</Button>
							)}
						</div>
						<div className="flex flex-wrap items-center gap-2 text-kumo-subtle type-tedix-label">
							<span>
								{WORKBOOK_SUPPORTED_FORMULA_COUNT}+ Excel-style functions
							</span>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								disabled={disabled || sheet.rows.length >= SHEET_MAX_ROWS}
								onClick={() =>
									commitWorkbook(
										replaceSheet(workbook, {
											...sheet,
											rows: [
												...sheet.rows,
												sheet.columns.map(() => emptyCell()),
											],
										}),
									)
								}
							>
								<ArrowDown size={13} /> Row
							</Button>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								disabled={disabled || sheet.columns.length >= SHEET_MAX_COLUMNS}
								onClick={() => {
									const index = sheet.columns.length;
									commitWorkbook(
										replaceSheet(workbook, {
											...sheet,
											columns: [
												...sheet.columns,
												{
													id: createOutputNodeId("column"),
													label: columnLabel(index),
													width: 120,
												},
											],
											rows: sheet.rows.map((row) => [...row, emptyCell()]),
										}),
									);
								}}
							>
								<Plus size={13} /> Column
							</Button>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								disabled={disabled || sheet.rows.length <= 1}
								onClick={() =>
									commitWorkbook(
										replaceSheet(workbook, {
											...sheet,
											rows: sheet.rows.filter(
												(_, index) => index !== selection.focus.row,
											),
										}),
									)
								}
							>
								<ArrowUp size={13} /> Delete row
							</Button>
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
