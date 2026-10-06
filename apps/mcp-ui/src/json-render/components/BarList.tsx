import { Badge, type BadgeVariant } from "@tedix/widget-ui/badge";
import { Card, CardContent } from "@tedix/widget-ui/card";

export type BarListTone = "default" | "success" | "warning" | "danger" | "info";
export type BarListFormat = "number" | "currency" | "percent";

export interface BarListItem {
	label: string;
	value: number;
	max?: number | null;
	valueLabel?: string | null;
	description?: string | null;
	badge?: string | null;
	badgeVariant?: BadgeVariant | null;
	tone?: BarListTone | null;
}

interface BarListProps {
	items?: BarListItem[] | null;
	title?: string | null;
	description?: string | null;
	maxValue?: number | null;
	format?: BarListFormat | null;
	currency?: string | null;
	showValues?: boolean | null;
	showPercent?: boolean | null;
	sort?: "asc" | "desc" | "none" | null;
	limit?: number | null;
	variant?: "card" | "plain" | null;
}

const toneFill: Record<BarListTone, string> = {
	default: "bg-primary",
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-destructive",
	info: "bg-info",
};

export function BarListComponent({
	items,
	title,
	description,
	maxValue,
	format,
	currency,
	showValues,
	showPercent,
	sort,
	limit,
	variant,
}: BarListProps) {
	const safeItems = Array.isArray(items)
		? items.filter((item) => typeof item.value === "number")
		: [];
	const sortedItems = sortItems(safeItems, sort ?? "none");
	const visibleItems =
		typeof limit === "number" && limit > 0
			? sortedItems.slice(0, limit)
			: sortedItems;
	const fallbackMax = Math.max(...visibleItems.map((item) => item.value), 0);
	const resolvedMax =
		typeof maxValue === "number" && maxValue > 0 ? maxValue : fallbackMax || 1;
	const content = (
		<div className="space-y-3">
			{visibleItems.map((item, index) => (
				<BarListRow
					key={`${item.label}-${index}`}
					item={item}
					maxValue={item.max && item.max > 0 ? item.max : resolvedMax}
					format={format ?? "number"}
					currency={currency}
					showValue={showValues !== false}
					showPercent={!!showPercent}
				/>
			))}
		</div>
	);

	if (visibleItems.length === 0) {
		return <EmptyPrimitiveState label="No bars" />;
	}

	if (variant === "plain") {
		return (
			<div className="space-y-3">
				<PrimitiveHeader title={title} description={description} />
				{content}
			</div>
		);
	}

	return (
		<Card size="sm">
			<CardContent className="space-y-4">
				<PrimitiveHeader title={title} description={description} />
				{content}
			</CardContent>
		</Card>
	);
}

function BarListRow({
	item,
	maxValue,
	format,
	currency,
	showValue,
	showPercent,
}: {
	item: BarListItem;
	maxValue: number;
	format: BarListFormat;
	currency?: string | null;
	showValue: boolean;
	showPercent: boolean;
}) {
	const tone = item.tone ?? "default";
	const percent = clamp((item.value / maxValue) * 100, 0, 100);
	const valueLabel =
		item.valueLabel ?? formatValue(item.value, format, currency);

	return (
		<div className="space-y-1.5">
			<div className="flex min-w-0 items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate font-medium text-foreground text-sm">
						{item.label}
					</p>
					{item.description && (
						<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
							{item.description}
						</p>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{item.badge && (
						<Badge pill variant={item.badgeVariant ?? toneToBadgeVariant(tone)}>
							{item.badge}
						</Badge>
					)}
					{showValue && (
						<span className="font-medium text-muted-foreground text-sm tabular-nums">
							{showPercent ? `${Math.round(percent)}%` : valueLabel}
						</span>
					)}
				</div>
			</div>
			<div className="h-2 overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full rounded-full ${toneFill[tone]}`}
					style={{ width: `${percent}%` }}
				/>
			</div>
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

function sortItems(
	items: BarListItem[],
	sort: "asc" | "desc" | "none",
): BarListItem[] {
	if (sort === "none") return items;
	return [...items].sort((left, right) =>
		sort === "asc" ? left.value - right.value : right.value - left.value,
	);
}

function toneToBadgeVariant(tone: BarListTone): BadgeVariant {
	if (tone === "success") return "success";
	if (tone === "warning") return "warning";
	if (tone === "danger") return "destructive";
	if (tone === "info") return "info";
	return "secondary";
}

function formatValue(
	value: number,
	format: BarListFormat,
	currency?: string | null,
): string {
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
