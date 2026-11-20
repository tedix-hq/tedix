import { Warning } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Surface } from "@/components/kumo/surface";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { Meter } from "@/components/kumo/meter";
import { Text } from "@/components/kumo/text";
import {
	type CreditUsage,
	allowanceUsage,
	creditsPaused,
	formatCredits,
	latestCreditNotice,
	monthlyAllowanceCredits,
} from "@/lib/billing-credits";
import { formatBillingAmount } from "@/lib/billing-price";
import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { formatCount, osLocale } from "@/lib/format";

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
function CreditNoticeAlert({ credits }: { credits: CreditUsage }) {
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
		</Alert>
	);
}

export function formatResetDate(periodEnd: string, year = false): string {
	return new Intl.DateTimeFormat(osLocale(), {
		month: "long",
		...(year ? { year: "numeric" } : {}),
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(periodEnd));
}

const BILLING_STATUS = {
	trial: "Trial",
	active: null,
	past_due: "Payment overdue",
	cancelled: "Cancelled",
	suspended: "Suspended",
} as const;

export function BillingCreditUsage({
	overview,
}: {
	overview: BillingOverview;
}) {
	const { credits } = overview;
	const usage = allowanceUsage(credits);
	const status =
		BILLING_STATUS[overview.account.status] ??
		(creditsPaused(credits) ? "Limit reached" : null);
	const used = formatCount(credits.usedCredits);
	const allowance = formatCredits(monthlyAllowanceCredits(credits));
	return (
		<Surface className="grid gap-2 p-tedix-card">
			{status && (
				<Badge
					className="justify-self-start"
					variant={
						overview.account.status === "trial" ? "secondary" : "destructive"
					}
				>
					{status}
				</Badge>
			)}
			<Meter
				label={`${used} of ${allowance} used (${usage.label})`}
				showValue={false}
				value={usage.percent}
				getAriaValueText={() => usage.label}
			/>
			<Text tone="secondary">Renews {formatResetDate(credits.periodEnd)}</Text>
			<CreditNoticeAlert credits={credits} />
		</Surface>
	);
}

export function BillingCreditBalance({ credits }: { credits: CreditUsage }) {
	return (
		<MetricGrid appearance="bounded" columns={4} aria-label="Billing overview">
			<MetricItem
				label="Left from plan"
				value={formatCredits(credits.remainingIncludedCredits)}
			/>
			<MetricItem
				label="Credit pack balance"
				value={formatCredits(credits.topUpCredits)}
			/>
			<MetricItem
				label="Pay-as-you-go this month"
				value={formatBillingAmount(credits.payAsYouGo.spentMicros, "eur")}
			/>
			<MetricItem
				label="Renews on"
				value={formatResetDate(credits.periodEnd)}
			/>
		</MetricGrid>
	);
}
