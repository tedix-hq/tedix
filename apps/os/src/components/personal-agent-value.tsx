import { Robot } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Empty } from "@/components/kumo/empty";
import {
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { SettingsRow, SettingsRows } from "@/components/settings-row";
import { formatCount, useOsFormattingPreferences } from "@/lib/format";
import { osQuery } from "@/lib/os-query-options";
import { absoluteTime } from "@/lib/time";

export function PersonalAgentValue() {
	useOsFormattingPreferences();
	const query = useQuery(
		osQuery.personalAgentInbound.value.queryOptions({
			input: {},
			refetchInterval: 120000,
		}),
	);
	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Personal agent contributions</SectionTitle>
				</SectionHeading>
			</SectionHeader>
			{query.isPending && <ListSkeleton rows={2} rowClassName="h-20" />}
			{query.isError && (
				<Alert variant="destructive">
					<AlertTitle>Contributions could not be loaded</AlertTitle>
					<AlertDescription>Refresh the page to try again.</AlertDescription>
				</Alert>
			)}
			{!query.isPending && !query.isError && query.data?.length === 0 && (
				<Empty
					appearance="quiet"
					title="No personal agents enrolled"
					description="Contributions will appear here when an agent is connected."
				/>
			)}
			{query.data && query.data.length > 0 && (
				<SettingsRows>
					{query.data.map((row) => (
						<SettingsRow
							key={row.sourceAgentId}
							icon={Robot}
							title={row.sourceAgentName}
							description={
								<div className="grid gap-2">
									<Text role="label" tone="secondary">
										Seven-day capture window: {absoluteTime(row.windowStart)} to{" "}
										{absoluteTime(row.windowEnd)} (end excluded).
									</Text>
									<Text role="label">
										{formatCount(row.findings)} findings ·{" "}
										{formatCount(row.decisionFindings)} decisions requested ·{" "}
										{formatCount(row.fyiFindings)} FYIs.
									</Text>
									<Text role="label">
										Decided from the card: {formatCount(row.decidedFromCard)} /{" "}
										{formatCount(row.decisionCards)} (
										{row.decidedFromCardPercent === null
											? "no decision cards"
											: `${Math.round(row.decidedFromCardPercent)}%`}
										).
									</Text>
									<Text role="label">
										{formatCount(row.outcomes)} outcome revisions ·{" "}
										{formatCount(row.verifiedOutcomes)} with verified evidence ·{" "}
										{formatCount(row.corroboratedOutcomes)} independently
										confirmed · {formatCount(row.emailsSent)} emails sent ·{" "}
										{formatCount(row.acknowledgedOutcomes)} acknowledged.
									</Text>
									<Text role="label">
										Reminders avoided: unknown. Agent-reported retirements:{" "}
										{formatCount(row.agentReportedReminderRetirements)}.
										Historical chat baseline: unavailable.
									</Text>
									<Text role="label" tone="secondary">
										Retries share the original finding key. Sending and
										acknowledgment do not prove reminder suppression. Verified
										evidence applies to its cited claim.
									</Text>
								</div>
							}
						/>
					))}
				</SettingsRows>
			)}
		</PageSection>
	);
}
