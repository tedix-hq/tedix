import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import {
	osOutputs,
	osWorkspaceProjects,
	osWorkspaces,
} from "../schema/os-workspaces";
import {
	workApprovalProposals,
	workInteractions,
} from "../schema/work-factory";
import { workItems } from "../schema/work-items";

export async function getTodayProjectTotals(
	db: DbQueryClient,
	p: {
		orgId: string;
		projectId: string;
		personId: string;
		since: string;
		until: string;
		excludeOutputId: string;
	},
): Promise<{
	decisions: number;
	documents: number;
	lastTouched: string | null;
	receiptsJson: string;
}> {
	const i = alias(workInteractions, "i");
	const w = alias(workItems, "w");
	const requests = db.$with("requests").as(
		db
			.select({
				kind: sql<string>`${i.kind}`.as("kind"),
				status: sql<string>`${i.status}`.as("status"),
				createdAt: sql<string>`${i.createdAt}`.as("created_at"),
				resolvedAt: sql<string | null>`${i.resolvedAt}`.as("resolved_at"),
			})
			.from(i)
			.leftJoin(w, and(eq(w.id, i.workItemId), eq(w.orgId, i.orgId)))
			.where(
				and(
					eq(i.orgId, p.orgId),
					sql`coalesce(${i.projectId},${w.projectId})=${p.projectId}`,
					eq(i.targetType, "user"),
					eq(i.targetId, p.personId),
				),
			),
	);
	const o = alias(osOutputs, "o");
	const l = alias(osWorkspaceProjects, "l");
	const s = alias(osWorkspaces, "s");
	const documents = db.$with("documents").as(
		db
			.selectDistinct({
				id: sql<string>`${o.id}`.as("id"),
				title: sql<string>`${o.title}`.as("title"),
				updatedAt:
					sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ',${o.updatedAt})`.as(
						"updated_at",
					),
			})
			.from(o)
			.innerJoin(
				l,
				and(
					eq(l.workspaceId, o.workspaceId),
					eq(l.organizationId, o.organizationId),
				),
			)
			.innerJoin(
				s,
				and(eq(s.id, l.workspaceId), eq(s.organizationId, l.organizationId)),
			)
			.where(
				and(
					eq(o.organizationId, p.orgId),
					eq(l.projectId, p.projectId),
					eq(l.status, "active"),
					ne(o.id, p.excludeOutputId),
					eq(s.visibility, "org"),
					eq(s.status, "active"),
					eq(o.kind, "document"),
					eq(o.status, "active"),
				),
			),
	);
	const a = alias(workApprovalProposals, "a");
	const approvals = db.$with("approvals").as(
		db
			.select({
				status: sql<string>`${a.status}`.as("status"),
				createdAt: sql<string>`${a.createdAt}`.as("created_at"),
				resolvedAt: sql<string | null>`${a.resolvedAt}`.as("resolved_at"),
			})
			.from(a)
			.innerJoin(w, and(eq(w.id, a.workItemId), eq(w.orgId, a.orgId)))
			.where(
				and(
					eq(a.orgId, p.orgId),
					eq(w.projectId, p.projectId),
					eq(a.approverType, "user"),
					eq(a.approverId, p.personId),
				),
			),
	);
	const resolvedInWindow = (resolvedAt: typeof requests.resolvedAt) =>
		sql`julianday(${resolvedAt})>=julianday(${p.since}) AND julianday(${resolvedAt})<julianday(${p.until})`;
	const decidedRequests = db
		.select({ n: sql<number>`count(*)` })
		.from(requests)
		.where(
			and(
				eq(requests.status, "resolved"),
				inArray(requests.kind, ["question", "input"]),
				resolvedInWindow(requests.resolvedAt),
			),
		);
	const decidedApprovals = db
		.select({ n: sql<number>`count(*)` })
		.from(approvals)
		.where(
			and(
				inArray(approvals.status, ["approved", "rejected"]),
				resolvedInWindow(approvals.resolvedAt),
			),
		);
	const at = (column: typeof requests.resolvedAt | typeof requests.createdAt) =>
		sql<string | null>`${column}`.as("at");
	const touches = db
		.select({ at: at(requests.createdAt) })
		.from(requests)
		.unionAll(db.select({ at: at(requests.resolvedAt) }).from(requests))
		.unionAll(db.select({ at: at(documents.updatedAt) }).from(documents))
		.unionAll(db.select({ at: at(approvals.createdAt) }).from(approvals))
		.as("touches");
	// Aggregating the window's documents yields exactly one row (0 and '[]'
	// when empty), which carries the other totals as scalar subqueries.
	const rows = await db
		.with(requests, documents, approvals)
		.select({
			decisions: sql<number>`${decidedRequests} + ${decidedApprovals}`.as(
				"decisions",
			),
			documents: sql<number>`count(*)`.as("documents"),
			receiptsJson:
				sql<string>`json_group_array(json_object('id',${documents.id},'title',${documents.title},'at',${documents.updatedAt},'source','/outputs/'||${documents.id}))`.as(
					"receiptsJson",
				),
			lastTouched: sql<string | null>`${db
				.select({
					at: sql`strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(${touches.at})))`,
				})
				.from(touches)}`.as("lastTouched"),
		})
		.from(documents)
		.where(
			and(gte(documents.updatedAt, p.since), lt(documents.updatedAt, p.until)),
		);
	return rows[0]!;
}
