import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ListAgentDecisionsInputSchema,
	ListAgentDecisionsResultSchema,
	RecordAgentDecisionInputSchema,
	RecordAgentDecisionOutcomeInputSchema,
	RecordAgentDecisionOutcomeResultSchema,
	RecordAgentDecisionResultSchema,
} from "../schemas/agent-decisions";
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
				summary: "Explain how a Decisions card connects to earlier decisions",
				description:
					"Read-only, organization-scoped. Returns the card's linked Work, prior decision, newer replacement, duplicates, blocked count and a one-line plain-English explanation. At most four hops.",
			})
			.input(GetDecisionContextInputSchema)
			.output(GetDecisionContextOutputSchema),
		recordAgentDecision: oc
			.route({
				method: "POST",
				path: "/agent-decisions",
				summary: "Record a decision an agent made on its own",
				description:
					"Journals one autonomous agent decision: the question, options considered, the choice, reason, reversibility, protected effects and confidence, with links to Work, commits, an Output and an earlier decision. Writes a learning event of class `agent:<actor>:<decision class>` and decision graph links (decided_by, about, supersedes or depends_on, evidence). The person's Activity shows it as `Decided by <agent>`; it is never a Decisions question. Recording grants no authority: a decision that needs a person (`needsPerson`) still goes through approvals. Idempotent for the same session, class, question, choice and time; rate-limited per Agent-Session.",
			})
			.input(RecordAgentDecisionInputSchema)
			.output(RecordAgentDecisionResultSchema),
		recordAgentDecisionOutcome: oc
			.route({
				method: "POST",
				path: "/agent-decisions/outcome",
				summary: "Record how an agent decision turned out",
				description:
					"Records `worked`, `reverted` or `partial` for a journaled decision, with evidence. `by: person` marks a person's override or undo as a correction. A reverted or partial outcome is also an agent-mistake signal (`agent-mistake:<decision class>`) for lesson mining; per-class standing shows which kinds of decision agents get right. Changes nothing else.",
			})
			.input(RecordAgentDecisionOutcomeInputSchema)
			.output(RecordAgentDecisionOutcomeResultSchema),
		listAgentDecisions: oc
			.route({
				method: "GET",
				path: "/agent-decisions",
				summary: "List recent agent decisions with outcomes and class standing",
				description:
					"Read-only, organization-scoped journal since `since` (default the last 24 hours), newest first, with each decision's latest outcome, per-class standing over the last 30 days and a plain-English review of at most 60 words.",
			})
			.input(ListAgentDecisionsInputSchema)
			.output(ListAgentDecisionsResultSchema),
	});

export type DecisionGraphContract = typeof decisionGraphContract;
