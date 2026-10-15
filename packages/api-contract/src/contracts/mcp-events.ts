import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ClaimDueMcpEventWebhooksInputSchema,
	ClaimDueMcpEventWebhooksResultSchema,
	DeleteMcpEventWebhookSubscriptionInputSchema,
	DeleteMcpEventWebhookSubscriptionResultSchema,
	PollWorkCommentsInputSchema,
	PollWorkCommentsResultSchema,
	PollWorkInteractionRequestsInputSchema,
	PollWorkInteractionRequestsResultSchema,
	PollFailedSkillRunsInputSchema,
	PollFailedSkillRunsResultSchema,
	PollWorkApprovalRequestsInputSchema,
	PollWorkApprovalRequestsResultSchema,
	PollWorkStateChangesInputSchema,
	PollWorkStateChangesResultSchema,
	RecordMcpEventWebhookDeliveryInputSchema,
	RecordMcpEventWebhookDeliveryResultSchema,
	UpsertMcpEventWebhookSubscriptionInputSchema,
	UpsertMcpEventWebhookSubscriptionResultSchema,
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
		pollWorkComments: oc
			.route({
				method: "POST",
				path: "/work-comments/poll",
				summary: "Poll Work comments after a keyset cursor",
			})
			.input(PollWorkCommentsInputSchema)
			.output(PollWorkCommentsResultSchema),
		pollWorkInteractionRequests: oc
			.route({
				method: "POST",
				path: "/work-interaction-requests/poll",
				summary: "Poll Work interaction-requests after a keyset cursor",
			})
			.input(PollWorkInteractionRequestsInputSchema)
			.output(PollWorkInteractionRequestsResultSchema),
		pollFailedSkillRuns: oc
			.route({
				method: "POST",
				path: "/failed-skill-runs/poll",
				summary: "Poll failed skill workflow runs after a keyset cursor",
			})
			.input(PollFailedSkillRunsInputSchema)
			.output(PollFailedSkillRunsResultSchema),
		upsertWebhookSubscription: oc
			.route({
				method: "POST",
				path: "/webhook-subscriptions/upsert",
				summary: "Create or renew the caller's event webhook subscription",
			})
			.input(UpsertMcpEventWebhookSubscriptionInputSchema)
			.output(UpsertMcpEventWebhookSubscriptionResultSchema),
		deleteWebhookSubscription: oc
			.route({
				method: "POST",
				path: "/webhook-subscriptions/delete",
				summary: "Delete the caller's event webhook subscription",
			})
			.input(DeleteMcpEventWebhookSubscriptionInputSchema)
			.output(DeleteMcpEventWebhookSubscriptionResultSchema),
		claimDueWebhookSubscriptions: oc
			.route({
				method: "POST",
				path: "/webhook-subscriptions/claim-due",
				summary: "Claim due event webhook subscriptions (service binding)",
			})
			.input(ClaimDueMcpEventWebhooksInputSchema)
			.output(ClaimDueMcpEventWebhooksResultSchema),
		recordWebhookDelivery: oc
			.route({
				method: "POST",
				path: "/webhook-subscriptions/record-delivery",
				summary: "Record one event webhook delivery pass (service binding)",
			})
			.input(RecordMcpEventWebhookDeliveryInputSchema)
			.output(RecordMcpEventWebhookDeliveryResultSchema),
	});
