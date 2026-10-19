import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { classReadiness } from "@/lib/decision-deck";
import { attentionMetrics } from "@/lib/deck-attention";
import { Text } from "@/components/kumo/text";
import { Link } from "@/components/kumo/link";
import { OS_COPY } from "@/shared/os-copy";

export function WeeklyDecisionDigest() {
	const query = useQuery(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}),
	);
	const events = (query.data?.events ?? []).filter(
		(event) =>
			event.surface === "decision_capture" &&
			event.metadata?.answerSource === "os-decision-card",
	);
	const since = Date.now() - 7 * 86_400_000;
	const classes = [
		...new Set(
			events
				.filter((event) => Date.parse(event.occurredAt) >= since)
				.flatMap((event) =>
					typeof event.metadata?.decisionClass === "string"
						? [event.metadata.decisionClass]
						: [],
				),
		),
	];
	const metrics = attentionMetrics(
		(query.data?.events ?? []).filter(
			(event) => Date.parse(event.occurredAt) >= since,
		),
	);
	if (!classes.length && !metrics.measuredDecisions) return null;
	return (
		<section
			aria-label={OS_COPY.decisionDeck.weeklyTitle}
			className="grid gap-3 rounded-xl border border-kumo-line p-4"
		>
			<Text weight="semibold">{OS_COPY.decisionDeck.weeklyTitle}</Text>
			<Text tone="secondary">{OS_COPY.decisionDeck.weeklyScope}</Text>
			{metrics.medianMs !== null && (
				<Text>
					Median decision time {Math.round(metrics.medianMs / 1000)} s;{" "}
					{metrics.withoutDetailsRate === null
						? "details use not measured yet"
						: `${Math.round(metrics.withoutDetailsRate * 100)}% decided without opening details`}
					.
				</Text>
			)}
			{classes.map((classId) => {
				const rows = events.filter(
					(event) => event.metadata?.decisionClass === classId,
				);
				const readiness = classReadiness(
					rows.map((event) => ({
						id: event.id,
						requestId: event.targetId ?? undefined,
						classId,
						choice: String(event.metadata?.decisionChoice),
						signal: String(event.metadata?.feedbackSignal),
						at: event.occurredAt,
					})),
					classId,
					5,
				);
				return (
					<div key={classId} className="flex flex-wrap justify-between gap-2">
						<Text>
							{classId.replaceAll(/[-_]/g, " ")}:{" "}
							{OS_COPY.decisionDeck.learnedApprovals(readiness.unchanged)}
						</Text>
						{rows[0]?.targetId && (
							<Link href={`/work/interactions/${rows[0].targetId}`}>
								{OS_COPY.decisionDeck.readReceipt}
							</Link>
						)}
					</div>
				);
			})}
		</section>
	);
}
