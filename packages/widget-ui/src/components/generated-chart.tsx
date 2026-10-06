"use client";

import * as React from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Line,
	LineChart,
	Pie,
	PieChart,
	XAxis,
	YAxis,
} from "recharts";
import { cn } from "../lib/utils";
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "./chart";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export type GeneratedChartVariant = "area" | "bar" | "donut" | "line";
export type GeneratedChartColorToken =
	| "chart-1"
	| "chart-2"
	| "chart-3"
	| "chart-4"
	| "chart-5"
	| "chart-6";

export interface GeneratedChartSeries {
	key: string;
	label?: string | null;
	color?: GeneratedChartColorToken | null;
	stack?: string | null;
}

export interface GeneratedChartProps {
	title?: string | null;
	description?: string | null;
	data?: Array<Record<string, unknown>> | null;
	variant?: GeneratedChartVariant | null;
	xKey?: string | null;
	yKeys?: string[] | null;
	series?: GeneratedChartSeries[] | null;
	nameKey?: string | null;
	valueKey?: string | null;
	height?: number | null;
	showLegend?: boolean | null;
	showTooltip?: boolean | null;
	stacked?: boolean | null;
	className?: string | null;
}

const CHART_COLORS = [
	"var(--chart-1, #2563eb)",
	"var(--chart-2, #16a34a)",
	"var(--chart-3, #f97316)",
	"var(--chart-4, #dc2626)",
	"var(--chart-5, #7c3aed)",
	"var(--chart-6, #0891b2)",
];

export function GeneratedChart({
	title,
	description,
	data,
	variant = "line",
	xKey,
	yKeys,
	series,
	nameKey,
	valueKey,
	height,
	showLegend,
	showTooltip,
	stacked,
	className,
}: GeneratedChartProps) {
	const rows = React.useMemo(
		() => (Array.isArray(data) ? data.filter(isRecord).slice(0, 120) : []),
		[data],
	);
	const resolvedVariant = variant ?? "line";
	const resolvedNameKey = nameKey ?? inferLabelKey(rows) ?? "name";
	const resolvedValueKey = valueKey ?? inferNumericKeys(rows)[0] ?? "value";
	const resolvedXKey =
		xKey ??
		(resolvedVariant === "donut"
			? resolvedNameKey
			: (inferTimeKey(rows) ?? inferLabelKey(rows) ?? "label"));
	const resolvedYKeys =
		yKeys && yKeys.length > 0
			? yKeys
			: inferNumericKeys(rows, resolvedXKey).slice(0, 4);
	const resolvedSeries = normalizeSeries(series, resolvedYKeys);
	const chartHeight = clampHeight(height);
	const chartConfig = React.useMemo(
		() => buildChartConfig(resolvedVariant, resolvedSeries, resolvedValueKey),
		[resolvedVariant, resolvedSeries, resolvedValueKey],
	);

	if (rows.length === 0) {
		return (
			<div className="space-y-2">
				<ChartTitle title={title} description={description} />
				<ChartContainer
					config={{ value: { label: "Value", color: CHART_COLORS[0] } }}
					isEmpty
					className={cn("w-full", className ?? undefined)}
					style={{ height: chartHeight }}
				>
					<LineChart data={[]} />
				</ChartContainer>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<ChartTitle title={title} description={description} />
			<ChartContainer
				config={chartConfig}
				className={cn("w-full", className ?? undefined)}
				style={{ height: chartHeight }}
			>
				{resolvedVariant === "area" ? (
					<AreaChart data={rows} margin={{ left: 0, right: 12, top: 8 }}>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey={resolvedXKey}
							axisLine={false}
							tickLine={false}
							tickMargin={8}
							minTickGap={24}
						/>
						<YAxis
							axisLine={false}
							tickLine={false}
							tickMargin={8}
							width={36}
						/>
						{showTooltip !== false && (
							<ChartTooltip content={<ChartTooltipContent />} />
						)}
						{showLegend && <ChartLegend content={<ChartLegendContent />} />}
						{resolvedSeries.map((item, index) => (
							<Area
								key={item.key}
								dataKey={item.key}
								type="monotone"
								fill={colorForSeries(item, index)}
								fillOpacity={0.16}
								stroke={colorForSeries(item, index)}
								strokeWidth={2}
								stackId={item.stack ?? (stacked ? "stack" : undefined)}
							/>
						))}
					</AreaChart>
				) : resolvedVariant === "bar" ? (
					<BarChart data={rows} margin={{ left: 0, right: 12, top: 8 }}>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey={resolvedXKey}
							axisLine={false}
							tickLine={false}
							tickMargin={8}
							minTickGap={16}
						/>
						<YAxis
							axisLine={false}
							tickLine={false}
							tickMargin={8}
							width={36}
						/>
						{showTooltip !== false && (
							<ChartTooltip content={<ChartTooltipContent />} />
						)}
						{showLegend && <ChartLegend content={<ChartLegendContent />} />}
						{resolvedSeries.map((item, index) => (
							<Bar
								key={item.key}
								dataKey={item.key}
								fill={colorForSeries(item, index)}
								radius={[4, 4, 0, 0]}
								stackId={item.stack ?? (stacked ? "stack" : undefined)}
							/>
						))}
					</BarChart>
				) : resolvedVariant === "donut" ? (
					<PieChart margin={{ left: 0, right: 0, top: 8, bottom: 8 }}>
						{showTooltip !== false && (
							<ChartTooltip
								content={<ChartTooltipContent nameKey={resolvedNameKey} />}
							/>
						)}
						{showLegend !== false && (
							<ChartLegend
								content={<ChartLegendContent nameKey={resolvedNameKey} />}
							/>
						)}
						<Pie
							data={rows}
							dataKey={resolvedValueKey}
							nameKey={resolvedNameKey}
							innerRadius="54%"
							outerRadius="82%"
							paddingAngle={2}
						>
							{rows.map((row, index) => (
								<Cell
									key={`${String(row[resolvedNameKey] ?? index)}-${index}`}
									fill={colorForIndex(index)}
								/>
							))}
						</Pie>
					</PieChart>
				) : (
					<LineChart data={rows} margin={{ left: 0, right: 12, top: 8 }}>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey={resolvedXKey}
							axisLine={false}
							tickLine={false}
							tickMargin={8}
							minTickGap={24}
						/>
						<YAxis
							axisLine={false}
							tickLine={false}
							tickMargin={8}
							width={36}
						/>
						{showTooltip !== false && (
							<ChartTooltip content={<ChartTooltipContent />} />
						)}
						{showLegend && <ChartLegend content={<ChartLegendContent />} />}
						{resolvedSeries.map((item, index) => (
							<Line
								key={item.key}
								dataKey={item.key}
								type="monotone"
								stroke={colorForSeries(item, index)}
								strokeWidth={2}
								dot={false}
								activeDot={{ r: 4 }}
							/>
						))}
					</LineChart>
				)}
			</ChartContainer>
		</div>
	);
}

function ChartTitle({
	title,
	description,
}: {
	title?: string | null;
	description?: string | null;
}) {
	if (!title && !description) return null;
	return (
		<div className="space-y-1">
			{title ? <h3 className="font-medium text-sm">{title}</h3> : null}
			{description ? (
				<p className="text-muted-foreground text-xs">{description}</p>
			) : null}
		</div>
	);
}

function buildChartConfig(
	variant: GeneratedChartVariant,
	series: GeneratedChartSeries[],
	valueKey: string,
): ChartConfig {
	const entries =
		variant === "donut"
			? [{ key: valueKey, label: humanizeKey(valueKey) }]
			: series;
	return Object.fromEntries(
		entries.map((item, index) => [
			item.key,
			{
				label: item.label ?? humanizeKey(item.key),
				color: colorForSeries(item, index),
			},
		]),
	);
}

function normalizeSeries(
	series: GeneratedChartSeries[] | null | undefined,
	yKeys: string[],
): GeneratedChartSeries[] {
	const fromSeries = Array.isArray(series)
		? series
				.filter(
					(item): item is GeneratedChartSeries =>
						typeof item?.key === "string" && item.key.trim().length > 0,
				)
				.map((item, index) => ({
					key: item.key.trim(),
					...(item.label ? { label: item.label } : {}),
					color: item.color ?? colorTokenForIndex(index),
					...(item.stack ? { stack: item.stack } : {}),
				}))
		: [];
	if (fromSeries.length > 0) return fromSeries.slice(0, 6);
	return yKeys.slice(0, 6).map((key, index) => ({
		key,
		label: humanizeKey(key),
		color: colorTokenForIndex(index),
	}));
}

function colorForSeries(item: GeneratedChartSeries, index: number): string {
	return item.color ? colorForToken(item.color) : colorForIndex(index);
}

function colorForToken(token: GeneratedChartColorToken): string {
	const index = Number(token.replace("chart-", "")) - 1;
	return colorForIndex(index);
}

function colorForIndex(index: number): string {
	return CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0];
}

function colorTokenForIndex(index: number): GeneratedChartColorToken {
	const token = `chart-${(index % 6) + 1}` as GeneratedChartColorToken;
	return token;
}

function clampHeight(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 240;
	return Math.min(520, Math.max(140, Math.round(value)));
}

function inferTimeKey(rows: Record<string, unknown>[]): string | null {
	const keys = uniqueKeys(rows);
	return (
		keys.find((key) =>
			/^(date|time|timestamp|day|week|month|period|createdAt|updatedAt)$/i.test(
				key,
			),
		) ?? null
	);
}

function inferLabelKey(rows: Record<string, unknown>[]): string | null {
	const keys = uniqueKeys(rows);
	return (
		keys.find((key) =>
			/^(name|title|label|category|status|state|provider|source|app|tool)$/i.test(
				key,
			),
		) ??
		keys.find((key) => rows.some((row) => typeof row[key] === "string")) ??
		null
	);
}

function inferNumericKeys(
	rows: Record<string, unknown>[],
	excludeKey?: string | null,
): string[] {
	return uniqueKeys(rows).filter(
		(key) =>
			key !== excludeKey &&
			rows.some((row) => typeof toNumber(row[key]) === "number"),
	);
}

function uniqueKeys(rows: Record<string, unknown>[]): string[] {
	return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}

function toNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const normalized = value.replace(/[$€£,%\s]/g, "").replace(",", ".");
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

function humanizeKey(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, (char) => char.toUpperCase());
}
