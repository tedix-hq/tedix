"use client";

import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Button } from "./button";
import { cn } from "./cn";
import { Empty } from "./empty";
import { Skeleton } from "./skeleton";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from "./table";

export interface TableColumn<T = Record<string, unknown>> {
	header: React.ReactNode;
	accessor: keyof T | ((row: T, index: number) => React.ReactNode);
	headerClassName?: string;
	cellClassName?: string;
	width?: string;
	align?: "left" | "center" | "right";
	sticky?: "left" | "right";
}

export interface DataTableProps<T = Record<string, unknown>> extends Omit<
	React.ComponentProps<"div">,
	"children"
> {
	data: Array<T>;
	columns: Array<TableColumn<T>>;
	rowKey?: keyof T | ((row: T, index: number) => string | number);
	caption?: React.ReactNode;
	footer?: React.ReactNode;
	isLoading?: boolean;
	loadingRows?: number;
	error?: string | null;
	onRetry?: () => void;
	isEmpty?: boolean;
	emptyTitle?: string;
	emptyMessage?: string;
	emptyIcon?: React.ReactNode;
	errorTitle?: string;
	tableClassName?: string;
	scrollLabel?: string;
	rowClassName?: string | ((row: T, index: number) => string);
}

function alignClass(align?: "left" | "center" | "right") {
	if (align === "center") return "text-center";
	if (align === "right") return "text-right";
	return "text-left";
}

function cellValue<T>(
	row: T,
	accessor: keyof T | ((row: T, index: number) => React.ReactNode),
	index: number,
): React.ReactNode {
	if (typeof accessor === "function") return accessor(row, index);
	const value = row[accessor];
	if (value === null || value === undefined) return "";
	if (typeof value === "string" || typeof value === "number") return value;
	if (React.isValidElement(value)) return value;
	return String(value);
}

function rowKey<T>(
	row: T,
	index: number,
	key?: keyof T | ((row: T, index: number) => string | number),
) {
	if (!key) return index;
	if (typeof key === "function") return key(row, index);
	const value = row[key];
	return typeof value === "string" || typeof value === "number" ? value : index;
}

function Header<T>({ columns }: { columns: Array<TableColumn<T>> }) {
	return (
		<TableHeader variant="compact">
			<TableRow>
				{columns.map((column, index) => (
					<TableHead
						key={index}
						className={cn(alignClass(column.align), column.headerClassName)}
						scope="col"
						sticky={column.sticky}
						style={column.width ? { width: column.width } : undefined}
					>
						{column.header}
					</TableHead>
				))}
			</TableRow>
		</TableHeader>
	);
}

export function DataTable<T extends Record<string, unknown>>({
	data,
	columns,
	rowKey: rowKeyProp,
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
	scrollLabel = "Data table",
	rowClassName,
	...containerProps
}: DataTableProps<T>) {
	if (isLoading) {
		return (
			<div
				data-slot="data-table"
				data-state="loading"
				className={cn("relative w-full min-w-0", className)}
				aria-busy="true"
				aria-live="polite"
				{...containerProps}
			>
				<Table className={tableClassName} scrollLabel={scrollLabel}>
					<Header columns={columns} />
					<TableBody>
						{Array.from({ length: loadingRows }).map((_, rowIndex) => (
							<TableRow key={`skeleton-row-${rowIndex}`}>
								{columns.map((column, columnIndex) => (
									<TableCell
										key={`skeleton-cell-${rowIndex}-${columnIndex}`}
										className={cn(
											alignClass(column.align),
											column.cellClassName,
										)}
										sticky={column.sticky}
									>
										<Skeleton className="h-4 w-3/4" />
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		);
	}

	if (error) {
		return (
			<div
				data-slot="data-table"
				data-state="error"
				className={cn("relative w-full min-w-0", className)}
				{...containerProps}
			>
				<Alert variant="destructive">
					<AlertTitle>{errorTitle}</AlertTitle>
					<AlertDescription>{error}</AlertDescription>
					{onRetry ? (
						<div className="mt-3">
							<Button variant="outline" size="sm" onClick={onRetry}>
								Try again
							</Button>
						</div>
					) : null}
				</Alert>
			</div>
		);
	}

	if (isEmpty || data.length === 0) {
		return (
			<div
				data-slot="data-table"
				data-state="empty"
				className={cn("relative w-full min-w-0", className)}
				{...containerProps}
			>
				<Table className={tableClassName} scrollLabel={scrollLabel}>
					<Header columns={columns} />
					<TableBody>
						<TableRow className="hover:bg-transparent">
							<TableCell colSpan={columns.length} className="h-48 text-center">
								<Empty
									icon={emptyIcon}
									title={emptyTitle}
									description={emptyMessage}
									className="border-0 bg-transparent py-6"
								/>
							</TableCell>
						</TableRow>
					</TableBody>
				</Table>
			</div>
		);
	}

	return (
		<div
			data-slot="data-table"
			data-state="data"
			className={cn("relative w-full min-w-0", className)}
			{...containerProps}
		>
			<Table className={tableClassName} scrollLabel={scrollLabel}>
				{caption ? <TableCaption>{caption}</TableCaption> : null}
				<Header columns={columns} />
				<TableBody>
					{data.map((row, index) => {
						const rowClasses =
							typeof rowClassName === "function"
								? rowClassName(row, index)
								: rowClassName;
						return (
							<TableRow
								key={rowKey(row, index, rowKeyProp)}
								className={rowClasses}
							>
								{columns.map((column, columnIndex) => (
									<TableCell
										key={columnIndex}
										className={cn(
											alignClass(column.align),
											column.cellClassName,
										)}
										sticky={column.sticky}
									>
										{cellValue(row, column.accessor, index)}
									</TableCell>
								))}
							</TableRow>
						);
					})}
				</TableBody>
				{footer ? (
					<TableFooter>
						{typeof footer === "string" ? (
							<TableRow>
								<TableCell colSpan={columns.length}>{footer}</TableCell>
							</TableRow>
						) : (
							footer
						)}
					</TableFooter>
				) : null}
			</Table>
		</div>
	);
}
