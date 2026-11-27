import {
	and,
	eq,
	gte,
	inArray,
	lt,
	ne,
	sql,
	type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { coreTable } from "../core-store/client";
import { coreStore } from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";
import { osWorkspaceProjects, osWorkspaces } from "../schema/os-workspaces";
import {
	workApprovalProposals,
	workInteractions,
} from "../schema/work-factory";
import { workspaceOutputIndex } from "../schema/workspace-feed";
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
	const pg = coreStore(db) === "postgres";
	// Stored timestamps mix ISO and SQLite text; compare and emit them as UTC ISO.
	const instant = (value: SQLWrapper | string) =>
		pg ? sql`(${value})::timestamptz` : sql`julianday(${value})`;
	const isoText = (value: SQLWrapper) =>
		pg
			? sql`to_char((${value}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
			: sql`strftime('%Y-%m-%dT%H:%M:%fZ',${value})`;
	const i = alias(coreTable(db, workInteractions), "i");
	const w = alias(coreTable(db, workItems), "w");
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
	const o = alias(coreTable(db, workspaceOutputIndex), "o");
	const l = alias(coreTable(db, osWorkspaceProjects), "l");
	const s = alias(coreTable(db, osWorkspaces), "s");
	// CROSS JOIN fixes the loop order: the project's workspace links drive the
	// workspace and output seeks. Starting from workspace_output_index made the
	// planner scan every index row of the organization (15k rows a call on
	// 20 Nov 2026) before the project and workspace filters applied.
	const documents = db.$with("documents").as(
		db
			.selectDistinct({
				id: sql<string>`${o.outputId}`.as("id"),
				title: sql<string>`${o.title}`.as("title"),
				updatedAt: sql<string>`${isoText(
					pg ? instant(o.updatedAt) : o.updatedAt,
				)}`.as("updated_at"),
			})
			.from(l)
			.crossJoin(s)
			.crossJoin(o)
			.where(
				and(
					eq(l.organizationId, p.orgId),
					eq(l.projectId, p.projectId),
					eq(l.status, "active"),
					eq(s.id, l.workspaceId),
					eq(s.organizationId, l.organizationId),
					eq(o.organizationId, l.organizationId),
					eq(o.workspaceId, l.workspaceId),
					eq(s.visibility, "org"),
					eq(s.status, "active"),
					eq(o.outputKind, "document"),
					eq(o.status, "active"),
					eq(o.isCurrent, 1),
					ne(o.outputId, p.excludeOutputId),
				),
			),
	);
	const a = alias(coreTable(db, workApprovalProposals), "a");
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
		sql`${instant(resolvedAt)}>=${instant(p.since)} AND ${instant(resolvedAt)}<${instant(p.until)}`;
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
			decisions: sql<number>`${decidedRequests} + ${decidedApprovals}`
				.mapWith(Number)
				.as("decisions"),
			documents: sql<number>`count(*)`.mapWith(Number).as("documents"),
			receiptsJson: (pg
				? sql<string>`coalesce(json_agg(json_build_object('id',${documents.id},'title',${documents.title},'at',${documents.updatedAt},'source','/outputs/'||${documents.id}))::text,'[]')`
				: sql<string>`json_group_array(json_object('id',${documents.id},'title',${documents.title},'at',${documents.updatedAt},'source','/outputs/'||${documents.id}))`
			).as("receiptsJson"),
			lastTouched: sql<string | null>`${db
				.select({
					at: isoText(sql`max(${instant(touches.at)})`),
				})
				.from(touches)}`.as("lastTouched"),
		})
		.from(documents)
		.where(
			and(gte(documents.updatedAt, p.since), lt(documents.updatedAt, p.until)),
		);
	return rows[0]!;
}
