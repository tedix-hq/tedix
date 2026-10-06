import { resolveEnabledGovernedLearningCronNames } from "@tedix/api-contract/utils/governed-learning";
import { listMuscleMemory } from "@tedix/db/queries/cognitive/muscle-memory";
import { getPolicyPackById } from "@tedix/db/queries/control-plane/definitions";
import { getDelegationProfile } from "@tedix/db/queries/earned-delegation/entrustments";
import {
	buildCronFlywheelHealth,
	getCronExecutionCounts,
	getGovernedLearningScheduleStates,
	getLatestCronExecutions,
} from "@tedix/db/queries/flywheel/cron-executions";
import { getFlywheelPulse } from "@tedix/db/queries/flywheel/pulse";
import { getLatestGrowthSnapshot } from "@tedix/db/queries/growth-snapshots";
import { listOptimizationSignals } from "@tedix/db/queries/memory-graph/optimization-signals";
import { listRationaleRecords } from "@tedix/db/queries/rationale-records";
import {
	getActiveTasks,
	listObjectives,
} from "@tedix/db/queries/tedi-objectives";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	requireOrganizationId,
} from "./helpers";

export const listOperationsSummariesProcedure =
	authedTedisOs.listOperationsSummaries
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			const orgId = requireOrganizationId(context);
			const visibleTedis = (
				await getTedisByOrganization(context.db, orgId)
			).filter(
				(tedi) =>
					tedi.runtimeState !== "archived" &&
					!["error", "paused", "provisioning"].includes(tedi.status ?? ""),
			);
			const requestedIds = new Set(input?.tediIds ?? []);

			if (requestedIds.size > 0) {
				const visibleIds = new Set(visibleTedis.map((tedi) => tedi.id));
				for (const tediId of requestedIds) {
					if (!visibleIds.has(tediId)) {
						throw createError(
							ErrorCodes.FORBIDDEN,
							"Access denied to this tedi",
						);
					}
				}
			}

			const selectedTedis =
				requestedIds.size > 0
					? visibleTedis.filter((tedi) => requestedIds.has(tedi.id))
					: visibleTedis;
			const policyPackIds = [
				...new Set(
					selectedTedis
						.map((tedi) => tedi.policyPackId)
						.filter((id): id is string => Boolean(id)),
				),
			];
			const policyPacks = new Map(
				(
					await Promise.all(
						policyPackIds.map(
							async (id) =>
								[id, await getPolicyPackById(context.db, id)] as const,
						),
					)
				).map(([id, pack]) => [id, pack?.definition ?? null]),
			);

			const now24hAgo = new Date(
				Date.now() - 24 * 60 * 60 * 1000,
			).toISOString();

			const data = await Promise.all(
				selectedTedis.map(async (tedi) => {
					const access = { tediId: tedi.id, orgId };
					const [
						delegationProfile,
						pulse,
						activeTasks,
						activeObjectives,
						completedObjectives,
						growthSnapshot,
						cronExecutions,
						cronExecutionCounts,
						governedScheduleStates,
						rationales,
						muscles,
						optimizationSignals,
					] = await Promise.all([
						getDelegationProfile(context.db, {
							organizationId: orgId,
							tediId: tedi.id,
							now: new Date().toISOString(),
						}),
						getFlywheelPulse(context.db, access),
						getActiveTasks(context.db, tedi.id),
						listObjectives(context.db, {
							orgId,
							tediId: tedi.id,
							status: "active",
							limit: 50,
						}),
						listObjectives(context.db, {
							orgId,
							tediId: tedi.id,
							status: "completed",
							limit: 1,
						}),
						getLatestGrowthSnapshot(context.db, tedi.id),
						getLatestCronExecutions(context.db, access),
						getCronExecutionCounts(context.db, access, now24hAgo),
						getGovernedLearningScheduleStates(context.db, access),
						listRationaleRecords(context.db, {
							orgId,
							tediId: tedi.id,
							limit: 5,
						}),
						listMuscleMemory(context.db, orgId, tedi.id),
						listOptimizationSignals(context.db, orgId, {
							tediId: tedi.id,
							limit: 5,
						}),
					]);

					const enabledCronNames = resolveEnabledGovernedLearningCronNames({
						policyPackDefinition: tedi.policyPackId
							? policyPacks.get(tedi.policyPackId)
							: undefined,
						runtimeOverrides: tedi.runtimeOverrides,
						scheduledCronNames: governedScheduleStates
							.filter(
								(schedule) =>
									schedule.enabled === true || schedule.enabled === 1,
							)
							.map((schedule) => schedule.cronName),
					});

					return {
						tediId: tedi.id,
						delegationProfile,
						pulse: {
							lastRationale: pulse.lastRationale,
							lastFactLearned: pulse.lastFact,
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
						},
						activeTasks: activeTasks.map((task) => ({
							id: task.id,
							title: task.title,
							status: task.status,
							blocker: task.blocker,
						})),
						objectives: activeObjectives.data.map((objective) => ({
							id: objective.id,
							status: objective.status,
							gateConfig: objective.gateConfig,
						})),
						growthMetrics: growthSnapshot?.metrics ?? null,
						crons: buildCronFlywheelHealth(
							cronExecutions,
							cronExecutionCounts,
							Date.now(),
							governedScheduleStates,
							enabledCronNames,
						),
						recentRationales: rationales.data.map((rationale) => ({
							id: rationale.id,
							action: rationale.action,
							category: rationale.category,
							outcomeStatus: rationale.outcomeStatus,
							createdAt: rationale.createdAt,
						})),
						muscleCount: muscles.length,
						completedObjectives: completedObjectives.total,
						approvalFatigueSignal: (() => {
							const signal = optimizationSignals.find(
								(item) => item.type === "approval_fatigue",
							);
							return signal
								? {
										type: signal.type,
										evidence: signal.evidence,
									}
								: null;
						})(),
					};
				}),
			);

			return { data };
		});
