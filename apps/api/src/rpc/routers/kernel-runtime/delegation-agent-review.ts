/**
 * Kernel runtime — agent review of held Home delegations over the Work
 * approval plane (owner directive: agent-in-the-loop, not human-in-the-loop).
 *
 * request: an agent-routable hold with a resolved approver becomes a held Work
 *   Item (created + accepted, never admitted) requiring the `home_delegation`
 *   authority, plus a Work approval proposal addressed to the approver tedi.
 * wake: the approver is woken through the same `/hooks/inject` path the cron
 *   redrive uses; a failed wake is retried by that redrive.
 * The approver's decision is carried out by `./delegation-agent-decision`.
 */

import {
	getWorkApprovalProposal,
	proposeWorkApproval,
} from "@tedix/db/queries/work-items/approvals";
import {
	acceptWorkItem,
	createWorkItem,
	getWorkItemById,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import { workItemPurposeFor } from "@tedix/db/queries/work-items/purpose";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { BaseContext } from "../../orpc";
import {
	HOME_DELEGATION_AUTHORITY,
	HOME_DELEGATION_REVIEW_SOURCE,
	type HomeDelegationAgentReview,
} from "../kernel/delegation-approver";
import {
	delegationWorkItemTitle,
	requiredProofKindForExecution,
} from "../kernel/delegation-work-item";
import type { HomeDelegationAgentReviewRequest } from "../kernel/turn-work";

/** Requester of every Home delegation review: the platform, never the approver. */
const HOME_REVIEW_REQUESTER = { type: "system", id: "tedix" } as const;

function reviewDescription(input: HomeDelegationAgentReviewRequest): string {
	const workOrder = input.workOrder;
	const line = (label: string, value: unknown) =>
		typeof value === "string" && value.trim()
			? [`${label}: ${value.trim()}`]
			: [];
	return [
		"Home held this delegation for an independent decision. Approving",
		"authorizes this one dispatch only; it is not an entrustment or promotion.",
		"",
		`Target tedi: ${input.targetTediLabel ?? input.targetTediId} (${input.targetTediId})`,
		`Hold reason: ${input.holdReason}`,
		`Route risk: ${input.route.risk}`,
		...line("Activity", input.route.targetActivityId),
		...line("Effort class", input.route.effortClass),
		...line("Route rationale", input.route.rationale),
		`Execution surface: ${input.executionRequirement.surface}`,
		"",
		...line("Objective", workOrder.objective),
		...line("Output contract", workOrder.outputContract),
		...(Array.isArray(workOrder.boundaries) && workOrder.boundaries.length
			? [
					"Boundaries:",
					...workOrder.boundaries
						.filter((item): item is string => typeof item === "string")
						.map((item) => `- ${item}`),
				]
			: []),
		"",
		`Operator request: ${input.content.trim()}`,
	]
		.join("\n")
		.slice(0, 8_000);
}

/**
 * Create (or reuse, keyed `${homeRunId}:delegation-review`) the held Work Item
 * and propose it to the approver tedi. Throws on any failure; the turn body
 * turns that into `agentReview.status: "unavailable"` and the operator card.
 */
export async function requestHomeDelegationAgentReview(
	context: BaseContext,
	input: HomeDelegationAgentReviewRequest,
): Promise<HomeDelegationAgentReview> {
	const sourceIntentId = `${input.homeRunId}:delegation-review`;
	let item = await getWorkItemBySourceIntentId(context.db, {
		orgId: input.organizationId,
		sourceIntentId,
	});
	if (!item) {
		const created = await createWorkItem(context.db, {
			id: crypto.randomUUID(),
			orgId: input.organizationId,
			title: delegationWorkItemTitle(input.content),
			description: reviewDescription(input),
			workKind: "operations",
			priority: "medium",
			requiredAuthorities: [HOME_DELEGATION_AUTHORITY],
			accountableOwnerType: "tedi",
			accountableOwnerId: input.targetTediId,
			stewardType: "system",
			stewardId: "home",
			...workItemPurposeFor({
				objectiveId: input.objectiveId,
				workClass: "maintenance",
				now: new Date(input.requestedAt),
			}),
			sourceSessionKey: input.conversationId,
			sourceIntentId,
			provenance: {
				source: HOME_DELEGATION_REVIEW_SOURCE,
				homeRunId: input.homeRunId,
			},
			metadata: {
				source: HOME_DELEGATION_REVIEW_SOURCE,
				homeRunId: input.homeRunId,
				delegatedTediId: input.targetTediId,
				approverTediId: input.approverTediId,
				purposeContext: input.objectiveId
					? "objective"
					: "transitional_home_exception",
				executionRequirement:
					input.executionRequirement as unknown as JsonValue,
				requiredProofKind: requiredProofKindForExecution(
					input.executionRequirement,
				),
			},
			createdAt: input.requestedAt,
		});
		item = await acceptWorkItem(context.db, {
			orgId: input.organizationId,
			workItemId: created.id,
			acceptanceContract: {
				version: 1,
				doneLooksLike:
					"The delegated tedi completed the requested work and settled its Attempt with the result.",
			},
			actor: { type: "system", id: "home" },
			acceptedAt: input.requestedAt,
		});
	}
	if (item.disposition !== "accepted") {
		throw new Error(
			`Held delegation Work Item ${item.id} is ${item.disposition}, not accepted`,
		);
	}
	const proposal = await proposeWorkApproval(context.db, {
		id: crypto.randomUUID(),
		orgId: input.organizationId,
		workItemId: item.id,
		workItemVersion: item.version,
		authorityKey: HOME_DELEGATION_AUTHORITY,
		proposal: {
			kind: "home_delegation",
			homeRunId: input.homeRunId,
			targetTediId: input.targetTediId,
			holdReason: input.holdReason,
			route: input.route,
		},
		requesterType: HOME_REVIEW_REQUESTER.type,
		requesterId: HOME_REVIEW_REQUESTER.id,
		approverType: "tedi",
		approverId: input.approverTediId,
		rationale: `Home held a delegation to ${input.targetTediLabel ?? input.targetTediId}: ${input.holdReason}. Decide whether this one dispatch may proceed.`,
		expiresAt: input.expiresAt,
		now: input.requestedAt,
	});
	return {
		status: "pending",
		approverTediId: input.approverTediId,
		approverTediLabel: input.approverTediLabel,
		proposalId: proposal.id,
		proposalVersion: proposal.version,
		workItemId: item.id,
		requestedAt: input.requestedAt,
		expiresAt: input.expiresAt,
	};
}

/** Wake the approver for one pending Home delegation proposal. */
export async function wakeHomeDelegationAgentReview(
	context: BaseContext,
	input: { organizationId: string; proposalId: string },
): Promise<void> {
	const proposal = await getWorkApprovalProposal(context.db, {
		orgId: input.organizationId,
		proposalId: input.proposalId,
	});
	if (
		!proposal ||
		proposal.status !== "pending" ||
		proposal.approverType !== "tedi" ||
		!proposal.expiresAt
	)
		return;
	const item = await getWorkItemById(
		context.db,
		proposal.workItemId,
		input.organizationId,
	);
	const { wakePendingWorkApproval } =
		await import("../../../jobs/work-approval-redrive");
	await wakePendingWorkApproval(context.env, context.db, {
		id: proposal.id,
		orgId: proposal.orgId,
		workItemId: proposal.workItemId,
		workItemVersion: proposal.workItemVersion,
		workItemTitle: item?.title ?? "Home delegation review",
		authorityKey: proposal.authorityKey,
		proposal: proposal.proposal,
		requesterType: proposal.requesterType,
		requesterId: proposal.requesterId,
		approverId: proposal.approverId,
		rationale: proposal.rationale,
		expiresAt: proposal.expiresAt,
		version: proposal.version,
	});
}
