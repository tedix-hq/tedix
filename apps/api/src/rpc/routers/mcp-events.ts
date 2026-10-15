/**
 * Org-scoped ledger feeds behind the MCP Worker's SEP-3415 `events/poll`.
 *
 * These read the canonical ledgers (work_events, work_approval_proposals,
 * skill_runs) instead of a second event queue, so a poll cursor survives
 * deploys and replays exactly what committed. Every read is bound to the
 * credential's organization; payloads carry identifiers and enums only.
 */
import { implement } from "@orpc/server";
import { mcpEventsContract } from "@tedix/api-contract/contracts/mcp-events";
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
import { requireOrgId } from "../org-scope";
import { AUTHZ, type BaseContext, withAuth, withAuthorization } from "../orpc";

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

export const mcpEventsContractRouter = eventsOs.router({
	pollWorkStateChanges: pollWorkStateChangesProcedure,
	pollWorkApprovalRequests: pollWorkApprovalRequestsProcedure,
	pollFailedSkillRuns: pollFailedSkillRunsProcedure,
});
