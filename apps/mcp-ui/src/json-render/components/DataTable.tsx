import { Badge, type BadgeVariant } from "@tedix/widget-ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@tedix/widget-ui/table";
import { useState } from "react";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export type DataTableColumn = string | DataTableColumnConfig;

export interface DataTableColumnConfig {
	header?: unknown;
	label?: unknown;
	field?: unknown;
	key?: unknown;
	accessor?: unknown;
	accessorKey?: unknown;
	id?: unknown;
	format?: "text" | "number" | "currency" | "percent" | "date" | "badge" | null;
	align?: "left" | "center" | "right" | null;
	sortable?: boolean | null;
	width?: string | null;
}

interface NormalizedDataTableColumn {
	header: string;
	field: string;
	format?: "text" | "number" | "currency" | "percent" | "date" | "badge" | null;
	align?: "left" | "center" | "right" | null;
	sortable?: boolean | null;
	width?: string | null;
}

interface DataTableProps {
	columns?: DataTableColumn[] | null;
	data?: Record<string, unknown>[] | null;
	pageSize?: number | null;
	striped?: boolean | null;
	compact?: boolean | null;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	let current: unknown = obj;
	for (const key of path.split(".")) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function formatCell(
	value: unknown,
	column: NormalizedDataTableColumn,
): React.ReactNode {
	if (value == null) return "—";
	const format = column.format;

	switch (format) {
		case "currency":
			return typeof value === "number"
				? new Intl.NumberFormat("en-US", {
						style: "currency",
						currency: "USD",
					}).format(value)
				: String(value);
		case "percent":
			return typeof value === "number"
				? `${(value * 100).toFixed(1)}%`
				: String(value);
		case "number":
			return typeof value === "number"
				? new Intl.NumberFormat().format(value)
				: String(value);
		case "date":
			return typeof value === "string"
				? new Date(value).toLocaleDateString()
				: String(value);
		case "badge":
			return renderBadge(value);
		default:
			if (isStatusColumn(column)) return renderBadge(value);
			return renderTextCell(value);
	}
}

function isStatusColumn(column: NormalizedDataTableColumn): boolean {
	const field = column.field.toLowerCase();
	const header = column.header.toLowerCase();
	return field === "status" || field.endsWith(".status") || header === "status";
}

function renderBadge(value: unknown): React.ReactNode {
	const label = String(value);
	const normalized = label.toLowerCase();
	let variant: BadgeVariant = "secondary";
	if (
		[
			"active",
			"completed",
			"complete",
			"healthy",
			"ok",
			"ready",
			"running",
			"success",
		].includes(normalized)
	) {
		variant = "success";
	} else if (
		["cancelled", "error", "failed", "inactive", "unhealthy"].includes(
			normalized,
		)
	) {
		variant = "destructive";
	} else if (
		["pending", "queued", "starting", "stopping", "warning"].includes(
			normalized,
		)
	) {
		variant = "warning";
	} else if (["paused", "stopped", "unknown"].includes(normalized)) {
		variant = "outline";
	}
	return (
		<Badge pill title={label} variant={variant}>
			{humanizeCellLabel(label)}
		</Badge>
	);
}

function renderTextCell(value: unknown): React.ReactNode {
	const text = formatTextValue(value);
	return (
		<span className="block max-w-[24rem] truncate" title={text}>
			{text}
		</span>
	);
}

function formatTextValue(value: unknown): string {
	if (value == null) return "—";
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => formatTextValue(item)).join(", ");
	}
	if (isRecord(value)) {
		const label = firstString(value, [
			"label",
			"name",
			"title",
			"displayName",
			"value",
			"id",
			"key",
		]);
		if (label) return label;
		return JSON.stringify(value);
	}
	return String(value);
}

function firstString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function humanizeCellLabel(value: string): string {
	return value
		.replace(/[_-]+/g, " ")
		.replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

function normalizeColumns(
	columns: DataTableColumn[] | null | undefined,
	rows: Record<string, unknown>[],
): NormalizedDataTableColumn[] {
	const inputColumns = Array.isArray(columns) ? columns : [];
	const normalized = inputColumns
		.map((column) => normalizeColumn(column))
		.filter((column): column is NormalizedDataTableColumn => column != null);
	if (normalized.length > 0) return normalized;
	return inferColumns(rows);
}

function normalizeColumn(
	column: DataTableColumn,
): NormalizedDataTableColumn | null {
	if (typeof column === "string") {
		return {
			field: column,
			header: humanizeCellLabel(column),
			sortable: true,
		};
	}
	if (!isRecord(column)) return null;
	const field =
		stringFrom(column.field) ??
		stringFrom(column.key) ??
		stringFrom(column.accessorKey) ??
		stringFrom(column.accessor) ??
		stringFrom(column.id);
	if (!field) return null;
	const header =
		stringFrom(column.header) ??
		stringFrom(column.label) ??
		labelFromObject(column.header) ??
		labelFromObject(column.label) ??
		humanizeCellLabel(field);
	return {
		field,
		header,
		format: isColumnFormat(column.format) ? column.format : undefined,
		align: isColumnAlign(column.align) ? column.align : undefined,
		sortable: typeof column.sortable === "boolean" ? column.sortable : true,
		width: typeof column.width === "string" ? column.width : undefined,
	};
}

function inferColumns(
	rows: Record<string, unknown>[],
): NormalizedDataTableColumn[] {
	const keys = Array.from(
		new Set(
			rows
				.flatMap((row) => Object.keys(row))
				.filter((key) =>
					rows.some((row) => {
						const value = row[key];
						return (
							value == null ||
							typeof value === "string" ||
							typeof value === "number" ||
							typeof value === "boolean"
						);
					}),
				),
		),
	);
	return keys.slice(0, 6).map((key) => ({
		field: key,
		header: humanizeCellLabel(key),
		sortable: true,
	}));
}

function labelFromObject(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return (
		stringFrom(value.label) ??
		stringFrom(value.name) ??
		stringFrom(value.title) ??
		stringFrom(value.value) ??
		stringFrom(value.key)
	);
}

function stringFrom(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return undefined;
}

function isColumnFormat(
	value: unknown,
): value is NonNullable<NormalizedDataTableColumn["format"]> {
	return (
		value === "text" ||
		value === "number" ||
		value === "currency" ||
		value === "percent" ||
		value === "date" ||
		value === "badge"
	);
}

function isColumnAlign(
	value: unknown,
): value is NonNullable<NormalizedDataTableColumn["align"]> {
	return value === "left" || value === "center" || value === "right";
}

export function DataTableComponent({
	columns,
	data,
	pageSize,
	striped,
	compact,
}: DataTableProps) {
	const [page, setPage] = useState(0);
	const [sortField, setSortField] = useState<string | null>(null);
	const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

	const rows = Array.isArray(data) ? data.filter(isRecord) : [];
	const safeColumns = normalizeColumns(columns, rows);

	// Sort
	const sortedData = [...rows];
	if (sortField) {
		sortedData.sort((a, b) => {
			const aVal = getNestedValue(a, sortField);
			const bVal = getNestedValue(b, sortField);
			const cmp = String(aVal ?? "").localeCompare(
				String(bVal ?? ""),
				undefined,
				{ numeric: true },
			);
			return sortDir === "asc" ? cmp : -cmp;
		});
	}

	// Paginate
	const effectivePageSize =
		typeof pageSize === "number" && pageSize > 0 ? pageSize : 25;
	const totalPages = Math.ceil(sortedData.length / effectivePageSize);
	const pagedData = sortedData.slice(
		page * effectivePageSize,
		(page + 1) * effectivePageSize,
	);

	const handleSort = (field: string) => {
		if (sortField === field) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortField(field);
			setSortDir("asc");
		}
	};

	const alignClass = (align?: string | null) => {
		if (align === "center") return "text-center";
		if (align === "right") return "text-right";
		return "text-left";
	};

	return (
		<div className="space-y-2">
			<div className="overflow-x-auto rounded-md border bg-background/85">
				<Table className="min-w-[36rem]">
					<TableHeader>
						<TableRow>
							{safeColumns.map((col) => (
								<TableHead
									key={col.field}
									className={`${alignClass(col.align)} ${col.sortable ? "cursor-pointer select-none hover:bg-muted/50" : ""}`}
									style={col.width ? { width: col.width } : undefined}
									onClick={
										col.sortable ? () => handleSort(col.field) : undefined
									}
								>
									{col.header}
									{sortField === col.field && (
										<span className="ml-1">
											{sortDir === "asc" ? "↑" : "↓"}
										</span>
									)}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{pagedData.map((row, rowIdx) => (
							<TableRow
								key={rowIdx}
								className={striped && rowIdx % 2 === 1 ? "bg-muted/30" : ""}
							>
								{safeColumns.map((col) => (
									<TableCell
										key={col.field}
										className={`${alignClass(col.align)} ${compact ? "py-1.5" : ""} align-middle`}
									>
										{formatCell(getNestedValue(row, col.field), col)}
									</TableCell>
								))}
							</TableRow>
						))}
						{pagedData.length === 0 && (
							<TableRow>
								<TableCell
									colSpan={Math.max(safeColumns.length, 1)}
									className="py-8 text-center text-muted-foreground"
								>
									No data
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>
			{totalPages > 1 && (
				<div className="flex items-center justify-between text-muted-foreground text-sm">
					<span>
						Page {page + 1} of {totalPages} ({sortedData.length} rows)
					</span>
					<div className="flex gap-1">
						<button
							type="button"
							className="rounded px-2 py-1 hover:bg-muted disabled:opacity-50"
							disabled={page === 0}
							onClick={() => setPage((p) => p - 1)}
						>
							← Prev
						</button>
						<button
							type="button"
							className="rounded px-2 py-1 hover:bg-muted disabled:opacity-50"
							disabled={page >= totalPages - 1}
							onClick={() => setPage((p) => p + 1)}
						>
							Next →
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
