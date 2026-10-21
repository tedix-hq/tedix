import type { ChatTurnParams } from "./chat-turn-input";
import { buildCronGovernanceAnalyticsDataPoint } from "@tedix/api-contract/schemas/mcp-analytics";
import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import type { HttpPlatformClient } from "./brain/platform-client";
import {
	getTediRuntimeCanonicalIsolateId,
	getTediRuntimePolicy,
} from "@tedix/db/queries/tedi-runtime-bootstrap";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import { ConversationFacet } from "./conversation-facet";
import {
	applyCronReconcileActions,
	applyTediCronPolicyOverrides,
	buildCronExecutionStart,
	buildCronPreDispatchFailure,
	buildCronStabilityTimeoutFailure,
	type CronFirePayload,
	type CronTemplateLike,
	cronScheduleCeilingError,
	cronSchedulesSupersededByName,
	conversationalScheduleCreationReceipt,
	isCronFireExpired,
	isOrphanedIsolateDo,
	planCronReconcile,
	protectedCronNameError,
	resolveCronExpiry,
	resolveCronSessionKey,
	type ScheduleLike,
	scheduleToCronJob,
	shouldRunTrajectoryMining,
	withCognitiveCronDefaults,
	writeConversationalSchedule,
} from "./cron";
import {
	type CronBudgetSuppression,
	type CronBudgetSuppressionSnapshot,
	cronBudgetSuppressionSnapshot,
} from "./cron-budget-control";
import {
	formatScheduledTaskPrompt,
	type ScheduledTaskRecurrence,
} from "./scheduled-task-prompt";
import { type FacetWorkflowTurnInput } from "./delegated-work-lease";
import { buildRunId, buildWorkflowInstanceId } from "./ledger-mirror";
import type { CronToolInput } from "./mcp-mount";
import { type WorkflowDispatchContext } from "./workflow-start-watchdog";
import type { AgentTediDO } from "./do";
import type { State } from "./runtime-state";

export type CronFireOutcome =
	| {
			status: "dispatched";
			fireKey: string;
			runId: string;
			workflowId: string;
	  }
	| {
			status: "suppressed";
			fireKey: string;
			reason: string;
			resumesAt: string;
			budget: CronBudgetSuppressionSnapshot;
	  }
	| {
			status: "skipped";
			reason:
				| "empty_message"
				| "expired"
				| "orphaned_runtime"
				| "conversation_unstable";
	  };

export type PolicyCronReconcileReceipt = {
	ok: boolean;
	forceUpdate: boolean;
	templateCount: number;
	existingCount: number;
	plannedCount: number;
	appliedCount: number;
	actions: Array<{ op: "add" | "update" | "remove"; name: string }>;
	errors: string[];
};

export interface RuntimeCronHost {
	cronReconcileDone: boolean;
	state: State;
	reconcilePolicyPackCrons: (options?: {
		forceUpdate?: boolean;
	}) => Promise<PolicyCronReconcileReceipt>;
	env: Cloudflare.Env;
	cronReconcileQueue: Promise<void>;
	reconcilePolicyPackCronsNow: (options?: {
		forceUpdate?: boolean;
	}) => Promise<PolicyCronReconcileReceipt>;
	loadPolicyPackCronTemplates: (
		tediId: string,
	) => Promise<
		| { ok: true; templates: CronTemplateLike[] }
		| { ok: false; templates: CronTemplateLike[]; error: string }
	>;
	listSchedules: AgentTediDO["listSchedules"];
	cancelSchedule: AgentTediDO["cancelSchedule"];
	schedule: AgentTediDO["schedule"];
	cronProtectionError: (
		name: string | null | undefined,
		action: "remove" | "replace",
	) => Promise<string | null>;
	scheduleEvery: AgentTediDO["scheduleEvery"];
	getScheduleById: AgentTediDO["getScheduleById"];
	onCronFire: (
		payload: CronFirePayload,
		row?: { id?: string; time?: number },
	) => Promise<CronFireOutcome>;
	name: string;
	ctx: DurableObjectState<{}>;
	durableObjectReference: () => string;
	isOrphanedIsolateForCron: () => Promise<boolean>;
	confirmLegacyOrphanScheduleRemoval: (
		scheduleIds: string[],
	) => Promise<string[]>;
	cleanupOrphanSchedules: (input?: { expectedSlugs?: string[] }) => Promise<{
		doName: string;
		tediId: string;
		slug: string;
		orphaned: boolean;
		skippedReason?: "identity_missing" | "slug_mismatch";
		cancelledScheduleIds: string[];
		failedScheduleIds: string[];
		remainingScheduleIds: string[];
	}>;
	ensureIdentity: (hints?: {
		slug?: string;
		tediId?: string;
		orgId?: string;
		authSubject?: string;
	}) => Promise<void>;
	acceptRuntimeTurn: (
		runId: string,
		sessionKey: string,
		input: unknown,
		reuseAccepted?: boolean,
	) => Promise<void>;
	cronBudgetSuppression: () => Promise<CronBudgetSuppression | null>;
	stampCronExecution: (stamp: {
		phase: "started" | "finished";
		fireKey: string;
		cronName: string;
		runId?: string;
		startedAt: string;
		finishedAt?: string;
		status?: "success" | "failure";
		transitions?: Record<string, unknown>;
		error?: string;
	}) => Promise<void>;
	subAgent: AgentTediDO["subAgent"];
	recordWorkflowDispatch: (
		workflowInstanceId: string,
		ctx: {
			runId: string;
			traceId?: string;
			sessionKey: string;
			userText: string;
			userTs: number;
			workItemId?: string;
			cron?: WorkflowDispatchContext["cron"];
		},
	) => Promise<boolean>;
	dispatchAdmittedChatWorkflow: (
		binding: "CHAT_TURN_WORKFLOW",
		params: ChatTurnParams & Pick<FacetWorkflowTurnInput, "operatorConsent">,
		options: { id: string; agentBinding: "TEDI_AGENT" },
	) => Promise<void>;
	clearWorkflowDispatch: (
		workflowInstanceId: string,
		imageCleanup?: "terminal" | "cancelled",
	) => Promise<void>;
	getPlatformClient: () => Promise<HttpPlatformClient | null>;
	identityValue: (value: string | null | undefined) => string | undefined;
}

/**
 * Trigger the policy-pack cron reconcile at most once per DO instance, off the
 * hot path (fire-and-forget). No-ops until `tediId` is resolved, then runs on
 * the next call. Never throws into the turn.
 */
export function maybeReconcileCrons(host: RuntimeCronHost): void {
	if (host.cronReconcileDone) return;
	if (!host.identityValue(host.state.tediId)) return;
	host.cronReconcileDone = true;
	void host.reconcilePolicyPackCrons();
}

/**
 * Load this tedi's policy-pack `cronPolicy.cronTemplates` from D1 (the
 * canonical source). Fail-soft: any missing pack / parse error returns `[]`.
 * Single indexed join, read-only — no network, no hot-path risk.
 */
export async function loadPolicyPackCronTemplates(
	host: RuntimeCronHost,
	tediId: string,
): Promise<
	| { ok: true; templates: CronTemplateLike[] }
	| { ok: false; templates: CronTemplateLike[]; error: string }
> {
	try {
		const row = await getTediRuntimePolicy(host.env.DB, tediId);
		const def = row?.definition
			? ((typeof row.definition === "string"
					? JSON.parse(row.definition)
					: row.definition) as {
					cronPolicy?: {
						cronTemplates?: CronTemplateLike[];
						disableCognitiveDefaults?: boolean;
						disabledCognitiveCronNames?: unknown;
					};
				} | null)
			: null;
		const cronPolicy = def?.cronPolicy;
		const runtimeOverrides = row?.runtimeOverrides
			? ((typeof row.runtimeOverrides === "string"
					? JSON.parse(row.runtimeOverrides)
					: row.runtimeOverrides) as {
					cronPolicy?: {
						cronTemplates?: CronTemplateLike[];
						disableCognitiveDefaults?: boolean;
						disabledCognitiveCronNames?: unknown;
					};
				} | null)
			: null;
		const packTemplates = Array.isArray(cronPolicy?.cronTemplates)
			? (cronPolicy?.cronTemplates ?? [])
			: [];
		// Pack-authored opt-out: a deliberately cron-less / non-cognitive pack
		// disables the platform floor here (omitting templates does NOT — the
		// floor re-adds them). See withCognitiveCronDefaults.
		const packResolved = withCognitiveCronDefaults(packTemplates, {
			disableCognitiveDefaults: cronPolicy?.disableCognitiveDefaults === true,
			disabledCognitiveCronNames: Array.isArray(
				cronPolicy?.disabledCognitiveCronNames,
			)
				? cronPolicy.disabledCognitiveCronNames.filter(
						(n): n is string => typeof n === "string",
					)
				: undefined,
		});
		const tediCronPolicy = runtimeOverrides?.cronPolicy;
		return {
			ok: true,
			templates: applyTediCronPolicyOverrides(packResolved, {
				disableCognitiveDefaults:
					tediCronPolicy?.disableCognitiveDefaults === true,
				disabledCognitiveCronNames: Array.isArray(
					tediCronPolicy?.disabledCognitiveCronNames,
				)
					? tediCronPolicy.disabledCognitiveCronNames.filter(
							(name): name is string => typeof name === "string",
						)
					: undefined,
				cronTemplates: Array.isArray(tediCronPolicy?.cronTemplates)
					? tediCronPolicy.cronTemplates
					: undefined,
			}),
		};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		console.warn(
			`[isolate.cron-reconcile] load templates failed for ${tediId}:`,
			error,
		);
		// Unknown policy cannot authorize additions OR removals. Reinstalling
		// defaults here revives explicitly disabled cognitive jobs on a read
		// failure. Preserve installed schedules and report degraded state.
		return {
			ok: false,
			templates: [],
			error,
		};
	}
}

/**
 * Agent-tool mutation guard for policy-protected cron names. Reads
 * `cronPolicy.protectedCronNames` from the tedi's policy pack (D1) — the
 * admin-owned, config-driven source; the in-session tool can never set it.
 * FAIL-CLOSED: if protection state is unreadable, the mutation is refused
 * (removes are rare and retryable; silently allowing deletion during a D1
 * blip would defeat the rail). Returns null when admissible.
 */
export async function cronProtectionError(
	host: RuntimeCronHost,
	name: string | null | undefined,
	action: "remove" | "replace",
): Promise<string | null> {
	const target = (name ?? "").trim();
	if (!target) return null;
	const tediId = host.identityValue(host.state.tediId);
	if (!tediId) return null;
	let protectedNames: string[];
	try {
		const row = await getTediRuntimePolicy(host.env.DB, tediId);
		const def = row?.definition
			? ((typeof row.definition === "string"
					? JSON.parse(row.definition)
					: row.definition) as {
					cronPolicy?: { protectedCronNames?: unknown };
				} | null)
			: null;
		const names = def?.cronPolicy?.protectedCronNames;
		protectedNames = Array.isArray(names)
			? names.filter((n): n is string => typeof n === "string")
			: [];
	} catch (err) {
		console.warn(
			"[isolate.cron] protection read failed (fail-closed):",
			err instanceof Error ? err.message : err,
		);
		return `cron protection state is temporarily unreadable; retry the ${action} shortly`;
	}
	return protectedCronNameError(target, protectedNames, action);
}

/**
 * Reconcile policy-pack cron templates onto this DO's SDK scheduler so D1 is
 * the canonical, drift-free source for tedi crons (vs the in-session `cron`
 * tool, whose adds live only on whichever instance ran them). NAME-keyed via
 * {@link planCronReconcile}: add-if-missing / update-if-changed / leave-else,
 * idempotent across restarts. Only touches `onCronFire` schedules — the
 * framework `isolate-*` maintenance tasks ({@link getScheduledTasks}) are left
 * alone. Fully fail-soft: never throws into startup or a turn.
 */
export function reconcilePolicyPackCrons(
	host: RuntimeCronHost,
	options: { forceUpdate?: boolean } = {},
): Promise<PolicyCronReconcileReceipt> {
	const result = host.cronReconcileQueue.then(() =>
		host.reconcilePolicyPackCronsNow(options),
	);
	host.cronReconcileQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

export async function reconcilePolicyPackCronsNow(
	host: RuntimeCronHost,
	options: { forceUpdate?: boolean } = {},
): Promise<PolicyCronReconcileReceipt> {
	const forceUpdate = options.forceUpdate === true;
	try {
		const tediId = host.identityValue(host.state.tediId);
		if (!tediId) {
			return {
				ok: false,
				forceUpdate,
				templateCount: 0,
				existingCount: 0,
				plannedCount: 0,
				appliedCount: 0,
				actions: [],
				errors: ["tedi identity is unavailable"],
			};
		}
		const templateLoad = await host.loadPolicyPackCronTemplates(tediId);
		const templates = templateLoad.templates;
		const existing = (await host.listSchedules()).filter(
			(s) => s.callback === "onCronFire",
		) as unknown as ScheduleLike[];
		const actions = planCronReconcile(templates, existing, {
			forceUpdate,
			removeStale: templateLoad.ok,
		});
		const applied = await applyCronReconcileActions(actions, {
			cancelSchedule: (id) => host.cancelSchedule(id),
			schedule: (expr, payload, options) =>
				host.schedule(
					expr,
					"onCronFire",
					payload,
					// agents@0.19 cron schedule() deduplicates identical
					// callback+expr+payload by default. An update must mint a
					// distinct id before the prior row can be retired.
					options.fresh ? { idempotent: false } : undefined,
				),
		});
		const errors = [
			...(templateLoad.ok ? [] : [`policy_read:${templateLoad.error}`]),
			...applied.errors,
		];
		if (actions.length) {
			console.log(
				`[isolate.cron-reconcile] applied ${applied.appliedCount}/${actions.length} policy-pack cron action(s) for ${host.state.slug}`,
			);
		}
		return {
			ok: errors.length === 0,
			forceUpdate,
			templateCount: templates.length,
			existingCount: existing.length,
			plannedCount: actions.length,
			appliedCount: applied.appliedCount,
			actions: actions.map(({ op, name }) => ({ op, name })),
			errors,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn("[isolate.cron-reconcile] reconcile failed (no-op):", message);
		return {
			ok: false,
			forceUpdate,
			templateCount: 0,
			existingCount: 0,
			plannedCount: 0,
			appliedCount: 0,
			actions: [],
			errors: [message],
		};
	}
}

/**
 * Cron MCP tool dispatcher (list/add/remove/status/run), backed by the Agents
 * SDK durable scheduler on this DO (`schedule`/`scheduleEvery`/`listSchedules`/
 * `cancelSchedule`). `onCronFire` injects the job message as a real tedi turn
 * (full session + ledger + brain), so a cron is autonomous tedi work, not a
 * passive timer. All three schedule kinds map onto the SDK natively:
 * `at`→Date (one-shot), `every`→`scheduleEvery` (interval), `cron`→cron-string.
 */
export async function cronTool(
	host: RuntimeCronHost,
	input: CronToolInput,
	boundSessionKey?: string,
): Promise<unknown> {
	switch (input.action) {
		case "list":
		case "status": {
			const jobs = (await host.listSchedules())
				.filter((s) => s.callback === "onCronFire")
				.map(scheduleToCronJob);
			return input.action === "status"
				? { ok: true, count: jobs.length, jobs }
				: { ok: true, jobs };
		}
		case "add": {
			const job = input.job;
			const sched = job?.schedule;
			if (!sched?.kind) {
				return {
					ok: false,
					error: "job.schedule.kind (at|every|cron) is required for add",
				};
			}
			const message = (
				job?.message ??
				job?.payload?.message ??
				job?.payload?.text ??
				""
			).trim();
			if (!message) {
				return {
					ok: false,
					error:
						"a message is required for add (job.message, or job.payload.message/text)",
				};
			}
			// CEILINGS (see cron.ts): every fire runs a full agent turn, and this
			// tool is reachable from the tedi's own in-turn tool selection — so an
			// unbounded interval or an unbounded job count is unbounded spend.
			// Checked against REAL schedule state, before anything is created.
			const sessionKey = resolveCronSessionKey(
				job?.sessionTarget,
				boundSessionKey,
			);
			const name = job?.name?.trim() || `cron-${host.state.tediId || "tedi"}`;
			// Idempotent by name (see cronSchedulesSupersededByName): re-adding an
			// existing name REPLACES it rather than accumulating a duplicate,
			// bringing `add` to parity with the reconcile path. Superseded jobs are
			// retired after replacement creation, so they must NOT count toward the
			// ceiling.
			const allSchedules = await host.listSchedules();
			// PROTECTION (config-driven, policy pack): a protected name can be
			// neither replaced (add-upsert) nor removed from the agent tool.
			const protectionError = await host.cronProtectionError(name, "replace");
			if (protectionError) return { ok: false, error: protectionError };
			// TTL stop-contract: recurring tool-added jobs always expire; renewal
			// is re-adding the same name (this very upsert path).
			const expiry = resolveCronExpiry(sched.kind, job?.expiresAt, Date.now());
			if ("error" in expiry) return { ok: false, error: expiry.error };
			const supersededIds = cronSchedulesSupersededByName(
				name,
				allSchedules as unknown as ScheduleLike[],
			);
			const existingJobCount =
				allSchedules.filter((s) => s.callback === "onCronFire").length -
				supersededIds.length;
			const ceilingError = cronScheduleCeilingError(
				{ kind: sched.kind, everyMs: sched.everyMs, expr: sched.expr },
				existingJobCount,
				host.state.budgets?.maxCronJobs,
			);
			if (ceilingError) {
				return { ok: false, error: ceilingError };
			}
			const payload: CronFirePayload = {
				message,
				name,
				sessionKey,
				expiresAtMs: expiry.expiresAtMs,
				source: "tool",
			};
			try {
				let spec:
					| { kind: "at"; at: Date }
					| { kind: "every"; everySeconds: number }
					| { kind: "cron"; expr: string };
				if (sched.kind === "at") {
					if (!sched.at) {
						return {
							ok: false,
							error: "schedule.at (ISO-8601 timestamp) is required for kind=at",
						};
					}
					const when = new Date(sched.at);
					if (Number.isNaN(when.getTime())) {
						return {
							ok: false,
							error: `schedule.at is not a valid ISO-8601 timestamp: ${sched.at}`,
						};
					}
					spec = { kind: "at", at: when };
				} else if (sched.kind === "every") {
					if (!sched.everyMs || sched.everyMs <= 0) {
						return {
							ok: false,
							error: "schedule.everyMs (> 0) is required for kind=every",
						};
					}
					// SDK interval granularity is whole seconds; clamp to ≥1s.
					spec = {
						kind: "every",
						everySeconds: Math.max(1, Math.round(sched.everyMs / 1000)),
					};
				} else {
					if (!sched.expr) {
						return {
							ok: false,
							error:
								"schedule.expr (cron expression) is required for kind=cron",
						};
					}
					spec = { kind: "cron", expr: sched.expr };
				}
				const write = await writeConversationalSchedule(
					{ spec, payload, supersededIds },
					{
						cancel: (id) => host.cancelSchedule(id),
						create: (target, value, options) => {
							if (target.kind === "at")
								return host.schedule(
									target.at,
									"onCronFire",
									value,
									options.fresh ? { idempotent: false } : undefined,
								);
							if (target.kind === "every")
								return host.scheduleEvery(
									target.everySeconds,
									"onCronFire",
									value,
									options.fresh ? { _idempotent: false } : undefined,
								);
							return host.schedule(
								target.expr,
								"onCronFire",
								value,
								options.fresh ? { idempotent: false } : undefined,
							);
						},
					},
				);
				const created = write.created;
				const full = await host.getScheduleById(created.id);
				return conversationalScheduleCreationReceipt(
					write,
					full ? scheduleToCronJob(full) : { id: created.id, name },
					sessionKey,
				);
			} catch (err) {
				return {
					ok: false,
					error: `failed to schedule cron job: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}
		case "remove": {
			const id = (input.id ?? input.jobId ?? "").trim();
			if (!id) {
				return { ok: false, error: "id (or jobId) is required for remove" };
			}
			const target = await host.getScheduleById(id);
			if (target?.callback === "onCronFire") {
				const targetName = (
					target.payload as Partial<CronFirePayload> | null | undefined
				)?.name;
				const protectionError = await host.cronProtectionError(
					targetName,
					"remove",
				);
				if (protectionError) {
					return { ok: false, error: protectionError, protected: true };
				}
			}
			const removed = await host.cancelSchedule(id);
			return { ok: removed, removed, id };
		}
		case "run": {
			const id = (input.id ?? input.jobId ?? "").trim();
			if (!id) {
				return { ok: false, error: "id (or jobId) is required for run" };
			}
			const sched = await host.getScheduleById(id);
			if (sched?.callback !== "onCronFire") {
				return { ok: false, error: `no cron job with id ${id}` };
			}
			const outcome = await host.onCronFire(sched.payload as CronFirePayload, {
				id: sched.id,
				// Manual invocation is a distinct occurrence. Reusing the
				// schedule's next fire time aliases both onto one fire key.
				time: Date.now(),
			});
			return { ok: true, fired: id, outcome };
		}
		default:
			return { ok: false, error: `unsupported cron action: ${input.action}` };
	}
}

export function durableObjectReference(host: RuntimeCronHost): string {
	try {
		return host.name;
	} catch {
		// Legacy Agent objects created before PartyServer persisted its name can
		// still be addressed by an opaque Durable Object id.
		return host.ctx.id.toString();
	}
}

/**
 * Whether THIS DO is an orphaned (zombie) isolate — its own DO name is no
 * longer the tedi's canonical `isolate_agent_id` in D1. Fail-safe: resolves
 * the tediId from persisted DO state (a zombie keeps its own SQLite across a
 * rebind), reads the canonical id from D1, and only reports orphan on a
 * definite mismatch. A successful lookup with no row proves the tedi was
 * deleted and is also definitive. Missing local identity, a present row with
 * no canonical id, and lookup errors remain fail-safe (`false`).
 */
export async function isOrphanedIsolateForCron(
	host: RuntimeCronHost,
): Promise<boolean> {
	const tediId = host.identityValue(host.state.tediId);
	if (!tediId) throw new Error("Canonical runtime identity is missing");
	const row = await getTediRuntimeCanonicalIsolateId(host.env.DB, tediId);
	if (row.exists && !row.isolateAgentId)
		throw new Error("Canonical runtime custody is unresolved");
	// A successful query with no row proves this persisted DO outlived a hard
	// delete. A present row with no canonical isolate remains ambiguous and
	// therefore fail-safe (fire normally).
	return isOrphanedIsolateDo(
		host.durableObjectReference(),
		row.isolateAgentId,
		row.exists,
	);
}

/**
 * Agents 0.23 cancels the job before emitting schedule:cancel. A legacy
 * unnamed object's event may still throw; confirm removal through the public
 * scheduler API. Never query the retired cf_agents_schedules table.
 */
export async function confirmLegacyOrphanScheduleRemoval(
	host: RuntimeCronHost,
	scheduleIds: string[],
): Promise<string[]> {
	const deleted: string[] = [];
	for (const scheduleId of scheduleIds) {
		if (!(await host.getScheduleById(scheduleId))) deleted.push(scheduleId);
	}
	return deleted;
}

/**
 * Cancel every schedule only after this DO proves it is orphaned against the
 * canonical tedi row. This includes named cron jobs and the parent's
 * static maintenance tasks: leaving either class installed can wake a deleted
 * tedi and, for brain-digest maintenance, spend inference tokens. Public so an
 * operator can safely clean a known zombie
 * through a cross-script Durable Object RPC binding. An optional persisted-
 * slug allowlist lets an operator scan opaque object ids without touching any
 * other orphan; active tedis are always a no-op.
 */
export async function cleanupOrphanSchedules(
	host: RuntimeCronHost,
	input?: { expectedSlugs?: string[] },
): Promise<{
	doName: string;
	tediId: string;
	slug: string;
	orphaned: boolean;
	skippedReason?: "identity_missing" | "slug_mismatch";
	cancelledScheduleIds: string[];
	failedScheduleIds: string[];
	remainingScheduleIds: string[];
}> {
	const doName = host.durableObjectReference();
	const tediId = host.identityValue(host.state.tediId) ?? "";
	const slug = host.identityValue(host.state.slug) ?? "";
	if (!tediId || !slug) {
		return {
			doName,
			tediId,
			slug,
			orphaned: false,
			skippedReason: "identity_missing",
			cancelledScheduleIds: [],
			failedScheduleIds: [],
			remainingScheduleIds: [],
		};
	}
	const expectedSlugs = (input?.expectedSlugs ?? [])
		.map((value) => host.identityValue(value))
		.filter((value): value is string => Boolean(value))
		.slice(0, 8);
	if (expectedSlugs.length > 0 && !expectedSlugs.includes(slug)) {
		return {
			doName,
			tediId,
			slug,
			orphaned: false,
			skippedReason: "slug_mismatch",
			cancelledScheduleIds: [],
			failedScheduleIds: [],
			remainingScheduleIds: [],
		};
	}
	if (!(await host.isOrphanedIsolateForCron())) {
		return {
			doName,
			tediId,
			slug,
			orphaned: false,
			cancelledScheduleIds: [],
			failedScheduleIds: [],
			remainingScheduleIds: [],
		};
	}

	const orphanSchedules = await host.listSchedules();
	const cancelledScheduleIds: string[] = [];
	const failedScheduleIds: string[] = [];
	const legacyFallbackScheduleIds: string[] = [];
	const isLegacyUnnamedObject = doName === host.ctx.id.toString();
	for (const schedule of orphanSchedules) {
		try {
			const cancelled = await host.cancelSchedule(schedule.id);
			if (cancelled) cancelledScheduleIds.push(schedule.id);
			else failedScheduleIds.push(schedule.id);
		} catch {
			if (isLegacyUnnamedObject) {
				legacyFallbackScheduleIds.push(schedule.id);
			} else {
				failedScheduleIds.push(schedule.id);
			}
		}
	}
	if (legacyFallbackScheduleIds.length > 0) {
		const fallbackDeleted = new Set(
			await host.confirmLegacyOrphanScheduleRemoval(legacyFallbackScheduleIds),
		);
		for (const scheduleId of legacyFallbackScheduleIds) {
			if (fallbackDeleted.has(scheduleId)) {
				cancelledScheduleIds.push(scheduleId);
			} else {
				failedScheduleIds.push(scheduleId);
			}
		}
	}
	const remainingScheduleIds = (await host.listSchedules()).map(
		(schedule) => schedule.id,
	);
	return {
		doName,
		tediId,
		slug,
		orphaned: true,
		cancelledScheduleIds,
		failedScheduleIds,
		remainingScheduleIds,
	};
}

/**
 * Cron callback — invoked by the SDK alarm when a scheduled job fires (with
 * the job payload and the schedule row). Dispatches onto `CHAT_TURN_WORKFLOW`
 * (durable, eviction-surviving) so the alarm context can return immediately
 * without binding model execution or terminal settlement to the alarm context.
 * Same workflow path as the async-inject (`payload.async===true`) branch.
 * Per-fire `clientRequestId` is keyed by schedule id + scheduled time so each
 * fire is its own run and a re-fired alarm with the same fireKey deduplicates
 * to the same workflow instance. Public because the SDK resolves it by name
 * (`callback: keyof this`).
 */
export async function onCronFire(
	host: RuntimeCronHost,
	payload: CronFirePayload,
	row?: { id?: string; time?: number },
): Promise<CronFireOutcome> {
	// Orphaned-DO self-heal (see isOrphanedIsolateDo in cron.ts). A rebind
	// repoints the tedi's canonical isolate_agent_id to a fresh DO but leaves
	// THIS DO's alarms firing forever. If this DO is no longer the canonical
	// one, cancel its schedules and stop — every zombie self-terminates within
	// one fire cycle. Fully fail-safe: any lookup error, or any ambiguity,
	// falls through to a normal fire, so the guard can only ever stop an
	// orphan, never the live fleet.
	try {
		const cleanup = await host.cleanupOrphanSchedules();
		if (cleanup.orphaned) {
			console.warn(
				`[isolate.cron] orphaned DO self-heal: own=${cleanup.doName} is not the canonical isolate; cancelled ${cleanup.cancelledScheduleIds.length} schedule(s), failed ${cleanup.failedScheduleIds.length}, remaining ${cleanup.remainingScheduleIds.length}; skipping fire`,
			);
			return { status: "skipped", reason: "orphaned_runtime" };
		}
	} catch (err) {
		console.warn("[isolate.cron] canonical custody check failed:", err);
		throw err;
	}
	await host.ensureIdentity();
	const message = payload?.message?.trim();
	if (!message) {
		console.warn("[isolate.cron] fired with empty message; skipping");
		return { status: "skipped", reason: "empty_message" };
	}
	// TTL STOP-CONTRACT (see cron.ts § GOVERNANCE): an expired job cancels
	// itself at fire time instead of running — never silently: a warn line for
	// the human trail plus a queryable cron_governance AE datapoint. Renewal
	// is a named re-add through the cron tool. Fail-soft: enforcement errors
	// fall through to a normal fire (the safe direction — one extra turn).
	try {
		if (isCronFireExpired(payload ?? {}, Date.now())) {
			if (row?.id) await host.cancelSchedule(row.id).catch(() => {});
			const expiredByMs = Date.now() - (payload?.expiresAtMs ?? Date.now());
			console.warn(
				`[isolate.cron] TTL expired: cancelled job name=${payload?.name ?? "?"} id=${row?.id ?? "?"} expiredBy=${Math.round(expiredByMs / 1000)}s; re-add the job to renew`,
			);
			try {
				host.env.RUNTIME_ANALYTICS?.writeDataPoint(
					buildCronGovernanceAnalyticsDataPoint({
						action: "expired_cancelled",
						tediId: host.state.tediId ?? "",
						jobName: payload?.name ?? "",
						scheduleId: row?.id ?? "",
						expiredByMs,
					}),
				);
			} catch {
				/* AE write is best-effort */
			}
			return { status: "skipped", reason: "expired" };
		}
	} catch (err) {
		console.warn(
			"[isolate.cron] TTL check failed (firing normally):",
			err instanceof Error ? err.message : err,
		);
	}
	const sessionKey = payload?.sessionKey || DEFAULT_SESSION_KEY;
	const fireKey = `cron:${row?.id ?? payload?.name ?? "job"}:${row?.time ?? Date.now()}`;
	const { tediId, slug } = host.state;
	const runId = buildRunId(tediId, fireKey, "cron");
	await host.acceptRuntimeTurn(runId, sessionKey, {
		kind: "cron",
		payload,
		schedule: row,
	});
	// A budget rejection is a deterministic governance stop for the current
	// UTC accounting window, not a transient failure. Skip before opening a run
	// or execution stamp; the Agents-SDK schedule remains installed and will
	// resume automatically after reset (or after an operator raises the limit).
	try {
		const suppression = await host.cronBudgetSuppression();
		if (suppression) {
			const resumesAt = new Date(suppression.resetAtMs).toISOString();
			const budget = cronBudgetSuppressionSnapshot(suppression);
			console.warn(
				`[isolate.cron] budget-suppressed fire name=${payload?.name ?? "?"} id=${row?.id ?? "?"} tokens=${budget.usedTokens}/${budget.tokenLimit} messages=${budget.usedMessages}/${budget.messageLimit} resumes=${resumesAt}`,
			);
			try {
				host.env.RUNTIME_ANALYTICS?.writeDataPoint(
					buildCronGovernanceAnalyticsDataPoint({
						action: "budget_suppressed",
						tediId: tediId ?? "",
						jobName: payload?.name ?? "",
						scheduleId: row?.id ?? "",
						suppressedForMs: Math.max(0, suppression.resetAtMs - Date.now()),
						usedTokens: budget.usedTokens,
						tokenLimit: budget.tokenLimit,
						remainingTokens: budget.remainingTokens,
						usedMessages: budget.usedMessages,
						messageLimit: budget.messageLimit,
						remainingMessages: budget.remainingMessages,
					}),
				);
			} catch {
				/* AE write is best-effort */
			}
			return {
				status: "suppressed",
				fireKey,
				reason: suppression.reason,
				resumesAt,
				budget,
			};
		}
	} catch (err) {
		// The provider-side atomic admission guard still fails closed. Let one
		// turn reach it rather than silently disabling valid scheduled work.
		console.warn(
			"[isolate.cron] budget suppression check failed (falling through to provider admission):",
			err instanceof Error ? err.message : err,
		);
	}
	const userTs = Date.now();
	// Stamp the fire before the stability gate: a named alarm that woke but
	// could not enter a turn is a real failed execution, not "never executed".
	const cronStamp = buildCronExecutionStart(
		payload ?? {},
		fireKey,
		runId,
		userTs,
	);
	if (cronStamp) await host.stampCronExecution(cronStamp);
	let stable: boolean;
	try {
		stable = await (
			await host.subAgent(
				ConversationFacet,
				sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_"),
			)
		).waitUntilStable({ timeout: 30_000 });
	} catch (error) {
		if (cronStamp) {
			await host.stampCronExecution(
				buildCronPreDispatchFailure(
					cronStamp,
					Date.now(),
					"stability_error",
					error,
				),
			);
		}
		throw error;
	}
	if (!stable) {
		if (cronStamp) {
			await host.stampCronExecution(
				buildCronStabilityTimeoutFailure(cronStamp, Date.now()),
			);
		}
		console.warn(
			`[isolate.cron] conversation not stable; skipping scheduled turn fire=${fireKey}`,
		);
		return { status: "skipped", reason: "conversation_unstable" };
	}
	const conversationId = buildTediConversationId({
		tediRef: slug || tediId,
		sessionKey,
	});
	// Cloudflare Workflow instance ids reject colons — fireKey is colon-delimited
	// (e.g. "cron:job-id:1234567890"), so sanitize to a valid, deterministic id.
	// Same derivation as the inject and cancel paths — same fireKey → same id.
	const workflowInstanceId = buildWorkflowInstanceId(fireKey);
	// CANONICAL SCHEDULED-TURN ENVELOPE (scheduled-task-prompt.ts). The stored
	// authored prompt stays verbatim on the schedule row; the identity,
	// recurrence, intended-vs-actual occurrence, and the autonomous notice are
	// composed here at dispatch. Without the notice a scheduled turn answers as
	// if a human were reading — asking a question nobody will answer, or
	// apologizing instead of doing tool work — which is exactly the false
	// negative `cron-turn-outcome.ts` has to reclassify downstream.
	// Fail-soft: recurrence lookup never blocks a fire.
	let recurrence: ScheduledTaskRecurrence = { type: "one-off" };
	try {
		const schedule = row?.id ? await host.getScheduleById(row.id) : null;
		if (schedule?.type === "cron" && typeof schedule.cron === "string") {
			recurrence = { type: "cron", expr: schedule.cron };
		} else if (
			schedule?.type === "interval" &&
			typeof schedule.intervalSeconds === "number"
		) {
			recurrence = {
				type: "every",
				everyMs: schedule.intervalSeconds * 1000,
			};
		}
	} catch (err) {
		console.warn(
			"[isolate.cron] recurrence lookup failed; enveloping as one-off:",
			err,
		);
	}
	const envelopedMessage = formatScheduledTaskPrompt({
		name: payload?.name ?? null,
		prompt: message,
		// The SDK persists `Schedule.time` in unix SECONDS.
		scheduledForMs: typeof row?.time === "number" ? row.time * 1000 : null,
		currentTimeMs: userTs,
		recurrence,
	});
	// Durable execution stamp (flywheel cron-health ledger): open a `running`
	// row for every NAMED fire before dispatch. The terminal hooks
	// (onWorkflowComplete / mirrorWorkflowFailure) seal it success/failure via
	// the cron ctx persisted on the workflow dispatch record. Fail-soft: a
	// stamp outage never blocks the fire.
	const dispatchContextRecorded = await host.recordWorkflowDispatch(
		workflowInstanceId,
		{
			runId,
			sessionKey,
			userText: envelopedMessage,
			userTs,
			...(cronStamp
				? {
						cron: {
							name: cronStamp.cronName,
							fireKey,
							startedAtIso: cronStamp.startedAt,
						},
					}
				: {}),
		},
	);
	if (!dispatchContextRecorded) {
		const error = new Error(
			`workflow dispatch context could not be recorded for ${workflowInstanceId}`,
		);
		if (cronStamp) {
			await host.stampCronExecution(
				buildCronPreDispatchFailure(
					cronStamp,
					Date.now(),
					"dispatch_context_error",
					error,
				),
			);
		}
		// Do not launch an untrackable workflow: without persisted dispatch
		// context neither its run nor its cron execution can be sealed later.
		throw error;
	}
	try {
		await host.dispatchAdmittedChatWorkflow(
			"CHAT_TURN_WORKFLOW",
			{
				agentName: host.name,
				sessionKey,
				userText: envelopedMessage,
				userTs,
				conversationId,
				runId,
				clientRequestId: fireKey,
				// This message was loaded from the authenticated persisted schedule,
				// not supplied by the current MCP caller.
				trustedInstructionOrigin: "cron",
			},
			{ id: workflowInstanceId, agentBinding: "TEDI_AGENT" },
		);
	} catch (e) {
		await host.clearWorkflowDispatch(workflowInstanceId);
		if (cronStamp) {
			await host.stampCronExecution(
				buildCronPreDispatchFailure(
					cronStamp,
					Date.now(),
					"workflow_dispatch_error",
					e,
				),
			);
		}
		console.error(
			`[isolate.cron] workflow dispatch failed fire=${fireKey}:`,
			e instanceof Error ? e.message : e,
		);
		// Re-throw so the SDK alarm retries this fire (schedule maxAttempts).
		throw e;
	}
	// WS2 trajectory mining: the skill-development cycle carries a mechanical
	// consolidation operator alongside its LLM turn — deterministic mining of
	// recurring successful tool-call routines (evidence-linked rationale
	// episodes) into draft Skill Workshop proposals via
	// `skills.mineCandidates`. Runs AFTER the turn workflow dispatches so a
	// slow mine never delays the cycle; fail-soft — mining problems never
	// fail the fire.
	if (shouldRunTrajectoryMining(payload ?? {})) {
		try {
			const platform = await host.getPlatformClient();
			if (platform) {
				const mined = await platform.mineSkillCandidates({});
				console.log(
					`[isolate.cron] trajectory mining: episodes=${mined.episodesExamined} runs=${mined.runsExamined} patterns=${mined.patterns.length} proposed=${mined.proposed.length} skipped=${mined.skipped.length}`,
				);
			}
		} catch (err) {
			console.warn(
				"[isolate.cron] trajectory mining failed (fire unaffected):",
				err instanceof Error ? err.message : err,
			);
		}
	}
	return {
		status: "dispatched",
		fireKey,
		runId,
		workflowId: workflowInstanceId,
	};
}

/**
 * Fail-soft write of a cron execution stamp to the durable
 * `tedi_cron_executions` ledger (via apps/api). The ledger is evidence, not
 * control flow: a failed stamp is logged and the fire proceeds.
 */
export async function stampCronExecution(
	host: RuntimeCronHost,
	stamp: {
		phase: "started" | "finished";
		fireKey: string;
		cronName: string;
		runId?: string;
		startedAt: string;
		finishedAt?: string;
		status?: "success" | "failure";
		transitions?: Record<string, unknown>;
		error?: string;
	},
): Promise<void> {
	try {
		const platform = await host.getPlatformClient();
		if (!platform) {
			console.warn(
				`[isolate.cron] no platform client; execution stamp skipped name=${stamp.cronName} phase=${stamp.phase}`,
			);
			return;
		}
		await platform.recordCronExecution(stamp);
	} catch (err) {
		console.warn(
			`[isolate.cron] execution stamp failed name=${stamp.cronName} phase=${stamp.phase}:`,
			err instanceof Error ? err.message : err,
		);
	}
}
