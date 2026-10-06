import type * as z from "zod";
import { WorkPrincipalTypeSchema } from "@tedix/api-contract/schemas/work-items";
import { getWorkAdmissionSpecification } from "@tedix/db/queries/work-items/admissions";
import { implement } from "@orpc/server";
import { workApprovalsContract } from "@tedix/api-contract/contracts/work-approvals";
import {
	decideWorkApproval,
	getWorkApprovalProposal,
	listWorkApprovalInbox,
	proposeWorkApproval,
} from "@tedix/db/queries/work-items/approvals";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";
import { verifiedActiveWorkActor } from "./work-items-principal";
import {
	assertWorkItemAccess,
	requireOwnerAdminWorkItemAuthor,
	rethrowWorkControlError,
} from "./work-items/policy-helpers";

const approvalsOs = implement(workApprovalsContract).$context<BaseContext>();
const authenticatedOs = approvalsOs.use(withAuth);
const readOs = authenticatedOs.use(AUTHZ.messagingRead);
const requestOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Proposal handlers derive the active requester from its credential and bind the request to the current organization's Work Item revision",
		},
		"mcp:work.write",
	),
);
const writeOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Handlers derive the active requester/approver from the authenticated credential and scope every row to the current organization",
		},
		"mcp:messaging.write",
	),
);

function rethrowApprovalError(error: unknown): never {
	return rethrowWorkControlError(error, { invalidPrincipal: "forbidden" });
}

type ApprovalProposalRow = NonNullable<
	Awaited<ReturnType<typeof getWorkApprovalProposal>>
>;

function proposalOutput(row: ApprovalProposalRow) {
	if (row.expiresAt === null) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Stored Work approval is missing its required expiry",
		);
	}
	return {
		id: row.id,
		orgId: row.orgId,
		workItemId: row.workItemId,
		workItemVersion: row.workItemVersion,
		action: row.action,
		proposal: row.proposal,
		authorityKey: row.authorityKey,
		approverType: row.approverType,
		approverId: row.approverId,
		requestRationale: row.rationale,
		// Legacy rows persist a `system` requester; the read contract admits every
		// principal type while writes stay gated to credential actors.
		requestedByType: row.requesterType as z.infer<
			typeof WorkPrincipalTypeSchema
		>,
		requestedById: row.requesterId,
		requestedBySessionId: row.requesterSessionId,
		status: row.status,
		requestedAt: row.createdAt,
		expiresAt: row.expiresAt,
		resolvedAt: row.resolvedAt,
		version: row.version,
	};
}

type ApprovalDecisionRow = NonNullable<
	Awaited<ReturnType<typeof decideWorkApproval>>
>;

function decisionOutput(row: ApprovalDecisionRow) {
	return {
		id: row.id,
		proposalId: row.proposalId,
		resolvedProposalVersion: row.resolvedProposalVersion,
		decision: row.decision,
		deciderType: row.deciderType,
		deciderId: row.deciderId,
		rationale: row.rationale,
		decidedAt: row.decidedAt,
	};
}

const proposeProcedure = requestOs.propose.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.workItemId);
		const requestedAt = new Date().toISOString();
		if (input.expiresAt <= requestedAt) {
			throw createError(
				ErrorCodes.UNPROCESSABLE_CONTENT,
				"Work approval expiry must be in the future",
			);
		}
		const actor = await verifiedActiveWorkActor(context, workItem.orgId);
		try {
			const proposal = await proposeWorkApproval(context.db, {
				id: crypto.randomUUID(),
				orgId: workItem.orgId,
				workItemId: workItem.id,
				workItemVersion: input.workItemVersion,
				authorityKey: input.authorityKey,
				proposal: input.proposal,
				requesterType: actor.type,
				requesterId: actor.id,
				requesterSessionId: actor.sessionId,
				externalSessionKey: actor.externalSessionKey,
				approverType: input.approverType,
				approverId: input.approverId,
				rationale: input.requestRationale,
				expiresAt: input.expiresAt,
				now: requestedAt,
			});
			if (proposal.approverType === "tedi" && proposal.expiresAt) {
				const wake = import("../../jobs/work-approval-redrive")
					.then(({ wakePendingWorkApproval }) =>
						wakePendingWorkApproval(context.env, context.db, {
							id: proposal.id,
							orgId: proposal.orgId,
							workItemId: proposal.workItemId,
							workItemVersion: proposal.workItemVersion,
							workItemTitle: workItem.title,
							authorityKey: proposal.authorityKey,
							proposal: proposal.proposal,
							requesterType: proposal.requesterType,
							requesterId: proposal.requesterId,
							approverId: proposal.approverId,
							rationale: proposal.rationale,
							expiresAt: proposal.expiresAt,
							version: proposal.version,
						}),
					)
					.catch((error) =>
						console.error("[work-approval] immediate tedi wake failed", error),
					);
				context.waitUntil?.(wake);
			}
			return proposalOutput(proposal);
		} catch (error) {
			rethrowApprovalError(error);
		}
	},
);

/**
 * A decision on a held Home delegation (`kernelRuntime.homeDelegationReview`)
 * is carried out here: approve admits the held Work Item and dispatches;
 * reject hands the run back to the operator. Fail-soft: the Work decision is
 * already durable, and a run left parked still shows the operator card.
 */
async function carryOutHomeDelegationDecision(
	context: BaseContext,
	input: {
		orgId: string;
		proposal: ApprovalProposalRow;
		decision: ApprovalDecisionRow;
		deciderTediId: string;
	},
): Promise<void> {
	try {
		const workItem = await getWorkItemById(
			context.db,
			input.proposal.workItemId,
			input.orgId,
		);
		const metadata = workItem?.metadata as Record<string, unknown> | undefined;
		const { HOME_DELEGATION_REVIEW_SOURCE } =
			await import("./kernel/delegation-approver");
		if (
			!workItem ||
			metadata?.source !== HOME_DELEGATION_REVIEW_SOURCE ||
			typeof metadata.homeRunId !== "string"
		)
			return;
		const { settleHomeDelegationAgentDecision } =
			await import("./kernel-runtime/delegation-agent-decision");
		await settleHomeDelegationAgentDecision(context, {
			organizationId: input.orgId,
			proposalId: input.proposal.id,
			workItemId: workItem.id,
			homeRunId: metadata.homeRunId,
			decision: input.decision.decision,
			deciderTediId: input.deciderTediId,
			rationale: input.decision.rationale,
			decidedAt: input.decision.decidedAt,
		});
	} catch (error) {
		console.error(
			"[work-approval] Home delegation decision could not be carried out",
			error,
		);
	}
}

const decideProcedure = writeOs.decide.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	if (actor.type === "external_agent") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Work approval decisions require the designated user or tedi credential",
		);
	}
	try {
		const decision = await decideWorkApproval(context.db, {
			id: crypto.randomUUID(),
			orgId,
			proposalId: input.proposalId,
			expectedVersion: input.expectedProposalVersion,
			decision: input.decision,
			deciderType: actor.type,
			deciderId: actor.id,
			rationale: input.rationale,
			now: new Date().toISOString(),
		});
		const proposal = await getWorkApprovalProposal(context.db, {
			orgId,
			proposalId: input.proposalId,
		});
		if (!proposal) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Work approval proposal not found",
			);
		}
		if (actor.type === "tedi") {
			await carryOutHomeDelegationDecision(context, {
				orgId,
				proposal,
				decision,
				deciderTediId: actor.id,
			});
		}
		return {
			proposal: proposalOutput(proposal),
			decision: decisionOutput(decision),
		};
	} catch (error) {
		rethrowApprovalError(error);
	}
});

const listInboxProcedure = readOs.listInbox.handler(
	async ({ input, context }) => {
		const observedAt = new Date().toISOString();
		const orgId = requireOrgId(context);
		const actor = await verifiedActiveWorkActor(context, orgId);
		if (actor.type === "external_agent") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Work approval inboxes require an eligible user or tedi approver credential",
			);
		}
		const page = await listWorkApprovalInbox(context.db, {
			orgId,
			proposalId: input.proposalId,
			statuses: input.statuses,
			workItemId: input.workItemId,
			projectId: input.projectId,
			authorityKey: input.authorityKey,
			approverType: actor.type,
			approverId: actor.id,
			cursor: input.cursor,
			limit: input.limit,
			observedAt,
		});
		return {
			data: await Promise.all(
				page.data.map(async (row) => ({
					proposal: proposalOutput(row.proposal),
					effectiveStatus: row.effectiveStatus,
					canDecide: row.effectiveStatus === "pending",
					decision:
						row.decision.id === null ? null : decisionOutput(row.decision),
					workItem: row.workItem,
					admissionSpecification: await getWorkAdmissionSpecification(
						context.db,
						{ orgId, workItemId: row.workItem.id },
					),
				})),
			),
			nextCursor: page.nextCursor,
			hasMore: page.hasMore,
			observedAt,
		};
	},
);

const listAuditProcedure = readOs.listAudit.handler(
	async ({ input, context }) => {
		const observedAt = new Date().toISOString();
		const orgId = requireOrgId(context);
		await requireOwnerAdminWorkItemAuthor(
			context,
			orgId,
			"Work approval audit",
		);
		const page = await listWorkApprovalInbox(context.db, {
			orgId,
			proposalId: input.proposalId,
			statuses: input.statuses,
			workItemId: input.workItemId,
			projectId: input.projectId,
			authorityKey: input.authorityKey,
			cursor: input.cursor,
			limit: input.limit,
			observedAt,
		});
		return {
			data: await Promise.all(
				page.data.map(async (row) => ({
					proposal: proposalOutput(row.proposal),
					effectiveStatus: row.effectiveStatus,
					canDecide: false,
					decision:
						row.decision.id === null ? null : decisionOutput(row.decision),
					workItem: row.workItem,
					admissionSpecification: await getWorkAdmissionSpecification(
						context.db,
						{ orgId, workItemId: row.workItem.id },
					),
				})),
			),
			nextCursor: page.nextCursor,
			hasMore: page.hasMore,
			observedAt,
		};
	},
);

export const workApprovalsContractRouter = approvalsOs.router({
	propose: proposeProcedure,
	decide: decideProcedure,
	listInbox: listInboxProcedure,
	listAudit: listAuditProcedure,
});
