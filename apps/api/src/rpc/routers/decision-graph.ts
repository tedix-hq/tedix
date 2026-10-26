/**
 * Decision graph: how a Deck card connects to earlier decisions, and the
 * agent decision journal that adds agents' own decisions to it.
 */

import { implement } from "@orpc/server";
import { decisionGraphContract } from "@tedix/api-contract/contracts/decision-graph";
import {
	explainChain,
	getDecisionContext,
} from "@tedix/db/queries/decision-graph";
import { listDeckSourceObjectives } from "@tedix/db/queries/work-items/deck-sweep";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	withAuth,
	withAuthorization,
	createError,
	ErrorCodes,
} from "../orpc";
import { runDecisionGraphBackfillPage } from "../../services/decision-graph-backfill";
import {
	createDecisionGraphReader,
	enrichDecisionContexts,
} from "../../services/decision-graph-reads";

const decisionGraphOs = implement(
	decisionGraphContract,
).$context<BaseContext>();

const getContext = decisionGraphOs.getContext
	.use(withAuth)
	.use(AUTHZ.messagingRead)
	.handler(async ({ input, context }) => {
		// Every edge read is predicated on the caller's organization.
		const orgId = requireOrgId(context);
		const decisionContext = await getDecisionContext(
			context.db,
			orgId,
			input.cardId,
			{ maxHops: input.maxHops },
		);
		// The graph adds indirect blocks and duplicate communities when it is
		// configured; D1 alone answers otherwise.
		await enrichDecisionContexts(
			createDecisionGraphReader(context.env, context.db),
			orgId,
			[{ id: input.cardId }],
			new Map([[input.cardId, decisionContext]]),
		);
		const workId = decisionContext.chain.find(
			(step) => step.edge.kind === "card_from_work",
		)?.node.id;
		const objective = workId
			? (await listDeckSourceObjectives(context.db, orgId, [workId])).get(
					workId,
				)
			: undefined;
		if (objective) decisionContext.objective = objective;
		return {
			context: decisionContext,
			explanation: explainChain(decisionContext),
		};
	});

const backfillPreview = decisionGraphOs.backfillPreview
	.use(withAuth)
	.use(withAuthorization("settings:manage", "mcp:memory.admin"))
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (input.cursor && input.cursor.organizationId !== orgId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Backfill cursor belongs to another organization",
			);
		}
		return runDecisionGraphBackfillPage(context.db, orgId, {
			...input,
			dryRun: true,
		});
	});

const recordAgentDecision = decisionGraphOs.recordAgentDecision
	.use(withAuth)
	.use(withAuthorization("tedis:read", "mcp:messaging.write"))
	.handler(async ({ input, context }) => {
		const { recordAgentDecision } =
			await import("../../services/agent-decision-journal");
		return recordAgentDecision(context, requireOrgId(context), input);
	});

const recordAgentDecisionOutcome = decisionGraphOs.recordAgentDecisionOutcome
	.use(withAuth)
	.use(withAuthorization("tedis:read", "mcp:messaging.write"))
	.handler(async ({ input, context }) => {
		const { recordAgentDecisionOutcome } =
			await import("../../services/agent-decision-journal");
		return recordAgentDecisionOutcome(context, requireOrgId(context), input);
	});

const listAgentDecisions = decisionGraphOs.listAgentDecisions
	.use(withAuth)
	.use(AUTHZ.messagingRead)
	.handler(async ({ input, context }) => {
		const { listAgentDecisions } =
			await import("../../services/agent-decision-journal");
		return listAgentDecisions(context, requireOrgId(context), input);
	});

export const decisionGraphContractRouter = decisionGraphOs.router({
	getContext,
	backfillPreview,
	recordAgentDecision,
	recordAgentDecisionOutcome,
	listAgentDecisions,
});
