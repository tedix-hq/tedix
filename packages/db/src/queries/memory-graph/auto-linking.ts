import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";

export interface AutoLinkScope {
	organizationId: string;
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
function eligible(alias: "a" | "b", scope: AutoLinkScope) {
	const a = sql.raw(alias);
	return sql`${a}.organization_id=${scope.organizationId} AND ${a}.archived_at IS NULL AND ${a}.valid_to IS NULL
 AND ${a}.status='active' AND COALESCE(${a}.review_status,'pending') NOT IN ('restricted','stale','disputed','rejected','superseded')
 AND ${a}.memory_scope NOT IN ('graph','session') AND ${a}.use_policy IN ('can_use_as_instruction','can_use_as_evidence')
 AND (${a}.visibility IN ('org','shared') OR (${a}.visibility='private' AND ${a}.tedi_id=${scope.tediId ?? null}))
 ${scope.domainId ? sql`AND ${a}.domain_id=${scope.domainId}` : sql``}`;
}
/** Canonical least-privilege active facts only; finite selected IDs avoid D1's bind limit. */
export async function listAutoLinkFacts(
	db: DbClient,
	scope: AutoLinkScope,
): Promise<AutoLinkFact[]> {
	if (scope.factIds?.length === 0) return [];
	if ((scope.factIds?.length ?? 0) > 80)
		throw new Error("Auto-link selection exceeds80facts");
	return db.all<AutoLinkFact>(sql`SELECT a.id,a.organization_id AS organizationId,a.tedi_id AS tediId,a.domain_id AS domainId,a.content,a.source,a.visibility FROM memory_facts a
 WHERE ${eligible("a", scope)} ${
		scope.factIds
			? sql`AND a.id IN (${sql.join(
					scope.factIds.map((id) => sql`${id}`),
					sql`,`,
				)})`
			: sql``
 }
 ORDER BY a.created_at DESC,a.id ASC LIMIT 40`);
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
	const rows = await db.all<{
		id: string;
	}>(sql`INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type,strength,context)
 SELECT ${input.id},a.id,b.id,${input.relationType},0.6,${input.context} FROM memory_facts a,memory_facts b
 WHERE a.id=${input.source.id} AND b.id=${input.target.id} AND a.id<>b.id AND a.domain_id=b.domain_id
 AND a.content=${input.source.content} AND b.content=${input.target.content}
 AND ${eligible("a", scope)} AND ${eligible("b", scope)}
 AND ((a.visibility IN ('org','shared') AND b.visibility IN ('org','shared')) OR (a.visibility='private' AND b.visibility='private' AND a.tedi_id=b.tedi_id))
 AND (SELECT COUNT(*) FROM memory_edges e WHERE e.source_fact_id=a.id OR e.target_fact_id=a.id)<20
 AND (SELECT COUNT(*) FROM memory_edges e WHERE e.source_fact_id=b.id OR e.target_fact_id=b.id)<20
 AND NOT EXISTS(SELECT 1 FROM memory_edges e WHERE (e.source_fact_id=a.id AND e.target_fact_id=b.id) OR (e.source_fact_id=b.id AND e.target_fact_id=a.id))
 ON CONFLICT DO NOTHING RETURNING id`);
	return rows.length === 1;
}
