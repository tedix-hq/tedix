import { Link } from "@/components/kumo/link";
import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { MetricGrid } from "@/components/kumo/metric-grid";
import { MetricTile } from "@/components/metric-tile";
import { Meter } from "@/components/kumo/meter";
import { Text } from "@/components/kumo/text";
import {
	formatCreditWorth,
	formatUsageCredits,
} from "@/lib/billing-credit-display";
import { settledCreditCoverage } from "@/lib/billing-inference-spending";

export function BillingCreditWallet({
	overview,
}: {
	overview: BillingOverview;
}) {
	const credits = overview.credits;
	const monetary = credits?.billingMode === "monetary";
	const coverageDays = credits
		? settledCreditCoverage({
				...credits,
				periodStart: overview.snapshot.periodStart,
				periodEnd: overview.snapshot.periodEnd,
				nowMs: Date.now(),
			})
		: null;
	const currency = monetary
		? (credits?.currency ?? "eur")
		: overview.plan.currency;
	const denominated = monetary || currency.toLowerCase() === "eur";
	const creditValue = credits?.creditValueMicros ?? 10_000;
	const available =
		credits?.availableMicros ?? overview.snapshot.availableCreditMicros;
	const reserved =
		credits?.reservedMicros ?? overview.snapshot.reservedChargeMicros;
	const balance =
		credits?.walletBalanceMicros ?? overview.snapshot.creditBalanceMicros;
	const label = (micros: number) =>
		denominated
			? formatUsageCredits(micros, creditValue)
			: formatCreditWorth(micros, currency);
	const worth = (micros: number) => formatCreditWorth(micros, currency);
	const spent =
		credits?.spentMicros ??
		(overview.period
			? overview.period.creditAppliedMicros +
				overview.period.customerChargeMicros
			: null);
	const reasons: Record<string, string> = {
		subscription_inactive: "Your subscription needs attention.",
		billing_period_inactive: "Your billing period needs to be renewed.",
		monthly_allowance_exhausted: "The included allowance is exhausted.",
		payment_required: "The wallet needs more credits.",
		hard_spend_limit: "The monthly spending cap has been reached.",
		inference_capacity_exhausted: "Today's usage limit has been reached.",
		pricing_unavailable: "Model pricing is not available yet.",
		credit_allowance_exhausted: "Add credits to continue.",
	};
	return (
		<Card tone="raised">
			<CardHeader className="sm:grid-cols-[minmax(0,1fr)_auto]">
				<div className="space-y-1">
					<CardTitle>
						{denominated ? "Usage credits" : "Usage balance"}
					</CardTitle>
					<Text tone="secondary">
						{monetary
							? "Your shared AI usage balance"
							: "Your credit wallet · this plan still uses a token allowance"}
					</Text>
				</div>
				<Badge
					variant={overview.inferenceCapacity.available ? "success" : "warning"}
				>
					{overview.inferenceCapacity.available
						? "Ready to run"
						: "Usage paused"}
				</Badge>
			</CardHeader>
			<CardContent className="space-y-4">
				<div>
					<Text role="label" tone="secondary">
						Available to spend
					</Text>
					<Text
						role="metric"
						weight="semibold"
						className="break-words tabular-nums"
					>
						{label(available)}
					</Text>
					<Text tone="secondary">
						{worth(available)} of usage value · after credits held for running
						work
					</Text>
				</div>
				{!overview.inferenceCapacity.available && (
					<Alert variant="destructive">
						<AlertDescription>
							{reasons[overview.inferenceCapacity.blockingReason ?? ""] ??
								"Usage is blocked. Check your plan and limits below."}
						</AlertDescription>
					</Alert>
				)}
				<MetricGrid columns={3} appearance="bounded">
					<MetricTile
						tile={{
							state: "measured",
							label: "Wallet balance",
							value: label(balance),
							window: "now",
							source: "billing snapshot",
							qualifier: `${worth(balance)} · includes plan credits and top-ups`,
						}}
					/>
					<MetricTile
						tile={{
							state: "measured",
							label: "Held for running work",
							value: label(reserved),
							window: "now",
							source: "billing snapshot",
							qualifier: `${worth(reserved)} · released or settled when work finishes`,
						}}
					/>
					<MetricTile
						tile={
							spent === null
								? {
										state: "empty",
										label: "Spent this period",
										emptyReason:
											"Not settled yet — no settlement total is available",
									}
								: {
										state: "measured",
										label: "Spent this period",
										value: label(spent),
										window: "this billing period",
										source: "usage ledger",
										qualifier: `${worth(spent)} · recorded usage, excluding subscription`,
									}
						}
					/>
				</MetricGrid>
				{monetary && credits && (
					<div className="space-y-2">
						<Text>
							Plan includes {label(credits.includedMicros)} (
							{worth(credits.includedMicros)}) each month.
						</Text>
						<Text>
							{credits.perRunBudgetMicros === undefined ? (
								"No per-run inference cap is recorded."
							) : (
								<>
									Maximum per run: {label(credits.perRunBudgetMicros)} (
									{worth(credits.perRunBudgetMicros)}).
								</>
							)}{" "}
							External tool fees are separate; a cap is not an estimate of the
							full workflow cost.
						</Text>
						<Text tone="secondary">
							Included allowance remaining:{" "}
							{label(credits.remainingIncludedMicros)} (
							{worth(credits.remainingIncludedMicros)}). Purchased and
							promotional balances are not broken out separately.
						</Text>
						<Text tone="secondary">
							{coverageDays === null
								? "Coverage forecast unavailable for this period. It needs at least one day and some settled usage in an active billing period."
								: `At the settled spending pace since this period began, your available credits and current cap cover up to ${coverageDays} more days within this billing period.`}{" "}
							Pending calls, future prices and plan renewals can change this
							estimate.
						</Text>
						{credits.monthlyCapMicros !== null && (
							<>
								<Meter
									label="Monthly spending cap used or held"
									value={Math.min(
										100,
										credits.monthlyCapMicros > 0
											? ((credits.spentMicros + reserved) /
													credits.monthlyCapMicros) *
													100
											: 100,
									)}
								/>
								<Text tone="secondary">
									Monthly spending cap: {label(credits.monthlyCapMicros)} (
									{worth(credits.monthlyCapMicros)}), including held credits.
								</Text>
							</>
						)}
					</div>
				)}
				<Text role="label" tone="secondary">
					{denominated ? (
						<>1 credit = {worth(creditValue)} of usage value. </>
					) : (
						<>
							Balance shown in {currency.toUpperCase()}; no credit conversion or
							exchange rate is applied.{" "}
						</>
					)}
					Model and cache prices determine consumption. Other service credits
					stay separate. Credits are not cash.{" "}
					{monetary
						? "You can spend the credits available. Automatic cash overage stays off."
						: "Credit display does not replace your current token allowance or change historical charges."}
				</Text>
				<Link
					href={
						monetary
							? "/admin/billing?section=subscription#credit-budget"
							: "/admin/billing?section=subscription"
					}
				>
					{monetary ? "Manage spending cap" : "Manage plan and limits"}
				</Link>
			</CardContent>
		</Card>
	);
}
