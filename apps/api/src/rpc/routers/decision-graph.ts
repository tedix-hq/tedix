/** Read-only decision graph: how a Deck card connects to earlier decisions. */

import { implement } from "@orpc/server";
import { decisionGraphContract } from "@tedix/api-contract/contracts/decision-graph";
import {
	explainChain,
	getDecisionContext,
} from "@tedix/db/queries/decision-graph";
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
			createDecisionGraphReader(context.env),
			orgId,
			[{ id: input.cardId }],
			new Map([[input.cardId, decisionContext]]),
		);
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

export const decisionGraphContractRouter = decisionGraphOs.router({
	getContext,
	backfillPreview,
});
