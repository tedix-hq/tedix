"use client";

/**
 * Chart Components - Layer 2 Composite
 *
 * widget-ui Chart primitives built on Recharts with shadcn/ui styling.
 *
 * Base: Recharts with custom context and theming
 *
 * Features:
 * - ChartContainer: Responsive wrapper with theme support
 * - ChartTooltip: Styled tooltip component
 * - ChartTooltipContent: Formatted tooltip content
 * - ChartLegend: Legend component
 * - ChartLegendContent: Formatted legend content
 * - Theme-aware color configuration
 * - Stateful rendering (loading, error, empty states)
 *
 * @example
 * <ChartContainer config={chartConfig} isLoading={loading} error={error}>
 *   <AreaChart data={data}>
 *     <ChartTooltip content={<ChartTooltipContent />} />
 *   </AreaChart>
 * </ChartContainer>
 */

import { AlertCircle, BarChart3 } from "lucide-react";
import * as React from "react";
import * as RechartsPrimitive from "recharts";

import { cn } from "../lib/utils";
import type { StatefulComponentProps } from "../types/stateful-component-props";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Button } from "./button";
import { renderChartStyle } from "./chart-style";
import { Skeleton } from "./skeleton";

export type ChartConfig = {
	[k in string]: {
		label?: React.ReactNode;
		icon?: React.ComponentType;
	} & (
		| { color?: string; theme?: never }
		| { color?: never; theme: Record<"light" | "dark", string> }
	);
};

type ChartContextProps = {
	config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
	const context = React.useContext(ChartContext);

	if (!context) {
		throw new Error("useChart must be used within a <ChartContainer />");
	}

	return context;
}

function ChartContainer({
	id,
	className,
	children,
	config,
	isLoading,
	error,
	isEmpty,
	onRetry,
	emptyMessage = "No chart data available",
	...props
}: React.ComponentProps<"div"> &
	StatefulComponentProps & {
		config: ChartConfig;
		children: React.ComponentProps<
			typeof RechartsPrimitive.ResponsiveContainer
		>["children"];
		emptyMessage?: string;
	}) {
	const uniqueId = React.useId();
	const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`;

	// Loading state
	if (isLoading) {
		return (
			<div
				data-slot="chart"
				className={cn("flex aspect-video justify-center", className)}
				{...props}
			>
				<Skeleton className="h-full w-full" />
			</div>
		);
	}

	// Error state
	if (error) {
		const errorMessage =
			typeof error === "string"
				? error
				: error instanceof Error
					? error.message
					: "Error loading chart";
		return (
			<div
				data-slot="chart"
				className={cn("flex aspect-video justify-center", className)}
				{...props}
			>
				<Alert color="danger" variant="soft" className="w-full">
					<AlertCircle className="h-4 w-4" />
					<AlertTitle>Failed to load chart</AlertTitle>
					<AlertDescription className="flex items-center justify-between">
						<span>{errorMessage}</span>
						{onRetry && (
							<Button variant="outline" size="sm" onClick={onRetry}>
								Retry
							</Button>
						)}
					</AlertDescription>
				</Alert>
			</div>
		);
	}

	// Empty state
	if (isEmpty) {
		return (
			<div
				data-slot="chart"
				className={cn("flex aspect-video justify-center", className)}
				{...props}
			>
				<div className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed">
					<BarChart3 className="h-12 w-12 text-muted-foreground" />
					<p className="text-muted-foreground text-sm">{emptyMessage}</p>
				</div>
			</div>
		);
	}

	return (
		<ChartContext.Provider value={{ config }}>
			<div
				data-slot="chart"
				data-chart={chartId}
				className={cn(
					"flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden",
					className,
				)}
				{...props}
			>
				<ChartStyle id={chartId} config={config} />
				<RechartsPrimitive.ResponsiveContainer
					width="100%"
					height="100%"
					minWidth={1}
					minHeight={1}
				>
					{children}
				</RechartsPrimitive.ResponsiveContainer>
			</div>
		</ChartContext.Provider>
	);
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
	const css = renderChartStyle(id, config);
	return css ? <style>{css}</style> : null;
};

const ChartTooltip = RechartsPrimitive.Tooltip;

/**
 * Recharts tooltip payload item type
 */
export type TooltipPayloadItem = {
	dataKey?: string;
	name?: string;
	value?: number;
	payload?: Record<string, unknown>;
	color?: string;
	fill?: string;
	stroke?: string;
};

/**
 * Custom tooltip props type for use with ChartTooltip content prop
 */
export type CustomTooltipProps = {
	active?: boolean;
	payload?: TooltipPayloadItem[];
	label?: string | number;
	className?: string;
	hideLabel?: boolean;
	hideIndicator?: boolean;
	indicator?: "line" | "dot" | "dashed";
	nameKey?: string;
	labelKey?: string;
	labelFormatter?: (
		label: unknown,
		payload: TooltipPayloadItem[],
	) => React.ReactNode;
	labelClassName?: string;
	formatter?: (
		value: number,
		name: string,
		item: TooltipPayloadItem,
		index: number,
		payload: Record<string, unknown>,
	) => React.ReactNode;
	color?: string;
};

function ChartTooltipContent({
	active,
	payload,
	className,
	indicator = "dot",
	hideLabel = false,
	hideIndicator = false,
	label,
	labelFormatter,
	labelClassName,
	formatter,
	color,
	nameKey,
	labelKey,
}: CustomTooltipProps) {
	const { config } = useChart();

	const tooltipLabel = React.useMemo(() => {
		if (hideLabel || !payload?.length) {
			return null;
		}

		const [item] = payload;
		const key = `${labelKey || item?.dataKey || item?.name || "value"}`;
		const itemConfig = getPayloadConfigFromPayload(config, item, key);
		const value =
			!labelKey && typeof label === "string"
				? config[label as keyof typeof config]?.label || label
				: itemConfig?.label;

		if (labelFormatter) {
			return (
				<div className={cn("font-medium", labelClassName)}>
					{labelFormatter(value, payload)}
				</div>
			);
		}

		if (!value) {
			return null;
		}

		return <div className={cn("font-medium", labelClassName)}>{value}</div>;
	}, [
		label,
		labelFormatter,
		payload,
		hideLabel,
		labelClassName,
		config,
		labelKey,
	]);

	if (!active || !payload?.length) {
		return null;
	}

	const nestLabel = payload.length === 1 && indicator !== "dot";

	return (
		<div
			className={cn(
				"grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl",
				className,
			)}
		>
			{!nestLabel ? tooltipLabel : null}
			<div className="grid gap-1.5">
				{payload.map((item: TooltipPayloadItem, index: number) => {
					const key = `${nameKey || item.name || item.dataKey || "value"}`;
					const itemConfig = getPayloadConfigFromPayload(config, item, key);
					const indicatorColor = color || item.payload?.fill || item.color;

					return (
						<div
							key={item.dataKey}
							className={cn(
								"flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground",
								indicator === "dot" && "items-center",
							)}
						>
							{formatter && item?.value !== undefined && item.name ? (
								formatter(
									item.value,
									item.name,
									item,
									index,
									item.payload ?? {},
								)
							) : (
								<>
									{itemConfig?.icon ? (
										<itemConfig.icon />
									) : (
										!hideIndicator && (
											<div
												className={cn(
													"shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
													{
														"h-2.5 w-2.5": indicator === "dot",
														"w-1": indicator === "line",
														"w-0 border-[1.5px] border-dashed bg-transparent":
															indicator === "dashed",
														"my-0.5": nestLabel && indicator === "dashed",
													},
												)}
												style={
													{
														"--color-bg": indicatorColor,
														"--color-border": indicatorColor,
													} as React.CSSProperties
												}
											/>
										)
									)}
									<div
										className={cn(
											"flex flex-1 justify-between leading-none",
											nestLabel ? "items-end" : "items-center",
										)}
									>
										<div className="grid gap-1.5">
											{nestLabel ? tooltipLabel : null}
											<span className="text-muted-foreground">
												{itemConfig?.label || item.name}
											</span>
										</div>
										{item.value && (
											<span className="font-medium font-mono text-foreground tabular-nums">
												{item.value.toLocaleString()}
											</span>
										)}
									</div>
								</>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

const ChartLegend = RechartsPrimitive.Legend;

/**
 * Recharts legend payload item type
 */
export type LegendPayloadItem = {
	dataKey?: string;
	value?: string;
	color?: string;
	type?: string;
	payload?: Record<string, unknown>;
};

function ChartLegendContent({
	className,
	hideIcon = false,
	payload,
	verticalAlign = "bottom",
	nameKey,
}: React.ComponentProps<"div"> & {
	payload?: LegendPayloadItem[];
	verticalAlign?: "top" | "bottom";
	hideIcon?: boolean;
	nameKey?: string;
}) {
	const { config } = useChart();

	if (!payload?.length) {
		return null;
	}

	return (
		<div
			className={cn(
				"flex items-center justify-center gap-4",
				verticalAlign === "top" ? "pb-3" : "pt-3",
				className,
			)}
		>
			{payload.map((item: LegendPayloadItem) => {
				const key = `${nameKey || item.dataKey || "value"}`;
				const itemConfig = getPayloadConfigFromPayload(config, item, key);

				return (
					<div
						key={item.value}
						className={cn(
							"flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground",
						)}
					>
						{itemConfig?.icon && !hideIcon ? (
							<itemConfig.icon />
						) : (
							<div
								className="h-2 w-2 shrink-0 rounded-[2px]"
								style={{
									backgroundColor: item.color,
								}}
							/>
						)}
						{itemConfig?.label}
					</div>
				);
			})}
		</div>
	);
}

// Helper to extract item config from a payload.
function getPayloadConfigFromPayload(
	config: ChartConfig,
	payload: unknown,
	key: string,
) {
	if (typeof payload !== "object" || payload === null) {
		return undefined;
	}

	const payloadPayload =
		"payload" in payload &&
		typeof payload.payload === "object" &&
		payload.payload !== null
			? payload.payload
			: undefined;

	let configLabelKey: string = key;

	if (
		key in payload &&
		typeof payload[key as keyof typeof payload] === "string"
	) {
		configLabelKey = payload[key as keyof typeof payload] as string;
	} else if (
		payloadPayload &&
		key in payloadPayload &&
		typeof payloadPayload[key as keyof typeof payloadPayload] === "string"
	) {
		configLabelKey = payloadPayload[
			key as keyof typeof payloadPayload
		] as string;
	}

	return configLabelKey in config
		? config[configLabelKey]
		: config[key as keyof typeof config];
}

export {
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartStyle,
	ChartTooltip,
	ChartTooltipContent,
	useChart,
};
