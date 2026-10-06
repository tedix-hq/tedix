import { Badge, type BadgeVariant } from "@tedix/widget-ui/badge";
import { Card, CardContent } from "@tedix/widget-ui/card";

export type MetricTrendDirection = "up" | "down" | "flat";
export type MetricTrendTone =
	| "default"
	| "success"
	| "warning"
	| "danger"
	| "info";
export type MetricTrendFormat = "number" | "currency" | "percent" | "text";
export type MetricTrendVariant = "card" | "plain" | "inline";

interface MetricTrendProps {
	label: string;
	value: number | string;
	unit?: string | null;
	trend?: string | null;
	trendLabel?: string | null;
	direction?: MetricTrendDirection | null;
	description?: string | null;
	badge?: string | null;
	badgeVariant?: BadgeVariant | null;
	tone?: MetricTrendTone | null;
	format?: MetricTrendFormat | null;
	currency?: string | null;
	variant?: MetricTrendVariant | null;
}

const toneText: Record<MetricTrendTone, string> = {
	default: "text-muted-foreground",
	success: "text-success",
	warning: "text-warning",
	danger: "text-destructive",
	info: "text-info",
};

const directionText: Record<MetricTrendDirection, string> = {
	up: "text-success",
	down: "text-destructive",
	flat: "text-muted-foreground",
};

const directionSymbol: Record<MetricTrendDirection, string> = {
	up: "+",
	down: "-",
	flat: "",
};

export function MetricTrendComponent({
	label,
	value,
	unit,
	trend,
	trendLabel,
	direction,
	description,
	badge,
	badgeVariant,
	tone,
	format,
	currency,
	variant,
}: MetricTrendProps) {
	const content = (
		<div className={variant === "inline" ? "min-w-0" : "min-w-0 space-y-2"}>
			<div className="flex min-w-0 items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate font-medium text-muted-foreground text-xs uppercase tracking-normal">
						{label}
					</p>
					<div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
						<span className="break-words font-semibold text-2xl text-foreground tabular-nums leading-tight">
							{formatValue(value, format, currency)}
						</span>
						{unit && (
							<span className="font-medium text-muted-foreground text-sm">
								{unit}
							</span>
						)}
					</div>
				</div>
				{badge && (
					<Badge pill variant={badgeVariant ?? toneToBadgeVariant(tone)}>
						{badge}
					</Badge>
				)}
			</div>
			{(trend || trendLabel || description) && (
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
					{trend && (
						<span
							className={`font-medium tabular-nums ${directionText[direction ?? "flat"]}`}
						>
							{directionSymbol[direction ?? "flat"]}
							{trend}
						</span>
					)}
					{trendLabel && (
						<span className={toneText[tone ?? "default"]}>{trendLabel}</span>
					)}
					{description && (
						<span className="min-w-0 text-muted-foreground">{description}</span>
					)}
				</div>
			)}
		</div>
	);

	if (variant === "plain" || variant === "inline") {
		return content;
	}

	return (
		<Card size="sm">
			<CardContent>{content}</CardContent>
		</Card>
	);
}

function toneToBadgeVariant(tone?: MetricTrendTone | null): BadgeVariant {
	if (tone === "success") return "success";
	if (tone === "warning") return "warning";
	if (tone === "danger") return "destructive";
	if (tone === "info") return "info";
	return "secondary";
}

function formatValue(
	value: number | string,
	format?: MetricTrendFormat | null,
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
