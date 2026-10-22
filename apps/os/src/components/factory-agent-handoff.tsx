import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import type {
	DecisionDeckConfig,
	DeckRoutingPolicy,
} from "@tedix/api-contract/schemas/os-decision-deck";
import {
	factoryStandingSentence,
	type FactoryClassStatus,
} from "@tedix/api-contract/utils/factory-class-autonomy";
import { Badge } from "@/components/kumo/badge";
import { Text } from "@/components/kumo/text";
import { useFactoryDelivery } from "@/lib/use-factory-delivery";

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
	policies,
}: {
	sources: readonly CardReviewSource[];
	routing?: DeckRoutingPolicy;
	policies?: DecisionDeckConfig["classPolicies"];
}) {
	const { standings } = useFactoryDelivery(sources, policies, routing);
	if (!standings.length) return null;
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
