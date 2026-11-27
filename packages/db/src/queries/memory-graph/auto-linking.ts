import { type TenantScope, normalizeTenantScope } from "../../tenant-scope";
import { and, desc, asc, eq, isNull, notExists, sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	alias as sqliteAlias,
} from "drizzle-orm/sqlite-core";
import { alias as pgAlias } from "drizzle-orm/pg-core";
import { coreTable } from "../../core-store/client";
import { coreStore, anyIds } from "../../core-store/dialect";
import type { DbClient } from "../../client";
import {
	memoryEdges as d1MemoryEdges,
	memoryFacts as d1MemoryFacts,
} from "../../schema/memory-graph";

export interface AutoLinkScope extends TenantScope {
	tediId?: string;
	domainId?: string;
	factIds?: readonly string[];
}
export interface AutoLinkFact {
	id: string;
	organizationId: string;
	tediId: string | null;
	domainId: string;
	content: string;
	source: string | null;
	visibility: string;
}
type EligibleFactColumns = Record<
	| "organizationId"
	| "archivedAt"
	| "validTo"
	| "status"
	| "reviewStatus"
	| "memoryScope"
	| "usePolicy"
	| "visibility"
	| "tediId"
	| "domainId",
	AnySQLiteColumn
>;
// Enum lists stay SQL literals so the 80-id selection keeps its bind headroom.
function eligible(f: EligibleFactColumns, scope: AutoLinkScope) {
	return and(
		eq(f.organizationId, scope.organizationId),
		isNull(f.archivedAt),
		isNull(f.validTo),
		sql`${f.status}='active'`,
		sql`COALESCE(${f.reviewStatus},'pending') NOT IN ('restricted','stale','disputed','rejected','superseded')`,
		sql`${f.memoryScope} NOT IN ('graph','session')`,
		sql`${f.usePolicy} IN ('can_use_as_instruction','can_use_as_evidence')`,
		sql`(${f.visibility} IN ('org','shared') OR (${f.visibility}='private' AND ${f.tediId}=${scope.tediId ?? null}))`,
		scope.domainId ? eq(f.domainId, scope.domainId) : undefined,
	);
}
/** Canonical least-privilege active facts only; finite selected IDs avoid D1's bind limit. */
export async function listAutoLinkFacts(
	db: DbClient,
	scope: AutoLinkScope,
): Promise<AutoLinkFact[]> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const alias = (
		coreStore(db) === "postgres" ? pgAlias : sqliteAlias
	) as typeof sqliteAlias;
	scope = { ...scope, ...normalizeTenantScope(scope) };
	if (scope.factIds?.length === 0) return [];
	if ((scope.factIds?.length ?? 0) > 80)
		throw new Error("Auto-link selection exceeds80facts");
	const a = alias(memoryFacts, "a");
	return db
		.select({
			id: a.id,
			organizationId: a.organizationId,
			tediId: a.tediId,
			domainId: sql<string>`${a.domainId}`.as("domainId"),
			content: a.content,
			source: a.source,
			visibility: sql<string>`${a.visibility}`.as("visibility"),
		})
		.from(a)
		.where(
			and(
				eligible(a, scope),
				scope.factIds ? anyIds(db, a.id, scope.factIds) : undefined,
			),
		)
		.orderBy(desc(a.createdAt), asc(a.id))
		.limit(40);
}
/** Recheck source bytes, scope, eligibility and BOTH endpoint caps in the atomic canonical write. */
export async function createAutoLinkEdge(
	db: DbClient,
	scope: AutoLinkScope,
	input: {
		id: string;
		source: AutoLinkFact;
		target: AutoLinkFact;
		relationType: "related_to" | "contradicts" | "supersedes";
		context: string;
	},
): Promise<boolean> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const alias = (
		coreStore(db) === "postgres" ? pgAlias : sqliteAlias
	) as typeof sqliteAlias;
	scope = { ...scope, ...normalizeTenantScope(scope) };
	const a = alias(memoryFacts, "a");
	const memoryEdges = coreTable(db, d1MemoryEdges);
	const b = alias(memoryFacts, "b");
	const e = alias(memoryEdges, "e");
	const edgeCount = (fact: typeof a.id | typeof b.id) =>
		db
			.select({ count: sql<number>`COUNT(*)`.as("count") })
			.from(e)
			.where(sql`${e.sourceFactId}=${fact} OR ${e.targetFactId}=${fact}`);
	const rows = await db
		.insert(memoryEdges)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					sourceFactId: sql<string>`${a.id}`.as("source_fact_id"),
					targetFactId: sql<string>`${b.id}`.as("target_fact_id"),
					relationType: sql<
						typeof input.relationType
					>`${input.relationType}`.as("relation_type"),
					strength: sql<number>`0.6`.as("strength"),
					context: sql<string>`${input.context}`.as("context"),
				})
				.from(a)
				.crossJoin(b)
				.where(
					and(
						eq(a.id, input.source.id),
						eq(b.id, input.target.id),
						sql`${a.id}<>${b.id}`,
						eq(a.domainId, b.domainId),
						eq(a.content, input.source.content),
						eq(b.content, input.target.content),
						eligible(a, scope),
						eligible(b, scope),
						sql`((${a.visibility} IN ('org','shared') AND ${b.visibility} IN ('org','shared')) OR (${a.visibility}='private' AND ${b.visibility}='private' AND ${a.tediId}=${b.tediId}))`,
						sql`${edgeCount(a.id)}<20`,
						sql`${edgeCount(b.id)}<20`,
						notExists(
							db
								.select({ one: sql`1` })
								.from(e)
								.where(
									sql`(${e.sourceFactId}=${a.id} AND ${e.targetFactId}=${b.id}) OR (${e.sourceFactId}=${b.id} AND ${e.targetFactId}=${a.id})`,
								),
						),
					),
				),
		)
		.onConflictDoNothing()
		.returning({ id: memoryEdges.id });
	return rows.length === 1;
}
