import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	PollFailedSkillRunsInputSchema,
	PollFailedSkillRunsResultSchema,
	PollWorkApprovalRequestsInputSchema,
	PollWorkApprovalRequestsResultSchema,
	PollWorkStateChangesInputSchema,
	PollWorkStateChangesResultSchema,
} from "../schemas/mcp-events";

/** Org-scoped ledger feeds served to the MCP Worker's `events/poll`. */
export const mcpEventsContract = oc
	.route({ tags: ["mcp-events"], prefix: "/mcp-events" })
	.errors(baseErrors)
	.router({
		pollWorkStateChanges: oc
			.route({
				method: "POST",
				path: "/work-state-changes/poll",
				summary: "Poll Work Item state changes after a ledger cursor",
			})
			.input(PollWorkStateChangesInputSchema)
			.output(PollWorkStateChangesResultSchema),
		pollWorkApprovalRequests: oc
			.route({
				method: "POST",
				path: "/work-approval-requests/poll",
				summary: "Poll Work approval requests after a keyset cursor",
			})
			.input(PollWorkApprovalRequestsInputSchema)
			.output(PollWorkApprovalRequestsResultSchema),
		pollFailedSkillRuns: oc
			.route({
				method: "POST",
				path: "/failed-skill-runs/poll",
				summary: "Poll failed skill workflow runs after a keyset cursor",
			})
			.input(PollFailedSkillRunsInputSchema)
			.output(PollFailedSkillRunsResultSchema),
	});
