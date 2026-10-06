import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import {
	Progress,
	ProgressIndicator,
	ProgressLabel,
	ProgressTrack,
} from "@/components/ui/progress";

export interface CatalogBreakdownRow {
	label: string;
	percent: number;
	value: string;
}

interface CatalogBreakdownChartProps {
	asOfLabel: string;
	description: string;
	emptyDescription: string;
	rows: CatalogBreakdownRow[];
	title: string;
}

export function CatalogBreakdownChart({
	asOfLabel,
	description,
	emptyDescription,
	rows,
	title,
}: CatalogBreakdownChartProps) {
	return (
		<Card className="h-full" aria-label={title}>
			<CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
				<div className="space-y-1">
					<CardTitle>{title}</CardTitle>
					<CardDescription className="text-sm leading-relaxed">
						{description}
					</CardDescription>
				</div>
				<Badge variant="outline" className="w-fit shrink-0">
					{asOfLabel}
				</Badge>
			</CardHeader>
			<CardContent>
				{rows.length > 0 ? (
					<ol className="space-y-5">
						{rows.map((row) => (
							<li key={row.label}>
								<Progress
									value={row.percent}
									aria-label={`${row.label}: ${row.value}, ${row.percent}% of indexed apps`}
								>
									<div className="flex w-full items-baseline justify-between gap-4 text-sm">
										<ProgressLabel>{row.label}</ProgressLabel>
										<span className="flex items-baseline gap-2 text-kumo-subtle tabular-nums">
											<span className="font-medium text-kumo-default tabular-nums">
												{row.value}
											</span>
											<span>{row.percent}%</span>
										</span>
									</div>
									<ProgressTrack>
										<ProgressIndicator />
									</ProgressTrack>
								</Progress>
							</li>
						))}
					</ol>
				) : (
					<Empty
						title="Data refresh in progress"
						description={emptyDescription}
					/>
				)}
			</CardContent>
		</Card>
	);
}
