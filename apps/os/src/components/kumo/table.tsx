"use client";

import { Table as KumoTable } from "@cloudflare/kumo/components/table";
import type * as React from "react";
import { cn } from "./cn";

type TableProps = React.ComponentProps<typeof KumoTable> & {
	containerClassName?: string;
	scrollLabel?: string;
};

function Table({
	className,
	containerClassName,
	scrollLabel,
	...props
}: TableProps) {
	return (
		<div
			data-slot="table-container"
			className={cn(
				"relative w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain",
				scrollLabel &&
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus",
				containerClassName,
			)}
			aria-label={scrollLabel}
			role={scrollLabel ? "region" : undefined}
			tabIndex={scrollLabel ? 0 : undefined}
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

function TableFooter({
	className,
	...props
}: React.ComponentProps<typeof KumoTable.Footer>) {
	return (
		<KumoTable.Footer
			data-slot="table-footer"
			className={cn("bg-kumo-elevated font-medium", className)}
			{...props}
		/>
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
				"border-kumo-hairline border-b transition-colors even:bg-transparent even:[--kumo-table-row-bg:transparent] last:border-b-0 hover:bg-kumo-tint data-[state=selected]:bg-kumo-tint motion-reduce:transition-none",
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
				"h-10 whitespace-nowrap text-left align-middle font-medium text-kumo-subtle type-tedix-body [&:has([role=checkbox])]:pr-0",
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
			className={cn(
				// Kumo's table root pins `text-base` (16px) and its cell adds no
				// type class of its own, so an unstyled operational cell renders two
				// tiers above the Console. TableCell owns the body role the way
				// TableHead owns the label role; the role class is `!important`, so
				// call sites style colour and layout and no longer guess at
				// `text-sm`/`text-xs` on the cell itself. A genuinely smaller
				// fragment (a truncated id, secondary metadata) belongs in a child
				// element, which keeps its own size.
				"whitespace-nowrap align-middle type-tedix-body [&:has([role=checkbox])]:pr-0",
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
			className={cn("mt-4 text-kumo-subtle type-tedix-body", className)}
			{...props}
		/>
	);
}

export {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
};
