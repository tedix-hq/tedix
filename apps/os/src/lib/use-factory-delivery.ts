import { useQuery } from "@tanstack/react-query";
import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import type {
	DecisionDeckConfig,
	DeckRoutingPolicy,
} from "@tedix/api-contract/schemas/os-decision-deck";
import type { ReviewCard } from "@tedix/api-contract/utils/card-review";
import { factoryCardDelivery } from "@tedix/api-contract/utils/decision-class-policy";
import {
	factoryClassStandings,
	stableAuditSample,
} from "@tedix/api-contract/utils/factory-class-autonomy";
import { osQuery, userProfileQueryOptions } from "./os-query-options";
import { workRefreshOptions } from "./work-refresh";

/** Personal evidence and one stable audit draw shared by the count, queue and class strip. */
export function useFactoryDelivery(
	sources: readonly CardReviewSource[],
	policies?: DecisionDeckConfig["classPolicies"],
	routing?: DeckRoutingPolicy,
) {
	const enabled = sources.some(
		(source) => source.scoring?.agentDecidableClasses.length,
	);
	const profile = useQuery({ ...userProfileQueryOptions(), enabled });
	const history = useQuery({
		...osQuery.learningFeedback.listInteractions.queryOptions({
			input: {
				scopeKind: "personal",
				limit: 200,
				surfaces: ["decision_deck", "decision_learning"],
			},
		}),
		...workRefreshOptions,
		enabled,
	});
	const events = history.data?.events ?? [];
	const userId = profile.data?.id ?? "";
	return {
		quiet: (card: ReviewCard) => {
			const source = sources[card.sourceIndex];
			return (
				!!source &&
				!!userId &&
				factoryCardDelivery({
					source,
					card,
					events,
					userId,
					policies,
					routing,
					sample: stableAuditSample(`${userId}:${card.key}`),
				}) === "auto"
			);
		},
		standings: factoryClassStandings({
			sources,
			events,
			userId,
			policies,
			routing,
		}),
		refetch: () => (enabled ? history.refetch() : Promise.resolve()),
	};
}
