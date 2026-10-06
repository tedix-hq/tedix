"use client";

import * as React from "react";

import { cn } from "../lib/utils";
import type { StatefulComponentProps } from "../types/stateful-component-props";
import { Alert } from "./alert";
import { Button } from "./button";
import { EmptyMessage } from "./empty-message";
import { Skeleton } from "./skeleton";

// ============================================================================
// Types
// ============================================================================

/**
 * Column definition for the data-driven Table API
 */
export interface TableColumn<T = Record<string, unknown>> {
	/** Column header text */
	header: React.ReactNode;
	/**
	 * Key to access data from the row object.
	 * Can be a simple key or a function for custom rendering.
	 */
	accessor: keyof T | ((row: T, index: number) => React.ReactNode);
	/** Additional className for the header cell */
	headerClassName?: string;
	/** Additional className for the body cells */
	cellClassName?: string;
	/**
	 * Column width (e.g., "100px", "20%", "auto")
	 * Applied to both header and body cells
	 */
	width?: string;
	/**
	 * Text alignment for the column
	 * @default "left"
	 */
	align?: "left" | "center" | "right";
}

/**
 * Props for the data-driven Table API
 */
export interface DataTableProps<T = Record<string, unknown>>
	extends
		StatefulComponentProps,
		Omit<React.ComponentProps<"div">, "children"> {
	/** Data array to render in the table */
	data: Array<T>;
	/** Column definitions */
	columns: Array<TableColumn<T>>;
	/**
	 * Unique key accessor for each row.
	 * Can be a key name or a function.
	 * @default Uses array index if not provided
	 */
	rowKey?: keyof T | ((row: T, index: number) => string | number);
	/** Table caption */
	caption?: React.ReactNode;
	/** Footer content (renders in TableFooter) */
	footer?: React.ReactNode;
	/**
	 * Number of skeleton rows to show when loading
	 * @default 5
	 */
	loadingRows?: number;
	/** Empty state title */
	emptyTitle?: string;
	/** Empty state description */
	emptyMessage?: string;
	/** Empty state icon */
	emptyIcon?: React.ReactNode;
	/** Error state title */
	errorTitle?: string;
	/** Additional table className */
	tableClassName?: string;
	/** Row click handler */
	onRowClick?: (row: T, index: number) => void;
	/** Additional className for rows */
	rowClassName?: string | ((row: T, index: number) => string);
}

// ============================================================================
// Primitive Components (unchanged API)
// ============================================================================

function Table({ className, ...props }: React.ComponentProps<"table">) {
	return (
		<div
			data-slot="table-container"
			className="relative w-full overflow-x-auto"
		>
			<table
				data-slot="table"
				className={cn("w-full caption-bottom text-sm", className)}
				{...props}
			/>
		</div>
	);
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
	return (
		<thead
			data-slot="table-header"
			className={cn("[&_tr]:border-b", className)}
			{...props}
		/>
	);
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
	return (
		<tbody
			data-slot="table-body"
			className={cn("[&_tr:last-child]:border-0", className)}
			{...props}
		/>
	);
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
	return (
		<tfoot
			data-slot="table-footer"
			className={cn(
				"border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
				className,
			)}
			{...props}
		/>
	);
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
	return (
		<tr
			data-slot="table-row"
			className={cn(
				"border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
				className,
			)}
			{...props}
		/>
	);
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
	return (
		<th
			data-slot="table-head"
			className={cn(
				"h-12 whitespace-nowrap px-3 text-left align-middle font-medium text-foreground [&:has([role=checkbox])]:pr-0",
				className,
			)}
			{...props}
		/>
	);
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
	return (
		<td
			data-slot="table-cell"
			className={cn(
				"whitespace-nowrap p-3 align-middle [&:has([role=checkbox])]:pr-0",
				className,
			)}
			{...props}
		/>
	);
}

function TableCaption({
	className,
	...props
}: React.ComponentProps<"caption">) {
	return (
		<caption
			data-slot="table-caption"
			className={cn("mt-4 text-muted-foreground text-sm", className)}
			{...props}
		/>
	);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get alignment class for table cells
 */
function getAlignClass(align?: "left" | "center" | "right"): string {
	switch (align) {
		case "center":
			return "text-center";
		case "right":
			return "text-right";
		default:
			return "text-left";
	}
}

/**
 * Get cell value from row data using accessor
 */
function getCellValue<T>(
	row: T,
	accessor: keyof T | ((row: T, index: number) => React.ReactNode),
	index: number,
): React.ReactNode {
	if (typeof accessor === "function") {
		return accessor(row, index);
	}
	const value = row[accessor];
	// Handle primitive values
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string" || typeof value === "number") {
		return value;
	}
	// For objects/arrays, stringify (or render if it's a ReactNode)
	if (React.isValidElement(value)) {
		return value;
	}
	return String(value);
}

/**
 * Get row key from row data
 */
function getRowKey<T>(
	row: T,
	index: number,
	rowKey?: keyof T | ((row: T, index: number) => string | number),
): string | number {
	if (!rowKey) {
		return index;
	}
	if (typeof rowKey === "function") {
		return rowKey(row, index);
	}
	const value = row[rowKey];
	if (typeof value === "string" || typeof value === "number") {
		return value;
	}
	return index;
}

// ============================================================================
// DataTable Component (Layer 2 - with StatefulComponentProps)
// ============================================================================

/**
 * DataTable - Data-driven table with StatefulComponentProps support
 *
 * A higher-level table component that accepts data and column definitions,
 * and handles loading, error, and empty states automatically.
 *
 * @example Loading state
 * ```tsx
 * <DataTable
 *   columns={columns}
 *   data={[]}
 *   isLoading={true}
 *   loadingRows={5}
 * />
 * ```
 *
 * @example Error state
 * ```tsx
 * <DataTable
 *   columns={columns}
 *   data={[]}
 *   error="Failed to load data"
 *   onRetry={() => refetch()}
 * />
 * ```
 *
 * @example Empty state
 * ```tsx
 * <DataTable
 *   columns={columns}
 *   data={[]}
 *   isEmpty={true}
 *   emptyTitle="No invoices"
 *   emptyMessage="Create your first invoice to get started."
 * />
 * ```
 *
 * @example With data
 * ```tsx
 * <DataTable
 *   columns={[
 *     { header: "Name", accessor: "name" },
 *     { header: "Email", accessor: "email" },
 *     { header: "Actions", accessor: (row) => <Button>Edit</Button>, align: "right" }
 *   ]}
 *   data={users}
 *   rowKey="id"
 *   onRowClick={(user) => navigate(`/users/${user.id}`)}
 * />
 * ```
 */
function DataTable<T extends Record<string, unknown>>({
	data,
	columns,
	rowKey,
	caption,
	footer,
	isLoading = false,
	loadingRows = 5,
	error,
	onRetry,
	isEmpty,
	emptyTitle = "No data",
	emptyMessage = "No items to display.",
	emptyIcon,
	errorTitle = "Error loading data",
	className,
	tableClassName,
	onRowClick,
	rowClassName,
	...containerProps
}: DataTableProps<T>) {
	// Loading state
	if (isLoading) {
		return (
			<div
				data-slot="data-table"
				data-state="loading"
				className={cn("relative w-full", className)}
				aria-busy="true"
				aria-live="polite"
				{...containerProps}
			>
				<Table className={tableClassName}>
					<TableHeader>
						<TableRow>
							{columns.map((column, colIndex) => (
								<TableHead
									key={colIndex}
									className={cn(
										getAlignClass(column.align),
										column.headerClassName,
									)}
									style={column.width ? { width: column.width } : undefined}
								>
									<Skeleton className="h-4 w-3/4" />
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{Array.from({ length: loadingRows }).map((_, rowIndex) => (
							<TableRow key={`skeleton-row-${rowIndex}`}>
								{columns.map((column, colIndex) => (
									<TableCell
										key={`skeleton-cell-${rowIndex}-${colIndex}`}
										className={cn(
											getAlignClass(column.align),
											column.cellClassName,
										)}
									>
										<Skeleton
											className={cn(
												"h-4",
												column.align === "right"
													? "ml-auto w-1/2"
													: column.align === "center"
														? "mx-auto w-1/2"
														: "w-3/4",
											)}
										/>
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		);
	}

	// Error state
	if (error) {
		return (
			<div
				data-slot="data-table"
				data-state="error"
				className={cn("relative w-full", className)}
				{...containerProps}
			>
				<Alert color="danger" variant="soft" title={errorTitle}>
					<div className="flex flex-col gap-3">
						<div>{error}</div>
						{onRetry && (
							<div>
								<Button
									variant="outline"
									color="secondary"
									size="sm"
									onClick={onRetry}
								>
									Try again
								</Button>
							</div>
						)}
					</div>
				</Alert>
			</div>
		);
	}

	// Empty state (explicit isEmpty prop or no data)
	if (isEmpty || data.length === 0) {
		return (
			<div
				data-slot="data-table"
				data-state="empty"
				className={cn("relative w-full", className)}
				{...containerProps}
			>
				<Table className={tableClassName}>
					<TableHeader>
						<TableRow>
							{columns.map((column, colIndex) => (
								<TableHead
									key={colIndex}
									className={cn(
										getAlignClass(column.align),
										column.headerClassName,
									)}
									style={column.width ? { width: column.width } : undefined}
								>
									{column.header}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						<TableRow className="hover:bg-transparent">
							<TableCell colSpan={columns.length} className="h-48 text-center">
								<EmptyMessage fill="none">
									{emptyIcon ? (
										<EmptyMessage.Icon>{emptyIcon}</EmptyMessage.Icon>
									) : null}
									<EmptyMessage.Title>{emptyTitle}</EmptyMessage.Title>
									{emptyMessage ? (
										<EmptyMessage.Description>
											{emptyMessage}
										</EmptyMessage.Description>
									) : null}
								</EmptyMessage>
							</TableCell>
						</TableRow>
					</TableBody>
				</Table>
			</div>
		);
	}

	// Data state
	return (
		<div
			data-slot="data-table"
			data-state="data"
			className={cn("relative w-full", className)}
			{...containerProps}
		>
			<Table className={tableClassName}>
				{caption && <TableCaption>{caption}</TableCaption>}
				<TableHeader>
					<TableRow>
						{columns.map((column, colIndex) => (
							<TableHead
								key={colIndex}
								className={cn(
									getAlignClass(column.align),
									column.headerClassName,
								)}
								style={column.width ? { width: column.width } : undefined}
							>
								{column.header}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{data.map((row, rowIndex) => {
						const key = getRowKey(row, rowIndex, rowKey);
						const isClickable = typeof onRowClick === "function";
						const rowClasses =
							typeof rowClassName === "function"
								? rowClassName(row, rowIndex)
								: rowClassName;

						return (
							<TableRow
								key={key}
								className={cn(isClickable && "cursor-pointer", rowClasses)}
								onClick={
									isClickable ? () => onRowClick(row, rowIndex) : undefined
								}
								tabIndex={isClickable ? 0 : undefined}
								onKeyDown={
									isClickable
										? (e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													onRowClick(row, rowIndex);
												}
											}
										: undefined
								}
								role={isClickable ? "button" : undefined}
							>
								{columns.map((column, colIndex) => (
									<TableCell
										key={colIndex}
										className={cn(
											getAlignClass(column.align),
											column.cellClassName,
										)}
									>
										{getCellValue(row, column.accessor, rowIndex)}
									</TableCell>
								))}
							</TableRow>
						);
					})}
				</TableBody>
				{footer && (
					<TableFooter>
						{typeof footer === "string" ? (
							<TableRow>
								<TableCell colSpan={columns.length}>{footer}</TableCell>
							</TableRow>
						) : (
							footer
						)}
					</TableFooter>
				)}
			</Table>
		</div>
	);
}

// ============================================================================
// Exports
// ============================================================================

export {
	// Primitive components (Layer 1 - compound pattern)
	Table,
	TableHeader,
	TableBody,
	TableFooter,
	TableHead,
	TableRow,
	TableCell,
	TableCaption,
	// Data-driven component (Layer 2 - with StatefulComponentProps)
	DataTable,
};
