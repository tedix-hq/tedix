import { Badge, type BadgeVariant } from "@tedix/widget-ui/badge";
import { Card, CardContent } from "@tedix/widget-ui/card";

export type StatGridTone =
	| "default"
	| "success"
	| "warning"
	| "danger"
	| "info";
export type StatGridChangeType = "positive" | "negative" | "neutral";
export type StatGridFormat = "number" | "currency" | "percent" | "text";

export interface StatGridItem {
	label: string;
	value: number | string;
	unit?: string | null;
	description?: string | null;
	change?: string | null;
	changeType?: StatGridChangeType | null;
	badge?: string | null;
	badgeVariant?: BadgeVariant | null;
	tone?: StatGridTone | null;
	progress?: number | null;
	format?: StatGridFormat | null;
	currency?: string | null;
}

interface ResponsiveColumns {
	mobile: number;
	tablet?: number | null;
	desktop?: number | null;
}

interface StatGridProps {
	stats?: StatGridItem[] | null;
	title?: string | null;
	description?: string | null;
	columns?: ResponsiveColumns | null;
	variant?: "cards" | "panel" | "minimal" | null;
	density?: "compact" | "comfortable" | null;
}

const toneAccent: Record<StatGridTone, string> = {
	default: "bg-primary",
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-destructive",
	info: "bg-info",
};

const changeColor: Record<StatGridChangeType, string> = {
	positive: "text-emerald-600 dark:text-emerald-400",
	negative: "text-red-600 dark:text-red-400",
	neutral: "text-muted-foreground",
};

export function StatGridComponent({
	stats,
	title,
	description,
	columns,
	variant,
	density,
}: StatGridProps) {
	const safeStats = Array.isArray(stats) ? stats : [];
	const resolvedVariant = variant ?? "cards";
	const compact = density === "compact";
	const gridColumns = buildColumnClasses(
		columns ?? { mobile: 1, tablet: 2, desktop: 4 },
	);
	const content = (
		<div className={`${gridColumns} grid gap-3`}>
			{safeStats.map((stat, index) => (
				<StatGridCell
					key={`${stat.label}-${index}`}
					stat={stat}
					compact={compact}
					minimal={resolvedVariant === "minimal"}
				/>
			))}
		</div>
	);

	if (safeStats.length === 0) {
		return <EmptyPrimitiveState label="No stats" />;
	}

	if (resolvedVariant === "panel") {
		return (
			<Card size="sm">
				<CardContent className="space-y-4">
					<PrimitiveHeader title={title} description={description} />
					{content}
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-3">
			<PrimitiveHeader title={title} description={description} />
			{content}
		</div>
	);
}

function StatGridCell({
	stat,
	compact,
	minimal,
}: {
	stat: StatGridItem;
	compact: boolean;
	minimal: boolean;
}) {
	const tone = stat.tone ?? "default";
	const progress =
		typeof stat.progress === "number" ? clamp(stat.progress, 0, 100) : null;
	const value = formatValue(stat.value, stat.format, stat.currency);

	return (
		<div
			className={[
				"relative overflow-hidden rounded-lg border bg-card text-card-foreground",
				minimal ? "border-transparent bg-transparent shadow-none" : "",
				compact ? "p-3" : "p-4",
			]
				.filter(Boolean)
				.join(" ")}
		>
			{!minimal && (
				<div
					className={`absolute inset-x-0 top-0 h-0.5 ${toneAccent[tone]}`}
					aria-hidden="true"
				/>
			)}
			<div className="flex min-w-0 items-start justify-between gap-3">
				<p className="min-w-0 truncate font-medium text-muted-foreground text-sm">
					{stat.label}
				</p>
				{stat.badge && (
					<Badge pill variant={stat.badgeVariant ?? toneToBadgeVariant(tone)}>
						{stat.badge}
					</Badge>
				)}
			</div>
			<div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
				<p className="break-words font-semibold text-2xl text-foreground tabular-nums leading-tight">
					{value}
				</p>
				{stat.unit && (
					<span className="font-medium text-muted-foreground text-sm">
						{stat.unit}
					</span>
				)}
				{stat.change && (
					<span
						className={`font-medium text-sm ${changeColor[stat.changeType ?? "neutral"]}`}
					>
						{stat.change}
					</span>
				)}
			</div>
			{stat.description && (
				<p className="mt-2 line-clamp-2 text-muted-foreground text-xs leading-relaxed">
					{stat.description}
				</p>
			)}
			{progress != null && (
				<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
					<div
						className={`h-full rounded-full ${toneAccent[tone]}`}
						style={{ width: `${progress}%` }}
					/>
				</div>
			)}
		</div>
	);
}

function PrimitiveHeader({
	title,
	description,
}: {
	title?: string | null;
	description?: string | null;
}) {
	if (!title && !description) return null;
	return (
		<div className="space-y-1">
			{title && (
				<h3 className="font-semibold text-base text-foreground">{title}</h3>
			)}
			{description && (
				<p className="text-muted-foreground text-sm leading-relaxed">
					{description}
				</p>
			)}
		</div>
	);
}

function EmptyPrimitiveState({ label }: { label: string }) {
	return (
		<div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center text-muted-foreground text-sm">
			{label}
		</div>
	);
}

function buildColumnClasses(columns: ResponsiveColumns): string {
	return [
		columnClass(columns.mobile),
		columns.tablet ? columnClass(columns.tablet, "md") : "",
		columns.desktop ? columnClass(columns.desktop, "lg") : "",
	]
		.filter(Boolean)
		.join(" ");
}

function columnClass(count: number, breakpoint?: "lg" | "md"): string {
	const normalized = Math.min(Math.max(Math.round(count), 1), 4);
	const prefix = breakpoint ? `${breakpoint}:` : "";
	if (normalized === 1) return `${prefix}grid-cols-1`;
	if (normalized === 2) return `${prefix}grid-cols-2`;
	if (normalized === 3) return `${prefix}grid-cols-3`;
	return `${prefix}grid-cols-4`;
}

function toneToBadgeVariant(tone: StatGridTone): BadgeVariant {
	if (tone === "success") return "success";
	if (tone === "warning") return "warning";
	if (tone === "danger") return "destructive";
	if (tone === "info") return "info";
	return "secondary";
}

function formatValue(
	value: number | string,
	format?: StatGridFormat | null,
	currency?: string | null,
): string {
	if (typeof value !== "number" || format === "text") return String(value);
	if (format === "currency") {
		return new Intl.NumberFormat("en-US", {
			currency: currency ?? "USD",
			style: "currency",
			maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
		}).format(value);
	}
	if (format === "percent") {
		return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
	}
	return new Intl.NumberFormat("en-US").format(value);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
