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

function scoreStatus(value: number): "healthy" | "thin" | "missing" {
	if (value >= 0.7) return "healthy";
	if (value > 0) return "thin";
	return "missing";
}

export interface BrainProducerQualityRow {
	producer: string;
	factsLearned: number;
	activeFacts: number;
	archivedFacts: number;
	probationFacts: number;
	withProvenance: number;
	retrievedFacts: number;
	feedbackTouchedFacts: number;
	citedFacts: number;
	avgConfidence: number;
}

export interface BrainProducerQuality {
	windowDays: number;
	since: string;
	producers: Array<
		BrainProducerQualityRow & {
			score: number;
			status: "healthy" | "thin" | "missing";
			rates: {
				provenance: number;
				lifecycle: number;
				retrieval: number;
				feedback: number;
				citation: number;
				archive: number;
			};
			gaps: string[];
		}
	>;
	summary: {
		producerCount: number;
		factsLearned: number;
		healthyProducers: number;
		thinProducers: number;
		missingProducers: number;
	};
}

export async function getBrainProducerQuality(
	db: DbClient,
	access: FlywheelAccess,
	windowDays = 14,
): Promise<BrainProducerQuality> {
	const since = new Date(
		Date.now() - windowDays * 24 * 60 * 60 * 1000,
	).toISOString();
	const rows = await db.all<BrainProducerQualityRow>(
		sql`WITH facts AS (
			SELECT
				id,
				confidence,
				archived_at,
				valid_to,
				status,
				source,
				source_session_id,
				source_url,
				source_hash,
				access_count,
				usage_count,
				CASE
					WHEN source LIKE 'skill://runs/%' THEN 'skill-workflow'
					WHEN source LIKE 'payment://%' THEN 'economic-payment'
					WHEN source LIKE 'observation://%' THEN 'afterTurn'
					WHEN source = 'entity-extraction' THEN 'entity-extraction'
					WHEN source = 'session' THEN 'session'
					WHEN source LIKE '%heartbeat%' THEN 'heartbeat'
					WHEN source LIKE '%brain-reflection%' OR source LIKE '%reflection%' THEN 'brain-reflection'
					WHEN source LIKE '%cron%' THEN 'cron'
					WHEN source LIKE '%conversation%' OR source_session_id IS NOT NULL THEN 'afterTurn'
					WHEN source_url IS NOT NULL OR source LIKE 'doc://%' OR source LIKE 'http%' THEN 'source-backed'
					WHEN json_extract(metadata, '$.producer') IS NOT NULL THEN json_extract(metadata, '$.producer')
					WHEN json_extract(metadata, '$.sourceKind') IS NOT NULL THEN json_extract(metadata, '$.sourceKind')
					ELSE COALESCE(source, 'unknown')
				END AS producer
			FROM memory_facts
			WHERE organization_id = ${access.orgId}
				AND (tedi_id = ${access.tediId} OR tedi_id IS NULL)
				AND created_at >= ${since}
		), cited_fact_ids AS (
			SELECT DISTINCT CAST(tree.value AS TEXT) AS id
			FROM tedi_rationale_records rationale,
				json_tree(CASE WHEN json_valid(rationale.evidence)
					THEN rationale.evidence ELSE '{}' END) tree
			WHERE rationale.tedi_id = ${access.tediId}
				AND rationale.org_id = ${access.orgId}
				AND rationale.created_at >= ${since}
				AND tree.type = 'text'
				AND (
					tree.key IN ('factId', 'fact_id', 'memoryFactId', 'memory_fact_id')
					OR tree.path LIKE '%factIds%'
					OR tree.path LIKE '%fact_ids%'
					OR tree.path LIKE '%retrievedFacts%'
					OR tree.path LIKE '%retrieved_facts%'
					OR tree.path LIKE '%usedFactIds%'
					OR tree.path LIKE '%used_fact_ids%'
					OR tree.path LIKE '%factAttributions%'
				)
		)
		SELECT
			producer,
			count(*) AS factsLearned,
			sum(CASE WHEN archived_at IS NULL AND valid_to IS NULL THEN 1 ELSE 0 END) AS activeFacts,
			sum(CASE WHEN archived_at IS NOT NULL OR valid_to IS NOT NULL THEN 1 ELSE 0 END) AS archivedFacts,
			sum(CASE WHEN status = 'probation' THEN 1 ELSE 0 END) AS probationFacts,
			sum(CASE
				WHEN source IS NOT NULL
					OR source_session_id IS NOT NULL
					OR source_url IS NOT NULL
					OR source_hash IS NOT NULL
				THEN 1 ELSE 0 END) AS withProvenance,
			sum(CASE WHEN access_count > 0 THEN 1 ELSE 0 END) AS retrievedFacts,
			sum(CASE WHEN usage_count > 0 THEN 1 ELSE 0 END) AS feedbackTouchedFacts,
			sum(CASE WHEN cited_fact_ids.id IS NOT NULL THEN 1 ELSE 0 END) AS citedFacts,
			avg(confidence) AS avgConfidence
		FROM facts
		LEFT JOIN cited_fact_ids ON cited_fact_ids.id = facts.id
		GROUP BY producer
		ORDER BY factsLearned DESC`,
	);

	const producers = rows.map((row) => {
		const provenance = rate(row.withProvenance, row.factsLearned);
		const lifecycle = rate(row.activeFacts, row.factsLearned);
		const retrieval = rate(row.retrievedFacts, row.factsLearned);
		const feedback = rate(
			row.feedbackTouchedFacts,
			Math.max(row.retrievedFacts, 1),
		);
		const citation = rate(row.citedFacts, row.factsLearned);
		const archive = rate(row.archivedFacts, row.factsLearned);
		const avgConfidence = Math.round((row.avgConfidence ?? 0) * 1000) / 1000;
		const score =
			Math.round(
				(provenance * 0.25 +
					lifecycle * 0.2 +
					retrieval * 0.15 +
					feedback * 0.2 +
					citation * 0.15 +
					Math.max(0, 1 - archive) * 0.05) *
					100,
			) / 100;
		const gaps = [
			provenance < 0.9 ? "missing provenance envelope" : null,
			lifecycle < 0.7 ? "low active-fact retention" : null,
			retrieval < 0.2 ? "facts rarely retrieved" : null,
			feedback < 0.2 ? "retrieved facts rarely receive feedback" : null,
			citation < 0.1 ? "facts rarely cited by decisions" : null,
			archive > 0.3 ? "high archive/invalidated rate" : null,
		].filter((gap): gap is string => Boolean(gap));
		return {
			...row,
			avgConfidence,
			score,
			status: scoreStatus(score),
			rates: {
				provenance,
				lifecycle,
				retrieval,
				feedback,
				citation,
				archive,
			},
			gaps,
		};
	});

	return {
		windowDays,
		since,
		producers,
		summary: {
			producerCount: producers.length,
			factsLearned: producers.reduce((sum, row) => sum + row.factsLearned, 0),
			healthyProducers: producers.filter((row) => row.status === "healthy")
				.length,
			thinProducers: producers.filter((row) => row.status === "thin").length,
			missingProducers: producers.filter((row) => row.status === "missing")
				.length,
		},
	};
}
