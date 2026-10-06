import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";

interface FlywheelAccess {
	tediId: string;
	orgId: string;
}

function rate(count: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(1, Math.round((count / total) * 1000) / 1000);
}

export interface BrainCompoundingSignals {
	completedDecisions: number;
	operationalArtifacts: number;
	skillExecutions: number;
	reusedSkillExecutions: number;
	skillClaimedEpisodes: number;
	conformantSkillEpisodes: number;
	factsCreated: number;
	factsConsolidated: number;
	rates: {
		artifact: number;
		skillReuse: number;
		conformance: number;
		consolidation: number;
	};
}

type BrainCompoundingCountRow = Omit<BrainCompoundingSignals, "rates">;

/**
 * SQL predicate: the `skill_usage_events` row aliased `alias` is a REUSE —
 * some other execution of the same skill in the same org strictly precedes it
 * (created_at, with id as the tie-breaker for identical timestamps). Shared by
 * the benchmark compounding stage (`getBrainCompoundingSignals`) and the
 * strategy-map daily skill-reuse rate (queries/strategy-map.ts) so the two
 * surfaces count "reused execution" identically.
 */
export function skillReusePriorEventSql(alias: string) {
	const usage = sql.raw(alias);
	return sql`EXISTS (
		SELECT 1 FROM skill_usage_events prior
		WHERE prior.organization_id = ${usage}.organization_id
			AND prior.skill_id = ${usage}.skill_id
			AND (prior.created_at < ${usage}.created_at
				OR (prior.created_at = ${usage}.created_at AND prior.id < ${usage}.id))
	)`;
}

export async function getBrainCompoundingSignals(
	db: DbClient,
	access: FlywheelAccess,
	windowDays = 30,
): Promise<BrainCompoundingSignals> {
	const since = new Date(
		Date.now() - windowDays * 24 * 60 * 60 * 1000,
	).toISOString();
	const rows = await db.all<BrainCompoundingCountRow>(
		sql`SELECT
			(SELECT count(*) FROM tedi_rationale_records
				WHERE tedi_id = ${access.tediId} AND org_id = ${access.orgId}
					AND created_at >= ${since}
					AND outcome_status != 'pending') AS completedDecisions,
			((SELECT count(*) FROM work_items
				WHERE org_id = ${access.orgId}
					AND ((accountable_owner_type = 'tedi' AND accountable_owner_id = ${access.tediId})
						OR (steward_type = 'tedi' AND steward_id = ${access.tediId}))
					AND created_at >= ${since})
			 + (SELECT count(*) FROM tedi_optimization_signals
				WHERE tedi_id = ${access.tediId}
					AND organization_id = ${access.orgId}
					AND created_at >= ${since})) AS operationalArtifacts,
			(SELECT count(*) FROM skill_usage_events
				WHERE tedi_id = ${access.tediId}
					AND organization_id = ${access.orgId}
					AND created_at >= ${since}) AS skillExecutions,
			(SELECT count(*) FROM skill_usage_events usage
				WHERE usage.tedi_id = ${access.tediId}
					AND usage.organization_id = ${access.orgId}
					AND usage.created_at >= ${since}
					AND ${skillReusePriorEventSql("usage")}) AS reusedSkillExecutions,
			(SELECT count(DISTINCT rationale.id)
				FROM tedi_rationale_records rationale
				JOIN skill_usage_events usage
					ON usage.organization_id = rationale.org_id
					AND usage.tedi_id = rationale.tedi_id
					AND usage.run_id = rationale.run_id
				WHERE rationale.tedi_id = ${access.tediId}
					AND rationale.org_id = ${access.orgId}
					AND rationale.created_at >= ${since}) AS skillClaimedEpisodes,
			(SELECT count(DISTINCT rationale.id)
				FROM tedi_rationale_records rationale
				JOIN skill_usage_events usage
					ON usage.organization_id = rationale.org_id
					AND usage.tedi_id = rationale.tedi_id
					AND usage.run_id = rationale.run_id
				WHERE rationale.tedi_id = ${access.tediId}
					AND rationale.org_id = ${access.orgId}
					AND rationale.created_at >= ${since}
					AND rationale.outcome_status = 'success'
					AND usage.outcome = 'success') AS conformantSkillEpisodes,
			(SELECT count(*) FROM memory_facts
				WHERE organization_id = ${access.orgId}
					AND (tedi_id = ${access.tediId} OR tedi_id IS NULL)
					AND created_at >= ${since}) AS factsCreated,
			(SELECT count(*) FROM memory_facts
				WHERE organization_id = ${access.orgId}
					AND (tedi_id = ${access.tediId} OR tedi_id IS NULL)
					AND (archived_at >= ${since} OR valid_to >= ${since})) AS factsConsolidated`,
	);
	const counts = rows[0] ?? {
		completedDecisions: 0,
		operationalArtifacts: 0,
		skillExecutions: 0,
		reusedSkillExecutions: 0,
		skillClaimedEpisodes: 0,
		conformantSkillEpisodes: 0,
		factsCreated: 0,
		factsConsolidated: 0,
	};
	return {
		...counts,
		rates: {
			artifact: rate(counts.operationalArtifacts, counts.completedDecisions),
			skillReuse: rate(counts.reusedSkillExecutions, counts.skillExecutions),
			conformance: rate(
				counts.conformantSkillEpisodes,
				counts.skillClaimedEpisodes,
			),
			consolidation: rate(counts.factsConsolidated, counts.factsCreated),
		},
	};
}
