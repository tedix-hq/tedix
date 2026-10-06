/**
 * Skill portfolio pace-layer balance (flywheel remodel WS6).
 *
 * Distribution of non-archived skills across the three pace layers vs the
 * ~75/20/5 healthy envelope (Gartner pace layering: systems of record carry
 * most of the portfolio, differentiation ~20%, innovation ~5%). Doubles as
 * the stagnation detector VISION.md's self-evolution guardrails call for:
 * an all-innovation portfolio is churn without compounding; an all-record
 * portfolio is rigidity without learning.
 *
 * The effective layer is the required stored `pace_layer` column.
 */

import { and, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	SKILL_PACE_LAYERS,
	type SkillPaceLayer,
	skillEntries,
} from "../schema/cognitive";

/** Healthy pace-layer share envelope (record/differentiation/innovation). */
export const SKILL_PORTFOLIO_HEALTHY_ENVELOPE: Record<SkillPaceLayer, number> =
	{
		record: 0.75,
		differentiation: 0.2,
		innovation: 0.05,
	};

export type SkillPortfolioStagnationKind = "all_innovation" | "all_record";

export interface SkillPortfolioLayerStat {
	count: number;
	/** Share of the non-archived portfolio (0 when the portfolio is empty). */
	share: number;
	healthyShare: number;
	/** share − healthyShare; positive = over-weighted vs the envelope. */
	deviation: number;
}

export interface SkillPortfolioBalance {
	/** Non-archived skills in scope. */
	totalSkills: number;
	layers: Record<SkillPaceLayer, SkillPortfolioLayerStat>;
	healthyEnvelope: Record<SkillPaceLayer, number>;
	/** True when every skill sits in one extreme layer (and the portfolio is non-empty). */
	stagnation: boolean;
	stagnationKind: SkillPortfolioStagnationKind | null;
}

export interface GetSkillPortfolioBalanceOptions {
	/** Restrict to one tedi's skills. Omit for the org-wide portfolio (org-scoped skills have tediId NULL and would be silently missed by a tedi filter). */
	tediId?: string;
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

const layerExpr = skillEntries.paceLayer;

/**
 * Portfolio population predicate: the org's own non-archived operating
 * skills. App-scoped rows are product surfaces, not the org's routine
 * portfolio (same population rule as knowledge-market commons — fixes the
 * 51-vs-6 envelope audit item).
 */
function portfolioConditions(organizationId: string) {
	return [
		sql`${skillEntries.organizationId} = ${organizationId}`,
		sql`coalesce(${skillEntries.lifecycleState}, 'draft') <> 'archived'`,
		sql`${skillEntries.appId} IS NULL`,
	];
}

function emptyLayerCounts(): Record<SkillPaceLayer, number> {
	return { innovation: 0, differentiation: 0, record: 0 };
}

function balanceFromCounts(
	counts: Record<SkillPaceLayer, number>,
): SkillPortfolioBalance {
	const totalSkills =
		counts.innovation + counts.differentiation + counts.record;
	const layers = Object.fromEntries(
		SKILL_PACE_LAYERS.map((layer) => {
			const share = totalSkills > 0 ? counts[layer] / totalSkills : 0;
			const healthyShare = SKILL_PORTFOLIO_HEALTHY_ENVELOPE[layer];
			return [
				layer,
				{
					count: counts[layer],
					share: round(share),
					healthyShare,
					deviation: round(share - healthyShare),
				},
			];
		}),
	) as Record<SkillPaceLayer, SkillPortfolioLayerStat>;

	const stagnationKind: SkillPortfolioStagnationKind | null =
		totalSkills > 0 && counts.innovation === totalSkills
			? "all_innovation"
			: totalSkills > 0 && counts.record === totalSkills
				? "all_record"
				: null;

	return {
		totalSkills,
		layers,
		healthyEnvelope: { ...SKILL_PORTFOLIO_HEALTHY_ENVELOPE },
		stagnation: stagnationKind !== null,
		stagnationKind,
	};
}

export async function getSkillPortfolioBalance(
	db: DbClient,
	organizationId: string,
	options: GetSkillPortfolioBalanceOptions = {},
): Promise<SkillPortfolioBalance> {
	const conditions = portfolioConditions(organizationId);
	if (options.tediId) {
		conditions.push(sql`${skillEntries.tediId} = ${options.tediId}`);
	}
	const rows = await db
		.select({ layer: layerExpr, count: sql<number>`count(*)` })
		.from(skillEntries)
		.where(and(...conditions))
		.groupBy(layerExpr);

	const counts = emptyLayerCounts();
	for (const row of rows) {
		if ((SKILL_PACE_LAYERS as readonly string[]).includes(row.layer)) {
			counts[row.layer as SkillPaceLayer] = Number(row.count);
		}
	}
	return balanceFromCounts(counts);
}

/**
 * Every tedi's portfolio balance in ONE query (GROUP BY tedi_id + layer)
 * instead of a per-tedi fan-out — the governance overview reads up to
 * MAX_TEDIS of these at once. Same population predicate as
 * `getSkillPortfolioBalance`; org-scoped rows (tediId NULL) belong to no
 * tedi's portfolio and are excluded. Tedis with zero portfolio skills have
 * no map entry — callers fall back to zero counts.
 */
export async function getSkillPortfolioBalanceByTedi(
	db: DbClient,
	organizationId: string,
): Promise<Map<string, SkillPortfolioBalance>> {
	const rows = await db
		.select({
			tediId: skillEntries.tediId,
			layer: layerExpr,
			count: sql<number>`count(*)`,
		})
		.from(skillEntries)
		.where(
			and(
				...portfolioConditions(organizationId),
				sql`${skillEntries.tediId} IS NOT NULL`,
			),
		)
		.groupBy(skillEntries.tediId, layerExpr);

	const countsByTedi = new Map<string, Record<SkillPaceLayer, number>>();
	for (const row of rows) {
		if (!row.tediId) continue;
		if (!(SKILL_PACE_LAYERS as readonly string[]).includes(row.layer)) continue;
		const counts = countsByTedi.get(row.tediId) ?? emptyLayerCounts();
		counts[row.layer as SkillPaceLayer] = Number(row.count);
		countsByTedi.set(row.tediId, counts);
	}
	return new Map(
		[...countsByTedi].map(([tediId, counts]) => [
			tediId,
			balanceFromCounts(counts),
		]),
	);
}
