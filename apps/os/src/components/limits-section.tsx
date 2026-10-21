import type { ComputePosture } from "@tedix/api-contract/contracts/os-compute";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
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
import { formatUsd } from "@/lib/cost-reading";
import { useOsFormattingPreferences, formatCount } from "@/lib/format";

/** Warn at 80% of a limit; at 100% the limit is reached. */
export const LIMIT_WARN_SHARE = 0.8;

export type LimitLevel = "ok" | "warn" | "full";

export function limitLevel(share: number | null): LimitLevel | null {
	if (share === null) return null;
	if (share >= 1) return "full";
	if (share >= LIMIT_WARN_SHARE) return "warn";
	return "ok";
}

export type LimitRow = {
	id: string;
	name: string;
	/** What the limit is, with its window. */
	limitLabel: string;
	/** Where the number comes from. */
	source: string;
	/** Null means usage is not measured on this surface, never 0. */
	usage: { used: number; limit: number; label: string } | null;
	/** Where it is configured, shown when usage is not measured. */
	configuredAt: { text: string; href?: string };
	/** Plain-English consequence once the limit is reached. */
	consequence: string;
};

const DAILY_RESET =
	"New AI replies pause until tomorrow 00:00 UTC. Daily limits count by UTC calendar day.";

/**
 * Build the rows from the single posture read. Only limits whose value the
 * existing endpoint returns are listed; a limit with no readable usage carries
 * `usage: null` and renders "Usage not measured".
 */
export function limitRows(posture: ComputePosture): LimitRow[] {
	const rows: LimitRow[] = [];
	const { budget, admissionPolicy } = posture;

	if (budget.configured && budget.unlimitedTokenUsage === false) {
		const included = budget.includedTokens;
		const used = budget.usedTokens;
		const measurable = included !== null && included > 0 && used !== null;
		rows.push({
			id: "plan-tokens",
			name: "Included plan tokens",
			limitLabel:
				included !== null && included > 0
					? `${formatCount(included)} tokens in the plan allowance`
					: "Plan token allowance not known",
			source: "Billing balance for the current plan period",
			usage: measurable
				? {
						used,
						limit: included,
						label: `${formatCount(used)} of ${formatCount(included)} tokens used`,
					}
				: null,
			configuredAt: { text: "Billing", href: "/admin/billing" },
			consequence:
				budget.allowOverage === true
					? "Your plan allows usage beyond the allowance; other limits still apply."
					: "New AI replies pause until the next plan period or a plan change.",
		});
	}

	if (admissionPolicy.desiredDailyTokenLimit !== null) {
		rows.push({
			id: "daily-tokens",
			name: "Daily token limit",
			limitLabel: `${formatCount(admissionPolicy.desiredDailyTokenLimit)} tokens per UTC day, whole workspace`,
			source: "Workspace admission policy",
			usage: null,
			configuredAt: { text: "the workspace policy pack (no screen yet)" },
			consequence: DAILY_RESET,
		});
	}

	if (admissionPolicy.desiredDailySpendLimitMicros !== null) {
		rows.push({
			id: "daily-spend",
			name: "Daily spend limit",
			limitLabel: `${formatUsd(admissionPolicy.desiredDailySpendLimitMicros / 1_000_000)} per UTC day, whole workspace`,
			source: "Workspace admission policy",
			usage: null,
			configuredAt: { text: "the workspace policy pack (no screen yet)" },
			consequence: DAILY_RESET,
		});
	}

	return rows;
}

function LimitAlert({ row }: { row: LimitRow }) {
	const share = row.usage ? row.usage.used / row.usage.limit : null;
	const level = limitLevel(share);
	if (level === "warn")
		return (
			<Alert variant="warning" data-limit-alert="warn">
				<AlertTitle>{row.name} is nearly used up</AlertTitle>
				<AlertDescription>
					{Math.round((share ?? 0) * 100)}% used. {row.consequence}
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
	return (
		<div className="grid gap-1.5 px-4 py-3" data-limit-id={row.id}>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body" weight="medium" tone="strong">
					{row.name}
				</Text>
				{row.usage === null && (
					<Badge variant="outline" data-usage="not-measured">
						Usage not measured
					</Badge>
				)}
			</div>
			<Text as="span" role="label" tone="secondary">
				{row.limitLabel}
			</Text>
			{row.usage && (
				<>
					<Meter
						label={`${row.name} used`}
						hideLabel
						value={Math.min(100, (row.usage.used / row.usage.limit) * 100)}
						className="h-2"
					/>
					<Text as="span" role="label" tone="secondary">
						{row.usage.label}
					</Text>
				</>
			)}
			<Text as="span" role="caption" tone="secondary" className="opacity-70">
				Read from: {row.source}
			</Text>
			{row.usage === null && (
				<Text as="span" role="caption" tone="secondary">
					If reached: {row.consequence} Configured in{" "}
					{row.configuredAt.href ? (
						<a className="underline" href={row.configuredAt.href}>
							{row.configuredAt.text}
						</a>
					) : (
						row.configuredAt.text
					)}
					.
				</Text>
			)}
			<LimitAlert row={row} />
		</div>
	);
}

export function LimitsSection({ posture }: { posture: ComputePosture }) {
	useOsFormattingPreferences();
	const rows = limitRows(posture);
	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Limits</SectionTitle>
					<SectionDescription>
						Each spending limit this page can read, with usage against it.
						Read-only.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{rows.length === 0 ? (
				<Alert>
					<AlertTitle>No limits are readable here</AlertTitle>
					<AlertDescription>
						No plan allowance or daily limit is configured for this workspace.
					</AlertDescription>
				</Alert>
			) : (
				<Collection aria-label="Limits" className="[&>li]:min-w-0">
					{rows.map((row) => (
						<li key={row.id}>
							<LimitItem row={row} />
						</li>
					))}
				</Collection>
			)}
			<Text as="span" role="caption" tone="secondary">
				Not shown (no readable value on this page): per-tedi daily limits, the
				monthly hard spend limit, payment budgets and delegation budgets.
			</Text>
		</PageSection>
	);
}
