import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Text } from "@/components/kumo/text";
import {
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";

export function PersonalAgentValue() {
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
					<SectionTitle>Personal-agent contributions</SectionTitle>
				</SectionHeading>
			</SectionHeader>
			{query.isPending && <Text>Loading contributions…</Text>}
			{query.isError && (
				<Text>
					Contributions could not be loaded. Try refreshing this page.
				</Text>
			)}
			{query.data?.length === 0 && <Text>No personal agents enrolled.</Text>}
			{query.data?.map((row) => (
				<Card key={row.sourceAgentId}>
					<CardHeader>
						<CardTitle>{row.sourceAgentName}</CardTitle>
					</CardHeader>
					<CardContent>
						<Text>
							Seven-day capture window: {row.windowStart} to {row.windowEnd}{" "}
							(UTC, end excluded).
						</Text>
						<Text>
							{row.findings} findings · {row.decisionFindings} decisions
							requested · {row.fyiFindings} FYIs.
						</Text>
						<Text>
							Decided from the card: {row.decidedFromCard} / {row.decisionCards}{" "}
							(
							{row.decidedFromCardPercent === null
								? "no decision cards"
								: `${Math.round(row.decidedFromCardPercent)}%`}
							).
						</Text>
						<Text>
							{row.outcomes} outcome revisions · {row.verifiedOutcomes} with
							verified evidence · {row.corroboratedOutcomes} independently
							confirmed · {row.emailsSent} emails sent ·{" "}
							{row.acknowledgedOutcomes} acknowledged.
						</Text>
						<Text>
							Reminders avoided: unknown. Agent-reported retirements:{" "}
							{row.agentReportedReminderRetirements}. Historical chat baseline:
							unavailable.
						</Text>
						<Text tone="secondary">
							Retries share the original finding key. Sending and acknowledgment
							do not prove reminder suppression. Verified evidence applies to
							its cited claim.
						</Text>
					</CardContent>
				</Card>
			))}
		</PageSection>
	);
}
