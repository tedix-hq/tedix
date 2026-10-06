import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";
import { Text, type TextTone } from "./text";

type MetricGridColumns = 2 | 3 | 4 | 5 | 6;

const COLUMN_CLASS: Record<MetricGridColumns, string> = {
	2: "grid-cols-1 sm:grid-cols-2",
	3: "grid-cols-2 [&>[data-slot=metric-item]:last-child]:col-span-2 sm:grid-cols-3 sm:[&>[data-slot=metric-item]:last-child]:col-span-1",
	4: "grid-cols-2 sm:grid-cols-4",
	5: "grid-cols-2 [&>[data-slot=metric-item]:last-child]:col-span-2 sm:grid-cols-3 lg:grid-cols-5 lg:[&>[data-slot=metric-item]:last-child]:col-span-1",
	6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
};

interface MetricGridProps extends ComponentProps<"dl"> {
	appearance?: "inline" | "bounded";
	columns: MetricGridColumns;
}

function MetricGrid({
	appearance = "inline",
	columns,
	className,
	...props
}: MetricGridProps) {
	return (
		<dl
			data-slot="metric-grid"
			data-appearance={appearance}
			className={cn(
				"m-0 grid min-w-0 gap-px bg-kumo-line",
				COLUMN_CLASS[columns],
				appearance === "bounded"
					? "overflow-hidden rounded-lg border border-kumo-line"
					: "border-kumo-line border-y",
				className,
			)}
			{...props}
		/>
	);
}

interface MetricItemProps extends Omit<ComponentProps<"div">, "children"> {
	description?: ReactNode;
	emphasis?: "body" | "dialog" | "metric";
	label: ReactNode;
	value: ReactNode;
	valueClassName?: string;
	valueTone?: TextTone;
}

function MetricItem({
	description,
	emphasis = "body",
	label,
	value,
	valueClassName,
	valueTone = "strong",
	className,
	...props
}: MetricItemProps) {
	return (
		<div
			data-slot="metric-item"
			className={cn(
				"grid min-w-0 content-start gap-1 bg-kumo-base px-4 py-3",
				className,
			)}
			{...props}
		>
			<Text
				as="dt"
				role="caption"
				tone="secondary"
				weight="medium"
				className="uppercase tracking-wide"
			>
				{label}
			</Text>
			<Text
				as="dd"
				role={emphasis}
				tone={valueTone}
				weight={emphasis === "body" ? "medium" : "semibold"}
				className={cn("m-0 tabular-nums", valueClassName)}
			>
				{value}
			</Text>
			{description ? (
				<Text as="p" role="label" tone="secondary" className="m-0">
					{description}
				</Text>
			) : null}
		</div>
	);
}

export { MetricGrid, MetricItem };
export type { MetricGridColumns, MetricGridProps, MetricItemProps };
