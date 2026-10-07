/**
 * Billing usage overview — the hero stats row of /admin/billing.
 *
 * The canonical numbers remain primary. Two high-signal charts — daily
 * estimated cost and cost concentration by tedi — are passed to a nested lazy
 * Kumo/ECharts boundary. Token-distribution and duplicate model charts remain
 * intentionally absent because they do not add an operator decision.
 */

import { useQuery } from "@tanstack/react-query";
import { Warning } from "@phosphor-icons/react";
import { lazy, Suspense } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { Progress } from "@/components/kumo/progress";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { formatPlanLimit, hasUnlimitedTokenUsage } from "@/lib/billing-display";
import { formatCurrencyAmount } from "@/lib/billing-price";
import {
	billingOverviewQueryOptions,
	ORG_USAGE_PERIOD,
	orgUsageQueryOptions,
} from "@/lib/os-query-options";

const BillingUsageCharts = lazy(() =>
	import("@/components/billing-usage-charts").then((mod) => ({
		default: mod.BillingUsageCharts,
	})),
);

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return n.toLocaleString();
}

function formatCost(n: number): string {
	return formatCurrencyAmount(n);
}

function formatPeriod(start: string, end: string): string {
	const from = new Date(start);
	const to = new Date(end);
	// Show the year whenever the window spans more than one. Without it a
	// 2026-08-29 to 2027-08-29 account rendered as "Aug 29 – Aug 29", which
	// reads as a zero-length period — on the card an operator stares at while
	// working out why they are blocked.
	const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
	const formatter = new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
		timeZone: "UTC",
	});
	return `${formatter.format(from)} – ${formatter.format(to)}`;
}

function sentenceCase(value: string) {
	return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

function errorText(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function BillingUsageOverview({
	organizationId,
}: {
	organizationId: string;
}) {
	const overviewQuery = useQuery({
		...billingOverviewQueryOptions(),
		staleTime: 30_000,
		refetchInterval: 60_000,
	});
	const billingWindow = overviewQuery.data
		? {
				from: overviewQuery.data.snapshot.periodStart,
				to: overviewQuery.data.snapshot.periodEnd,
			}
		: undefined;
	const usageQuery = useQuery({
		...orgUsageQueryOptions(organizationId, ORG_USAGE_PERIOD, billingWindow),
		enabled: Boolean(billingWindow),
		staleTime: 60_000,
		refetchInterval: 120_000,
	});

	if (usageQuery.isPending || overviewQuery.isPending) {
		return (
			<div className="space-y-4" aria-busy="true" aria-label="Loading usage">
				<Skeleton className="h-64 w-full" />
				<MetricGrid appearance="bounded" columns={3} aria-hidden>
					{Array.from({ length: 3 }).map((_, index) => (
						<MetricItem
							key={`usage-metric-${index}`}
							label={<Skeleton className="h-3 w-24" />}
							value={<Skeleton className="h-7 w-20" />}
							description={<Skeleton className="h-3 w-32 max-w-full" />}
						/>
					))}
				</MetricGrid>
			</div>
		);
	}

	if (
		usageQuery.isError ||
		overviewQuery.isError ||
		!usageQuery.data ||
		!overviewQuery.data
	) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Billing usage could not be read</AlertTitle>
				<AlertDescription>
					{errorText(
						usageQuery.error ?? overviewQuery.error,
						"The usage read failed.",
					)}
				</AlertDescription>
			</Alert>
		);
	}

	const overview = overviewQuery.data;
	const usedTokens = overview.snapshot.usedTokens;
	const includedTokens = overview.snapshot.includedTokens;
	const usagePct = includedTokens > 0 ? usedTokens / includedTokens : 0;
	const isUnlimited = hasUnlimitedTokenUsage(overview.snapshot, overview.plan);
	// The canonical admission mode excludes embedded provider customers even if
	// their billing snapshot otherwise resembles a paid overage account.
	const monthlyMetered =
		"monthlyMetered" in overview.inferenceCapacity &&
		overview.inferenceCapacity.monthlyMetered === true;
	const isWarning = !isUnlimited && !monthlyMetered && usagePct > 0.8;
	const isCritical = !isUnlimited && !monthlyMetered && usagePct > 0.95;
	const overageTokens = Math.max(0, usedTokens - includedTokens);
	const billingPeriod = formatPeriod(
		overview.snapshot.periodStart,
		overview.snapshot.periodEnd,
	);

	return (
		<div className="space-y-5">
			<div className="space-y-4">
				{/* The primary billing story: plan, period, and usage in one place. */}
				<Card
					tone="raised"
					className={
						isCritical
							? "border-kumo-danger"
							: isWarning
								? "border-kumo-warning"
								: undefined
					}
				>
					<CardHeader className="sm:grid-cols-[minmax(0,1fr)_auto]">
						<div className="space-y-1">
							<div className="flex flex-wrap items-center gap-2">
								<CardTitle>
									{sentenceCase(overview.snapshot.planKey)} plan
								</CardTitle>
								<Badge
									variant={
										overview.snapshot.status === "active"
											? "success"
											: overview.snapshot.status === "cancelled" ||
												  overview.snapshot.status === "suspended" ||
												  overview.snapshot.status === "past_due"
												? "destructive"
												: "secondary"
									}
								>
									{sentenceCase(overview.snapshot.status)}
								</Badge>
								{isCritical && <Warning className="size-4 text-kumo-danger" />}
							</div>
							<Text role="label" tone="secondary">
								Current billing period · {billingPeriod}
							</Text>
						</div>
					</CardHeader>
					<CardContent className="space-y-5">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<div>
								<Text role="label" tone="secondary">
									Settled billing tokens
								</Text>
								<Text
									as="span"
									role="metric"
									weight="semibold"
									className="block tabular-nums"
								>
									{formatTokens(usedTokens)}
								</Text>
							</div>
							<Text role="body" tone="secondary" className="sm:text-right">
								{isUnlimited
									? "Unlimited plan allowance"
									: monthlyMetered && overageTokens > 0
										? `${formatTokens(includedTokens)} included · ${formatTokens(overageTokens)} overage tokens`
										: monthlyMetered
											? `${formatTokens(includedTokens)} included · overage billed per plan`
											: `${formatTokens(Math.max(0, includedTokens - usedTokens))} remaining of ${formatTokens(includedTokens)}`}
							</Text>
						</div>
						{!isUnlimited && !monthlyMetered && (
							<Progress value={Math.min(usagePct * 100, 100)} />
						)}
						<div className="grid gap-3 border-kumo-line border-t pt-4 sm:grid-cols-4">
							<PlanFact
								label="Tedis"
								value={formatPlanLimit(overview.plan.maxTedis)}
							/>
							<PlanFact
								label="Jobs per tedi"
								value={formatPlanLimit(overview.plan.maxCronJobsPerTedi)}
							/>
							<PlanFact
								label="Steps per task"
								value={formatPlanLimit(overview.plan.maxIterationsPerTask)}
							/>
							<PlanFact
								label="Overage"
								value={
									overview.plan.overageUnitPriceMicros === 0
										? "No surcharge"
										: `${formatCost(overview.plan.overageUnitPriceMicros / 1_000_000)} / ${formatTokens(overview.plan.overageUnitTokens)}`
								}
							/>
						</div>
					</CardContent>
				</Card>

				<MetricGrid
					appearance="bounded"
					columns={3}
					aria-label="Billing summary"
				>
					<MetricItem
						emphasis="metric"
						label="Metered usage charges"
						value={formatCost(
							(overview.period?.customerChargeMicros ?? 0) / 1_000_000,
						)}
						description={
							isUnlimited
								? "Estimated usage this period · unlimited token allowance"
								: `Estimated usage this period · ${formatTokens(overview.period?.meteredOverageTokens ?? 0)} metered overage tokens`
						}
					/>
					<MetricItem
						emphasis="metric"
						label="Credits"
						value={formatCost(
							overview.snapshot.availableCreditMicros / 1_000_000,
						)}
						description={`Available after reservations · ${formatCost(
							(overview.period?.creditAppliedMicros ?? 0) / 1_000_000,
						)} applied this period`}
					/>
					<MetricItem
						emphasis="metric"
						label="Settled model cost"
						value={formatCost(
							(overview.period?.providerCostMicros ?? 0) / 1_000_000,
						)}
						description="Recorded model cost for settled usage · not a customer charge or total infrastructure spend"
					/>
				</MetricGrid>
			</div>
			<Text role="label" tone="secondary">
				Settled tokens count billing input and output. Metered usage charges
				exclude the subscription price and are not an invoice. Usage trends
				below include organization-attributed observations, including cache and
				records that may be held; they can differ from settled billing totals.
			</Text>
			{overview.stripeEnvironment === "test" && (
				<Text role="label" tone="secondary">
					Stripe test mode · payment documents use test data; recorded usage and
					model costs are not simulated.
				</Text>
			)}
			<MetricGrid appearance="bounded" columns={3}>
				<MetricItem
					label="Observed model tokens"
					value={formatTokens(usageQuery.data.totals.totalTokens)}
					description="Organization-attributed ledger observations this period"
				/>
				<MetricItem
					label="Known model-cost subtotal"
					value={formatCost(usageQuery.data.totals.knownSubtotalUsd)}
					description={`${sentenceCase(usageQuery.data.totals.costCompleteness)} pricing coverage · not a payable amount`}
				/>
				<MetricItem
					label="Unpriced observed tokens"
					value={formatTokens(usageQuery.data.totals.unpricedTokens)}
					description={`${formatTokens(usageQuery.data.totals.pricedRowCount)} priced rows · ${formatTokens(usageQuery.data.totals.unpricedRowCount)} unpriced rows`}
				/>
			</MetricGrid>
			<Card tone="raised">
				<CardHeader>
					<CardTitle>Reviewed provider estimates</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2">
					<Text role="metric">
						{formatCost(
							usageQuery.data.totals.reviewedEstimateMicros / 1_000_000,
						)}
					</Text>
					<Text>
						{formatTokens(usageQuery.data.totals.reviewedEstimateRowCount)}{" "}
						reviewed rows ·{" "}
						{formatTokens(usageQuery.data.totals.reviewedEstimateTokens)}{" "}
						observed tokens
					</Text>
					<Text tone="secondary">
						Included in the known model-cost subtotal. These estimates are not
						payable and do not release held usage or change customer charges.
					</Text>
					<details>
						<summary>Technical details</summary>
						<Text tone="secondary">
							{formatTokens(usageQuery.data.totals.sourceRetiredRowCount)}{" "}
							retained records whose original source is no longer present. Only
							the current reviewed version contributes; original usage is
							counted once.
						</Text>
					</details>
				</CardContent>
			</Card>
			<Card tone="raised">
				<CardHeader>
					<CardTitle>Reconciled workstation cost</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2">
					<Text role="metric">
						{overview.workstationCostCoverage.knownAttributedCostMicros === null
							? "Unknown"
							: formatCost(
									overview.workstationCostCoverage.knownAttributedCostMicros /
										1_000_000,
								)}
					</Text>
					<Text tone="secondary">
						Allocated share of recorded provider cost · separate from model cost
						and customer charges.
					</Text>
					<Text>
						{overview.workstationCostCoverage.reconciled.rowCount} reconciled
						rows ·{" "}
						{overview.workstationCostCoverage.reconciled.leaseSeconds.toLocaleString()}{" "}
						lease seconds
					</Text>
					<Text>
						{overview.workstationCostCoverage.pending.rowCount} pending rows ·{" "}
						{overview.workstationCostCoverage.pending.leaseSeconds.toLocaleString()}{" "}
						lease seconds
					</Text>
					<Text>
						{overview.workstationCostCoverage.unproven.rowCount} unproven rows ·{" "}
						{overview.workstationCostCoverage.unproven.leaseSeconds.toLocaleString()}{" "}
						lease seconds
					</Text>
					<Text tone="secondary">
						Lease-end observations in this billing period. Wall-clock lease
						duration is a proxy, not active container time. Pending stored zero
						does not mean free.
					</Text>
					<Text tone="secondary">
						{overview.workstationCostCoverage.status === "none"
							? "No recorded workstation usage."
							: overview.workstationCostCoverage.status ===
								  "recorded_rows_reconciled"
								? "All recorded rows reconciled."
								: "Recorded rows partially reconciled."}{" "}
						Coverage excludes unrecorded leases and does not establish an
						invoice or total infrastructure spend.
					</Text>
					<Text role="label" tone="secondary">
						Observed{" "}
						{new Date(
							overview.workstationCostCoverage.observedAt,
						).toISOString()}
					</Text>
				</CardContent>
			</Card>

			<Suspense
				fallback={
					<div className="grid gap-4 lg:grid-cols-2">
						<Skeleton className="h-[340px]" />
						<Skeleton className="h-[340px]" />
					</div>
				}
			>
				<BillingUsageCharts
					daily={usageQuery.data.daily}
					tedis={usageQuery.data.tediBreakdown}
					periodLabel={billingPeriod}
				/>
			</Suspense>
		</div>
	);
}

function PlanFact({ label, value }: { label: string; value: string }) {
	return (
		<div className="space-y-0.5">
			<Text role="label" tone="secondary">
				{label}
			</Text>
			<Text weight="medium">{value}</Text>
		</div>
	);
}
