import type { OsWorkbook } from "@tedix/api-contract/schemas/os-workspaces";
import { useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import { activeWorkbookSheet } from "@/lib/output-models";
import {
	deleteColumns,
	deleteRows,
	freezePanes,
	insertColumns,
	insertRows,
	type WorkbookRange,
} from "@/lib/workbook-structure";

export function WorkbookStructureControls({
	workbook,
	range,
	disabled,
	onChange,
}: {
	workbook: OsWorkbook;
	range: WorkbookRange;
	disabled: boolean;
	onChange: (next: OsWorkbook) => void;
}) {
	const sheet = activeWorkbookSheet(workbook);
	const actions: [string, () => OsWorkbook, boolean][] = [
		[
			"Insert row above",
			() => insertRows(workbook, sheet.id, range.rowStart),
			sheet.rows.length >= 1000,
		],
		[
			"Insert row below",
			() => insertRows(workbook, sheet.id, range.rowEnd + 1),
			sheet.rows.length >= 1000,
		],
		[
			"Insert column left",
			() => insertColumns(workbook, sheet.id, range.columnStart),
			sheet.columns.length >= 64,
		],
		[
			"Insert column right",
			() => insertColumns(workbook, sheet.id, range.columnEnd + 1),
			sheet.columns.length >= 64,
		],
		[
			"Delete selected rows",
			() =>
				deleteRows(
					workbook,
					sheet.id,
					range.rowStart,
					range.rowEnd - range.rowStart + 1,
				),
			range.rowEnd - range.rowStart + 1 >= sheet.rows.length,
		],
		[
			"Delete selected columns",
			() =>
				deleteColumns(
					workbook,
					sheet.id,
					range.columnStart,
					range.columnEnd - range.columnStart + 1,
				),
			range.columnEnd - range.columnStart + 1 >= sheet.columns.length,
		],
		[
			"Freeze rows through selection",
			() =>
				freezePanes(workbook, sheet.id, range.rowEnd + 1, sheet.frozenColumns),
			false,
		],
		[
			"Freeze columns through selection",
			() =>
				freezePanes(workbook, sheet.id, sheet.frozenRows, range.columnEnd + 1),
			false,
		],
		[
			"Unfreeze panes",
			() => freezePanes(workbook, sheet.id, 0, 0),
			sheet.frozenRows === 0 && sheet.frozenColumns === 0,
		],
	];
	return (
		<div
			className="flex flex-wrap gap-1"
			role="group"
			aria-label="Sheet structure"
		>
			{actions.map(([label, run, unavailable]) => (
				<Button
					key={label}
					size="xs"
					variant="ghost"
					disabled={disabled || unavailable}
					onClick={() => onChange(run())}
				>
					{label}
				</Button>
			))}
		</div>
	);
}

export function WorkbookResizeHandle({
	label,
	axis,
	value,
	disabled,
	onResize,
}: {
	label: string;
	axis: "row" | "column";
	value: number;
	disabled: boolean;
	onResize: (size: number) => void;
}) {
	const drag = useRef<{ origin: number; pointer: number } | null>(null);
	const [delta, setDelta] = useState(0);
	const horizontal = axis === "column";
	const clamp = (size: number) =>
		Math.max(horizontal ? 48 : 20, Math.min(600, size));
	return (
		<div
			role="separator"
			aria-label={label}
			aria-orientation={horizontal ? "vertical" : "horizontal"}
			aria-valuenow={value}
			aria-valuemin={horizontal ? 48 : 20}
			aria-valuemax={600}
			aria-disabled={disabled}
			tabIndex={disabled ? -1 : 0}
			className={
				horizontal
					? "absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none hover:bg-kumo-focus focus:bg-kumo-focus"
					: "absolute bottom-0 left-0 z-10 h-1.5 w-full cursor-row-resize touch-none hover:bg-kumo-focus focus:bg-kumo-focus"
			}
			style={{
				transform: horizontal
					? `translateX(${delta}px)`
					: `translateY(${delta}px)`,
			}}
			onPointerDown={(event) => {
				if (disabled || event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				drag.current = {
					origin: horizontal ? event.clientX : event.clientY,
					pointer: event.pointerId,
				};
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				if (drag.current?.pointer !== event.pointerId) return;
				setDelta(
					clamp(
						value +
							(horizontal ? event.clientX : event.clientY) -
							drag.current.origin,
					) - value,
				);
			}}
			onPointerUp={(event) => {
				if (drag.current?.pointer !== event.pointerId) return;
				const size = clamp(
					value +
						(horizontal ? event.clientX : event.clientY) -
						drag.current.origin,
				);
				drag.current = null;
				setDelta(0);
				event.currentTarget.releasePointerCapture(event.pointerId);
				onResize(size);
			}}
			onPointerCancel={() => {
				drag.current = null;
				setDelta(0);
			}}
			onLostPointerCapture={() => {
				drag.current = null;
				setDelta(0);
			}}
			onKeyDown={(event) => {
				if (disabled) return;
				const direction =
					event.key === (horizontal ? "ArrowRight" : "ArrowDown")
						? 1
						: event.key === (horizontal ? "ArrowLeft" : "ArrowUp")
							? -1
							: 0;
				if (direction) {
					event.preventDefault();
					event.stopPropagation();
					onResize(clamp(value + direction * 8));
				}
			}}
		/>
	);
}
