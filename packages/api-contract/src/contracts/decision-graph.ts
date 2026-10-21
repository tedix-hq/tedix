import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	GetDecisionContextInputSchema,
	GetDecisionContextOutputSchema,
} from "../schemas/decision-graph";

export const decisionGraphContract = oc
	.route({ tags: ["decision-graph"], prefix: "/decision-graph" })
	.errors(baseErrors)
	.router({
		getContext: oc
			.route({
				method: "GET",
				path: "/context",
				summary: "Explain how a Deck card connects to earlier decisions",
				description:
					"Read-only, organization-scoped. Returns the card's linked Work, prior decision, newer replacement, duplicates, blocked count and a one-line plain-English explanation. At most four hops.",
			})
			.input(GetDecisionContextInputSchema)
			.output(GetDecisionContextOutputSchema),
	});

export type DecisionGraphContract = typeof decisionGraphContract;
