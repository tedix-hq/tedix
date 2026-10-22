"use client";

import { Table as KumoTable } from "@cloudflare/kumo/components/table";
import type * as React from "react";
import { cn } from "./cn";

type TableProps = React.ComponentProps<typeof KumoTable> & {
	containerClassName?: string;
	scrollLabel?: string;
	mobileLayout?: "scroll" | "stacked";
};

function Table({
	className,
	containerClassName,
	scrollLabel,
	mobileLayout = "scroll",
	...props
}: TableProps) {
	return (
		<div
			data-slot="table-container"
			data-focus-ring="inset"
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
				role="table"
				data-mobile-layout={mobileLayout}
				className={cn(
					"group/table caption-bottom",
					mobileLayout === "stacked" &&
						"max-sm:block max-sm:[&>thead]:sr-only max-sm:[&>tbody]:grid",
					className,
				)}
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
}: React.ComponentProps<typeof KumoTable.Row>) {
	return (
		<KumoTable.Row
			role="row"
			data-slot="table-row"
			variant={variant ?? "default"}
			className={cn(
				"border-kumo-hairline border-b transition-colors even:bg-transparent even:[--kumo-table-row-bg:transparent] last:border-b-0 group-data-[mobile-layout=stacked]/table:max-sm:grid group-data-[mobile-layout=stacked]/table:max-sm:py-3 hover:bg-kumo-tint data-[state=selected]:bg-kumo-tint motion-reduce:transition-none",
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
			role="columnheader"
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
	label,
	children,
	...props
}: React.ComponentProps<typeof KumoTable.Cell> & { label?: React.ReactNode }) {
	return (
		<KumoTable.Cell
			role="cell"
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
				"whitespace-nowrap align-middle type-tedix-body [&:has([role=checkbox])]:pr-0 group-data-[mobile-layout=stacked]/table:max-sm:flex group-data-[mobile-layout=stacked]/table:max-sm:min-w-0 group-data-[mobile-layout=stacked]/table:max-sm:items-start group-data-[mobile-layout=stacked]/table:max-sm:justify-between group-data-[mobile-layout=stacked]/table:max-sm:gap-3 group-data-[mobile-layout=stacked]/table:max-sm:whitespace-normal group-data-[mobile-layout=stacked]/table:max-sm:break-words",
				className,
			)}
			{...props}
		>
			{label != null ? (
				<>
					<span
						aria-hidden="true"
						className="hidden shrink-0 text-left text-kumo-subtle group-data-[mobile-layout=stacked]/table:max-sm:block"
					>
						{label}
					</span>
					<span className="min-w-0">{children}</span>
				</>
			) : (
				children
			)}
		</KumoTable.Cell>
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
