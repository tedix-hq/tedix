/**
 * Pure cron helpers for the isolate tedi cron tool.
 *
 * The DO-bound dispatch + scheduling (`cronTool`/`onCronFire`) lives in `do.ts`
 * and calls the Agents SDK scheduler directly; this module holds only the pure
 * mapping/validation logic so it can be unit-tested without a DO harness. See
 * docs/engineering/tedi/agent-runtime.md § Cron Ceilings.
 */

import { scrubText } from "@tedix/context-core/trace-safety";
import { DEFAULT_CRON_TEMPLATES } from "@tedix/db/schema/control-plane";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";

/** Payload stored on a cron schedule and passed to `onCronFire`. */
export interface CronFirePayload {
	message: string;
	name?: string;
	sessionKey?: string;
	/**
	 * TTL stop-contract (see § governance below): unix ms after which a fire
	 * cancels the schedule instead of running. `null`/absent = no expiry
	 * (platform-managed template jobs). Stamped by the `cron` tool at add time.
	 */
	expiresAtMs?: number | null;
	/** Provenance: in-session `cron` tool add vs policy-pack template reconcile. */
	source?: "tool" | "template";
}

/** The subset of an Agents-SDK `Schedule` row `scheduleToCronJob` reads. */
export interface ScheduleLike {
	id: string;
	callback: string;
	payload: unknown;
	type: "scheduled" | "delayed" | "cron" | "interval";
	time?: number;
	cron?: string;
	intervalSeconds?: number;
}

/**
 * Resolve a cron `sessionTarget` to an isolate session key. An in-turn binding
 * always wins: an AI tool call belongs to the conversation whose facet exposed
 * it and cannot redirect a durable follow-up into another conversation. The
 * unbound MCP surface retains its legacy `"session:<key>"` escape hatch;
 * everything else targets the tedi's default main session.
 */
export function resolveCronSessionKey(
	target: string | undefined,
	boundSessionKey?: string,
): string {
	if (boundSessionKey) return boundSessionKey;
	if (target?.startsWith("session:")) {
		const key = target.slice("session:".length).trim();
		if (key) return key;
	}
	return DEFAULT_SESSION_KEY;
}

/**
 * Map an Agents-SDK `Schedule` row to the cron-job shape the tool returns.
 * `type` → `kind`
 * (scheduled/delayed→at, interval→every, cron→cron); the stored payload carries
 * the message/name/sessionKey.
 *
 * Units: the SDK persists `Schedule.time` in unix seconds (it floors
 * `getTime()/1000` on insert — agents/dist/index.js schedule paths), so convert
 * to ms here. Treating it as ms renders every next-run as January 1970.
 */
export function scheduleToCronJob(s: ScheduleLike): Record<string, unknown> {
	const payload = (s.payload ?? {}) as Partial<CronFirePayload>;
	const kind =
		s.type === "cron" ? "cron" : s.type === "interval" ? "every" : "at";
	const nextRunMs = typeof s.time === "number" ? s.time * 1000 : null;
	return {
		id: s.id,
		name: payload.name ?? null,
		kind,
		...(s.type === "cron" ? { expr: s.cron } : {}),
		...(s.type === "interval" && typeof s.intervalSeconds === "number"
			? { everyMs: s.intervalSeconds * 1000 }
			: {}),
		message: payload.message ?? null,
		sessionTarget: payload.sessionKey ?? null,
		nextRunMs,
		nextRunIso: nextRunMs !== null ? new Date(nextRunMs).toISOString() : null,
		expiresAtMs:
			typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : null,
		expiresAt:
			typeof payload.expiresAtMs === "number"
				? new Date(payload.expiresAtMs).toISOString()
				: null,
		source: payload.source ?? null,
	};
}

/**
 * One schedule row as exposed by the operator-only `GET /__admin/schedules`
 * endpoint on the DO (the org-scoped read behind `tedis.listSchedules` in
 * apps/api). Unlike {@link scheduleToCronJob} (the in-session `cron` tool
 * shape, which omits non-applicable keys), every field is explicitly present
 * so the contract schema stays stable across kinds and callbacks.
 */
export interface AdminScheduleSnapshot {
	id: string;
	/** DO callback the alarm invokes ("onCronFire" = operator/tedi cron job). */
	callback: string;
	name: string | null;
	kind: "cron" | "every" | "at";
	/** Cron expression (kind=cron only). */
	expr: string | null;
	/** Interval in milliseconds (kind=every only). */
	everyMs: number | null;
	/** Prompt message injected as a real tedi turn when the job fires. */
	message: string | null;
	sessionTarget: string | null;
	/** Next scheduled fire time (SDK persists unix seconds; converted to ms). */
	nextRunAtMs: number | null;
	nextRunAt: string | null;
	/** TTL stop-contract expiry (tool-added jobs); null = platform-managed. */
	expiresAtMs: number | null;
	expiresAt: string | null;
	source: "tool" | "template" | null;
}

/**
 * Map an Agents-SDK `Schedule` row to the {@link AdminScheduleSnapshot} the
 * `/__admin/schedules` operator read returns. Covers every schedule on the DO
 * (framework maintenance callbacks included, not just `onCronFire`), so the
 * payload may be anything — non-string payload fields degrade to null.
 * Same seconds→ms `time` conversion caveat as {@link scheduleToCronJob}.
 */
export function scheduleToAdminSchedule(
	s: ScheduleLike,
): AdminScheduleSnapshot {
	const payload = (s.payload ?? {}) as Partial<CronFirePayload>;
	const kind =
		s.type === "cron" ? "cron" : s.type === "interval" ? "every" : "at";
	const nextRunAtMs = typeof s.time === "number" ? s.time * 1000 : null;
	return {
		id: s.id,
		callback: s.callback,
		name: typeof payload.name === "string" ? payload.name : null,
		kind,
		expr: s.type === "cron" ? (s.cron ?? null) : null,
		everyMs:
			s.type === "interval" && typeof s.intervalSeconds === "number"
				? s.intervalSeconds * 1000
				: null,
		message: typeof payload.message === "string" ? payload.message : null,
		sessionTarget:
			typeof payload.sessionKey === "string" ? payload.sessionKey : null,
		nextRunAtMs,
		nextRunAt:
			nextRunAtMs !== null ? new Date(nextRunAtMs).toISOString() : null,
		expiresAtMs:
			typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : null,
		expiresAt:
			typeof payload.expiresAtMs === "number"
				? new Date(payload.expiresAtMs).toISOString()
				: null,
		source:
			payload.source === "tool" || payload.source === "template"
				? payload.source
				: null,
	};
}

/**
 * A policy-pack cron template (the subset {@link planCronReconcile} reads).
 * Structurally compatible with `@tedix/db` `PolicyPackCronTemplate` so the DO
 * can pass loaded templates straight in.
 */
export interface CronTemplateLike {
	name: string;
	/** Cron expression string, e.g. "0 9 * * 1-5". */
	schedule: string;
	message: string;
}

/**
 * Give every platform-managed cron its own conversation history. Reusing the
 * interactive default session made unrelated recurring jobs replay one shared,
 * ever-growing transcript on every fire — pure input-token spend and a source
 * of context contamination.
 */
export function cronTemplateSessionKey(name: string): string {
	const stableName =
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "unnamed";
	return `agent:main:cron:${stableName}`;
}

/**
 * One reconcile step: add a missing template job, or update a changed one.
 * Updates are applied create-before-retire so a transient scheduler failure
 * cannot darken a healthy recurring job.
 */
export type CronReconcileAction =
	| {
			op: "add" | "update";
			name: string;
			expr: string;
			message: string;
			sessionKey: string;
			/** For "update": the existing schedule id to cancel first. */
			cancelId?: string;
	  }
	| {
			op: "remove";
			name: string;
			cancelId: string;
	  };

export interface CronReconcileApplyReceipt {
	appliedCount: number;
	errors: string[];
}

export interface CronReconcileScheduler {
	cancelSchedule(id: string): Promise<boolean>;
	schedule(
		expr: string,
		payload: CronFirePayload,
		options: { fresh: boolean },
	): Promise<{ id: string }>;
}

/**
 * Apply a reconcile plan without ever cancelling a healthy update target
 * before its replacement exists. If retiring the old row throws, retain the
 * replacement: Agents SDK cancellation deletes first and can then throw while
 * recalculating the alarm, so rollback could delete the only surviving row.
 */
export async function applyCronReconcileActions(
	actions: readonly CronReconcileAction[],
	scheduler: CronReconcileScheduler,
): Promise<CronReconcileApplyReceipt> {
	let appliedCount = 0;
	const errors: string[] = [];
	for (const action of actions) {
		if (action.op === "remove") {
			try {
				// `false` means the row was already absent, which is idempotent
				// success for a desired-state removal.
				await scheduler.cancelSchedule(action.cancelId);
				appliedCount += 1;
			} catch (error) {
				errors.push(
					`${action.op}:${action.name}:${error instanceof Error ? error.message : String(error)}`,
				);
			}
			continue;
		}

		const payload: CronFirePayload = {
			message: action.message,
			name: action.name,
			sessionKey: action.sessionKey,
			expiresAtMs: null,
			source: "template",
		};
		let created: { id: string };
		try {
			created = await scheduler.schedule(action.expr, payload, {
				fresh: action.op === "update",
			});
		} catch (error) {
			errors.push(
				`${action.op}:${action.name}:create:${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}

		if (action.op === "update" && action.cancelId) {
			if (created.id === action.cancelId) {
				errors.push(
					`${action.op}:${action.name}:create:replacement reused prior schedule id`,
				);
				continue;
			}
			try {
				// If the prior row disappeared concurrently (`false`), the newly
				// created replacement is already the only desired schedule.
				await scheduler.cancelSchedule(action.cancelId);
			} catch (error) {
				const retirementError =
					error instanceof Error ? error.message : String(error);
				errors.push(
					`${action.op}:${action.name}:retire_ambiguous:${retirementError};replacement_retained:${created.id}`,
				);
				continue;
			}
		}
		appliedCount += 1;
	}
	return { appliedCount, errors };
}

/**
 * Platform-guarantee the cognitive (S4 adaptation) crons on top of a pack's own
 * templates. The `DEFAULT_CRON_TEMPLATES` (the six EXPECTED_COGNITIVE_CRONS
 * the flywheel health surface tracks — brain-reflection, objective-review,
 * app-operations, skill-development, knowledge-freshness, grounding-review —
 * plus muscle-crystallization and growth-snapshot) are the shared
 * platform-default cron set — the flywheel's slow S4 loop: memory
 * consolidation/disposal, learning, objective and grounding review. They must
 * run on every cognitive tedi regardless of whether the live policy pack's
 * `cronPolicy.cronTemplates` happens to list them.
 *
 * Root cause of the "dark crons" (probation accreting, learning starved) was not
 * the removed opt-in gate alone: `loadPolicyPackCronTemplates` reads the live D1
 * pack and returned only what that pack embeds — packs created before the templates
 * were seeded carried a subset/none, so the S4 loop scheduled nowhere. Making the
 * defaults a runtime floor un-darks every tedi via deploy, without a per-pack D1
 * backfill. A pack template with the same name overrides schedule/message (packs
 * stay authoritative for customization); pack-specific crons are added. This is the
 * VSM point: the adaptation function is guaranteed protected resource by the
 * platform, not left to per-unit opt-in.
 *
 * Opt-out (pack authority preserved): the floor is a legacy un-dark guarantee for
 * packs that merely omit the templates — it is not a mandate. A deliberately
 * cron-less or non-cognitive pack (minimal / paused / utility tedis) restores its
 * documented authority to disable a cycle via explicit `cronPolicy` signals, which
 * are distinguishable from "never configured":
 *   - `disableCognitiveDefaults: true` suppresses the entire platform floor (the
 *     pack runs only its own `cronTemplates`, possibly none), so a cron-less pack
 *     incurs no recurring LLM-turn spend.
 *   - `disabledCognitiveCronNames: [...]` suppresses individual named cycles while
 *     keeping the rest floored.
 * A pack that instead supplies its own same-name template still schedules that one
 * (pack templates are applied after suppression, so pack authority always wins).
 *
 * Floor integrity: a pack template overrides a default (or contributes its own
 * cron) only when it is itself SCHEDULABLE — see {@link isSchedulableCronTemplate}.
 * A same-name pack entry with a blank/whitespace or structurally-invalid
 * schedule or message (a stub, a typo, or an admin blanking a template to
 * "disable" it) must never displace a known-good platform-floor default: doing
 * so would let the pack silently dark the exact cron this floor guarantees.
 * Malformed pack entries are dropped here rather than reaching the reconciler as
 * an `add` whose `this.schedule()` would throw and abort the whole pass. Note
 * this is not the disable path — an intentional disable uses the `cronPolicy`
 * opt-out signals above, which are distinguishable from a malformed template.
 */
export function withCognitiveCronDefaults(
	packTemplates: readonly CronTemplateLike[],
	options?: CognitiveCronFloorOptions,
): CronTemplateLike[] {
	const byName = new Map<string, CronTemplateLike>();
	if (!options?.disableCognitiveDefaults) {
		const disabled = new Set(options?.disabledCognitiveCronNames ?? []);
		for (const t of DEFAULT_CRON_TEMPLATES) {
			if (disabled.has(t.name)) continue;
			byName.set(t.name, {
				name: t.name,
				schedule: t.schedule,
				message: t.message,
			});
		}
	}
	for (const t of packTemplates) {
		if (isSchedulableCronTemplate(t)) {
			byName.set(t.name, t);
		}
	}
	return [...byName.values()];
}

/**
 * Pack-controlled opt-out for the {@link withCognitiveCronDefaults} floor,
 * sourced from D1 `policy_packs.definition.cronPolicy`. Restores the pack's
 * documented authority to run a cycle-less or non-cognitive tedi without
 * incurring recurring per-fire LLM-turn spend.
 */
export interface CognitiveCronFloorOptions {
	/**
	 * Full opt-out: skip the entire platform S4 floor (pack runs only its own
	 * `cronTemplates`). For deliberately cron-less / paused / utility tedis.
	 */
	disableCognitiveDefaults?: boolean;
	/**
	 * Partial opt-out: names of individual cognitive defaults this pack disables
	 * while keeping the remaining floor. A pack's own same-name template still
	 * schedules (it is applied after suppression).
	 */
	disabledCognitiveCronNames?: readonly string[];
}

/** Per-tedi final override layered over its policy pack via `runtime_overrides`. */
export interface TediCronPolicyOverrides extends CognitiveCronFloorOptions {
	cronTemplates?: readonly CronTemplateLike[];
}

/**
 * Apply a tedi-local cron policy after the shared pack has been resolved.
 * Unlike the pack floor controls, this is the final per-worker authority: it
 * can suppress a template that the shared pack explicitly contains, without
 * forcing unrelated tedis onto a cloned policy pack.
 */
export function applyTediCronPolicyOverrides(
	templates: readonly CronTemplateLike[],
	overrides?: TediCronPolicyOverrides | null,
): CronTemplateLike[] {
	if (!overrides) return [...templates];
	const disabled = new Set(overrides.disabledCognitiveCronNames ?? []);
	const byName = new Map<string, CronTemplateLike>();
	if (!overrides.disableCognitiveDefaults) {
		for (const template of templates) {
			if (!disabled.has(template.name)) byName.set(template.name, template);
		}
	}
	for (const template of overrides.cronTemplates ?? []) {
		if (isSchedulableCronTemplate(template)) {
			byName.set(template.name, template);
		}
	}
	return [...byName.values()];
}

/**
 * Whether a policy-pack cron template is complete enough to actually schedule:
 * a non-blank name and message, and a structurally-valid cron expression (5
 * fields, or 6 with a seconds column). Blank/whitespace fields (a stub or an
 * admin "disabling" a template by emptying it) and non-cron junk like `"off"`
 * fail — so they can neither displace a platform-floor default in
 * {@link withCognitiveCronDefaults} nor be handed to the reconciler as an `add`
 * whose `this.schedule()` would throw and abort the pass. An intentional disable
 * uses {@link CognitiveCronFloorOptions}, not a blanked template.
 */
function isSchedulableCronTemplate(
	t: CronTemplateLike | null | undefined,
): boolean {
	if (!t || typeof t.name !== "string" || t.name.trim().length === 0) {
		return false;
	}
	if (typeof t.schedule !== "string" || t.schedule.trim().length === 0) {
		return false;
	}
	if (typeof t.message !== "string" || t.message.trim().length === 0) {
		return false;
	}
	const fields = t.schedule.trim().split(/\s+/).length;
	return fields === 5 || fields === 6;
}

/**
 * Pure, name-keyed reconcile plan for policy-pack cron templates against the
 * existing `onCronFire` schedules (caller filters `existing` to
 * `callback === "onCronFire"`). For each template: add-if-missing,
 * update-if (cron expr or message changed), leave-otherwise. Idempotent — a
 * second run with the same inputs returns `[]`. Name-keying (never id) is what
 * makes it clobber-safe: re-adds mint fresh ids, so keying on id would loop.
 * Invalid/incomplete templates are skipped. The caller applies the actions via
 * the Agents-SDK scheduler.
 *
 * Every valid template reconciles — including the cognitive reflection crons
 * (`DEFAULT_CRON_TEMPLATES`). A previous opt-in gate (`agentRuntime === true`)
 * excluded them on the claim that the framework `isolate-*`
 * maintenance tasks "already cover reflection"; they do not — those are
 * mechanical tasks (log flush, directive compile, brain digest, corpus audit,
 * skill-guidance refresh), not the LLM-driven cognitive cycles the flywheel
 * health surface tracks. With the container runtime gone, the gate left the
 * six cognitive crons scheduled nowhere (`flywheel.crons_flywheel_health`
 * showed all six never-executed). D1 policy packs are the single scheduling
 * authority: a pack that should not run a cognitive cycle opts out explicitly via
 * `cronPolicy.disableCognitiveDefaults` / `cronPolicy.disabledCognitiveCronNames`
 * (see {@link withCognitiveCronDefaults}). Merely removing the template no longer
 * disables the cycle — the runtime floor re-adds it — because an omitted template
 * is indistinguishable from a legacy pack seeded before the templates existed.
 */
export function planCronReconcile(
	templates: readonly CronTemplateLike[],
	existing: readonly ScheduleLike[],
	options?: { forceUpdate?: boolean; removeStale?: boolean },
): CronReconcileAction[] {
	const byName = new Map<string, ScheduleLike>();
	for (const s of existing) {
		const name = (s.payload as Partial<CronFirePayload> | null | undefined)
			?.name;
		if (name) byName.set(name, s);
	}
	const actions: CronReconcileAction[] = [];
	const desiredNames = new Set(
		templates
			.filter(isSchedulableCronTemplate)
			.map((template) => template.name),
	);
	if (options?.removeStale !== false) {
		for (const [name, schedule] of byName) {
			const payload = schedule.payload as Partial<CronFirePayload> | null;
			if (payload?.source === "template" && !desiredNames.has(name)) {
				actions.push({ op: "remove", name, cancelId: schedule.id });
			}
		}
	}
	for (const t of templates) {
		if (!t?.name || !t?.schedule || !t?.message) continue;
		const sessionKey = cronTemplateSessionKey(t.name);
		const cur = byName.get(t.name);
		if (!cur) {
			actions.push({
				op: "add",
				name: t.name,
				expr: t.schedule,
				message: t.message,
				sessionKey,
			});
			continue;
		}
		const curExpr = cur.type === "cron" ? cur.cron : undefined;
		const curMsg = (cur.payload as Partial<CronFirePayload> | null | undefined)
			?.message;
		const curSessionKey = (
			cur.payload as Partial<CronFirePayload> | null | undefined
		)?.sessionKey;
		if (
			options?.forceUpdate === true ||
			curExpr !== t.schedule ||
			curMsg !== t.message ||
			curSessionKey !== sessionKey
		) {
			actions.push({
				op: "update",
				name: t.name,
				expr: t.schedule,
				message: t.message,
				sessionKey,
				cancelId: cur.id,
			});
		}
	}
	return actions;
}

// =============================================================================
// ceilings
// =============================================================================

/**
 * Cron ceilings — the missing stop-contract on an L4 loop.
 *
 * Every cron fire runs a full agent turn (`onCronFire` → a normal LLM turn with
 * its tool loop). The `cron` tool is reachable from the tedi's own in-turn tool
 * selection (`do.ts`'s `cron: tool({...})` — "Manage YOUR OWN scheduled jobs"),
 * so one bad turn — or one prompt injection carried in untrusted content — could
 * durably install a schedule that re-executes forever. Before these ceilings the
 * only validation on `kind=every` was `everyMs > 0`, then
 * `Math.max(1, round(everyMs / 1000))`: `everyMs: 1000` bought a real agent turn
 * every second, in perpetuity, with no cap on how many such jobs could be added.
 * That is unbounded spend and a self-inflicted DoS on the DO.
 *
 * The rule: hard ceilings, always — a loop with no ceiling is a bug. These are
 * deliberately generous — they kill runaway, not legitimate use (reminders,
 * follow-ups, periodic checks). A human operator hitting a ceiling can still
 * schedule tighter cadences by other means; an agent cannot talk its way past
 * one, because the check is mechanical and lives below the tool surface.
 */

/** Floor for recurring schedules. One turn/minute is already a lot of spend. */
export const MIN_RECURRING_INTERVAL_MS = 60_000;

/** Ceiling on concurrently scheduled jobs per tedi. */
export const MAX_SCHEDULED_JOBS = 25;

/** A 6-field cron expression carries a seconds field — sub-minute granularity. */
function hasSecondsField(expr: string): boolean {
	return expr.trim().split(/\s+/).length >= 6;
}

export type CronScheduleGuardInput = {
	kind: "at" | "every" | "cron";
	everyMs?: number;
	expr?: string;
};

/**
 * Mechanical admission check for `cron add`. Returns an error string when the
 * requested schedule breaches a ceiling, or `null` when it is admissible.
 *
 * `currentJobCount` is the tedi's existing `onCronFire` schedule count, so the
 * job cap is enforced against real state rather than trusted from the caller.
 */
export function cronScheduleCeilingError(
	schedule: CronScheduleGuardInput,
	currentJobCount: number,
	maxScheduledJobs: number = MAX_SCHEDULED_JOBS,
): string | null {
	if (maxScheduledJobs >= 0 && currentJobCount >= maxScheduledJobs) {
		return `cron job limit reached (${maxScheduledJobs} scheduled jobs). Remove an existing job before adding another.`;
	}

	if (schedule.kind === "every") {
		// `everyMs > 0` is validated by the caller; only the floor is enforced here.
		if (
			typeof schedule.everyMs === "number" &&
			schedule.everyMs > 0 &&
			schedule.everyMs < MIN_RECURRING_INTERVAL_MS
		) {
			return `recurring interval too short: everyMs=${schedule.everyMs} is below the ${MIN_RECURRING_INTERVAL_MS}ms (${MIN_RECURRING_INTERVAL_MS / 1000}s) floor. Every fire runs a full agent turn; use a longer interval, or kind="at" for a one-shot.`;
		}
	}

	if (schedule.kind === "cron" && schedule.expr) {
		// A 5-field cron's tightest cadence is 1/minute (already at the floor). A
		// 6-field expression adds a seconds column and can fire every second.
		if (hasSecondsField(schedule.expr)) {
			return `sub-minute cron expressions are not allowed: "${schedule.expr}" carries a seconds field. Every fire runs a full agent turn; use a 5-field expression (minute granularity) or kind="every" with everyMs >= ${MIN_RECURRING_INTERVAL_MS}.`;
		}
	}

	return null;
}

// =============================================================================
// orphaned-DO self-heal
// =============================================================================

/**
 * Whether the DO executing a cron fire is an orphaned (zombie) isolate.
 *
 * A rebind (`performRebindIsolate`, apps/api) repoints a tedi's canonical
 * `isolate_agent_id` to a fresh Durable Object to escape a wedged one — but it
 * never cancels the old DO's SDK schedules. Cloudflare wakes a DO to run a
 * pending alarm even when nothing routes to it, so every rebind leaves a full
 * copy of the tedi's cron fleet firing forever: invisibly (the `cron` tool
 * routes to the current DO, so `list`/`remove` never see the orphans) and
 * expensively (each fire is a full agent turn), multiplying a tedi's cron
 * fires by the number of orphaned DOs.
 *
 * The self-heal needs no zombie DO names (unrecoverable — no audit chain, and
 * `runtime_external_id` is null): on each fire, a DO compares its own name to
 * the tedi's canonical `isolate_agent_id` in D1. An orphan cancels its own
 * schedules and stops. Every zombie self-terminates within one fire cycle.
 *
 * Fail-safe is the whole point: this decides whether a DO kills its own CRONS,
 * so a false positive would silently disable the live fleet (watchers, safety
 * nets, everything). It returns `true` only on a definite mismatch — both ids
 * present and different — or when a successful canonical lookup proves the
 * tedi row was deleted. Any ambiguity (missing own name while a row is present,
 * unknown/empty canonical on a present row, or a failed lookup) returns
 * `false`: the DO fires normally. The safe failure direction is "an uncertain
 * orphan keeps firing", never "the live DO dies".
 */
export function isOrphanedIsolateDo(
	ownDoName: string | null | undefined,
	canonicalIsolateAgentId: string | null | undefined,
	canonicalTediExists = true,
): boolean {
	// A completed canonical lookup that finds no tedi row is definitive deletion,
	// not ambiguity. The persisted tedi identity is then sufficient proof even
	// for legacy objects whose PartyServer name was never stored.
	if (!canonicalTediExists) return true;
	const own = (ownDoName ?? "").trim();
	if (!own) return false;
	const canonical = (canonicalIsolateAgentId ?? "").trim();
	if (!canonical) return false;
	return own !== canonical;
}

/**
 * Which existing schedules a named `add` should supersede (cancel) first.
 *
 * The interactive `cron` add path is not idempotent by name: re-adding a cron
 * with a name that already exists mints a fresh schedule and leaves the old one
 * firing, accumulating same-DO duplicates (the reconcile path,
 * `planCronReconcile`, already dedups by name — this brings `add` to parity).
 * Returns the ids of every existing `onCronFire` schedule whose payload name
 * matches, so the caller can retire them after a replacement is durably
 * created — upsert semantics without a dark window. An empty/absent name
 * matches nothing (never mass-cancel).
 */
export function cronSchedulesSupersededByName(
	name: string | null | undefined,
	existing: readonly ScheduleLike[],
): string[] {
	const target = (name ?? "").trim();
	if (!target) return [];
	return existing
		.filter((s) => s.callback === "onCronFire")
		.filter(
			(s) =>
				(s.payload as Partial<CronFirePayload> | null | undefined)?.name ===
				target,
		)
		.map((s) => s.id);
}

export type ConversationalScheduleSpec =
	| { kind: "at"; at: Date }
	| { kind: "every"; everySeconds: number }
	| { kind: "cron"; expr: string };

export interface ConversationalScheduleWriter {
	create(
		spec: ConversationalScheduleSpec,
		payload: CronFirePayload,
		options: { fresh: boolean },
	): Promise<{ id: string }>;
	cancel(id: string): Promise<boolean>;
}

export interface ConversationalScheduleWriteReceipt {
	created: { id: string };
	retiredIds: string[];
	retirementErrors: string[];
}

export interface ConversationalScheduleCreationReceipt {
	ok: true;
	status: "created" | "created_degraded";
	created: { id: string; sessionTarget: string };
	job: Record<string, unknown>;
	retiredIds: string[];
	degraded?: true;
	retirementErrors?: string[];
}

/** Stable additive receipt for callers that need to distinguish creation from cleanup. */
export function conversationalScheduleCreationReceipt(
	write: ConversationalScheduleWriteReceipt,
	job: Record<string, unknown>,
	sessionKey: string,
): ConversationalScheduleCreationReceipt {
	const degraded = write.retirementErrors.length > 0;
	return {
		ok: true,
		status: degraded ? "created_degraded" : "created",
		created: { id: write.created.id, sessionTarget: sessionKey },
		job,
		retiredIds: write.retiredIds,
		...(degraded
			? { degraded: true as const, retirementErrors: write.retirementErrors }
			: {}),
	};
}

/**
 * Create-before-retire upsert for a named conversational schedule.
 *
 * Cloudflare schedule creation can fail transiently and cancellation can throw
 * after deleting its row. Creating a fresh replacement first means neither
 * failure mode leaves a previously healthy reminder dark. An ambiguous retire
 * keeps the replacement and reports the duplicate for operator visibility.
 */
export async function writeConversationalSchedule(
	input: {
		spec: ConversationalScheduleSpec;
		payload: CronFirePayload;
		supersededIds: readonly string[];
	},
	writer: ConversationalScheduleWriter,
): Promise<ConversationalScheduleWriteReceipt> {
	const created = await writer.create(input.spec, input.payload, {
		fresh: input.supersededIds.length > 0,
	});
	if (input.supersededIds.includes(created.id)) {
		throw new Error(
			`replacement reused superseded schedule id ${created.id}; prior schedule retained`,
		);
	}

	const retiredIds: string[] = [];
	const retirementErrors: string[] = [];
	for (const id of input.supersededIds) {
		try {
			await writer.cancel(id);
			retiredIds.push(id);
		} catch (error) {
			retirementErrors.push(
				`${id}:${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { created, retiredIds, retirementErrors };
}

// =============================================================================
// governance (TTL stop-contract + protected names)
// =============================================================================

/**
 * Default TTL for recurring jobs added through the in-session `cron` tool.
 * Agent-created watchers must not be immortal-by-forgetting: a job that matters
 * gets renewed (re-adding the same name refreshes the window via the upsert
 * semantics of {@link cronSchedulesSupersededByName}); a forgotten one stops
 * burning turns after 30 days. Template-reconciled jobs (`source:"template"`)
 * are platform-managed in D1 and carry no expiry.
 */
export const DEFAULT_TOOL_CRON_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Ceiling on an explicit `expiresAt`: nothing agent-created outlives a year. */
export const MAX_TOOL_CRON_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Resolve the expiry to stamp on a tool-added job. One-shots (`at`) are
 * self-bounding → no expiry. Recurring jobs take the validated explicit
 * `expiresAt` (must parse, be in the future, and sit within
 * {@link MAX_TOOL_CRON_TTL_MS}) or default to now + 30d.
 */
export function resolveCronExpiry(
	kind: "at" | "every" | "cron",
	explicitExpiresAtIso: string | undefined,
	nowMs: number,
): { expiresAtMs: number | null } | { error: string } {
	if (kind === "at") return { expiresAtMs: null };
	if (explicitExpiresAtIso !== undefined) {
		const t = new Date(explicitExpiresAtIso).getTime();
		if (Number.isNaN(t)) {
			return {
				error: `job.expiresAt is not a valid ISO-8601 timestamp: ${explicitExpiresAtIso}`,
			};
		}
		if (t <= nowMs) {
			return { error: `job.expiresAt is in the past: ${explicitExpiresAtIso}` };
		}
		if (t - nowMs > MAX_TOOL_CRON_TTL_MS) {
			return {
				error: `job.expiresAt exceeds the ${MAX_TOOL_CRON_TTL_MS / 86_400_000}-day ceiling; renew the job (re-add the same name) instead of scheduling further out`,
			};
		}
		return { expiresAtMs: t };
	}
	return { expiresAtMs: nowMs + DEFAULT_TOOL_CRON_TTL_MS };
}

/** Whether a fire arrived past the payload's TTL (absent/null → never). */
export function isCronFireExpired(
	payload: Pick<CronFirePayload, "expiresAtMs">,
	nowMs: number,
): boolean {
	return typeof payload.expiresAtMs === "number" && nowMs > payload.expiresAtMs;
}

/**
 * Typed refusal for agent-tool mutations against a protected job name.
 * Protection is config-driven: `cronPolicy.protectedCronNames` on the tedi's
 * policy pack (D1) — settable only through the admin/policy surface, never
 * through the in-session tool, so an agent can neither delete a protected
 * watcher nor protect its own jobs into immortality. Returns null when the
 * mutation is admissible.
 */
export function protectedCronNameError(
	name: string | null | undefined,
	protectedNames: readonly string[],
	action: "remove" | "replace",
): string | null {
	const target = (name ?? "").trim();
	if (!target || !protectedNames.includes(target)) return null;
	return `cron job "${target}" is protected by policy (cronPolicy.protectedCronNames) and cannot be ${action === "remove" ? "removed" : "replaced"} from the in-session cron tool. Ask a platform operator to update the policy pack if this job should change.`;
}

// =============================================================================
// consolidation operators (WS2 trajectory mining)
// =============================================================================

/** Name of the daily skill-development cognitive cycle (policy-pack template). */
export const SKILL_DEVELOPMENT_CRON_NAME = "skill-development";

/**
 * Whether a cron fire should also run the deterministic trajectory miner —
 * the WS2 consolidation operator that mines recurring successful tool-call
 * routines from evidence-linked episodes into Skill Workshop draft proposals
 * (`skills.mineCandidates` via the platform client). Keyed on the
 * skill-development template name: the miner is the mechanical companion to
 * that cycle's LLM turn (PMAx — computation separated from interpretation),
 * so it rides the same fire and the same flywheel-health execution stamp.
 */
export function shouldRunTrajectoryMining(
	payload: Pick<CronFirePayload, "name">,
): boolean {
	return (payload?.name ?? "").trim() === SKILL_DEVELOPMENT_CRON_NAME;
}

// =============================================================================
// execution stamps (cron flywheel-health ledger)
// =============================================================================

/**
 * The start-phase execution stamp `onCronFire` writes to the durable
 * `tedi_cron_executions` ledger (via `HttpPlatformClient.recordCronExecution`)
 * before dispatching the turn workflow. The matching finish stamp is written
 * from `onWorkflowComplete` / the failure mirror when the workflow settles.
 * This ledger is what `flywheel.crons_flywheel_health` reports — mechanical
 * evidence a loop ran, independent of anything the LLM chose to write.
 */
export interface CronExecutionStartStamp {
	phase: "started";
	fireKey: string;
	cronName: string;
	runId: string;
	startedAt: string;
}

export interface CronExecutionFinishStamp {
	phase: "finished";
	fireKey: string;
	cronName: string;
	runId: string;
	startedAt: string;
	finishedAt: string;
	status: "failure";
	transitions: Record<string, unknown>;
	error: string;
}

export type CronPreDispatchFailureStage =
	| "stability_error"
	| "dispatch_context_error"
	| "workflow_dispatch_error";

const MAX_CRON_EXECUTION_ERROR_CHARS = 1_000;

function boundedCronExecutionError(error: unknown): string {
	let raw = "unknown runtime error";
	try {
		raw = error instanceof Error ? error.message : String(error);
	} catch {
		// A hostile/non-standard thrown value must not prevent terminal stamping.
	}
	const redacted = scrubText(raw);
	return redacted.length <= MAX_CRON_EXECUTION_ERROR_CHARS
		? redacted
		: `${redacted.slice(0, MAX_CRON_EXECUTION_ERROR_CHARS)}\n…(truncated)`;
}

/**
 * Build the start stamp for a fire, or `null` for unnamed jobs: every
 * cognitive-loop / watcher cron carries a payload name (templates always do;
 * the cron tool's upsert semantics key on it); nameless one-shot reminders are
 * not loop executions and would pollute the health ledger.
 */
export function buildCronExecutionStart(
	payload: Pick<CronFirePayload, "name">,
	fireKey: string,
	runId: string,
	nowMs: number,
): CronExecutionStartStamp | null {
	const cronName = (payload?.name ?? "").trim();
	if (!cronName) return null;
	return {
		phase: "started",
		fireKey,
		cronName,
		runId,
		startedAt: new Date(nowMs).toISOString(),
	};
}

/** Close a named fire that woke but could not cross the runtime stability gate. */
export function buildCronStabilityTimeoutFailure(
	start: CronExecutionStartStamp,
	nowMs: number,
): CronExecutionFinishStamp {
	return {
		phase: "finished",
		fireKey: start.fireKey,
		cronName: start.cronName,
		runId: start.runId,
		startedAt: start.startedAt,
		finishedAt: new Date(nowMs).toISOString(),
		status: "failure",
		transitions: { dispatched: false, stability: "timeout" },
		error: "conversation did not become stable within 30000ms",
	};
}

/**
 * Close a named fire whose pre-dispatch orchestration threw. These are separate
 * from a normal workflow failure because no workflow terminal callback is
 * guaranteed yet; the runtime that opened the row must seal it synchronously.
 */
export function buildCronPreDispatchFailure(
	start: CronExecutionStartStamp,
	nowMs: number,
	stage: CronPreDispatchFailureStage,
	error: unknown,
): CronExecutionFinishStamp {
	const stageTransitions: Record<
		CronPreDispatchFailureStage,
		Record<string, unknown>
	> = {
		stability_error: { dispatched: false, stability: "error" },
		dispatch_context_error: {
			dispatched: false,
			stability: "ready",
			dispatchContext: "error",
		},
		workflow_dispatch_error: {
			dispatched: false,
			stability: "ready",
			dispatchContext: "recorded",
			workflowDispatch: "error",
		},
	};
	return {
		phase: "finished",
		fireKey: start.fireKey,
		cronName: start.cronName,
		runId: start.runId,
		startedAt: start.startedAt,
		finishedAt: new Date(nowMs).toISOString(),
		status: "failure",
		transitions: stageTransitions[stage],
		error: boundedCronExecutionError(error),
	};
}

/**
 * Mechanical transitions summary for a settled cron turn, built from the
 * CHAT_TURN_WORKFLOW result (`{ text, stopReason, toolCalls }`). Defensive:
 * the result crosses a workflow/RPC boundary, so every field is re-checked.
 * Records only observable turn facts — never LLM claims.
 */
export function summarizeCronTurnTransitions(
	result: unknown,
): Record<string, unknown> {
	const r = result as
		| { text?: unknown; stopReason?: unknown; toolCalls?: unknown }
		| null
		| undefined;
	const toolCalls = Array.isArray(r?.toolCalls)
		? r.toolCalls
				.map((call) => {
					const c = call as { name?: unknown; ok?: unknown } | null | undefined;
					return typeof c?.name === "string"
						? { name: c.name, ok: c?.ok === true }
						: null;
				})
				.filter((call): call is { name: string; ok: boolean } => call !== null)
		: [];
	return {
		stopReason: typeof r?.stopReason === "string" ? r.stopReason : null,
		responseChars: typeof r?.text === "string" ? r.text.length : null,
		toolCalls,
	};
}
