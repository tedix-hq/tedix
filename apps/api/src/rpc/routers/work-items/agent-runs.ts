/**
 * The agent runs tedis started from a chat, for the tedi that supervises
 * them and for people who can read the organization's Work.
 */

import { WORK_RUN_STEER_SCOPE } from "@tedix/api-contract/schemas/work-attempt-steps";
import { requireOrgId } from "../../org-scope";
import { describeAgentRuns } from "../../../services/agent-run-status";
import { withAuthorization } from "../../orpc";
import { assertTediAccess } from "../work-items-principal";
import { authOs } from "./policy-helpers";

const readerOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The handler reads only the caller's organization and limits a tedi to the runs it started",
		},
		"mcp:work.read",
		WORK_RUN_STEER_SCOPE,
	),
);

export const listAgentRunsProcedure = readerOs.listAgentRuns.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		// A tedi supervises its own runs and never reads another tedi's.
		if (context.tediId) await assertTediAccess(context, context.tediId, orgId);
		return describeAgentRuns(context.db, {
			orgId,
			stewardTediId: context.tediId ?? input.tediId,
			state: input.state,
			limit: input.limit,
		});
	},
);
