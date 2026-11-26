import { and, eq, sql } from "drizzle-orm";
import { WORK_DELEGATION_DEFAULTS } from "@tedix/api-contract/schemas/lane-execution";
import { coreTable } from "../../core-store/client";
import {
	coreStore,
	jsonRead,
	jsonParameter,
	booleanValue,
} from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	workItems as d1WorkItems,
	type WorkItem,
} from "../../schema/work-items";
import {
	workApprovalProposals as d1WorkApprovalProposals,
	workApprovalDecisions as d1WorkApprovalDecisions,
} from "../../schema/work-factory";

type ApprovalWork = Pick<
	WorkItem,
	"orgId" | "id" | "version" | "admissionSpecRevision"
>;

/** Only the specification writer emits this server-owned continuity receipt. */
export function planningApprovalVersion(
	db: object,
	item: ApprovalWork | typeof d1WorkItems,
) {
	return sql<number>`${sql`COALESCE((
		SELECT ${jsonRead(db, sql`e.payload`, ["planningApproval", "fromVersion"], "number")}
		FROM work_events e
		WHERE e.org_id=${item.orgId} AND e.work_item_id=${item.id}
		AND e.event_type IN ('work.created', 'work.accepted', 'work.specification_updated')
		AND e.event_type='work.specification_updated'
		AND ${jsonRead(db, sql`e.payload`, ["planningApproval", "toVersion"], "number")}=${item.version}
		AND ${jsonRead(db, sql`e.payload`, ["planningApproval", "admissionSpecRevision"], "text")}=${item.admissionSpecRevision}
		-- Sorting the few lifecycle rows beats walking the item's whole history.
		ORDER BY ${coreStore(db) === "postgres" ? sql`e.sequence` : sql`+e.sequence`} DESC LIMIT 1
	), ${item.version})`}`.mapWith(Number);
}

/** Exact reviewed version, or a receipt spanning only planning updates. */
export function matchesWorkApprovalVersion(
	db: object,
	item: ApprovalWork | typeof d1WorkItems,
) {
	return sql`(${coreTable(db, d1WorkApprovalProposals).workItemVersion} BETWEEN ${planningApprovalVersion(db, item)} AND ${item.version})`;
}

/** Auto delegates human-owned Work; stricter modes require a current owner receipt. */
export function ownerWorkDelegation(
	db: object,
	item:
		| (ApprovalWork &
				Pick<WorkItem, "accountableOwnerType" | "accountableOwnerId">)
		| typeof d1WorkItems,
	now: string,
) {
	// Nest the correlated expression so Drizzle preserves outer-table qualifiers in SELECTs.
	return sql<boolean>`${sql`(EXISTS (
		SELECT 1 FROM organizations delegation_org
		JOIN organization_members delegation_owner ON delegation_owner.organization_id=delegation_org.id
		WHERE delegation_org.id=${item.orgId}
		AND COALESCE(${jsonRead(db, sql`delegation_org.metadata`, ["defaultApprovalMode"])}, ${WORK_DELEGATION_DEFAULTS.approvalMode})='auto'
		AND (${item.accountableOwnerType}='user' OR ${item.accountableOwnerType} IS NULL)
		AND (delegation_owner.user_id=${item.accountableOwnerId} OR delegation_owner.descope_user_id=${item.accountableOwnerId})
		AND delegation_owner.status='active' AND delegation_owner.kind='human'
	) OR (${item.accountableOwnerType}='user' AND EXISTS (
		SELECT 1 FROM work_events delegation
		WHERE delegation.org_id=${item.orgId} AND delegation.work_item_id=${item.id}
		AND delegation.event_type IN ('work.created', 'work.accepted', 'work.specification_updated')
		AND ${
			coreStore(db) === "postgres"
				? sql`delegation.occurred_at::timestamptz > ${now}::timestamptz - interval '24 hours' AND delegation.occurred_at::timestamptz <= ${now}::timestamptz`
				: sql`julianday(delegation.occurred_at)>julianday(${now})-1 AND julianday(delegation.occurred_at)<=julianday(${now})`
		}
		AND ${jsonRead(db, sql`delegation.payload`, ["workItemVersion"], "number")}
			BETWEEN ${planningApprovalVersion(db, item)} AND ${item.version}
		AND (
			(delegation.actor_type='user' AND delegation.actor_id=${item.accountableOwnerId}
			 AND delegation.actor_session_id IS NULL AND (
				delegation.event_type IN ('work.created','work.accepted') OR
				(delegation.event_type='work.specification_updated'
				 AND ${jsonRead(db, sql`delegation.payload`, ["ownerStarted"], "boolean")}=${booleanValue(db, true)})
			 ))
		)
	)))`}`;
}

export async function hasOwnerWorkDelegation(
	db: DbQueryClient,
	item: WorkItem,
	now: string,
) {
	const workItems = coreTable(db, d1WorkItems);
	const [row] = await db
		.select({
			delegated: ownerWorkDelegation(db, workItems, now).as("owner_delegated"),
		})
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, item.orgId),
				eq(workItems.id, item.id),
				eq(workItems.version, item.version),
			),
		)
		.limit(1);
	return Boolean(row?.delegated);
}

/** A receipt cannot keep delegation valid after its policy or owner action lapses. */
export function ownerWorkApprovalIsCurrent(
	db: object,
	item: Parameters<typeof ownerWorkDelegation>[1],
	now: string,
) {
	return sql`(COALESCE(${jsonRead(db, coreTable(db, d1WorkApprovalProposals).proposal, ["source"])}, '')!='owner_delegation' OR ${ownerWorkDelegation(db, item, now)})`;
}

/** Record delegation in the lifecycle or admission batch for D1's start guard. */
export function ownerWorkApprovalStatements(
	db: DbQueryClient,
	item: Pick<WorkItem, "orgId" | "id" | "version" | "riskLevel">,
	now: string,
) {
	if (item.riskLevel !== "high") return [] as const;
	const workItems = coreTable(db, d1WorkItems);
	const workApprovalProposals = coreTable(db, d1WorkApprovalProposals);
	const workApprovalDecisions = coreTable(db, d1WorkApprovalDecisions);
	const id = crypto.randomUUID();
	const proposal = db.insert(workApprovalProposals).select(
		db
			.select({
				id: sql<string>`${id}`.as("id"),
				orgId: workItems.orgId,
				workItemId: workItems.id,
				workItemVersion: workItems.version,
				authorityKey: sql<string>`'risk:high'`.as("authority_key"),
				action: sql<string>`'admission'`.as("action"),
				proposal: jsonParameter(db, { source: "owner_delegation" }).as(
					"proposal",
				),
				requesterType: sql<"system">`'system'`.as("requester_type"),
				requesterId: sql<string>`'tedix'`.as("requester_id"),
				approverType: sql<"user">`'user'`.as("approver_type"),
				approverId: workItems.accountableOwnerId,
				rationale:
					sql<string>`'The owner delegated this Work specification.'`.as(
						"rationale",
					),
				expiresAt:
					sql<string>`${new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString()}`.as(
						"expires_at",
					),
				createdAt: sql<string>`${now}`.as("created_at"),
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, item.orgId),
					eq(workItems.id, item.id),
					eq(workItems.version, item.version),
					ownerWorkDelegation(db, workItems, now),
					sql`NOT EXISTS (
						SELECT 1 FROM work_approval_proposals existing
						WHERE existing.org_id=${item.orgId} AND existing.work_item_id=${item.id}
						AND existing.work_item_version=${item.version} AND existing.action='admission'
						AND existing.authority_key='risk:high' AND existing.status='approved'
						AND existing.expires_at>${now}
					)`,
				),
			),
	);
	const decision = db.insert(workApprovalDecisions).select(
		db
			.select({
				id: sql<string>`${crypto.randomUUID()}`.as("id"),
				proposalId: workApprovalProposals.id,
				resolvedProposalVersion: sql<number>`2`.as("resolved_proposal_version"),
				decision: sql<"approved">`'approved'`.as("decision"),
				deciderType: sql<"user">`'user'`.as("decider_type"),
				deciderId: workApprovalProposals.approverId,
				rationale:
					sql<string>`'Recorded from the owner delegation receipt.'`.as(
						"rationale",
					),
				decidedAt: sql<string>`${now}`.as("decided_at"),
			})
			.from(workApprovalProposals)
			.where(eq(workApprovalProposals.id, id)),
	);
	return [proposal, decision] as const;
}
