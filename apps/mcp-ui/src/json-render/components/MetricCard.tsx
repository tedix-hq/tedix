import { Card, CardContent } from "@tedix/widget-ui/card";

interface MetricCardProps {
	label: string;
	value: number | string;
	change?: string | null;
	changeType?: "positive" | "negative" | "neutral" | null;
	icon?: string | null;
	format?: "number" | "currency" | "percent" | null;
}

export function MetricCardComponent({
	label,
	value,
	change,
	changeType,
	icon: _icon,
	format,
}: MetricCardProps) {
	const changeColor = {
		positive: "text-emerald-600 dark:text-emerald-400",
		negative: "text-red-600 dark:text-red-400",
		neutral: "text-muted-foreground",
	};

	return (
		<Card>
			<CardContent className="p-4">
				<p className="font-medium text-muted-foreground text-sm">{label}</p>
				<div className="mt-1 flex items-baseline gap-2">
					<p className="font-bold text-2xl text-foreground">
						{formatMetricValue(value, format)}
					</p>
					{change && (
						<span
							className={`font-medium text-sm ${changeColor[changeType ?? "neutral"]}`}
						>
							{change}
						</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function formatMetricValue(
	value: number | string,
	format?: MetricCardProps["format"],
): string {
	if (typeof value !== "number") return value;
	if (format === "currency") {
		return new Intl.NumberFormat("en-US", {
			currency: "USD",
			style: "currency",
		}).format(value);
	}
	if (format === "percent") return `${(value * 100).toFixed(1)}%`;
	return new Intl.NumberFormat("en-US").format(value);
}
