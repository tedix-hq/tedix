/**
 * Knowledge-Market Telemetry (P5 #6 — Davenport & Prusak)
 *
 * *Working Knowledge* (1998) models an organization's knowledge exchange as an
 * internal market: sellers (whose artifacts others use — repute), buyers, a
 * price system settled in reciprocity, and characteristic market failures —
 * asymmetry, **localness** (people buy only from their neighbors/themselves),
 * and hoarding/artificial scarcity. The cross-tedi mesh is such a market, and
 * until now it had no price system: the org-scoped-skills invisibility bug was
 * a textbook localness pathology nobody could see.
 *
 * This module derives the market signals mechanically from existing ledgers —
 * no new writes, no LLM judgment:
 *
 * - **Repute** — skills owned by tedi A executed by tedi B
 *   (`skill_usage_events.tedi_id` ≠ owning `skill_entries.tedi_id`), plus
 *   facts scoped to A cited in B's decisions (rationale evidence fact ids
 *   resolved against `memory_facts.tedi_id`). Fact attribution is a PROXY:
 *   `memory_facts.tedi_id` is a scope column stamped at learn time, not a
 *   dedicated producer ledger — the payload carries that caveat.
 * - **Reciprocity** — directional per-pair flow balance of cross-use.
 * - **Localness** — share of each tedi's executions that touch only its own
 *   skills vs the commons (org-scoped, owner-null skills) vs peers; plus the
 *   commons-utilization rate (dead commons inventory).
 * - **Isolates** — hoarding/artificial-scarcity proxy: tedis present in the
 *   market whose skills nobody uses AND who use nobody else's.
 *
 * All queries are org-scoped, windowed (default 14d), and capped; truncation
 * is reported as a payload caveat instead of silently biasing the counts.
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { chunkForBoundParams } from "../utils/batch";
import { extractFactIdsFromFlywheelEvidence } from "./flywheel/evidence-fact-ids";
import { evidenceReferencesFactsSql } from "./flywheel/evidence-references-facts";

// ============================================================================
// Constants — thresholds are part of the published method, not tunables
// ============================================================================

export const KNOWLEDGE_MARKET_DEFAULT_WINDOW_DAYS = 14;

/** Self-share floor for the localness flag (Davenport's localness pathology). */
export const LOCALNESS_SELF_SHARE_THRESHOLD = 0.8;

/** Minimum executions before a localness flag is issued (noise floor). */
export const LOCALNESS_MIN_EXECUTIONS = 5;

/** Minimum total pair volume before a one-way reciprocity flag is issued. */
export const RECIPROCITY_ONE_WAY_MIN_FLOW = 5;

/** |balance| floor for an all-buy/all-sell reciprocity flag. */
export const RECIPROCITY_ONE_WAY_BALANCE = 0.8;

/** Minimum directional pair executions for a pair-level one-way flag. */
export const PAIR_ONE_WAY_MIN_FLOW = 3;

/** Cap on (user, owner) flow groups read per report. */
export const KNOWLEDGE_MARKET_FLOW_GROUP_CAP = 500;

/** Cap on fact-citing decisions scanned for fact-level repute. */
export const KNOWLEDGE_MARKET_FACT_DECISION_CAP = 500;

/** Cap on distinct cited fact ids resolved to producers. */
export const KNOWLEDGE_MARKET_FACT_ID_CAP = 1000;

/**
 * Fact ids per producer-resolution query. D1 allows AT MOST 100 bound
 * parameters per query (developers.cloudflare.com/d1/platform/limits) and the
 * lookup binds `organizationId` too, so the id list must stay well below 100.
 * The original chunk of 100 (= 101 bound params with the org id) made every
 * live call 500 on orgs with ≥100 distinct cited facts in-window; 50 matches
 * the live-proven fact-lifecycle sweep chunk (`SWEEP_UPDATE_CHUNK`).
 */
export const KNOWLEDGE_MARKET_FACT_ID_CHUNK = 50;

/** Cap on roster/repute group rows (org tedi fleet bound). */
export const KNOWLEDGE_MARKET_TEDI_GROUP_CAP = 200;

// ============================================================================
// Raw row types (query results / synthetic test fixtures)
// ============================================================================

/** One (consumer, owner) execution-flow group from skill_usage_events. */
export interface SkillFlowRow {
	/** Executing tedi; null = direct human/org-level usage report. */
	userTediId: string | null;
	/** Owning tedi of the executed skill; null = commons (org-scoped skill). */
	ownerTediId: string | null;
	executions: number;
	distinctSkills: number;
}

/** Per-owner cross-use aggregate (consumer ≠ owner, both non-null). */
export interface SkillReputeRow {
	ownerTediId: string;
	/** Distinct owned skills executed by at least one OTHER tedi. */
	skillsUsedByOthers: number;
	executionsByOthers: number;
	distinctConsumers: number;
}

export interface CommonsInventoryRow {
	totalCommonsSkills: number;
	/** NULL when the org has zero commons skills (D1 sum() over an empty set). */
	usedCommonsSkills: number | null;
}

export interface SkillOwnershipRow {
	tediId: string;
	ownedSkills: number;
}

/** One resolved fact citation: a decision by `citingTediId` cited `factId`. */
export interface FactCitationLink {
	citingTediId: string;
	/** memory_facts.tedi_id of the cited fact; null = org/commons-scoped fact. */
	producerTediId: string | null;
	factId: string;
}

// ============================================================================
// Report types
// ============================================================================

export type ReciprocityFlag = "balanced" | "all_sell" | "all_buy" | "inactive";

export interface KnowledgeMarketTediReport {
	tediId: string;
	/** Non-archived skills this tedi owns (inventory context for repute). */
	ownedSkills: number;
	/** This tedi's own executions in the window, split by skill origin. */
	executions: { total: number; self: number; commons: number; peer: number };
	repute: {
		/** Distinct owned skills executed by at least one other tedi. */
		skillsUsedByOthers: number;
		executionsByOthers: number;
		distinctConsumers: number;
		/** Cross-tedi citations of facts scoped to this tedi (proxy — see caveats). */
		factCitationsByOthers: number;
		distinctFactCiters: number;
	};
	reciprocity: {
		/** Executions of this tedi's skills by peers (selling). */
		given: number;
		/** This tedi's executions of peers' skills (buying). Commons excluded. */
		received: number;
		/** (given − received) / (given + received); null when both are 0. */
		balance: number | null;
		flag: ReciprocityFlag;
	};
	localness: {
		selfShare: number | null;
		commonsShare: number | null;
		peerShare: number | null;
		/** total ≥ floor AND selfShare ≥ threshold AND commonsShare = 0. */
		flag: boolean;
	};
	/** Skill-market isolate: no consumers, no peer use, no commons use. */
	isolate: boolean;
}

export interface KnowledgeMarketPairFlow {
	/** Knowledge flows owner → user. */
	ownerTediId: string;
	userTediId: string;
	executions: number;
	distinctSkills: number;
	/** Directional flow ≥ PAIR_ONE_WAY_MIN_FLOW with zero reverse flow. */
	oneWay: boolean;
}

export interface KnowledgeMarketReport {
	orgId: string;
	window: { days: number; since: string; generatedAt: string };
	orgRollup: {
		/** All skill executions in the window (including non-tedi actors). */
		totalSkillExecutions: number;
		/** Executions with a tedi actor (the market's transaction base). */
		tediActorExecutions: number;
		/** Share of tedi-actor executions that are NOT self-owned (commons + peer). */
		crossUseShare: number | null;
		/** Share of commons skills with ≥1 execution in the window. */
		commonsUtilization: number | null;
		commons: { totalSkills: number; usedSkills: number; deadSkills: number };
		isolates: string[];
		pairFlows: KnowledgeMarketPairFlow[];
	};
	tedis: KnowledgeMarketTediReport[];
	caveats: string[];
}

// ============================================================================
// Pure derivation helpers
// ============================================================================

function share(numerator: number, denominator: number): number | null {
	if (denominator <= 0) return null;
	return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Null/NaN-safe aggregate read: D1 returns NULL (not 0) for `sum()` over an
 * empty set, and a missing/undefined column must never surface as NaN in the
 * report (the oRPC output schema rejects NaN).
 */
function toCount(value: unknown): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Normalize a nullable id column: only a non-empty string is an id. */
function toIdOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `extractFactIdsFromFlywheelEvidence`, hardened for production evidence
 * shapes: one hostile `evidence` value (non-JSON text, double-encoded JSON,
 * unexpected object graphs) must never take the whole report down.
 */
export function safeExtractFactIds(evidence: unknown): string[] {
	try {
		const ids = extractFactIdsFromFlywheelEvidence(evidence);
		return Array.isArray(ids)
			? ids.filter(
					(id): id is string => typeof id === "string" && id.length > 0,
				)
			: [];
	} catch {
		return [];
	}
}

/**
 * Resolve raw fact-citing decision rows into citation links using a
 * factId → producer map. Facts that do not resolve (deleted, other org,
 * heuristic false positives) are dropped, never guessed.
 */
export function deriveFactCitationLinks(
	decisions: Array<{ tediId: string; evidence: unknown }>,
	factProducers: Map<string, string | null>,
): FactCitationLink[] {
	const links: FactCitationLink[] = [];
	for (const decision of decisions) {
		const citingTediId = toIdOrNull(decision.tediId);
		if (!citingTediId) continue;
		const factIds = safeExtractFactIds(decision.evidence);
		for (const factId of factIds) {
			if (!factProducers.has(factId)) continue;
			links.push({
				citingTediId,
				producerTediId: factProducers.get(factId) ?? null,
				factId,
			});
		}
	}
	return links;
}

function reciprocityFlag(
	given: number,
	received: number,
	balance: number | null,
): ReciprocityFlag {
	const volume = given + received;
	if (volume === 0) return "inactive";
	if (balance === null || volume < RECIPROCITY_ONE_WAY_MIN_FLOW) {
		return "balanced";
	}
	if (balance >= RECIPROCITY_ONE_WAY_BALANCE) return "all_sell";
	if (balance <= -RECIPROCITY_ONE_WAY_BALANCE) return "all_buy";
	return "balanced";
}

/**
 * Pure builder: derive the full market report from pre-fetched rows.
 * Split from `getKnowledgeMarketReport` so every metric is unit-testable
 * with synthetic ledger fixtures.
 */
export function buildKnowledgeMarketReport(input: {
	orgId: string;
	windowDays: number;
	since: string;
	generatedAt: string;
	flows: SkillFlowRow[];
	repute: SkillReputeRow[];
	commons: CommonsInventoryRow;
	ownership: SkillOwnershipRow[];
	factCitations: FactCitationLink[];
	truncation?: {
		flows?: boolean;
		factDecisions?: boolean;
		factIds?: boolean;
	};
}): KnowledgeMarketReport {
	// Ingestion hardening: normalize null-ish/undefined ids and null aggregate
	// values from raw D1 rows before any derivation touches them.
	const reputeByOwner = new Map<string, SkillReputeRow>();
	for (const row of input.repute) {
		const ownerTediId = toIdOrNull(row.ownerTediId);
		if (!ownerTediId) continue;
		reputeByOwner.set(ownerTediId, {
			ownerTediId,
			skillsUsedByOthers: toCount(row.skillsUsedByOthers),
			executionsByOthers: toCount(row.executionsByOthers),
			distinctConsumers: toCount(row.distinctConsumers),
		});
	}
	const ownedByTedi = new Map<string, number>();
	for (const row of input.ownership) {
		const tediId = toIdOrNull(row.tediId);
		if (!tediId) continue;
		ownedByTedi.set(tediId, toCount(row.ownedSkills));
	}

	// Market roster: every tedi seen acting, owning a used skill, owning
	// inventory, or participating in a fact citation.
	const roster = new Set<string>();
	for (const flow of input.flows) {
		const userTediId = toIdOrNull(flow.userTediId);
		const ownerTediId = toIdOrNull(flow.ownerTediId);
		if (userTediId) roster.add(userTediId);
		if (ownerTediId) roster.add(ownerTediId);
	}
	for (const tediId of reputeByOwner.keys()) roster.add(tediId);
	for (const tediId of ownedByTedi.keys()) roster.add(tediId);
	for (const link of input.factCitations) {
		const citingTediId = toIdOrNull(link.citingTediId);
		const producerTediId = toIdOrNull(link.producerTediId);
		if (citingTediId) roster.add(citingTediId);
		if (producerTediId) roster.add(producerTediId);
	}

	// Per-tedi execution splits + directional pair totals.
	const executionsByTedi = new Map<
		string,
		{ total: number; self: number; commons: number; peer: number }
	>();
	const givenByTedi = new Map<string, number>();
	const receivedByTedi = new Map<string, number>();
	const pairExecutions = new Map<
		string,
		{ executions: number; distinctSkills: number }
	>();
	let totalSkillExecutions = 0;
	let tediActorExecutions = 0;
	let crossExecutions = 0;

	for (const flow of input.flows) {
		const executions = toCount(flow.executions);
		const userTediId = toIdOrNull(flow.userTediId);
		const ownerTediId = toIdOrNull(flow.ownerTediId);
		totalSkillExecutions += executions;
		if (!userTediId) continue;
		tediActorExecutions += executions;

		const split = executionsByTedi.get(userTediId) ?? {
			total: 0,
			self: 0,
			commons: 0,
			peer: 0,
		};
		split.total += executions;
		if (ownerTediId === null) {
			split.commons += executions;
			crossExecutions += executions;
		} else if (ownerTediId === userTediId) {
			split.self += executions;
		} else {
			split.peer += executions;
			crossExecutions += executions;
			givenByTedi.set(
				ownerTediId,
				(givenByTedi.get(ownerTediId) ?? 0) + executions,
			);
			receivedByTedi.set(
				userTediId,
				(receivedByTedi.get(userTediId) ?? 0) + executions,
			);
			pairExecutions.set(`${ownerTediId}→${userTediId}`, {
				executions,
				distinctSkills: toCount(flow.distinctSkills),
			});
		}
		executionsByTedi.set(userTediId, split);
	}

	// Fact-citation repute (cross-tedi only; commons-scoped facts have no seller).
	const factCitationsByProducer = new Map<string, number>();
	const factCitersByProducer = new Map<string, Set<string>>();
	for (const link of input.factCitations) {
		const producerTediId = toIdOrNull(link.producerTediId);
		const citingTediId = toIdOrNull(link.citingTediId);
		if (!producerTediId || !citingTediId) continue;
		if (producerTediId === citingTediId) continue;
		factCitationsByProducer.set(
			producerTediId,
			(factCitationsByProducer.get(producerTediId) ?? 0) + 1,
		);
		const citers =
			factCitersByProducer.get(producerTediId) ?? new Set<string>();
		citers.add(citingTediId);
		factCitersByProducer.set(producerTediId, citers);
	}

	const tedis: KnowledgeMarketTediReport[] = [...roster]
		.sort()
		.map((tediId) => {
			const executions = executionsByTedi.get(tediId) ?? {
				total: 0,
				self: 0,
				commons: 0,
				peer: 0,
			};
			const reputeRow = reputeByOwner.get(tediId);
			const given = givenByTedi.get(tediId) ?? 0;
			const received = receivedByTedi.get(tediId) ?? 0;
			const volume = given + received;
			const balance =
				volume === 0
					? null
					: Math.round(((given - received) / volume) * 1000) / 1000;
			const selfShare = share(executions.self, executions.total);
			const commonsShare = share(executions.commons, executions.total);
			const peerShare = share(executions.peer, executions.total);
			const localnessFlag =
				executions.total >= LOCALNESS_MIN_EXECUTIONS &&
				(selfShare ?? 0) >= LOCALNESS_SELF_SHARE_THRESHOLD &&
				commonsShare === 0;
			const executionsByOthers = reputeRow?.executionsByOthers ?? 0;
			// Skill-market isolate: present in the market (acted or holds
			// inventory) with zero cross flows in EITHER direction. Fact-citation
			// flows deliberately do not clear the flag (see caveats).
			const present =
				executions.total > 0 || (ownedByTedi.get(tediId) ?? 0) > 0;
			const isolate =
				present &&
				executionsByOthers === 0 &&
				executions.peer === 0 &&
				executions.commons === 0;

			return {
				tediId,
				ownedSkills: ownedByTedi.get(tediId) ?? 0,
				executions,
				repute: {
					skillsUsedByOthers: reputeRow?.skillsUsedByOthers ?? 0,
					executionsByOthers,
					distinctConsumers: reputeRow?.distinctConsumers ?? 0,
					factCitationsByOthers: factCitationsByProducer.get(tediId) ?? 0,
					distinctFactCiters: factCitersByProducer.get(tediId)?.size ?? 0,
				},
				reciprocity: {
					given,
					received,
					balance,
					flag: reciprocityFlag(given, received, balance),
				},
				localness: {
					selfShare,
					commonsShare,
					peerShare,
					flag: localnessFlag,
				},
				isolate,
			};
		});

	const pairFlows: KnowledgeMarketPairFlow[] = [...pairExecutions.entries()]
		.map(([key, flow]) => {
			const [ownerTediId, userTediId] = key.split("→") as [string, string];
			const reverse = pairExecutions.get(`${userTediId}→${ownerTediId}`);
			return {
				ownerTediId,
				userTediId,
				executions: flow.executions,
				distinctSkills: flow.distinctSkills,
				oneWay:
					flow.executions >= PAIR_ONE_WAY_MIN_FLOW &&
					(reverse === undefined || reverse.executions === 0),
			};
		})
		.sort((a, b) => b.executions - a.executions);

	// D1 returns NULL (not 0) for sum() over an empty set — e.g. an org with
	// zero commons skills — so both aggregates are read null-safely.
	const totalCommonsSkills = toCount(input.commons?.totalCommonsSkills);
	const usedCommonsSkills = toCount(input.commons?.usedCommonsSkills);

	const caveats: string[] = [
		"Fact-producer attribution uses memory_facts.tedi_id — a scope column stamped at learn time, a provenance proxy, not a dedicated producer ledger. Facts promoted to org scope (tedi_id NULL) count as commons, so fact-level repute undercounts producers of org-promoted facts.",
		`Fact citations are extracted heuristically from rationale evidence JSON (key-pattern based) over at most ${KNOWLEDGE_MARKET_FACT_DECISION_CAP} most recent fact-citing decisions in the window; unresolvable fact ids are dropped, never guessed.`,
		"Usage events without a tedi actor (direct human/org-level reports) are excluded from repute, reciprocity, and localness; they still count toward commons utilization and org execution totals.",
		"Reciprocity and isolates are defined on the skill market only (commons use is localness relief, not a pair flow; fact citations do not clear the isolate flag).",
		"Commons inventory excludes app-scoped skills (app_id set) per the WS6 portfolio population audit.",
	];
	if (input.truncation?.flows) {
		caveats.push(
			`Flow scan truncated at ${KNOWLEDGE_MARKET_FLOW_GROUP_CAP} (user, owner) groups — pair and share figures are floors.`,
		);
	}
	if (input.truncation?.factDecisions) {
		caveats.push(
			`Fact-citation scan truncated at ${KNOWLEDGE_MARKET_FACT_DECISION_CAP} decisions — fact-repute counts are floors.`,
		);
	}
	if (input.truncation?.factIds) {
		caveats.push(
			`Cited-fact resolution truncated at ${KNOWLEDGE_MARKET_FACT_ID_CAP} distinct fact ids — fact-repute counts are floors.`,
		);
	}

	return {
		orgId: input.orgId,
		window: {
			days: input.windowDays,
			since: input.since,
			generatedAt: input.generatedAt,
		},
		orgRollup: {
			totalSkillExecutions,
			tediActorExecutions,
			crossUseShare: share(crossExecutions, tediActorExecutions),
			commonsUtilization: share(usedCommonsSkills, totalCommonsSkills),
			commons: {
				totalSkills: totalCommonsSkills,
				usedSkills: usedCommonsSkills,
				deadSkills: Math.max(0, totalCommonsSkills - usedCommonsSkills),
			},
			isolates: tedis.filter((tedi) => tedi.isolate).map((tedi) => tedi.tediId),
			pairFlows,
		},
		tedis,
		caveats,
	};
}

// ============================================================================
// Queries
// ============================================================================

export async function getKnowledgeMarketReport(
	db: DbClient,
	access: { orgId: string },
	options: { windowDays?: number } = {},
): Promise<KnowledgeMarketReport> {
	const windowDays = Math.min(
		Math.max(options.windowDays ?? KNOWLEDGE_MARKET_DEFAULT_WINDOW_DAYS, 1),
		90,
	);
	const since = new Date(
		Date.now() - windowDays * 24 * 60 * 60 * 1000,
	).toISOString();

	const [flows, repute, commonsRows, ownership, factDecisions] =
		await Promise.all([
			db.all<SkillFlowRow>(
				sql`SELECT usage.tedi_id AS userTediId,
						skills.tedi_id AS ownerTediId,
						count(*) AS executions,
						count(DISTINCT usage.skill_id) AS distinctSkills
					FROM skill_usage_events usage
					JOIN skill_entries skills ON skills.id = usage.skill_id
					WHERE usage.organization_id = ${access.orgId}
						AND usage.created_at >= ${since}
					GROUP BY usage.tedi_id, skills.tedi_id
					LIMIT ${KNOWLEDGE_MARKET_FLOW_GROUP_CAP}`,
			),
			db.all<SkillReputeRow>(
				sql`SELECT skills.tedi_id AS ownerTediId,
						count(DISTINCT usage.skill_id) AS skillsUsedByOthers,
						count(*) AS executionsByOthers,
						count(DISTINCT usage.tedi_id) AS distinctConsumers
					FROM skill_usage_events usage
					JOIN skill_entries skills ON skills.id = usage.skill_id
					WHERE usage.organization_id = ${access.orgId}
						AND usage.created_at >= ${since}
						AND usage.tedi_id IS NOT NULL
						AND skills.tedi_id IS NOT NULL
						AND usage.tedi_id != skills.tedi_id
					GROUP BY skills.tedi_id
					LIMIT ${KNOWLEDGE_MARKET_TEDI_GROUP_CAP}`,
			),
			db.all<CommonsInventoryRow>(
				sql`SELECT count(*) AS totalCommonsSkills,
						sum(CASE WHEN EXISTS (
							SELECT 1 FROM skill_usage_events usage
							WHERE usage.skill_id = skills.id
								AND usage.organization_id = ${access.orgId}
								AND usage.created_at >= ${since}
						) THEN 1 ELSE 0 END) AS usedCommonsSkills
					FROM skill_entries skills
					WHERE skills.organization_id = ${access.orgId}
						AND skills.tedi_id IS NULL
						AND skills.app_id IS NULL
						AND coalesce(skills.lifecycle_state, 'draft') <> 'archived'`,
			),
			db.all<SkillOwnershipRow>(
				sql`SELECT skills.tedi_id AS tediId, count(*) AS ownedSkills
					FROM skill_entries skills
					WHERE skills.organization_id = ${access.orgId}
						AND skills.tedi_id IS NOT NULL
						AND coalesce(skills.lifecycle_state, 'draft') <> 'archived'
					GROUP BY skills.tedi_id
					LIMIT ${KNOWLEDGE_MARKET_TEDI_GROUP_CAP}`,
			),
			db.all<{ tediId: string; evidence: unknown }>(
				sql`SELECT tedi_id AS tediId, evidence
					FROM tedi_rationale_records
					WHERE org_id = ${access.orgId}
						AND created_at >= ${since}
						AND ${evidenceReferencesFactsSql()}
					ORDER BY created_at DESC
					LIMIT ${KNOWLEDGE_MARKET_FACT_DECISION_CAP}`,
			),
		]);

	// Resolve cited fact ids to their scope tedi (producer proxy), capped and
	// chunked BELOW D1's 100-bound-parameters-per-query limit (each lookup
	// binds the org id on top of the id list).
	const citedFactIds = new Set<string>();
	for (const decision of factDecisions) {
		for (const factId of safeExtractFactIds(decision.evidence)) {
			citedFactIds.add(factId);
		}
	}
	const factIdsTruncated = citedFactIds.size > KNOWLEDGE_MARKET_FACT_ID_CAP;
	const boundedFactIds = [...citedFactIds].slice(
		0,
		KNOWLEDGE_MARKET_FACT_ID_CAP,
	);
	const factProducers = new Map<string, string | null>();
	for (const factIdChunk of chunkForBoundParams(
		boundedFactIds,
		KNOWLEDGE_MARKET_FACT_ID_CHUNK,
	)) {
		const rows = await db.all<{ id: string; tediId: string | null }>(
			sql`SELECT id, tedi_id AS tediId
				FROM memory_facts
				WHERE organization_id = ${access.orgId}
					AND id IN (${sql.join(
						factIdChunk.map((factId) => sql`${factId}`),
						sql`, `,
					)})`,
		);
		for (const row of rows) {
			if (typeof row.id !== "string") continue;
			factProducers.set(row.id, row.tediId ?? null);
		}
	}

	// sum() over an empty set is NULL in D1 — the builder's toCount() ingestion
	// normalizes both aggregates (and every other raw count) to 0.
	const commons = commonsRows[0] ?? {
		totalCommonsSkills: 0,
		usedCommonsSkills: 0,
	};

	return buildKnowledgeMarketReport({
		orgId: access.orgId,
		windowDays,
		since,
		generatedAt: new Date().toISOString(),
		flows,
		repute,
		commons,
		ownership,
		factCitations: deriveFactCitationLinks(factDecisions, factProducers),
		truncation: {
			flows: flows.length >= KNOWLEDGE_MARKET_FLOW_GROUP_CAP,
			factDecisions: factDecisions.length >= KNOWLEDGE_MARKET_FACT_DECISION_CAP,
			factIds: factIdsTruncated,
		},
	});
}
