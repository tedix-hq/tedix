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
	creditPercent,
	formatCredits,
	microsToCredits,
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
 * Every monthly credit limit that applies to this organization: the plan's
 * included credits, the pay-as-you-go cap when it is on, and each tedi or
 * member cap an admin has set.
 */
export function limitRows(credits: CreditUsage): LimitRow[] {
	const rows: LimitRow[] = [
		{
			id: "monthly-credits",
			name: "Included monthly credits",
			limitLabel: `${formatCredits(credits.includedCredits)} a month from the plan`,
			used: credits.usedCredits,
			limit: credits.includedCredits,
			consequence:
				credits.topUpCredits > 0 || credits.payAsYouGo.enabled
					? "Work continues on top-up credits, then pay-as-you-go if it is on."
					: NEXT_MONTH,
		},
	];
	const { payAsYouGo } = credits;
	if (payAsYouGo.enabled && payAsYouGo.monthlyCapMicros !== null) {
		rows.push({
			id: "pay-as-you-go",
			name: "Pay-as-you-go cap",
			limitLabel: `Up to ${formatCredits(microsToCredits(payAsYouGo.monthlyCapMicros))} extra a month`,
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
			limitLabel: `${formatCredits(tedi.monthlyCapCredits)} a month for this tedi`,
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
			limitLabel: `${formatCredits(member.monthlyCapCredits)} a month for this member`,
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
					{creditPercent(row.used, row.limit)}% used. {row.consequence}
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
			<Text as="strong" role="body" weight="medium" tone="strong">
				{row.name}
			</Text>
			<Text as="span" role="label" tone="secondary">
				{row.limitLabel}
			</Text>
			<Meter
				label={`${row.name} used`}
				hideLabel
				value={creditPercent(row.used, row.limit)}
				className="h-2"
			/>
			<Text as="span" role="label" tone="secondary">
				{formatCredits(row.used)} of {formatCredits(row.limit)} used
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
						Each monthly credit limit, with usage against it. Change caps and
						pay-as-you-go in{" "}
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
