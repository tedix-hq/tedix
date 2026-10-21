"use client";
import { Table as KumoTable } from "@cloudflare/kumo/components/table";
import type * as React from "react";
import { cn } from "@/lib/utils";
function Table({
	className,
	...props
}: React.ComponentProps<typeof KumoTable>) {
	return (
		<div
			data-slot="table-container"
			className="relative w-full min-w-0 max-w-full overflow-x-auto"
		>
			<KumoTable
				data-slot="table"
				className={cn("caption-bottom", className)}
				{...props}
			/>
		</div>
	);
}
function TableHeader({
	className,
	variant = "compact",
	...props
}: React.ComponentProps<typeof KumoTable.Header>) {
	return (
		<KumoTable.Header
			data-slot="table-header"
			className={className}
			variant={variant}
			{...props}
		/>
	);
}
function TableBody({
	className,
	...props
}: React.ComponentProps<typeof KumoTable.Body>) {
	return (
		<KumoTable.Body data-slot="table-body" className={className} {...props} />
	);
}
function TableRow({
	className,
	variant,
	...props
}: React.ComponentProps<typeof KumoTable.Row> & { "data-state"?: string }) {
	return (
		<KumoTable.Row
			data-slot="table-row"
			variant={
				props["data-state"] === "selected" ? "selected" : (variant ?? "default")
			}
			className={cn(
				"border-kumo-hairline border-b transition-colors last:border-b-0 hover:bg-kumo-tint data-[state=selected]:bg-kumo-tint",
				className,
			)}
			{...props}
		/>
	);
}
function TableHead({
	className,
	...props
}: React.ComponentProps<typeof KumoTable.Head> & {
	scope?: React.ComponentProps<"th">["scope"];
}) {
	return (
		<KumoTable.Head
			data-slot="table-head"
			className={cn(
				"h-10 whitespace-nowrap text-left align-middle font-medium text-kumo-subtle",
				className,
			)}
			{...props}
		/>
	);
}
function TableCell({
	className,
	...props
}: React.ComponentProps<typeof KumoTable.Cell>) {
	return (
		<KumoTable.Cell
			data-slot="table-cell"
			className={cn("whitespace-nowrap align-middle", className)}
			{...props}
		/>
	);
}
export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
