import type { BillingInferenceSpending } from "@tedix/api-contract/schemas/billing-spending";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Empty, EmptyDescription } from "@/components/kumo/empty";
import { Text } from "@/components/kumo/text";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { osQuery } from "@/lib/os-query-options";
import { groupSettledCreditCharges } from "@/lib/billing-inference-spending";
import {
	formatCreditWorth,
	formatUsageCredits,
} from "@/lib/billing-credit-display";

export function SettledSpendingRows({
	data,
}: {
	data: BillingInferenceSpending;
}) {
	return (
		<div className="space-y-3">
			<Text weight="semibold">Settled usage credits by run</Text>
			<Text tone="secondary">
				Last 30 days · {data.rows.length} monetary receipts shown. These are
				customer charges, separate from the model cost estimates below.
				{data.hasMore &&
					" Only the newest receipts are shown; run subtotals are incomplete."}
			</Text>
			{data.rows.length === 0 ? (
				<Empty appearance="inline">
					<EmptyDescription>
						No settled monetary inference receipts in this window. Unsettled
						work and other service charges are not included.
					</EmptyDescription>
				</Empty>
			) : (
				<Table scrollLabel="Settled credit charges by run">
					<TableHeader>
						<TableRow>
							<TableHead>Run</TableHead>
							<TableHead>Settled charge</TableHead>
							<TableHead>Pricing</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{groupSettledCreditCharges(data.rows).map((group) => (
							<TableRow key={group.runId ?? "unlinked"}>
								<TableCell className="max-w-md whitespace-normal">
									{group.runId ? (
										<a
											className="text-kumo-brand underline underline-offset-2"
											href={`/work/runs/${encodeURIComponent(group.runId)}`}
										>
											Open run · {group.runId.slice(0, 8)}
										</a>
									) : (
										"Charges without a linked run"
									)}
									<details className="mt-2">
										<summary className="cursor-pointer">
											{group.calls.length} call receipts
										</summary>
										{group.calls.map((call) => (
											<div
												key={call.id}
												className="mt-2 break-words text-xs text-kumo-subtle"
											>
												{call.model} · {call.occurredAt} ·{" "}
												{Number.isSafeInteger(
													call.creditAppliedMicros + call.customerChargeMicros,
												)
													? formatCreditWorth(
															call.creditAppliedMicros +
																call.customerChargeMicros,
															"eur",
														)
													: "Amount unavailable"}{" "}
												· receipt {call.id}
												{call.traceId && ` · step trace ${call.traceId}`} ·
												price {call.rateVersionId ?? "unavailable"}
											</div>
										))}
									</details>
								</TableCell>
								<TableCell>
									{group.chargeMicros === null ? (
										"Total unavailable"
									) : (
										<>
											{group.creditValueMicros !== null && (
												<Text>
													{formatUsageCredits(
														group.chargeMicros,
														group.creditValueMicros,
													)}
												</Text>
											)}
											<Text>
												{formatCreditWorth(group.chargeMicros, "eur")}
											</Text>
											{group.creditValueMicros === null && (
												<Text tone="secondary">
													Credit denomination unavailable or mixed
												</Text>
											)}
										</>
									)}
								</TableCell>
								<TableCell>
									{group.pricesPinned
										? "Recorded price versions"
										: "Price version missing"}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
			<Text tone="secondary">
				A charge is counted once per receipt, even when a run produces several
				Outputs. Reviewed or accepted results are not linked to these charges
				yet, so cost per accepted result is unavailable.
			</Text>
		</div>
	);
}

export function BillingSettledSpending() {
	const spending = useQuery(
		osQuery.billing.getInferenceSpending.queryOptions({
			input: { limit: 100 },
		}),
	);
	if (spending.isPending)
		return (
			<Skeleton className="h-24" aria-label="Loading settled credit charges" />
		);
	if (spending.isError || !spending.data)
		return (
			<Alert variant="destructive">
				<AlertDescription>
					Settled credit charges could not be read. This does not mean zero
					spending.
				</AlertDescription>
			</Alert>
		);
	return <SettledSpendingRows data={spending.data} />;
}
