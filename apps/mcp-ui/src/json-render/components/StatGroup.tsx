export interface StatItem {
	label: string;
	value: string;
	change?: string | null;
	changeType?: "positive" | "negative" | "neutral" | null;
}

interface StatGroupProps {
	stats: StatItem[];
	columns?: {
		mobile: number;
		tablet?: number | null;
		desktop?: number | null;
	} | null;
}

export function StatGroupComponent({ stats, columns }: StatGroupProps) {
	const cols = columns ?? { mobile: 2, tablet: 3, desktop: 4 };
	const gridColumns = [
		columnClass(cols.mobile),
		cols.tablet ? columnClass(cols.tablet, "md") : "",
		cols.desktop ? columnClass(cols.desktop, "lg") : "",
	]
		.filter(Boolean)
		.join(" ");
	const changeColor = {
		positive: "text-emerald-600 dark:text-emerald-400",
		negative: "text-red-600 dark:text-red-400",
		neutral: "text-muted-foreground",
	};

	return (
		<div className={`grid ${gridColumns} gap-4`}>
			{stats.map((stat, i) => (
				<div key={i} className="rounded-lg border bg-card p-4">
					<p className="text-muted-foreground text-sm">{stat.label}</p>
					<div className="mt-1 flex items-baseline gap-2">
						<p className="font-bold text-foreground text-xl">{stat.value}</p>
						{stat.change && (
							<span
								className={`font-medium text-xs ${changeColor[stat.changeType ?? "neutral"]}`}
							>
								{stat.change}
							</span>
						)}
					</div>
				</div>
			))}
		</div>
	);
}

function columnClass(count: number, breakpoint?: "lg" | "md"): string {
	const normalized = Math.min(Math.max(Math.round(count), 1), 4);
	const prefix = breakpoint ? `${breakpoint}:` : "";
	if (normalized === 1) return `${prefix}grid-cols-1`;
	if (normalized === 2) return `${prefix}grid-cols-2`;
	if (normalized === 3) return `${prefix}grid-cols-3`;
	return `${prefix}grid-cols-4`;
}
