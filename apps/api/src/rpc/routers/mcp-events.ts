/**
 * Org-scoped ledger feeds behind the MCP Worker's SEP-3415 `events/poll`.
 *
 * These read the canonical ledgers (work_events, work_approval_proposals,
 * skill_runs) instead of a second event queue, so a poll cursor survives
 * deploys and replays exactly what committed. Every read is bound to the
 * credential's organization; payloads carry identifiers and enums only.
 */
import { implement } from "@orpc/server";
import { pollHomeRunFinished } from "../../services/home-run-finished";
import { mcpEventsContract } from "@tedix/api-contract/contracts/mcp-events";
import { McpWebhookEventNameSchema } from "@tedix/api-contract/schemas/mcp-events";
import {
	claimDueMcpEventSubscriptions,
	deleteMcpEventSubscription,
	getMcpEventSubscription,
	recordMcpEventDelivery,
	upsertMcpEventSubscription,
} from "@tedix/db/queries/mcp-event-subscriptions";
import {
	getLatestFailedSkillRunPosition,
	listFailedSkillRunEvents,
} from "@tedix/db/queries/skill-runs";
import {
	getLatestWorkApprovalPosition,
	listRequestedWorkApprovalEvents,
} from "@tedix/db/queries/work-items/approvals";
import {
	getWorkEventHeadSequence,
	listWorkStateChangeEvents,
} from "@tedix/db/queries/work-items/events";
import {
	getLatestWorkInteractionResponsePosition,
	listWorkInteractionResponseEvents,
	getLatestWorkInteractionPosition,
	listRequestedWorkInteractionEvents,
} from "@tedix/db/queries/work-items/interactions";
import {
	getLatestWorkCommentPosition,
	listWorkCommentEvents,
} from "@tedix/db/queries/work-items/comments";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	hasTedisReadAuthorization,
	withAuth,
	withAuthorization,
	withServiceAuth,
} from "../orpc";

const eventsOs = implement(mcpEventsContract).$context<BaseContext>();
const authenticatedOs = eventsOs.use(withAuth);
const workReadOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Each feed is scoped to the verified organization, like the Work board list",
		},
		"mcp:work.read",
	),
);
const interactionReadOs = authenticatedOs.use(AUTHZ.messagingRead);
const skillReadOs = authenticatedOs.use(AUTHZ.tedisRead);

const EMPTY_POSITION = { at: "", id: "" };

const CHANGE_BY_EVENT_TYPE = {
	"work.accepted": { change: "accepted", disposition: "accepted" },
	"work.completed": { change: "completed", disposition: "completed" },
	"work.cancelled": { change: "cancelled", disposition: "cancelled" },
	"attempt.settled": { change: "attempt_settled", disposition: null },
} as const;

const pollWorkStateChangesProcedure = workReadOs.pollWorkStateChanges.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context, "MCP events");
		if (input.afterSequence == null)
			return {
				events: [],
				afterSequence: await getWorkEventHeadSequence(context.db, orgId),
				hasMore: false,
			};
		const rows = await listWorkStateChangeEvents(context.db, {
			orgId,
			afterSequence: input.afterSequence,
			workItemId: input.workItemId,
			limit: input.limit + 1,
		});
		const page = rows.slice(0, input.limit);
		return {
			events: page.flatMap((row) => {
				const mapped =
					CHANGE_BY_EVENT_TYPE[
						row.eventType as keyof typeof CHANGE_BY_EVENT_TYPE
					];
				if (!mapped) return [];
				return [
					{
						eventId: `evt_work_${row.id}`,
						timestamp: row.occurredAt,
						data: {
							organization_id: orgId,
							work_item_id: row.workItemId,
							change: mapped.change,
							disposition: mapped.disposition,
							attempt_id: row.attemptId,
							attempt_outcome:
								mapped.change === "attempt_settled" ? row.outcome : null,
						},
					},
				];
			}),
			afterSequence: page.at(-1)?.sequence ?? input.afterSequence,
			hasMore: rows.length > input.limit,
		};
	},
);

const pollWorkApprovalRequestsProcedure =
	workReadOs.pollWorkApprovalRequests.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context, "MCP events");
		if (input.after == null)
			return {
				events: [],
				after:
					(await getLatestWorkApprovalPosition(context.db, orgId)) ??
					EMPTY_POSITION,
				hasMore: false,
			};
		const rows = await listRequestedWorkApprovalEvents(context.db, {
			orgId,
			after: input.after,
			workItemId: input.workItemId,
			approverId: input.approverId,
			limit: input.limit + 1,
		});
		const page = rows.slice(0, input.limit);
		const last = page.at(-1);
		return {
			events: page.map((row) => ({
				eventId: `evt_approval_${row.id}`,
				timestamp: row.createdAt,
				data: {
					organization_id: orgId,
					work_item_id: row.workItemId,
					approval_id: row.id,
					action: row.action,
					authority_key: row.authorityKey,
					approver_type: row.approverType,
					approver_id: row.approverId,
					expires_at: row.expiresAt,
				},
			})),
			after: last ? { at: last.createdAt, id: last.id } : input.after,
			hasMore: rows.length > input.limit,
		};
	});

const pollWorkCommentsProcedure = workReadOs.pollWorkComments.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context, "MCP events");
		if (input.after == null)
			return {
				events: [],
				after:
					(await getLatestWorkCommentPosition(context.db, orgId)) ??
					EMPTY_POSITION,
				hasMore: false,
			};
		const rows = await listWorkCommentEvents(context.db, {
			orgId,
			after: input.after,
			workItemId: input.workItemId,
			authorType: input.authorType,
			limit: input.limit + 1,
		});
		const page = rows.slice(0, input.limit);
		const last = page.at(-1);
		return {
			events: page.map((row) => ({
				eventId: `evt_comment_${row.id}`,
				timestamp: row.createdAt,
				data: {
					organization_id: orgId,
					work_item_id: row.workItemId,
					comment_id: row.id,
					author_type: row.authorType,
					author_id: row.authorId,
				},
			})),
			after: last ? { at: last.createdAt, id: last.id } : input.after,
			hasMore: rows.length > input.limit,
		};
	},
);

const pollWorkInteractionRequestsProcedure =
	workReadOs.pollWorkInteractionRequests.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context, "MCP events");
		if (input.after == null)
			return {
				events: [],
				after:
					(await getLatestWorkInteractionPosition(context.db, orgId)) ??
					EMPTY_POSITION,
				hasMore: false,
			};
		const rows = await listRequestedWorkInteractionEvents(context.db, {
			orgId,
			after: input.after,
			workItemId: input.workItemId,
			targetId: input.targetId,
			kind: input.kind,
			limit: input.limit + 1,
		});
		const page = rows.slice(0, input.limit);
		const last = page.at(-1);
		return {
			events: page.map((row) => ({
				eventId: `evt_interaction_${row.id}`,
				timestamp: row.createdAt,
				data: {
					organization_id: orgId,
					request_id: row.id,
					work_item_id: row.workItemId,
					project_id: row.projectId,
					kind: row.kind,
					target_type: row.targetType,
					target_id: row.targetId,
					creator_type: row.creatorType,
					due_at: row.dueAt,
				},
			})),
			after: last ? { at: last.createdAt, id: last.id } : input.after,
			hasMore: rows.length > input.limit,
		};
	});

const pollWorkInteractionResponsesProcedure =
	interactionReadOs.pollWorkInteractionResponses.handler(
		async ({ input, context }) => {
			const orgId = requireOrgId(context, "MCP events");
			if (input.after == null)
				return {
					events: [],
					after:
						(await getLatestWorkInteractionResponsePosition(
							context.db,
							orgId,
						)) ?? EMPTY_POSITION,
					hasMore: false,
				};
			const rows = await listWorkInteractionResponseEvents(context.db, {
				orgId,
				after: input.after,
				requestId: input.requestId,
				workItemId: input.workItemId,
				responderType: input.responderType,
				limit: input.limit + 1,
			});
			const page = rows.slice(0, input.limit);
			const last = page.at(-1);
			return {
				events: page.map((row) => ({
					eventId: `evt_interaction_response_${row.id}`,
					timestamp: row.respondedAt,
					data: {
						organization_id: orgId,
						request_id: row.interactionId,
						response_id: row.id,
					},
				})),
				after: last ? { at: last.respondedAt, id: last.id } : input.after,
				hasMore: rows.length > input.limit,
			};
		},
	);

const pollFailedSkillRunsProcedure = skillReadOs.pollFailedSkillRuns.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context, "MCP events");
		if (input.after == null)
			return {
				events: [],
				after:
					(await getLatestFailedSkillRunPosition(context.db, organizationId)) ??
					EMPTY_POSITION,
				hasMore: false,
			};
		const rows = await listFailedSkillRunEvents(context.db, {
			organizationId,
			after: input.after,
			tediId: input.tediId,
			skillId: input.skillId,
			limit: input.limit + 1,
		});
		const page = rows.slice(0, input.limit);
		const last = page.at(-1);
		return {
			events: page.map((row) => ({
				// A restarted run fails under a new execution epoch: a new event.
				eventId: `evt_skillrun_${row.id}_${row.executionEpoch}`,
				timestamp: row.completedAt,
				data: {
					organization_id: organizationId,
					run_id: row.id,
					skill_id: row.skillId,
					tedi_id: row.tediId,
					work_item_id: row.workItemId ?? null,
					error_class: row.errorClass,
				},
			})),
			after: last ? { at: last.completedAt, id: last.id } : input.after,
			hasMore: rows.length > input.limit,
		};
	},
);

/**
 * Webhook leases are owned by one human subject in one organization. Only the
 * MCP edge's forwarded user call may write them: it has already validated the
 * bearer, consent, organization selection and the event's read scope, and it
 * revalidates all of them before every delivery.
 */
const subscriptionOwnerOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"A webhook lease is keyed to the forwarded caller's own subject and verified organization",
		},
		"mcp:work.read",
	),
);

function subscriptionOwner(context: BaseContext): {
	organizationId: string;
	ownerSubject: string;
} {
	const organizationId = requireOrgId(context, "MCP event subscriptions");
	const ownerSubject = context.user?.sub;
	if (context.authType !== "user" || typeof ownerSubject !== "string")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A human caller owns event subscriptions",
		);
	return { organizationId, ownerSubject };
}

const upsertWebhookSubscriptionProcedure =
	subscriptionOwnerOs.upsertWebhookSubscription.handler(
		async ({ input, context }) => {
			const owner = subscriptionOwner(context);
			if (
				input.eventName === "skill.run.failed" &&
				!hasTedisReadAuthorization(context)
			)
				throw createError(ErrorCodes.FORBIDDEN, "Skill run read required");
			if (input.arguments.organization_id !== owner.organizationId)
				throw createError(ErrorCodes.FORBIDDEN, "Organization mismatch");
			const now = new Date().toISOString();
			const existing = input.keepCursor
				? await getMcpEventSubscription(context.db, {
						id: input.id,
						organizationId: owner.organizationId,
						ownerSubject: owner.ownerSubject,
					})
				: null;
			// A healthy renewal keeps its position so no event is skipped; an
			// unhealthy lease restarts from the position the edge supplied.
			const cursor =
				existing && existing.status === "active"
					? existing.cursor
					: input.cursor;
			const row = await upsertMcpEventSubscription(context.db, {
				id: input.id,
				...owner,
				mcpUrl: input.mcpUrl,
				eventName: input.eventName,
				arguments: input.arguments,
				callbackUrl: input.callbackUrl,
				sealedCredential: input.sealedCredential,
				cursor,
				expiresAt: new Date(input.expiresAt).toISOString(),
				now,
			});
			if (!row)
				throw createError(
					ErrorCodes.TOO_MANY_REQUESTS,
					"Event subscription limit reached",
				);
			return { id: input.id, cursor: row.cursor, expiresAt: row.expiresAt };
		},
	);

const deleteWebhookSubscriptionProcedure =
	subscriptionOwnerOs.deleteWebhookSubscription.handler(
		async ({ input, context }) => ({
			deleted: await deleteMcpEventSubscription(context.db, {
				id: input.id,
				...subscriptionOwner(context),
			}),
		}),
	);

/** The deliverer is the MCP Worker itself, never a forwarded caller. */
function assertDelivererCall(context: BaseContext): void {
	if (
		context.headers.get("X-Tedix-Caller-Type") ||
		context.headers.get("X-Forwarded-Authorization")
	)
		throw createError(ErrorCodes.FORBIDDEN, "Service deliverer only");
}

const claimDueWebhookSubscriptionsProcedure =
	eventsOs.claimDueWebhookSubscriptions
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			assertDelivererCall(context);
			const now = Date.now();
			const rows = await claimDueMcpEventSubscriptions(context.db, {
				now: new Date(now).toISOString(),
				leaseUntil: new Date(now + input.leaseMs).toISOString(),
				limit: input.limit,
			});
			return {
				subscriptions: rows.flatMap((row) => {
					const eventName = McpWebhookEventNameSchema.safeParse(row.eventName);
					if (!eventName.success) return [];
					return [
						{
							id: row.id,
							organizationId: row.organizationId,
							ownerSubject: row.ownerSubject,
							mcpUrl: row.mcpUrl,
							eventName: eventName.data,
							arguments: row.arguments,
							callbackUrl: row.callbackUrl,
							sealedCredential: row.sealedCredential,
							cursor: row.cursor,
							consecutiveFailures: row.consecutiveFailures,
							rateWindowStartedAt: row.rateWindowStartedAt,
							rateWindowCount: row.rateWindowCount,
							expiresAt: row.expiresAt,
						},
					];
				}),
			};
		});

const recordWebhookDeliveryProcedure = eventsOs.recordWebhookDelivery
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		assertDelivererCall(context);
		return {
			recorded: await recordMcpEventDelivery(context.db, {
				...input,
				now: new Date().toISOString(),
			}),
		};
	});

export const mcpEventsContractRouter = eventsOs.router({
	pollHomeRunFinished: authenticatedOs.pollHomeRunFinished
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Each run requires canonical conversation-grant visibility",
				},
				"mcp:messaging.read",
			),
		)
		.handler(({ context, input }) =>
			pollHomeRunFinished(
				context,
				input,
				requireOrgId(context, "Home run events"),
			),
		),
	pollWorkStateChanges: pollWorkStateChangesProcedure,
	pollWorkApprovalRequests: pollWorkApprovalRequestsProcedure,
	pollWorkComments: pollWorkCommentsProcedure,
	pollWorkInteractionRequests: pollWorkInteractionRequestsProcedure,
	pollWorkInteractionResponses: pollWorkInteractionResponsesProcedure,
	pollFailedSkillRuns: pollFailedSkillRunsProcedure,
	upsertWebhookSubscription: upsertWebhookSubscriptionProcedure,
	deleteWebhookSubscription: deleteWebhookSubscriptionProcedure,
	claimDueWebhookSubscriptions: claimDueWebhookSubscriptionsProcedure,
	recordWebhookDelivery: recordWebhookDeliveryProcedure,
});
