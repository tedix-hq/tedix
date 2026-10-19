import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CostChip } from "@/components/cost-chip";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Empty, EmptyDescription } from "@/components/kumo/empty";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { groupRecordedRunCosts } from "@/lib/billing-run-costs";
import { osQuery } from "@/lib/os-query-options";
import { BillingSettledSpending } from "./billing-settled-spending";

export function BillingRunCosts({
	organizationId,
}: {
	organizationId: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const ledger = useQuery({
		...osQuery.orgUsage.getBillingLedger.queryOptions({
			input: {
				organizationId,
				period: "30d",
				includeUnattributed: true,
				limit: 200,
			},
		}),
		enabled: expanded,
	});
	return (
		<Card tone="raised">
			<CardHeader className="sm:grid-cols-[minmax(0,1fr)_auto]">
				<div className="space-y-1">
					<CardTitle>Spending by run</CardTitle>
					<Text tone="secondary">
						See which runs used model resources, then open a run to inspect its
						steps.
					</Text>
				</div>
				<Button
					variant="outline"
					className="text-kumo-strong"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? "Hide run costs" : "View run costs"}
				</Button>
			</CardHeader>
			{expanded && (
				<CardContent className="space-y-3">
					<BillingSettledSpending />
					{ledger.isPending ? (
						<Skeleton className="h-24" aria-label="Loading recorded costs" />
					) : ledger.isError || !ledger.data ? (
						<Alert variant="destructive">
							<AlertDescription>
								Recorded costs could not be read. This does not mean zero
								spending.
							</AlertDescription>
						</Alert>
					) : (
						<>
							<Text tone="secondary">
								Recent 30 days · {ledger.data.pagination.returnedRows} of{" "}
								{ledger.data.pagination.totalRows} ledger records.{" "}
								{ledger.data.pagination.hasMore
									? "Only the newest records are shown; these run subtotals are incomplete."
									: "Run attribution can still be incomplete or arrive later."}{" "}
								These are recorded model costs, separate from customer credit
								charges.
							</Text>
							{ledger.data.rows.length === 0 ? (
								<Empty appearance="inline">
									<EmptyDescription>
										No model cost records in this window.
									</EmptyDescription>
								</Empty>
							) : (
								<Table scrollLabel="Recorded costs by run">
									<TableHeader>
										<TableRow>
											<TableHead>Run</TableHead>
											<TableHead>Recorded calls</TableHead>
											<TableHead>Model cost</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{groupRecordedRunCosts(ledger.data.rows).map((group) => (
											<TableRow key={group.runId ?? "unlinked"}>
												<TableCell>
													{group.runId ? (
														<a
															className="text-kumo-brand underline underline-offset-2"
															href={`/work/runs/${encodeURIComponent(group.runId)}`}
														>
															Open run · {group.runId.slice(0, 8)}
														</a>
													) : (
														"Calls without a linked run"
													)}
												</TableCell>
												<TableCell>{group.callCount}</TableCell>
												<TableCell>
													<CostChip
														reading={group.reading}
														subject="Model cost in returned ledger records for this run"
													/>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							)}
							<Text role="label" tone="secondary">
								Workspace, step and useful-result credit allocation is not
								available in this ledger. Unlinked calls stay visible.
							</Text>
						</>
					)}
				</CardContent>
			)}
		</Card>
	);
}
