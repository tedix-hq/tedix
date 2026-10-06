/**
 * Flywheel Health Router
 * Powers the cognitive flywheel evidence projection — pulse, fact lifecycle,
 * and cron status.
 *
 * REST Endpoints:
 * GET /flywheel/pulse          - Flywheel pulse (latest activity per layer)
 * GET /flywheel/fact-lifecycle  - Fact lifecycle distribution
 * GET /flywheel/crons          - Cron execution status
 */

import { implement } from "@orpc/server";
import { flywheelHealthContract } from "@tedix/api-contract/contracts/flywheel-health";
import { resolveEnabledGovernedLearningCronNames } from "@tedix/api-contract/utils/governed-learning";
import { getPolicyPackById } from "@tedix/db/queries/control-plane/definitions";
import {
	buildCronFlywheelHealth,
	getCronExecutionCounts,
	getGovernedLearningScheduleStates,
	getLatestCronExecutions,
	recordCronExecutionFinish,
	recordCronExecutionStart,
} from "@tedix/db/queries/flywheel/cron-executions";
import {
	buildDecisionEpisodeQuality,
	getDecisionEpisodeProjections,
} from "@tedix/db/queries/flywheel/decision-episodes";
import {
	getFactConfidenceHistogram,
	getFactTierDistribution,
} from "@tedix/db/queries/flywheel/fact-lifecycle";
import { getTaskTypeLearningCurves } from "@tedix/db/queries/flywheel/learning-curves";
import { getLearningReplayValidation } from "@tedix/db/queries/flywheel/learning-replay";
import { getBrainProducerQuality } from "@tedix/db/queries/flywheel/producer-quality";
import { getFlywheelPulse } from "@tedix/db/queries/flywheel/pulse";
import { getKnowledgeMarketReport } from "@tedix/db/queries/knowledge-market";
import { getReferenceClassEstimate } from "@tedix/db/queries/reference-class";
import { getStrategyMapValidation } from "@tedix/db/queries/strategy-map";
import { getTediById, getTedisByOrganization } from "@tedix/db/queries/tedis";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { getOrphanRunHealth } from "./cognitive-runtime/recovery-artifacts";

// =============================================================================
// IMPLEMENTER
// =============================================================================

const flywheelOs = implement(flywheelHealthContract).$context<BaseContext>();
const authOs = flywheelOs.use(withAuth);

// =============================================================================
// HELPERS
// =============================================================================

async function requireTediAccess(
	context: BaseContext,
	tediId: string,
): Promise<{
	tediId: string;
	orgId: string;
	policyPackId: string | null;
	runtimeOverrides: unknown;
}> {
	const orgId = requireOrgId(context);
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}
	if (tedi.organizationId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}
	return {
		tediId: tedi.id,
		orgId: tedi.organizationId,
		policyPackId: tedi.policyPackId,
		runtimeOverrides: tedi.runtimeOverrides,
	};
}

// =============================================================================
// PROCEDURES
// =============================================================================

const pulseProcedure = authOs.pulse
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const access = await requireTediAccess(context, input.tediId);
		const pulse = await getFlywheelPulse(context.db, access);

		return {
			lastRationale: pulse.lastRationale,
			lastFactLearned: pulse.lastFact,
			lastSkillActivity: pulse.lastSkill,
			lastMuscleActivity: pulse.lastMuscle,
			lastToolCall: pulse.lastToolCall
				? {
						toolName: pulse.lastToolCall.toolName,
						success:
							pulse.lastToolCall.success === null
								? null
								: pulse.lastToolCall.success === 1,
						createdAt: pulse.lastToolCall.createdAt,
					}
				: null,
			decisionsLast24h: pulse.decisionsLast24h,
			factsLearnedLast24h: pulse.factsLast24h,
			skillUsagesLast24h: pulse.skillUsagesLast24h,
		};
	});

const factLifecycleProcedure = authOs.factLifecycle
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const db = context.db;

		const tierRows = await getFactTierDistribution(db, orgId, input.tediId);
		const histogramRows = await getFactConfidenceHistogram(
			db,
			orgId,
			input.tediId,
		);

		const tierLabels: Record<string, string> = {
			probation: "Probation (new, unverified)",
			active_low: "Active (low confidence)",
			active_mid: "Active (moderate)",
			active_high: "Active (high confidence)",
			gold: "Gold (high use + high confidence)",
		};

		const tiers = tierRows.map((row) => ({
			tier: row.tier as
				| "probation"
				| "active_low"
				| "active_mid"
				| "active_high"
				| "gold",
			count: row.cnt,
			avgConfidence: Math.round(row.avgConf * 100) / 100,
			label: tierLabels[row.tier] ?? row.tier,
		}));

		const totalFacts = tiers.reduce((sum, t) => sum + t.count, 0);
		const goldCount = tiers.find((t) => t.tier === "gold")?.count ?? 0;
		const probationCount =
			tiers.find((t) => t.tier === "probation")?.count ?? 0;

		return {
			tiers,
			totalFacts,
			goldCount,
			probationCount,
			confidenceHistogram: histogramRows.map((row) => ({
				bucket: row.bucket,
				count: row.cnt,
			})),
		};
	});

const cronsProcedure = authOs.crons
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const access = await requireTediAccess(context, input.tediId);
		const db = context.db;
		const now24hAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		// Reads the durable cron execution ledger (tedi_cron_executions), stamped
		// mechanically by the Agent runtime on every fire — exact-name matching,
		// no rationale-prose inference.
		const [latest, counts, scheduleStates, policyPack] = await Promise.all([
			getLatestCronExecutions(db, access),
			getCronExecutionCounts(db, access, now24hAgo),
			getGovernedLearningScheduleStates(db, access),
			access.policyPackId
				? getPolicyPackById(db, access.policyPackId)
				: Promise.resolve(null),
		]);
		const enabledCronNames = resolveEnabledGovernedLearningCronNames({
			policyPackDefinition: policyPack?.definition,
			runtimeOverrides: access.runtimeOverrides,
			scheduledCronNames: scheduleStates
				.filter(
					(schedule) => schedule.enabled === true || schedule.enabled === 1,
				)
				.map((schedule) => schedule.cronName),
		});

		return {
			crons: buildCronFlywheelHealth(
				latest,
				counts,
				Date.now(),
				scheduleStates,
				enabledCronNames,
			),
		};
	});

const orphanRunHealthProcedure = authOs.getOrphanRunHealth
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) =>
		getOrphanRunHealth(context.db, requireOrgId(context), {
			sampleLimit: input.sampleLimit,
		}),
	);

const recordCronExecutionProcedure = authOs.recordCronExecution
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const access = await requireTediAccess(context, input.tediId);
		if (input.phase === "started") {
			await recordCronExecutionStart(context.db, access, {
				fireKey: input.fireKey,
				cronName: input.cronName,
				runId: input.runId ?? null,
				startedAt: input.startedAt,
			});
		} else {
			await recordCronExecutionFinish(context.db, access, {
				fireKey: input.fireKey,
				cronName: input.cronName,
				runId: input.runId ?? null,
				startedAt: input.startedAt,
				finishedAt: input.finishedAt,
				status: input.status,
				transitions: input.transitions ?? null,
				error: input.error ?? null,
			});
		}
		return { ok: true as const };
	});

const producerQualityProcedure = authOs.producerQuality
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const access = await requireTediAccess(context, input.tediId);
		return getBrainProducerQuality(context.db, access, input.windowDays);
	});

const decisionEpisodesProcedure = authOs.decisionEpisodes
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const access = await requireTediAccess(context, input.tediId);
		const episodes = await getDecisionEpisodeProjections(
			context.db,
			access,
			input.limit,
		);
		return { episodes, quality: buildDecisionEpisodeQuality(episodes) };
	});

const learningValidationProcedure = authOs.learningValidation
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const access = await requireTediAccess(context, input.tediId);
		return getLearningReplayValidation(context.db, access, input.windowDays);
	});

const learningCurvesProcedure = authOs.learningCurves
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const access = await requireTediAccess(context, input.tediId);
		return getTaskTypeLearningCurves(context.db, access, input);
	});

const getReferenceClassEstimateProcedure = authOs.getReferenceClassEstimate
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const access = await requireTediAccess(context, input.tediId);
		return getReferenceClassEstimate(context.db, access, {
			taskType: input.taskType,
			windowDays: input.windowDays,
		});
	});

const validateStrategyMapProcedure = authOs.validateStrategyMap
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const access = await requireTediAccess(context, input.tediId);
		return getStrategyMapValidation(context.db, access, {
			windowDays: input.windowDays,
			maxLagDays: input.maxLagDays,
		});
	});

const getKnowledgeMarketReportProcedure = authOs.getKnowledgeMarketReport
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		return getKnowledgeMarketReport(
			context.db,
			{ orgId },
			{ windowDays: input.windowDays },
		);
	});

export const flywheelHealthContractRouter = flywheelOs.router({
	pulse: pulseProcedure,
	factLifecycle: factLifecycleProcedure,
	crons: cronsProcedure,
	getOrphanRunHealth: orphanRunHealthProcedure,
	recordCronExecution: recordCronExecutionProcedure,
	producerQuality: producerQualityProcedure,
	decisionEpisodes: decisionEpisodesProcedure,
	learningValidation: learningValidationProcedure,
	learningCurves: learningCurvesProcedure,
	getReferenceClassEstimate: getReferenceClassEstimateProcedure,
	validateStrategyMap: validateStrategyMapProcedure,
	getKnowledgeMarketReport: getKnowledgeMarketReportProcedure,
});
