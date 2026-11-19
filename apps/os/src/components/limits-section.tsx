import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Empty } from "@/components/kumo/empty";
import { Meter } from "@/components/kumo/meter";
import {
	Collection,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import {
	type CreditLevel,
	type CreditUsage,
	creditLevel,
	formatUsagePercent,
	microsToCredits,
	monthlyAllowanceCredits,
	usagePercent,
} from "@/lib/billing-credits";
import { useOsFormattingPreferences } from "@/lib/format";

export type LimitRow = {
	id: string;
	name: string;
	/** What the limit is. Every limit is monthly. */
	limitLabel: string;
	used: number;
	limit: number;
	/** Plain-English consequence once the limit is reached. */
	consequence: string;
};

const NEXT_MONTH = "New work stops until the credits renew next month.";

/**
 * Every monthly credit limit that applies to this organization: this month's
 * credits (plan plus credit packs), the pay-as-you-go cap when it is on, and
 * each tedi or member cap an admin has set. Rows show the share used; exact
 * credit counts live in Billing › Usage.
 */
export function limitRows(credits: CreditUsage): LimitRow[] {
	const rows: LimitRow[] = [
		{
			id: "monthly-credits",
			name: "This month's credits",
			limitLabel:
				credits.topUpCredits > 0
					? "Your plan's monthly credits plus credit packs"
					: "Your plan's monthly credits",
			used: credits.usedCredits,
			limit: monthlyAllowanceCredits(credits),
			consequence: credits.payAsYouGo.enabled
				? "Work continues on pay-as-you-go up to its monthly cap."
				: NEXT_MONTH,
		},
	];
	const { payAsYouGo } = credits;
	if (payAsYouGo.enabled && payAsYouGo.monthlyCapMicros !== null) {
		rows.push({
			id: "pay-as-you-go",
			name: "Pay-as-you-go cap",
			limitLabel: "Extra credits allowed each month after the plan and packs",
			used: microsToCredits(payAsYouGo.spentMicros),
			limit: microsToCredits(payAsYouGo.monthlyCapMicros),
			consequence: NEXT_MONTH,
		});
	}
	for (const tedi of credits.tedis) {
		if (tedi.monthlyCapCredits === null) continue;
		rows.push({
			id: `tedi:${tedi.tediId}`,
			name: `${tedi.name} monthly cap`,
			limitLabel: "A separate monthly cap for this tedi",
			used: tedi.usedCredits,
			limit: tedi.monthlyCapCredits,
			consequence: `${tedi.name} pauses until next month; other tedis keep working.`,
		});
	}
	for (const member of credits.members) {
		if (member.monthlyCapCredits === null) continue;
		rows.push({
			id: `member:${member.userId}`,
			name: `${member.name} monthly cap`,
			limitLabel: "A separate monthly cap for this member",
			used: member.usedCredits,
			limit: member.monthlyCapCredits,
			consequence: `Work started by ${member.name} pauses until next month.`,
		});
	}
	return rows;
}

function LimitAlert({ row, level }: { row: LimitRow; level: CreditLevel }) {
	if (level === "warn")
		return (
			<Alert variant="warning" data-limit-alert="warn">
				<AlertTitle>{row.name} is nearly used up</AlertTitle>
				<AlertDescription>
					{formatUsagePercent(row.used, row.limit)} used. {row.consequence}
				</AlertDescription>
			</Alert>
		);
	if (level === "full")
		return (
			<Alert variant="destructive" data-limit-alert="full">
				<AlertTitle>{row.name} is used up</AlertTitle>
				<AlertDescription>{row.consequence}</AlertDescription>
			</Alert>
		);
	return null;
}

export function LimitItem({ row }: { row: LimitRow }) {
	const level = creditLevel(row.used, row.limit);
	return (
		<div className="grid gap-1.5 px-4 py-3" data-limit-id={row.id}>
			<div className="flex items-baseline justify-between gap-3">
				<Text as="strong" role="body" weight="medium" tone="strong">
					{row.name}
				</Text>
				<Text
					as="span"
					role="body"
					weight="medium"
					className="tabular-nums"
					data-limit-percent
				>
					{formatUsagePercent(row.used, row.limit)} used
				</Text>
			</div>
			<Meter
				label={`${row.name} used`}
				hideLabel
				value={usagePercent(row.used, row.limit)}
				getAriaValueText={() => formatUsagePercent(row.used, row.limit)}
				className="h-2"
			/>
			<Text as="span" role="label" tone="secondary">
				{row.limitLabel}
			</Text>
			<LimitAlert row={row} level={level} />
		</div>
	);
}

export function LimitsSection({ credits }: { credits: CreditUsage }) {
	useOsFormattingPreferences();
	const rows = limitRows(credits);
	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Monthly limits</SectionTitle>
					<SectionDescription>
						Each monthly credit limit and the share of it used. Exact credit
						counts, caps, and pay-as-you-go are in{" "}
						<a className="underline" href="/admin/billing">
							Billing
						</a>
						.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{rows.length === 0 ? (
				<Empty appearance="quiet" title="No monthly limits are set" />
			) : (
				<Collection aria-label="Monthly limits" className="[&>li]:min-w-0">
					{rows.map((row) => (
						<li key={row.id}>
							<LimitItem row={row} />
						</li>
					))}
				</Collection>
			)}
		</PageSection>
	);
}
