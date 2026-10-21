import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	DecisionGraphBackfillPreviewInputSchema,
	DecisionGraphBackfillPreviewOutputSchema,
} from "../schemas/decision-graph-backfill";
import {
	GetDecisionContextInputSchema,
	GetDecisionContextOutputSchema,
} from "../schemas/decision-graph";

export const decisionGraphContract = oc
	.route({ tags: ["decision-graph"], prefix: "/decision-graph" })
	.errors(baseErrors)
	.router({
		backfillPreview: oc
			.route({
				method: "GET",
				path: "/backfill/preview",
				summary: "Preview one historical decision graph backfill page",
				description:
					"Admin-only, read-only counts of candidate edges by kind. Follow nextCursor until null and sum counts for a complete inventory. Counts include existing edges; they are not newly inserted row counts. At most 50 source rows per page. Never writes edges or checkpoints.",
			})
			.input(DecisionGraphBackfillPreviewInputSchema)
			.output(DecisionGraphBackfillPreviewOutputSchema),
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
