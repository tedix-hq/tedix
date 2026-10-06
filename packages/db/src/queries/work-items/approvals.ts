import { normalizeWorkItemRow } from "./normalization";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { prefixedColumns } from "../../utils/select";
import { workItems } from "../../schema/work-items";
import {
	workApprovalDecisions,
	workApprovalProposals,
	type WorkApprovalDecision,
	type WorkApprovalProposal,
} from "../../schema/work-factory";
import {
	WorkControlError,
	requireActivePrincipal,
	requireExternalSession,
	requireWorkItem,
} from "./factory-validation";
import {
	requiredWorkAdmissionAuthorities,
	WORK_ADMISSION_APPROVAL_ACTION,
} from "./admission-approval-policy";

export interface ProposeWorkApprovalParams {
	id: string;
	orgId: string;
	workItemId: string;
	workItemVersion: number;
	authorityKey: string;
	proposal: Record<string, JsonValue>;
	requesterType: "user" | "tedi" | "external_agent" | "system";
	requesterId: string;
	requesterSessionId?: string;
	externalSessionKey?: string;
	approverType: "user" | "tedi";
	approverId: string;
	rationale: string;
	expiresAt: string;
	now: string;
}

export interface PendingTediWorkApproval {
	id: string;
	orgId: string;
	workItemId: string;
	workItemVersion: number;
	workItemTitle: string;
	authorityKey: string;
	proposal: Record<string, JsonValue>;
	requesterType: "user" | "tedi" | "external_agent" | "system";
	requesterId: string;
	approverId: string;
	rationale: string;
	expiresAt: string;
	version: number;
}

/** Pending tedi-addressed admission decisions that need an agent wake. */
export async function listPendingTediWorkApprovals(
	db: DbQueryClient,
	input: { observedAt: string; limit?: number },
): Promise<PendingTediWorkApproval[]> {
	const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
	return db
		.select({
			id: workApprovalProposals.id,
			orgId: workApprovalProposals.orgId,
			workItemId: workApprovalProposals.workItemId,
			workItemVersion: workApprovalProposals.workItemVersion,
			workItemTitle: workItems.title,
			authorityKey: workApprovalProposals.authorityKey,
			proposal: workApprovalProposals.proposal,
			requesterType: workApprovalProposals.requesterType,
			requesterId: workApprovalProposals.requesterId,
			approverId: workApprovalProposals.approverId,
			rationale: workApprovalProposals.rationale,
			expiresAt: sql<string>`${workApprovalProposals.expiresAt}`.as(
				"approval_expires_at",
			),
			version: workApprovalProposals.version,
		})
		.from(workApprovalProposals)
		.innerJoin(
			workItems,
			and(
				eq(workItems.id, workApprovalProposals.workItemId),
				eq(workItems.orgId, workApprovalProposals.orgId),
			),
		)
		.where(
			and(
				eq(workApprovalProposals.status, "pending"),
				eq(workApprovalProposals.approverType, "tedi"),
				sql`${workApprovalProposals.expiresAt}>${input.observedAt}`,
			),
		)
		.orderBy(desc(workApprovalProposals.createdAt))
		.limit(limit);
}
export async function proposeWorkApproval(
	db: DbQueryClient,
	p: ProposeWorkApprovalParams,
): Promise<WorkApprovalProposal> {
	const item = await requireWorkItem(db, p.orgId, p.workItemId);
	if (item.version !== p.workItemVersion)
		throw new WorkControlError(
			"CONFLICT",
			"Approval proposal Work Item version is stale",
		);
	if (!requiredWorkAdmissionAuthorities(item).includes(p.authorityKey))
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			`Authority ${p.authorityKey} is not required for Work Item admission`,
		);
	await Promise.all([
		requireActivePrincipal(db, {
			orgId: p.orgId,
			type: p.requesterType,
			id: p.requesterId,
		}),
		requireActivePrincipal(db, {
			orgId: p.orgId,
			type: p.approverType,
			id: p.approverId,
		}),
	]);
	if (p.requesterType === p.approverType && p.requesterId === p.approverId)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Requester cannot approve its own proposal",
		);
	if (p.requesterType === "external_agent") {
		if (!p.requesterSessionId || !p.externalSessionKey)
			throw new WorkControlError(
				"INVALID_PRINCIPAL",
				"External requester requires exact session fence",
			);
		await requireExternalSession(db, {
			orgId: p.orgId,
			principalId: p.requesterId,
			sessionId: p.requesterSessionId,
			externalSessionKey: p.externalSessionKey,
		});
	}
	const expire = db
		.update(workApprovalProposals)
		.set({
			status: "expired",
			resolutionFence: crypto.randomUUID(),
			resolvedAt: p.now,
			version: sql`${workApprovalProposals.version}+1`,
		})
		.where(
			and(
				eq(workApprovalProposals.orgId, p.orgId),
				eq(workApprovalProposals.workItemId, p.workItemId),
				eq(workApprovalProposals.workItemVersion, p.workItemVersion),
				eq(workApprovalProposals.authorityKey, p.authorityKey),
				eq(workApprovalProposals.action, WORK_ADMISSION_APPROVAL_ACTION),
				eq(workApprovalProposals.approverType, p.approverType),
				eq(workApprovalProposals.approverId, p.approverId),
				eq(workApprovalProposals.status, "pending"),
				sql`${workApprovalProposals.expiresAt}<=${p.now}`,
			),
		);
	const insert = db
		.insert(workApprovalProposals)
		.values({
			id: p.id,
			orgId: p.orgId,
			workItemId: p.workItemId,
			workItemVersion: p.workItemVersion,
			authorityKey: p.authorityKey,
			action: WORK_ADMISSION_APPROVAL_ACTION,
			proposal: p.proposal,
			requesterType: p.requesterType,
			requesterId: p.requesterId,
			requesterSessionId: p.requesterSessionId,
			requesterExternalSessionKey: p.externalSessionKey,
			approverType: p.approverType,
			approverId: p.approverId,
			status: "pending",
			rationale: p.rationale,
			expiresAt: p.expiresAt,
			resolutionFence: null,
			createdAt: p.now,
			version: 1,
		})
		.returning();
	const [, rows] = await db.batch([expire, insert]);
	return rows[0]!;
}

export interface DecideWorkApprovalParams {
	id: string;
	orgId: string;
	proposalId: string;
	expectedVersion: number;
	decision: "approved" | "rejected";
	deciderType: "user" | "tedi";
	deciderId: string;
	rationale: string;
	now: string;
}
export async function decideWorkApproval(
	db: DbQueryClient,
	p: DecideWorkApprovalParams,
): Promise<WorkApprovalDecision> {
	await requireActivePrincipal(db, {
		orgId: p.orgId,
		type: p.deciderType,
		id: p.deciderId,
	});
	const proposal = (
		await db
			.select()
			.from(workApprovalProposals)
			.where(
				and(
					eq(workApprovalProposals.id, p.proposalId),
					eq(workApprovalProposals.orgId, p.orgId),
					eq(workApprovalProposals.version, p.expectedVersion),
					eq(workApprovalProposals.status, "pending"),
					sql`(${workApprovalProposals.expiresAt} IS NULL OR ${workApprovalProposals.expiresAt}>${p.now})`,
				),
			)
			.limit(1)
	)[0];
	if (!proposal)
		throw new WorkControlError(
			"CONFLICT",
			"Approval proposal is no longer resolvable",
		);
	if (
		proposal.approverType !== p.deciderType ||
		proposal.approverId !== p.deciderId
	)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Decision actor is not the designated approver",
		);
	if (
		proposal.requesterType === p.deciderType &&
		proposal.requesterId === p.deciderId
	)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Requester cannot decide its own proposal",
		);
	const resolvedVersion = p.expectedVersion + 1;
	const decisionInsert = db
		.insert(workApprovalDecisions)
		.select(
			db
				.select({
					id: sql<string>`${p.id}`.as("id"),
					proposalId: workApprovalProposals.id,
					resolvedProposalVersion: sql<number>`${resolvedVersion}`.as(
						"resolved_proposal_version",
					),
					decision: sql<typeof p.decision>`${p.decision}`.as("decision"),
					deciderType: sql<typeof p.deciderType>`${p.deciderType}`.as(
						"decider_type",
					),
					deciderId: sql<string>`${p.deciderId}`.as("decider_id"),
					rationale: sql<string>`${p.rationale}`.as("rationale"),
					decidedAt: sql<string>`${p.now}`.as("decided_at"),
				})
				.from(workApprovalProposals)
				.where(
					and(
						eq(workApprovalProposals.id, p.proposalId),
						eq(workApprovalProposals.orgId, p.orgId),
						eq(workApprovalProposals.version, p.expectedVersion),
						eq(workApprovalProposals.status, "pending"),
						sql`${workApprovalProposals.resolutionFence} IS NULL`,
						sql`${workApprovalProposals.expiresAt}>${p.now}`,
					),
				),
		)
		.returning();
	try {
		const decisions = await decisionInsert;
		if (!decisions[0]) throw new Error("lost race");
		return decisions[0];
	} catch {
		throw new WorkControlError(
			"CONFLICT",
			"Approval proposal lost its resolution race",
		);
	}
}

export async function getWorkApprovalProposal(
	db: DbQueryClient,
	p: { orgId: string; proposalId: string },
) {
	return (
		(
			await db
				.select()
				.from(workApprovalProposals)
				.where(
					and(
						eq(workApprovalProposals.orgId, p.orgId),
						eq(workApprovalProposals.id, p.proposalId),
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
export async function listWorkApprovalInbox(
	db: DbQueryClient,
	p: {
		orgId: string;
		proposalId?: string;
		statuses?: Array<
			"pending" | "approved" | "rejected" | "cancelled" | "expired"
		>;
		workItemId?: string;
		projectId?: string;
		authorityKey?: string;
		approverType?: "user" | "tedi";
		approverId?: string;
		cursor?: { at: string; id: string };
		limit?: number;
		observedAt: string;
	},
) {
	const effective = sql<
		"pending" | "approved" | "rejected" | "cancelled" | "expired"
	>`CASE WHEN ${workApprovalProposals.status}='pending' AND ${workApprovalProposals.expiresAt}<=${p.observedAt} THEN 'expired' ELSE ${workApprovalProposals.status} END`;
	const limit = Math.min(p.limit ?? 50, 200);
	const rows = await db
		.select({
			proposal: prefixedColumns(
				workApprovalProposals,
				"work_approval_proposal",
			),
			effectiveStatus: effective.as("effective_status"),
			decision: prefixedColumns(
				workApprovalDecisions,
				"work_approval_decision",
			),
			workItem: prefixedColumns(workItems, "work_approval_item"),
		})
		.from(workApprovalProposals)
		.innerJoin(
			workItems,
			and(
				eq(workItems.orgId, workApprovalProposals.orgId),
				eq(workItems.id, workApprovalProposals.workItemId),
			),
		)
		.leftJoin(
			workApprovalDecisions,
			eq(workApprovalDecisions.proposalId, workApprovalProposals.id),
		)
		.where(
			and(
				eq(workApprovalProposals.orgId, p.orgId),
				p.proposalId ? eq(workApprovalProposals.id, p.proposalId) : undefined,
				// bound-params: statuses is a closed four-value approval-status enum
				p.statuses?.length ? inArray(effective, p.statuses) : undefined,
				p.workItemId
					? eq(workApprovalProposals.workItemId, p.workItemId)
					: undefined,
				p.projectId ? eq(workItems.projectId, p.projectId) : undefined,
				p.authorityKey
					? eq(workApprovalProposals.authorityKey, p.authorityKey)
					: undefined,
				p.approverType
					? eq(workApprovalProposals.approverType, p.approverType)
					: undefined,
				p.approverId
					? eq(workApprovalProposals.approverId, p.approverId)
					: undefined,
				p.cursor
					? sql`(${workApprovalProposals.createdAt}<${p.cursor.at} OR (${workApprovalProposals.createdAt}=${p.cursor.at} AND ${workApprovalProposals.id}<${p.cursor.id}))`
					: undefined,
			),
		)
		.orderBy(
			desc(workApprovalProposals.createdAt),
			desc(workApprovalProposals.id),
		)
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	// The joined Work Item crosses the DB boundary like every other work-item
	// read: older accepted rows carry the retired `claims[]`
	// acceptance-contract shape, which the strict read contract rejects.
	const data = rows.slice(0, limit).map((row) => ({
		...row,
		workItem: normalizeWorkItemRow(row.workItem),
	}));
	const last = data.at(-1);
	return {
		data,
		hasMore,
		nextCursor:
			hasMore && last
				? { at: last.proposal.createdAt, id: last.proposal.id }
				: null,
		observedAt: p.observedAt,
	};
}
