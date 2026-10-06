import { isGovernedLearningSkillSlug } from "@tedix/api-contract/utils/governed-learning";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/skill-schedule";
import { createDbClient } from "@tedix/db/client";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import {
	listDueSkillSchedules,
	recordSkillScheduleDispatch,
	recordSkillScheduleError,
	recordSkillScheduleSuppressed,
} from "@tedix/db/queries/skill-schedules";
import { getTediById } from "@tedix/db/queries/tedis";
import { recordTediSubmissionStarted } from "../kernel/runtime-submission-bridge";

export function scheduledSkillWorkflowIdempotencyKey(
	skillId: string,
	scheduledFireAt: string,
): string {
	return `skill-schedule:${skillId}:${scheduledFireAt}`;
}

type ScheduledRuntimeResponse = {
	runId: string;
	workflowInstanceId: string;
	status?: string;
	deduplicated?: boolean;
};

export type SkillScheduleScanResult = {
	observedAt: string;
	due: number;
	dispatched: number;
	deduplicated: number;
	failed: number;
	suppressed: number;
	runs: Array<{
		scheduleId: string;
		skillId: string;
		runId?: string;
		status: "dispatched" | "deduplicated" | "failed" | "suppressed";
		error?: string;
		budget?: {
			admissionClass: ScheduledBudgetClass;
			reason: string;
			resetAt: string;
		};
	}>;
};

/** How the tedi runtime reports its background inference lane on a probe. */
type TediBudgetStatus = {
	admissionClass?: "background" | "governed_learning";
	exhausted?: boolean;
	backgroundExhausted?: boolean;
	reason?: string | null;
	resetAt?: string;
	resetAtMs?: number;
};

type ScheduledBudgetClass = "background" | "governed_learning";

export type TediBudgetProbeResult = {
	admissionClass: ScheduledBudgetClass;
	exhausted: boolean;
	reason: string | null;
	resetAt: string | null;
};

export function scheduledBudgetClassForSkillSlug(
	slug: string | null | undefined,
): ScheduledBudgetClass {
	return isGovernedLearningSkillSlug(slug) ? "governed_learning" : "background";
}

/**
 * Probe a tedi's background inference budget so the scheduler can suppress a
 * scheduled cognitive skill that would only be rejected at provider admission.
 * Reads the read-only `/__admin/budget-status` route on the tedi runtime through
 * the `TEDI_SERVICE` binding (same service-binding trust shape the alwaysOn wake
 * uses). Memoized per distinct tedi for the scan, and FAIL-OPEN: any missing
 * slug/binding, non-2xx, or thrown error returns `false` (not exhausted) so a
 * probe hiccup can never silently starve legitimate scheduled work.
 */
export async function makeTediBudgetProbe(
	env: CloudflareEnv,
	db: ReturnType<typeof createDbClient>,
): Promise<
	(
		tediId: string,
		admissionClass?: ScheduledBudgetClass,
	) => Promise<TediBudgetProbeResult>
> {
	const cache = new Map<string, TediBudgetProbeResult>();
	return async (
		tediId: string,
		admissionClass: ScheduledBudgetClass = "background",
	): Promise<TediBudgetProbeResult> => {
		const cacheKey = `${tediId}:${admissionClass}`;
		const cached = cache.get(cacheKey);
		if (cached !== undefined) return cached;
		let result: TediBudgetProbeResult = {
			admissionClass,
			exhausted: false,
			reason: null,
			resetAt: null,
		};
		try {
			const tedi = await getTediById(db, tediId);
			const slug = tedi?.slug;
			if (slug && env.TEDI_SERVICE) {
				const res = await env.TEDI_SERVICE.fetch(
					`https://${slug}.tedi.tedix.dev/__admin/budget-status?admissionClass=${admissionClass}`,
					{
						method: "GET",
						headers: {
							"X-Tedix-Host": `${slug}.tedi.tedix.dev`,
							"X-Service-Binding": "true",
						},
					},
				);
				if (res.ok) {
					const body = (await res.json()) as TediBudgetStatus;
					const exhausted =
						body.admissionClass === admissionClass
							? body.exhausted === true
							: admissionClass === "background" &&
								body.backgroundExhausted === true;
					const resetAt =
						typeof body.resetAt === "string"
							? body.resetAt
							: typeof body.resetAtMs === "number"
								? new Date(body.resetAtMs).toISOString()
								: null;
					result = {
						admissionClass,
						exhausted,
						reason:
							exhausted && typeof body.reason === "string"
								? body.reason
								: exhausted
									? `${admissionClass} inference budget exhausted`
									: null,
						resetAt,
					};
				}
			}
		} catch {
			// Fail-open: a probe failure must never block scheduled dispatch.
			result = {
				admissionClass,
				exhausted: false,
				reason: null,
				resetAt: null,
			};
		}
		cache.set(cacheKey, result);
		return result;
	};
}

export async function dispatchDueSkillSchedules(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<SkillScheduleScanResult> {
	const db = createDbClient(env.DB);
	const observedAt = new Date(scheduledTime).toISOString();
	const due = await listDueSkillSchedules(db, observedAt, 50);
	const result: SkillScheduleScanResult = {
		observedAt,
		due: due.length,
		dispatched: 0,
		deduplicated: 0,
		failed: 0,
		suppressed: 0,
		runs: [],
	};
	if (!env.SKILL_RUNTIME) {
		throw new Error("SKILL_RUNTIME service binding is unavailable");
	}
	const isTediBudgetExhausted = await makeTediBudgetProbe(env, db);

	for (const schedule of due) {
		try {
			const skill = await getSkillEntry(
				db,
				schedule.skillId,
				schedule.organizationId,
			);
			if (!skill || skill.tediId !== schedule.tediId) {
				throw new Error("scheduled skill or owning tedi no longer matches");
			}
			const budgetClass = scheduledBudgetClassForSkillSlug(skill.slug);
			// Budget-aware suppression: if the owning tedi's background inference
			// lane is exhausted for the day, skip the dispatch (it would only be
			// rejected at admission) and advance to the next occurrence, which
			// re-probes once the UTC window resets. Fail-open inside the probe.
			const budget = await isTediBudgetExhausted(schedule.tediId, budgetClass);
			if (budget.exhausted) {
				const resetAt =
					budget.resetAt ??
					new Date(
						Date.UTC(
							new Date(scheduledTime).getUTCFullYear(),
							new Date(scheduledTime).getUTCMonth(),
							new Date(scheduledTime).getUTCDate() + 1,
						),
					).toISOString();
				const reason =
					budget.reason ??
					`${budgetClass} inference budget exhausted for the day`;
				await recordSkillScheduleSuppressed(db, {
					scheduleId: schedule.id,
					scheduledFireAt: schedule.nextFireAt,
					nextFireAt: nextSkillScheduleFireAt(
						schedule.cron,
						schedule.nextFireAt,
					),
					reason,
					resetAt,
					admissionClass: budgetClass,
				});
				result.suppressed++;
				result.runs.push({
					scheduleId: schedule.id,
					skillId: schedule.skillId,
					status: "suppressed",
					error: reason,
					budget: {
						admissionClass: budgetClass,
						reason,
						resetAt,
					},
				});
				continue;
			}
			const files = skill.files as Record<string, string> | null;
			const workflowSource = files?.["scripts/workflow.ts"];
			if (!workflowSource) {
				throw new Error("SKILL_NOT_EXECUTABLE: missing scripts/workflow.ts");
			}
			const skillDoc = skill.content ?? "";
			const manifest = parseCapabilityManifest(skillDoc);
			if (
				!manifest.schedule ||
				manifest.schedule.cron !== schedule.cron ||
				manifest.schedule.enabled !== schedule.enabled
			) {
				throw new Error("skill schedule projection drifted from its manifest");
			}
			const idempotencyKey = scheduledSkillWorkflowIdempotencyKey(
				skill.id,
				schedule.nextFireAt,
			);
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"X-Service-Binding": "true",
			};
			if (env.PLATFORM_SERVICE_TOKEN) {
				headers.Authorization = `Bearer ${env.PLATFORM_SERVICE_TOKEN}`;
			}
			const response = await env.SKILL_RUNTIME.fetch(
				"https://skill-runtime/run",
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						idempotencyKey,
						skillId: skill.id,
						skillSlug: skill.slug,
						skillRevision: skill.revision ?? null,
						orgId: schedule.organizationId,
						tediId: schedule.tediId,
						params: schedule.params,
						workflowSource,
						skillDoc,
						capabilityManifest: manifest,
						createdBy: "schedule",
					}),
				},
			);
			if (!response.ok) {
				throw new Error(
					`skill runtime admission failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
				);
			}
			const dispatched = (await response.json()) as ScheduledRuntimeResponse;
			await recordTediSubmissionStarted(db, {
				tediId: schedule.tediId,
				runId: dispatched.runId,
				organizationId: schedule.organizationId,
				sourceKind: "skill_workflow",
			});
			await recordSkillScheduleDispatch(db, {
				scheduleId: schedule.id,
				scheduledFireAt: schedule.nextFireAt,
				nextFireAt: nextSkillScheduleFireAt(schedule.cron, schedule.nextFireAt),
				runId: dispatched.runId,
			});
			if (dispatched.deduplicated) result.deduplicated++;
			else result.dispatched++;
			result.runs.push({
				scheduleId: schedule.id,
				skillId: schedule.skillId,
				runId: dispatched.runId,
				status: dispatched.deduplicated ? "deduplicated" : "dispatched",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.failed++;
			result.runs.push({
				scheduleId: schedule.id,
				skillId: schedule.skillId,
				status: "failed",
				error: message,
			});
			await recordSkillScheduleError(db, schedule.id, message).catch(
				() => undefined,
			);
		}
	}
	return result;
}
