/** Read-only decision graph: how a Deck card connects to earlier decisions. */

import { implement } from "@orpc/server";
import { decisionGraphContract } from "@tedix/api-contract/contracts/decision-graph";
import {
	explainChain,
	getDecisionContext,
} from "@tedix/db/queries/decision-graph";
import { requireOrgId } from "../org-scope";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";

const decisionGraphOs = implement(
	decisionGraphContract,
).$context<BaseContext>();

const getContext = decisionGraphOs.getContext
	.use(withAuth)
	.use(AUTHZ.messagingRead)
	.handler(async ({ input, context }) => {
		// Every edge read is predicated on the caller's organization.
		const decisionContext = await getDecisionContext(
			context.db,
			requireOrgId(context),
			input.cardId,
			{ maxHops: input.maxHops },
		);
		return {
			context: decisionContext,
			explanation: explainChain(decisionContext),
		};
	});

export const decisionGraphContractRouter = decisionGraphOs.router({
	getContext,
});
