/**
 * The agent runs tedis started from a chat, for the tedi that supervises
 * them and for people who can read the organization's Work.
 */

import { WORK_RUN_STEER_SCOPE } from "@tedix/api-contract/schemas/work-attempt-steps";
import { requireOrgId } from "../../org-scope";
import { AGENT_RUN_SOURCE } from "@tedix/db/queries/work-items/agent-runs";
import { sendAgentRunPersonUpdate } from "../../../services/agent-run-person-update";
import { describeAgentRuns } from "../../../services/agent-run-status";
import { createError, ErrorCodes, withAuthorization } from "../../orpc";
import { assertTediAccess } from "../work-items-principal";
import { assertWorkItemAccess, authOs } from "./policy-helpers";

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

const stewardTediOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The handler admits only the tedi that stewards the run; no person or other agent may call it",
		},
		"mcp:work.write",
		WORK_RUN_STEER_SCOPE,
	),
);

export const tellPersonAboutAgentRunProcedure =
	stewardTediOs.tellPersonAboutAgentRun.handler(async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		if (!context.tediId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the tedi that started the run can send this update",
			);
		await assertTediAccess(context, context.tediId, workItem.orgId);
		if (
			workItem.stewardType !== "tedi" ||
			workItem.stewardId !== context.tediId ||
			workItem.executorType !== "external_agent" ||
			workItem.metadata?.source !== AGENT_RUN_SOURCE
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the tedi that started the run can send this update",
			);
		return sendAgentRunPersonUpdate(context, workItem, input.message);
	});
