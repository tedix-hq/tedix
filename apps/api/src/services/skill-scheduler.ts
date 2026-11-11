import { isGovernedLearningSkillSlug } from "@tedix/api-contract/utils/governed-learning";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/skill-schedule";
import {
	OsDerivedAccessEnvelopeSchema,
	type OsDerivedAccessEnvelope,
} from "@tedix/api-contract/schemas/os-workspaces";
import { createDbClient } from "@tedix/db/client";
import { listActiveSkillPersonalResourceDelegations } from "@tedix/db/queries/personal-resource-delegations";
import type { PersonalResourceDelegationRow } from "@tedix/db/schema/personal-resource-delegations";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import {
	listDueSkillSchedules,
	listSchedulesWithFailedLastRun,
	pauseSkillSchedule,
	recordSkillScheduleDispatch,
	recordSkillScheduleError,
	recordSkillScheduleRetry,
	recordSkillScheduleSuppressed,
} from "@tedix/db/queries/skill-schedules";
import { isPlatformSkillFailure } from "@tedix/db/queries/skill-lifecycle";
import type { SkillSchedule } from "@tedix/db/schema/cognitive";
import { getTediById } from "@tedix/db/queries/tedis";
import { recordTediSubmissionStarted } from "../kernel/runtime-submission-bridge";
import { tediHost } from "../lib/platform-hosts";
import { personalDelegationSource } from "./personal-resource-delegation-authority";

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
					`https://${tediHost(env, slug)}/__admin/budget-status?admissionClass=${admissionClass}`,
					{
						method: "GET",
						headers: {
							"X-Tedix-Host": tediHost(env, slug),
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

/** Scheduled runs carry the owner's active consents exactly as a manual run admits them. */
export function scheduledPersonalResourceEnvelope(
	rows: PersonalResourceDelegationRow[],
): OsDerivedAccessEnvelope | undefined {
	if (!rows.length) return undefined;
	// Rows are newest first; keep one grant per resource so a re-granted
	// resource is not admitted twice.
	const seen = new Set<string>();
	return OsDerivedAccessEnvelopeSchema.parse({
		version: 1,
		sources: rows
			.filter((row) => !seen.has(row.resourceId) && seen.add(row.resourceId))
			.map(personalDelegationSource),
	});
}

/**
 * Minutes after the scheduled fire at which a run that failed on a platform
 * outage is dispatched again. Database outages on 9–11 Nov 2026 lasted up to
 * an hour, so the gaps double: 10, 20, 40 and 80 minutes.
 */
export const OUTAGE_RETRY_OFFSETS_MINUTES = [10, 30, 70, 150] as const;
const OUTAGE_RETRY_WINDOW_MS = 3 * 60 * 60 * 1000;

function parseRunTime(value: string | null): number | null {
	if (!value) return null;
	const ms = Date.parse(
		/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`,
	);
	return Number.isFinite(ms) ? ms : null;
}

/** When to try a failed scheduled run again, or null when it should stay failed. */
export function nextOutageRetry(input: {
	scheduledFireAt: string;
	failedRunStartedAt: string | null;
	error: string | null;
	now: number;
}): { offsetMinutes: number; dueAt: number } | null {
	if (!isPlatformSkillFailure(input.error)) return null;
	const fireAt = Date.parse(input.scheduledFireAt);
	if (!Number.isFinite(fireAt)) return null;
	const startedAt = parseRunTime(input.failedRunStartedAt) ?? fireAt;
	const elapsedMinutes = (startedAt - fireAt) / 60_000;
	const offsetMinutes = OUTAGE_RETRY_OFFSETS_MINUTES.find(
		(offset) => offset > elapsedMinutes + 1,
	);
	if (offsetMinutes === undefined) return null;
	return { offsetMinutes, dueAt: fireAt + offsetMinutes * 60_000 };
}

type ScheduleAdmission =
	| { status: "dispatched" | "deduplicated"; runId: string }
	| {
			status: "suppressed";
			error: string;
			budget?: SkillScheduleScanResult["runs"][number]["budget"];
	  };

/** Check the skill, its budget and its manifest, then hand the run to the skill runtime. */
async function admitScheduledRun(
	env: CloudflareEnv & { SKILL_RUNTIME: Fetcher },
	db: ReturnType<typeof createDbClient>,
	schedule: SkillSchedule,
	input: {
		observedAt: string;
		scheduledTime: number;
		idempotencyKey: string;
		retryOf?: string;
		budgetProbe: Awaited<ReturnType<typeof makeTediBudgetProbe>>;
	},
): Promise<ScheduleAdmission> {
	const skill = await getSkillEntry(
		db,
		schedule.skillId,
		schedule.organizationId,
	);
	if (!skill || skill.tediId !== schedule.tediId) {
		throw new Error("scheduled skill or owning tedi no longer matches");
	}
	if (
		skill.tags?.includes("workflow-improvement") ||
		!["active", "proven", "crystallized"].includes(skill.lifecycleState ?? "")
	) {
		await pauseSkillSchedule(db, skill.id, schedule.organizationId);
		return {
			status: "suppressed",
			error: "Skill is inactive or an improvement proposal; schedule paused",
		};
	}
	const budgetClass = scheduledBudgetClassForSkillSlug(skill.slug);
	// Budget-aware suppression: if the owning tedi's background inference
	// lane is exhausted for the day, skip the dispatch (it would only be
	// rejected at admission) and advance to the next occurrence, which
	// re-probes once the UTC window resets. Fail-open inside the probe.
	const budget = await input.budgetProbe(schedule.tediId, budgetClass);
	if (budget.exhausted) {
		const fireDay = new Date(input.scheduledTime);
		const resetAt =
			budget.resetAt ??
			new Date(
				Date.UTC(
					fireDay.getUTCFullYear(),
					fireDay.getUTCMonth(),
					fireDay.getUTCDate() + 1,
				),
			).toISOString();
		const reason =
			budget.reason ?? `${budgetClass} inference budget exhausted for the day`;
		// A retry leaves the schedule where the original fire put it.
		if (!input.retryOf) {
			await recordSkillScheduleSuppressed(db, {
				scheduleId: schedule.id,
				scheduledFireAt: schedule.nextFireAt,
				nextFireAt: nextSkillScheduleFireAt(schedule.cron, schedule.nextFireAt),
				reason,
				resetAt,
				admissionClass: budgetClass,
			});
		}
		return {
			status: "suppressed",
			error: reason,
			budget: { admissionClass: budgetClass, reason, resetAt },
		};
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
	// Owner consent covers this worker skill until revoked or expired; the
	// credential path re-validates every use, so the scheduler only carries it forward.
	const resourceAccessEnvelope = scheduledPersonalResourceEnvelope(
		skill.revision
			? await listActiveSkillPersonalResourceDelegations(db, {
					organizationId: schedule.organizationId,
					tediId: schedule.tediId,
					skillId: skill.id,
					now: input.observedAt,
				})
			: [],
	);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Service-Binding": "true",
	};
	if (env.PLATFORM_SERVICE_TOKEN) {
		headers.Authorization = `Bearer ${env.PLATFORM_SERVICE_TOKEN}`;
	}
	const response = await env.SKILL_RUNTIME.fetch("https://skill-runtime/run", {
		method: "POST",
		headers,
		body: JSON.stringify({
			idempotencyKey: input.idempotencyKey,
			skillId: skill.id,
			skillSlug: skill.slug,
			skillRevision: skill.revision ?? null,
			orgId: schedule.organizationId,
			tediId: schedule.tediId,
			params: schedule.params,
			workflowSource,
			skillDoc,
			capabilityManifest: manifest,
			...(resourceAccessEnvelope ? { resourceAccessEnvelope } : {}),
			createdBy: "schedule",
		}),
	});
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
	if (input.retryOf) {
		await recordSkillScheduleRetry(db, {
			scheduleId: schedule.id,
			failedRunId: input.retryOf,
			runId: dispatched.runId,
		});
	} else {
		await recordSkillScheduleDispatch(db, {
			scheduleId: schedule.id,
			scheduledFireAt: schedule.nextFireAt,
			nextFireAt: nextSkillScheduleFireAt(schedule.cron, schedule.nextFireAt),
			runId: dispatched.runId,
		});
	}
	return {
		status: dispatched.deduplicated ? "deduplicated" : "dispatched",
		runId: dispatched.runId,
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
	const runtime = env.SKILL_RUNTIME;
	if (!runtime) {
		throw new Error("SKILL_RUNTIME service binding is unavailable");
	}
	const runtimeEnv = { ...env, SKILL_RUNTIME: runtime };
	const budgetProbe = await makeTediBudgetProbe(env, db);

	const attempts: Array<{
		schedule: SkillSchedule;
		idempotencyKey: string;
		retryOf?: string;
	}> = due.map((schedule) => ({
		schedule,
		idempotencyKey: scheduledSkillWorkflowIdempotencyKey(
			schedule.skillId,
			schedule.nextFireAt,
		),
	}));
	// A scheduled run that failed because the platform was down is tried again
	// from the same fire, so a short outage does not cost the whole day.
	const failedRuns = await listSchedulesWithFailedLastRun(
		db,
		new Date(scheduledTime - OUTAGE_RETRY_WINDOW_MS).toISOString(),
	);
	for (const failed of failedRuns) {
		const fireAt = failed.schedule.lastFireAt;
		const failedRunId = failed.schedule.lastRunId;
		if (!fireAt || !failedRunId) continue;
		const retry = nextOutageRetry({
			scheduledFireAt: fireAt,
			failedRunStartedAt: failed.runStartedAt,
			error: failed.runError,
			now: scheduledTime,
		});
		if (!retry || retry.dueAt > scheduledTime) continue;
		result.due++;
		attempts.push({
			schedule: failed.schedule,
			idempotencyKey: `${scheduledSkillWorkflowIdempotencyKey(failed.schedule.skillId, fireAt)}:outage-retry-${retry.offsetMinutes}`,
			retryOf: failedRunId,
		});
	}

	for (const attempt of attempts) {
		const { schedule } = attempt;
		try {
			const admitted = await admitScheduledRun(runtimeEnv, db, schedule, {
				observedAt,
				scheduledTime,
				idempotencyKey: attempt.idempotencyKey,
				retryOf: attempt.retryOf,
				budgetProbe,
			});
			if (admitted.status === "suppressed") {
				result.suppressed++;
				result.runs.push({
					scheduleId: schedule.id,
					skillId: schedule.skillId,
					status: "suppressed",
					error: admitted.error,
					...(admitted.budget ? { budget: admitted.budget } : {}),
				});
				continue;
			}
			if (admitted.status === "deduplicated") result.deduplicated++;
			else result.dispatched++;
			result.runs.push({
				scheduleId: schedule.id,
				skillId: schedule.skillId,
				runId: admitted.runId,
				status: admitted.status,
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
