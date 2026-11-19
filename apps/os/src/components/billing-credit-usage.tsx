/**
 * Credits this month: used, included, remaining, top-ups, what used them,
 * and the 80% / 100% notices. Display only; the API decides what is billed
 * and when work stops.
 */

import { Warning } from "@phosphor-icons/react";
import { BillingSectionHeader } from "@/components/billing-section-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Card, CardContent } from "@/components/kumo/card";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { Meter } from "@/components/kumo/meter";
import { Text } from "@/components/kumo/text";
import {
	type CreditUsage,
	allowanceUsage,
	creditsPaused,
	formatCredits,
	formatUsagePercent,
	latestCreditNotice,
	monthlyAllowanceCredits,
	payAsYouGoRemainingCredits,
} from "@/lib/billing-credits";
import { formatBillingAmount } from "@/lib/billing-price";
import { osLocale } from "@/lib/format";

export function formatCreditPeriod(start: string, end: string): string {
	const from = new Date(start);
	// The period end is exclusive; show the last day that still counts.
	const to = new Date(Date.parse(end) - 1);
	const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
	const formatter = new Intl.DateTimeFormat(osLocale(), {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
		timeZone: "UTC",
	});
	return `${formatter.format(from)} – ${formatter.format(to)}`;
}

/** The plain-English notice for the highest threshold reached this month. */
export function CreditNoticeAlert({ credits }: { credits: CreditUsage }) {
	const notice = latestCreditNotice(credits);
	const paused = creditsPaused(credits);
	if (paused) {
		return (
			<Alert variant="destructive" data-credit-notice="paused">
				<Warning aria-hidden />
				<AlertTitle>Your organization is out of credits</AlertTitle>
				<AlertDescription>
					New work that uses credits has stopped until your included credits
					renew on {formatResetDate(credits.periodEnd)}. To continue now, buy a
					credit pack or turn on pay-as-you-go.
				</AlertDescription>
			</Alert>
		);
	}
	if (!notice) return null;
	if (notice.threshold === 100) {
		return (
			<Alert variant="warning" data-credit-notice="100">
				<Warning aria-hidden />
				<AlertTitle>All included credits are used</AlertTitle>
				<AlertDescription>
					Work continues on your top-up credits
					{credits.payAsYouGo.enabled ? " and then pay-as-you-go" : ""}. When
					those run out, new work stops until{" "}
					{formatResetDate(credits.periodEnd)}.
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<Alert variant="warning" data-credit-notice="80">
			<AlertTitle>80% of included credits are used</AlertTitle>
			<AlertDescription>
				You have {formatCredits(credits.remainingIncludedCredits)} left from
				your plan this month, plus {formatCredits(credits.topUpCredits)} from
				credit packs.
			</AlertDescription>
		</Alert>
	);
}

function formatResetDate(periodEnd: string): string {
	return new Intl.DateTimeFormat(osLocale(), {
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(periodEnd));
}

export function BillingCreditUsage({ credits }: { credits: CreditUsage }) {
	const usage = allowanceUsage(credits);
	const allowance = monthlyAllowanceCredits(credits);
	const paused = creditsPaused(credits);
	const payAsYouGoLeft = payAsYouGoRemainingCredits(credits.payAsYouGo);
	const period = formatCreditPeriod(credits.periodStart, credits.periodEnd);
	return (
		<Card tone="raised" aria-label="Credits this month">
			<BillingSectionHeader
				className="px-tedix-card"
				title="Credits this month"
				description={`${period} · included credits renew each month`}
				actions={
					<Badge variant={paused ? "destructive" : "success"}>
						{paused ? "Paused" : "Available"}
					</Badge>
				}
			/>
			<CardContent className="space-y-5">
				<CreditNoticeAlert credits={credits} />
				<div className="grid gap-2">
					<Text
						as="span"
						role="metric"
						weight="semibold"
						className="tabular-nums"
						data-credit-percent={usage.percent}
					>
						{usage.label} used this month
					</Text>
					<Meter
						label={`${formatCredits(credits.usedCredits)} used of ${formatCredits(allowance)} (included plus top-up credits)`}
						showValue={false}
						value={usage.percent}
						getAriaValueText={() => usage.label}
					/>
				</div>
				<MetricGrid
					appearance="bounded"
					columns={3}
					aria-label="Credit balance"
				>
					<MetricItem
						label="Included this month"
						value={formatCredits(credits.includedCredits)}
						description="From your plan; renews each month"
					/>
					<MetricItem
						label="Left from your plan"
						value={formatCredits(credits.remainingIncludedCredits)}
						description="Used first"
					/>
					<MetricItem
						label="Top-up credits"
						value={formatCredits(credits.topUpCredits)}
						description="From credit packs; used after your plan credits"
					/>
				</MetricGrid>
				{credits.payAsYouGo.enabled &&
					credits.payAsYouGo.monthlyCapMicros !== null && (
						<Text tone="secondary">
							Pay-as-you-go:{" "}
							{formatUsagePercent(
								credits.payAsYouGo.spentMicros,
								credits.payAsYouGo.monthlyCapMicros,
							)}{" "}
							of the monthly cap ·{" "}
							{formatBillingAmount(credits.payAsYouGo.spentMicros, "eur")} of{" "}
							{formatBillingAmount(credits.payAsYouGo.monthlyCapMicros, "eur")}{" "}
							used this month ({formatCredits(payAsYouGoLeft)} left).
						</Text>
					)}
				<div className="grid gap-2" aria-label="What used credits">
					<Text weight="medium">What used credits</Text>
					<div className="grid gap-3 sm:grid-cols-3">
						<BreakdownItem
							label="AI"
							description="Replies and work by your tedis"
							credits={credits.breakdown.ai}
							total={credits.usedCredits}
						/>
						<BreakdownItem
							label="Code runs"
							description="1 credit per run"
							credits={credits.breakdown.codeRuns}
							total={credits.usedCredits}
						/>
						<BreakdownItem
							label="Services"
							description="Tools such as SEO checks"
							credits={credits.breakdown.services}
							total={credits.usedCredits}
						/>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

function BreakdownItem({
	label,
	description,
	credits,
	total,
}: {
	label: string;
	description: string;
	credits: number;
	total: number;
}) {
	return (
		<div className="grid min-w-0 gap-0.5" data-credit-breakdown={label}>
			<Text role="label" tone="secondary">
				{label} · {formatUsagePercent(credits, total)}
			</Text>
			<Text weight="medium" className="tabular-nums">
				{formatCredits(credits)}
			</Text>
			<Text role="caption" tone="secondary">
				{description}
			</Text>
		</div>
	);
}
