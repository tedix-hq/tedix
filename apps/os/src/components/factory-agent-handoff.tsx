import { useQuery } from "@tanstack/react-query";
import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import type { DeckRoutingPolicy } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	factoryClassStandings,
	factoryStandingSentence,
	type FactoryClassStatus,
} from "@tedix/api-contract/utils/factory-class-autonomy";
import { Badge } from "@/components/kumo/badge";
import { Text } from "@/components/kumo/text";
import { osQuery } from "@/lib/os-query-options";
import { workRefreshOptions } from "@/lib/work-refresh";

const STATUS_LABEL: Record<FactoryClassStatus, string> = {
	blocked: "Stays with you",
	earned: "Agent decides",
	eligible: "Eligible to hand to an agent",
	candidate: "Learning",
};

/**
 * Where each agent-decidable factory class stands for the signed-in person.
 * Read-only: graduation comes only from their own unchanged verdicts.
 */
export function FactoryAgentHandoff({
	sources,
	routing,
}: {
	sources: readonly CardReviewSource[];
	routing?: DeckRoutingPolicy;
}) {
	const listed = sources.filter(
		(source) => (source.scoring?.agentDecidableClasses.length ?? 0) > 0,
	);
	const history = useQuery({
		...osQuery.learningFeedback.listInteractions.queryOptions({
			input: {
				scopeKind: "personal",
				limit: 200,
				surfaces: ["decision_deck", "decision_learning"],
			},
		}),
		...workRefreshOptions,
		enabled: listed.length > 0,
	});
	const events = history.data?.events ?? [];
	// The personal listing holds only the caller's own scope.
	const userId = events.find(
		(event) => event.actorType === "user" && event.actorId === event.scopeId,
	)?.actorId;
	if (listed.length === 0 || !userId) return null;
	const standings = factoryClassStandings({
		sources: listed,
		events,
		userId,
		routing,
	});
	return (
		<section
			aria-label="Agent handoff"
			data-factory-agent-handoff
			className="flex flex-col gap-1"
		>
			{standings.map((standing) => (
				<Text
					key={standing.decisionClass}
					as="p"
					role="caption"
					tone="secondary"
					className="m-0 flex flex-wrap items-center gap-1.5"
					data-factory-class-status={standing.status}
				>
					<Badge
						variant={standing.status === "earned" ? "secondary" : "outline"}
					>
						{STATUS_LABEL[standing.status]}
					</Badge>
					{factoryStandingSentence(standing)}
				</Text>
			))}
		</section>
	);
}
