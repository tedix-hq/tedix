import type { OsDerivedAccessEnvelope } from "@tedix/api-contract/schemas/os-workspaces";
/**
 * Skill + skill_runs data access.
 *
 * Worker-local adapter for the authoritative `skill_runs` snapshot and the
 * engine-confirmed lifecycle transitions owned by this runtime. The public
 * API uses `@tedix/db/queries/skill-runs`; this module deliberately keeps the
 * smaller binding-level projection needed during Workflow dispatch/resume.
 */

import { createDbClient } from "@tedix/db/client";
import { reconcileSkillWorkflowDispatchRationale } from "@tedix/db/queries/rationale-records";
import {
	recordMissingSkillMcpAppBindings,
	resolveSkillMcpNamespaceSlugs,
} from "@tedix/db/queries/cognitive/skill-mcp-bindings";
import { recordSkillRunOutcome } from "@tedix/db/queries/skill-usage";
import { logRuntimeFailure } from "./control-log";
import { isWorkflowRetirementError } from "./workflow-retirement";

/**
 * The partition discriminator persisted on `skill_runs.runtime_environment`.
 * This is a DATA shape, not the binding type: `ENVIRONMENT` is a plain config
 * string, and past rows still carry values (like "staging") that are no longer
 * deploy targets. Deriving it from the binding type broke the moment the
 * staging env was retired, so keep the two independent.
 */
export type SkillRunEnvironment = "development" | "staging" | "production";

/**
 * Narrow a raw `ENVIRONMENT` config string to the persisted enum. Unknown
 * values fall back to "production", matching the production Worker default.
 */
export function skillRunEnvironment(value: string): SkillRunEnvironment {
	return value === "development" || value === "staging" ? value : "production";
}

export interface SkillRunRow {
	runId: string;
	skillId: string;
	tediId: string;
	orgId: string;
	instanceId: string | null;
	executionEpoch: number;
	restartRequestedAt: string | null;
	restartCommandId: string | null;
	workflowRetiredAt: string | null;
	runtimeEnvironment: SkillRunEnvironment;
	status: string;
	error: string | null;
	createdAt: string;
	completedAt: string | null;
	pausedAt: string | null;
}

/** Insert a `skill_runs` row with an explicit pre-engine admission marker.
 *
 * Captures a frozen snapshot of the workflow source + SKILL.md +
 * revision + slug at dispatch time so the run loads exactly the code it
 * was started with, even if the skill is revised across hibernation
 * (step.waitForEvent / step.sleep). Snapshot fields are required by the
 * current dispatcher; null database values are treated as invalid runs.
 */
export async function createSkillRun(
	db: D1Database,
	input: {
		runId: string;
		skillId: string;
		tediId: string;
		orgId: string;
		workflowInstanceId: string;
		params: unknown;
		workflowSource?: string | null;
		skillDoc?: string | null;
		skillRevision?: number | null;
		skillSlug?: string | null;
		capabilityManifest?: unknown;
		resourceAccessEnvelope?: OsDerivedAccessEnvelope;
		createdBy?: string | null;
		workItemId?: string | null;
		originTediRunId?: string | null;
		runtimeEnvironment: "development" | "staging" | "production";
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO skill_runs (
				id, skill_id, tedi_id, organization_id,
				workflow_instance_id, params, status, error, started_at,
				workflow_source, skill_doc, skill_revision, skill_slug,
				capability_manifest, runtime_environment, created_by, work_item_id,
				origin_tedi_run_id, resource_access_envelope
			) VALUES (
				?1, ?2, ?3, ?4,
				?5, ?6, 'failed', 'WORKFLOW_ADMISSION_PENDING: workflow create not yet observed', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
				?7, ?8, ?9, ?10,
				?11, ?12, ?13, ?14, ?15, ?16
			)`,
		)
		.bind(
			input.runId,
			input.skillId,
			input.tediId,
			input.orgId,
			input.workflowInstanceId,
			JSON.stringify(input.params ?? {}),
			input.workflowSource ?? null,
			input.skillDoc ?? null,
			input.skillRevision ?? null,
			input.skillSlug ?? null,
			input.capabilityManifest != null
				? JSON.stringify(input.capabilityManifest)
				: null,
			input.runtimeEnvironment,
			input.createdBy ?? null,
			input.workItemId ?? null,
			input.originTediRunId ?? null,
			input.resourceAccessEnvelope
				? JSON.stringify(input.resourceAccessEnvelope)
				: null,
		)
		.run();
}

/**
 * Load the run's pinned workflow source + SKILL.md + slug, written
 * at dispatch time. Returns null when the row is invalid for execution.
 */
export interface SkillRunSnapshot {
	skillId: string;
	tediId: string;
	orgId: string;
	params: unknown;
	executionEpoch: number;
	runtimeEnvironment: "development" | "staging" | "production";
	admittedAt: string;
	skillSlug: string | null;
	skillRevision: number | null;
	workflowSource: string;
	skillDoc: string;
	capabilityManifest: unknown;
	resourceAccessEnvelope: OsDerivedAccessEnvelope | null;
	createdBy: string | null;
	workItemId: string | null;
	originTediRunId: string | null;
}

export async function loadSkillRunSnapshot(
	db: D1Database,
	runId: string,
): Promise<SkillRunSnapshot | null> {
	const row = await db
		.prepare(
			`SELECT skill_id, tedi_id, organization_id, params, execution_epoch,
			        runtime_environment, workflow_retired_at, error,
			        started_at,
			        skill_slug, skill_revision,
			        workflow_source, skill_doc, capability_manifest, resource_access_envelope, created_by,
			        work_item_id, origin_tedi_run_id
			 FROM skill_runs WHERE id = ?1 LIMIT 1`,
		)
		.bind(runId)
		.first<{
			skill_id: string;
			tedi_id: string;
			organization_id: string;
			params: string | null;
			execution_epoch: number;
			runtime_environment: "development" | "staging" | "production";
			workflow_retired_at: string | null;
			error: string | null;
			started_at: string;
			skill_slug: string | null;
			skill_revision: number | null;
			workflow_source: string | null;
			skill_doc: string | null;
			capability_manifest: string | null;
			resource_access_envelope: string | null;
			created_by: string | null;
			work_item_id: string | null;
			origin_tedi_run_id: string | null;
		}>();
	if (
		!row?.workflow_source ||
		row.workflow_retired_at != null ||
		isWorkflowRetirementError(row.error)
	) {
		return null;
	}
	return {
		skillId: row.skill_id,
		tediId: row.tedi_id,
		orgId: row.organization_id,
		params: row.params ? JSON.parse(row.params) : {},
		executionEpoch: row.execution_epoch ?? 0,
		runtimeEnvironment: row.runtime_environment,
		admittedAt: row.started_at,
		skillSlug: row.skill_slug,
		skillRevision: row.skill_revision,
		workflowSource: row.workflow_source,
		skillDoc: row.skill_doc ?? "",
		capabilityManifest: row.capability_manifest
			? JSON.parse(row.capability_manifest)
			: null,
		resourceAccessEnvelope: row.resource_access_envelope
			? JSON.parse(row.resource_access_envelope)
			: null,
		createdBy: row.created_by ?? null,
		workItemId: row.work_item_id ?? null,
		originTediRunId: row.origin_tedi_run_id ?? null,
	};
}

export async function getSkillRun(
	db: D1Database,
	runId: string,
	expectedEnvironment?: "development" | "staging" | "production",
): Promise<SkillRunRow | null> {
	const row = await db
		.prepare(
			`SELECT id, skill_id, tedi_id, organization_id, workflow_instance_id,
				        execution_epoch, restart_requested_at, restart_command_id,
				        workflow_retired_at,
				        runtime_environment,
			        status, error, started_at, completed_at, paused_at
			 FROM skill_runs WHERE id = ?1 LIMIT 1`,
		)
		.bind(runId)
		.first<{
			id: string;
			skill_id: string;
			tedi_id: string;
			organization_id: string;
			workflow_instance_id: string | null;
			execution_epoch: number;
			restart_requested_at: string | null;
			restart_command_id: string | null;
			workflow_retired_at: string | null;
			runtime_environment: "development" | "staging" | "production";
			status: string;
			error: string | null;
			started_at: string;
			completed_at: string | null;
			paused_at: string | null;
		}>();
	if (!row) return null;
	const run: SkillRunRow = {
		runId: row.id,
		skillId: row.skill_id,
		tediId: row.tedi_id,
		orgId: row.organization_id,
		instanceId: row.workflow_instance_id,
		executionEpoch: row.execution_epoch ?? 0,
		restartRequestedAt: row.restart_requested_at ?? null,
		restartCommandId: row.restart_command_id ?? null,
		workflowRetiredAt: row.workflow_retired_at ?? null,
		runtimeEnvironment: row.runtime_environment,
		status: row.status,
		error: row.error,
		createdAt: row.started_at,
		completedAt: row.completed_at,
		pausedAt: row.paused_at,
	};
	if (
		expectedEnvironment &&
		!skillRunEnvironmentMatches(run.runtimeEnvironment, expectedEnvironment)
	) {
		return null;
	}
	return run;
}

export function skillRunEnvironmentMatches(
	stored: SkillRunRow["runtimeEnvironment"],
	current: SkillRunEnvironment,
): boolean {
	return stored === current;
}

/** Reserve a collision-free identity epoch before an explicit engine restart. */
export async function reserveSkillRunExecutionEpoch(
	db: D1Database,
	runId: string,
	expectedExecutionEpoch: number,
	restartCommandId: string,
): Promise<number | null> {
	const row = await db
		.prepare(
			`UPDATE skill_runs
			 SET execution_epoch = execution_epoch + 1,
			     restart_requested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
			     restart_command_id = ?3
			 WHERE id = ?1
			   AND execution_epoch = ?2
			   AND restart_requested_at IS NULL
			   AND workflow_retired_at IS NULL
			   AND COALESCE(error, '') <> 'REVOKED'
			   AND COALESCE(error, '') NOT GLOB 'REVOKED:*'
			 RETURNING execution_epoch`,
		)
		.bind(runId, expectedExecutionEpoch, restartCommandId)
		.first<{ execution_epoch: number }>();
	return row?.execution_epoch ?? null;
}

/**
 * Persist a control state accepted by the Cloudflare Workflow engine. Pause,
 * resume, and cancel use a confirmed status read; restart uses the resolved
 * restart call plus its durable receipt and deliberately writes provisional
 * `queued` without trusting an immediate (possibly stale) terminal snapshot.
 * Restart clears stale terminal output/error data.
 */
export async function updateSkillRunAfterControl(
	db: D1Database,
	runId: string,
	status: string,
	options: {
		restart?: boolean;
		clearRestartIntent?: boolean;
		expectedExecutionEpoch?: number;
		requireAdmissionMarker?: boolean;
		requireRestartIntent?: boolean;
	} = {},
): Promise<boolean> {
	const now = new Date().toISOString();
	const terminal = ["completed", "failed", "canceled"].includes(status);
	const result = await db
		.prepare(
			`UPDATE skill_runs
			    SET status = ?2,
			        started_at = CASE
			          WHEN ?3 = 1 AND ?8 = 1
			            AND restart_requested_at IS NOT NULL THEN restart_requested_at
			          ELSE started_at
			        END,
			        result = CASE WHEN ?3 = 1 THEN NULL ELSE result END,
			        error = CASE WHEN ?3 = 1 THEN NULL ELSE error END,
			        cost_summary = CASE WHEN ?3 = 1 THEN NULL ELSE cost_summary END,
			        completed_at = CASE
			          WHEN ?3 = 1 THEN NULL
			          WHEN ?4 = 1 THEN COALESCE(completed_at, ?5)
			          ELSE completed_at
			        END,
			        paused_at = CASE
			          WHEN ?2 = 'paused' THEN COALESCE(paused_at, ?5)
			          ELSE NULL
			        END,
			        restart_requested_at = CASE
			          WHEN ?6 = 1 THEN NULL
			          ELSE restart_requested_at
			        END,
			        restart_command_id = CASE
			          WHEN ?6 = 1 THEN NULL
			          ELSE restart_command_id
			        END
			  WHERE id = ?1
			    AND (?7 IS NULL OR execution_epoch = ?7)
			    AND (?8 = 0 OR restart_requested_at IS NOT NULL)
			    AND (
			      ?9 = 0 OR (
			        status = 'failed' AND (
			          error LIKE 'WORKFLOW_ADMISSION_PENDING:%'
			          OR error LIKE 'WORKFLOW_ADMISSION_CREATE_FAILED:%'
			        )
			      )
			    )
			    AND (
			      status NOT IN ('completed','failed','canceled')
			      OR (?3 = 1 AND ?8 = 1 AND restart_requested_at IS NOT NULL)
			      OR (?3 = 1 AND ?9 = 1 AND status = 'failed' AND (
			        error LIKE 'WORKFLOW_ADMISSION_PENDING:%'
			        OR error LIKE 'WORKFLOW_ADMISSION_CREATE_FAILED:%'
			      ))
			    )`,
		)
		.bind(
			runId,
			status,
			options.restart ? 1 : 0,
			terminal ? 1 : 0,
			now,
			options.clearRestartIntent ? 1 : 0,
			options.expectedExecutionEpoch ?? null,
			options.requireRestartIntent ? 1 : 0,
			options.requireAdmissionMarker ? 1 : 0,
		)
		.run();
	return (result.meta?.changes ?? 0) === 1;
}

/**
 * Release an accepted restart fence only after the new execution epoch has
 * produced durable start evidence. The epoch predicate prevents a late poll
 * from clearing a newer restart's intent.
 */
export async function clearSkillRunRestartIntent(
	db: D1Database,
	runId: string,
	executionEpoch: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE skill_runs
			    SET restart_requested_at = NULL,
			        restart_command_id = NULL
			  WHERE id = ?1
			    AND execution_epoch = ?2
			    AND restart_requested_at IS NOT NULL`,
		)
		.bind(runId, executionEpoch)
		.run();
	return (result.meta?.changes ?? 0) === 1;
}

/**
 * Burn a verified no-start restart epoch as canceled after its exact durable
 * submission attempt has been canceled. The intent/command predicates make
 * this the final one-shot CAS in operator-abort recovery; retries recognize
 * the already-canceled row after this mutation rather than reopening it.
 */
export async function finalizeAbortedSkillRunRestart(
	db: D1Database,
	runId: string,
	executionEpoch: number,
	restartCommandId: string,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE skill_runs
			    SET status = 'canceled',
			        result = NULL,
			        error = NULL,
			        cost_summary = NULL,
			        started_at = restart_requested_at,
			        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
			        paused_at = NULL,
			        workflow_retired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
			        restart_requested_at = NULL,
			        restart_command_id = NULL
			  WHERE id = ?1
			    AND execution_epoch = ?2
			    AND restart_requested_at IS NOT NULL
			    AND restart_command_id = ?3`,
		)
		.bind(runId, executionEpoch, restartCommandId)
		.run();
	return (result.meta?.changes ?? 0) === 1;
}

/**
 * Reconcile a row to the engine-reported state. Sets `completed_at` /
 * `paused_at` based on transitions. Idempotent — callers can run this on a
 * cron without checking current status.
 */
export async function reconcileSkillRun(
	db: D1Database,
	runId: string,
	patch: {
		status: string;
		result?: unknown;
		error?: string | null;
		expectedExecutionEpoch?: number;
	},
): Promise<boolean> {
	const now = new Date().toISOString();
	const isTerminal = ["completed", "failed", "canceled"].includes(patch.status);
	const isPaused = patch.status === "paused";
	// RETURNING captures the execution epoch + restart intent ATOMICALLY with
	// the CAS so the terminal usage stamp below can be pinned to the epoch this
	// transition belongs to (an operator restart racing in between would
	// otherwise re-read a bumped epoch and mis-attribute the old outcome).
	const casRow = await db
		.prepare(
			`UPDATE skill_runs
			   SET status = ?2,
			       result = COALESCE(?3, result),
			       error = COALESCE(?4, error),
			       completed_at = CASE WHEN ?5 = 1 AND completed_at IS NULL THEN ?6 ELSE completed_at END,
			       paused_at = CASE WHEN ?7 = 1 AND paused_at IS NULL THEN ?6 ELSE paused_at END
			 WHERE id = ?1
			   AND (?8 IS NULL OR execution_epoch = ?8)
			   AND (
			     status NOT IN ('completed','failed','canceled')
			     OR (
			       status = 'failed'
			       AND ?2 = 'failed'
			       AND (error LIKE 'WORKFLOW_ADMISSION_PENDING:%'
			            OR error LIKE 'WORKFLOW_ADMISSION_CREATE_FAILED:%')
			     )
			   )
			 RETURNING execution_epoch, restart_requested_at`,
		)
		.bind(
			runId,
			patch.status,
			patch.result === undefined ? null : JSON.stringify(patch.result),
			patch.error ?? null,
			isTerminal ? 1 : 0,
			now,
			isPaused ? 1 : 0,
			patch.expectedExecutionEpoch ?? null,
		)
		.first<{
			execution_epoch: number;
			restart_requested_at: string | null;
		}>();
	const reconciled = casRow != null;
	// Every terminal completed/failed transition funnels through this CAS, so
	// this is the single choke point that stamps the canonical skill usage
	// ledger (skill_usage_events + success/failure counters). Idempotent per
	// (run, execution epoch); canceled and admission-marker (never-executed)
	// outcomes are skipped inside recordSkillRunOutcome. Stamping must never
	// break reconciliation, so failures only log.
	if (patch.status === "completed" || patch.status === "failed") {
		try {
			if (reconciled) {
				// Won the CAS: stamp pinned to the CAS-captured (status, epoch) so a
				// restart racing between the CAS and this stamp cannot shift the old
				// outcome onto the new epoch. If the restart intent was already
				// pending at CAS time, the outcome is superseded — skip.
				if (casRow.restart_requested_at == null) {
					await recordSkillRunOutcome(createDbClient(db), runId, {
						expected: {
							status: patch.status,
							executionEpoch: casRow.execution_epoch ?? 0,
						},
					});
				}
			} else {
				// Lost the CAS (row already terminal): self-heal backstop for the
				// crash-between-CAS-and-stamp window. The idempotent (run, epoch)
				// insert makes stamping observed terminal-but-unstamped state safe;
				// already-stamped rows no-op as duplicates and rows with a pending
				// restart intent are skipped inside recordSkillRunOutcome.
				await recordSkillRunOutcome(createDbClient(db), runId);
			}
		} catch (error) {
			logRuntimeFailure("workflow.skill_usage_stamp.failed", error, runId);
		}
	}
	// The dispatch rationale describes the whole workflow outcome, not merely
	// admission. Reconcile it at the same terminal CAS and attach the canonical
	// per-call receipts recorded by the workflow shim. This intentionally repairs
	// older dispatch rows that were prematurely closed as success.
	if (reconciled && isTerminal) {
		try {
			await reconcileSkillWorkflowDispatchRationale(createDbClient(db), {
				runId,
				status: patch.status as "completed" | "failed" | "canceled",
				error: patch.error,
				completedAt: now,
			});
		} catch (error) {
			logRuntimeFailure(
				"workflow.dispatch_rationale_reconciliation.failed",
				error,
				runId,
			);
		}
	}
	return reconciled;
}

/**
 * Resolve manifest-friendly namespace names to real apps/mcp slugs.
 * Lookup order: exact slug match, then `${namespace}-tedix` (the common
 * tedix-aggregator pattern). Returns a map; namespaces with no match get
 * an underscore→dash fallback handled by the dispatch shim.
 */
export async function resolveNamespaceSlugs(
	db: D1Database,
	namespaces: string[],
): Promise<Record<string, string>> {
	if (namespaces.length === 0) return {};
	const candidates = new Set<string>();
	for (const ns of namespaces) {
		candidates.add(ns);
		candidates.add(`${ns}-tedix`);
		candidates.add(ns.replace(/_/g, "-"));
	}
	const placeholders = Array.from(candidates)
		.map((_, i) => `?${i + 1}`)
		.join(",");
	const stmt = db
		.prepare(`SELECT slug FROM apps WHERE slug IN (${placeholders})`)
		.bind(...Array.from(candidates));
	const res = await stmt.all<{ slug: string }>();
	const known = new Set((res.results ?? []).map((r) => r.slug));

	const out: Record<string, string> = {};
	for (const ns of namespaces) {
		if (known.has(ns)) {
			out[ns] = ns;
		} else if (known.has(`${ns}-tedix`)) {
			out[ns] = `${ns}-tedix`;
		} else if (known.has(ns.replace(/_/g, "-"))) {
			out[ns] = ns.replace(/_/g, "-");
		}
		// else: leave unset; resolveMcpTarget routes unmapped namespaces to the
		// org-wide aggregate under the prefixed wire name (gateway namespaces
		// like `seo`/`cognitive` are not apps).
	}
	return out;
}

/**
 * Namespace → slug map for a skill run's declared namespaces. A namespace the
 * skill bound to an app id (`skill_entries.mcp_app_bindings`) routes to that
 * app's current slug, so an app rename does not detach the skill; unbound
 * namespaces keep the slug matching of {@link resolveNamespaceSlugs}.
 *
 * Lazy backfill: a namespace that still resolved by slug is bound to that
 * app (org-owned or public only) so a later rename keeps working. The write is
 * best-effort and never changes this run's routing.
 */
export async function resolveSkillNamespaceSlugs(
	db: D1Database,
	params: {
		orgId: string;
		skillId: string;
		namespaces: string[];
		runId?: string;
	},
): Promise<Record<string, string>> {
	if (params.namespaces.length === 0) return {};
	const client = createDbClient(db);
	let resolved: Awaited<ReturnType<typeof resolveSkillMcpNamespaceSlugs>>;
	try {
		resolved = await resolveSkillMcpNamespaceSlugs(client, {
			organizationId: params.orgId,
			skillId: params.skillId,
			namespaces: params.namespaces,
		});
	} catch (error) {
		logRuntimeFailure(
			"workflow.mcp_app_binding_lookup.failed",
			error,
			params.runId,
		);
		return resolveNamespaceSlugs(db, params.namespaces);
	}
	if (Object.keys(resolved.backfill).length > 0) {
		try {
			await recordMissingSkillMcpAppBindings(client, {
				organizationId: params.orgId,
				skillId: params.skillId,
				bindings: resolved.backfill,
			});
		} catch (error) {
			logRuntimeFailure(
				"workflow.mcp_app_binding_backfill.failed",
				error,
				params.runId,
			);
		}
	}
	return resolved.namespaceToSlug;
}

/**
 * Org-owned Code Mode gateway plus the owning tedi's configured namespace.
 *
 * Neither value is safely derivable from the organization/tedi slug:
 * `acme-s-workspace-*` owns `acme-unified`, and a tedi such as
 * `acme-operator` is intentionally exposed as `operator`. Resolve both from
 * the same organization-scoped app metadata that apps/mcp uses to construct
 * the aggregate surface. The tedi lookup is also organization-scoped so a
 * forged cross-tenant run tuple fails closed.
 */
export interface SkillWorkflowMcpGateway {
	slug: string;
	tediNamespace: string | null;
}

interface AggregateGatewayRow {
	organization_id: string;
	slug: string;
	metadata: unknown;
}

function parseAppMetadata(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function configuredTediNamespace(
	metadata: Record<string, unknown>,
	tediSlug: string,
): string | null {
	const mcpConfig =
		metadata.mcpConfig && typeof metadata.mcpConfig === "object"
			? (metadata.mcpConfig as Record<string, unknown>)
			: null;
	const aggregateTedis = mcpConfig?.aggregateTedis;
	if (!Array.isArray(aggregateTedis)) return null;
	for (const value of aggregateTedis) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (entry.slug !== tediSlug) continue;
		const rawNamespace =
			typeof entry.namespace === "string" && entry.namespace.trim()
				? entry.namespace
				: tediSlug;
		return rawNamespace.replace(/[^a-zA-Z0-9_]/g, "_");
	}
	return null;
}

export async function resolveSkillWorkflowMcpGateway(
	db: D1Database,
	organizationId: string,
	tediId: string,
): Promise<SkillWorkflowMcpGateway | null> {
	const tedi = await db
		.prepare("SELECT slug FROM tedis WHERE id = ?1 AND organization_id = ?2")
		.bind(tediId, organizationId)
		.first<{ slug: string }>();
	if (!tedi?.slug) return null;

	const rows = await db
		.prepare(
			`SELECT organization_id, slug, metadata
			   FROM apps
			  WHERE organization_id = ?1`,
		)
		.bind(organizationId)
		.all<AggregateGatewayRow>();
	const candidates: SkillWorkflowMcpGateway[] = [];
	for (const row of rows.results ?? []) {
		if (row.organization_id !== organizationId) continue;
		const metadata = parseAppMetadata(row.metadata);
		if (!metadata) continue;
		const mcpConfig =
			metadata.mcpConfig && typeof metadata.mcpConfig === "object"
				? (metadata.mcpConfig as Record<string, unknown>)
				: null;
		const aggregateApps = mcpConfig?.aggregateApps;
		if (
			!mcpConfig ||
			!Array.isArray(aggregateApps) ||
			aggregateApps.length === 0 ||
			mcpConfig.authMode !== "authenticated" ||
			mcpConfig.codeMode !== true
		) {
			continue;
		}
		candidates.push({
			slug: row.slug,
			tediNamespace: configuredTediNamespace(metadata, tedi.slug),
		});
	}
	const chosen =
		candidates.find((candidate) => candidate.slug.endsWith("-unified")) ??
		candidates[0];
	return chosen ?? null;
}

/** Pending/running rows plus terminal rows with an unresolved restart intent. */
export async function listNonTerminalRuns(
	db: D1Database,
	runtimeEnvironment: "development" | "staging" | "production",
	limit = 50,
): Promise<
	Array<{
		runId: string;
		skillId: string;
		tediId: string;
		workflowInstanceId: string;
		organizationId: string;
		params: unknown;
		status: string;
		executionEpoch: number;
		restartRequestedAt: string | null;
		restartCommandId: string | null;
		admissionRecovery: boolean;
	}>
> {
	const res = await db
		.prepare(
			`SELECT id, skill_id, tedi_id, workflow_instance_id, organization_id,
			        params, status, error,
			        execution_epoch, restart_requested_at, restart_command_id
			   FROM skill_runs
			  WHERE runtime_environment = ?1
			    AND workflow_retired_at IS NULL
			    AND COALESCE(error, '') <> 'REVOKED'
			    AND COALESCE(error, '') NOT GLOB 'REVOKED:*'
			    AND (status IN ('queued','running','paused')
			         OR restart_requested_at IS NOT NULL
			         OR (status = 'failed'
			             AND (error LIKE 'WORKFLOW_ADMISSION_CREATE_FAILED:%'
			                  OR error LIKE 'WORKFLOW_ADMISSION_PENDING:%')))
			  ORDER BY COALESCE(last_reconciled_at, started_at) ASC, started_at ASC
			  LIMIT ?2`,
		)
		.bind(runtimeEnvironment, limit)
		.all<{
			id: string;
			skill_id: string;
			tedi_id: string;
			workflow_instance_id: string;
			organization_id: string;
			params: string | null;
			status: string;
			error: string | null;
			execution_epoch: number;
			restart_requested_at: string | null;
			restart_command_id: string | null;
		}>();
	return (res.results ?? []).map((r) => ({
		runId: r.id,
		skillId: r.skill_id,
		tediId: r.tedi_id,
		workflowInstanceId: r.workflow_instance_id,
		organizationId: r.organization_id,
		params: r.params ? JSON.parse(r.params) : {},
		status: r.status,
		admissionRecovery:
			r.status === "failed" &&
			(r.error?.startsWith("WORKFLOW_ADMISSION_CREATE_FAILED:") === true ||
				r.error?.startsWith("WORKFLOW_ADMISSION_PENDING:") === true),
		executionEpoch: r.execution_epoch,
		restartRequestedAt: r.restart_requested_at ?? null,
		restartCommandId: r.restart_command_id ?? null,
	}));
}

/** Advance the fair-scan cursor even when engine state did not change. */
export async function touchSkillRunReconciled(
	db: D1Database,
	runId: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE skill_runs
			    SET last_reconciled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			  WHERE id = ?1`,
		)
		.bind(runId)
		.run();
}

export interface SkillRunArtifactStorageRow {
	id: string;
	size_bytes: number;
	content_r2_key: string | null;
	sha256: string | null;
}

export async function getSkillRunArtifactStorageRow(
	db: D1Database,
	runId: string,
	path: string,
): Promise<SkillRunArtifactStorageRow | null> {
	return db
		.prepare(
			`SELECT id, size_bytes, content_r2_key, sha256
			 FROM skill_run_artifacts
			 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
		)
		.bind(runId, path)
		.first<SkillRunArtifactStorageRow>();
}

export async function insertSkillRunArtifactOnce(
	db: D1Database,
	input: {
		id: string;
		runId: string;
		path: string;
		mimeType: string;
		sizeBytes: number;
		contentInline: string | null;
		contentR2Key: string | null;
		sha256: string | null;
		attempt: number;
		outcome: string;
	},
): Promise<boolean> {
	const inserted = await db
		.prepare(
			`INSERT OR IGNORE INTO skill_run_artifacts (
				id, run_id, path, mime_type, size_bytes, content_inline,
				content_r2_key, sha256, attempt, outcome
			) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
		)
		.bind(
			input.id,
			input.runId,
			input.path,
			input.mimeType,
			input.sizeBytes,
			input.contentInline,
			input.contentR2Key,
			input.sha256,
			input.attempt,
			input.outcome,
		)
		.run();
	return (inserted.meta.changes ?? 0) > 0;
}

export async function listSkillRunArtifactInlineContent(
	db: D1Database,
	runId: string,
	paths: string[],
): Promise<Array<{ path: string; content_inline: string | null }>> {
	if (paths.length === 0) return [];
	const placeholders = paths.map((_, index) => `?${index + 2}`).join(",");
	const rows = await db
		.prepare(
			`SELECT path, content_inline FROM skill_run_artifacts
			 WHERE run_id = ?1 AND path IN (${placeholders})`,
		)
		.bind(runId, ...paths)
		.all<{ path: string; content_inline: string | null }>();
	return rows.results ?? [];
}

export async function getSkillRunArtifactInlineContent(
	db: D1Database,
	runId: string,
	path: string,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT content_inline FROM skill_run_artifacts
			 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
		)
		.bind(runId, path)
		.first<{ content_inline: string | null }>();
	return row?.content_inline ?? null;
}

export async function claimSkillWorkflowAdmissionFence(
	db: D1Database,
	input: {
		fingerprint: string;
		candidateRunId: string;
		expiresAt: string;
		now: string;
	},
): Promise<{ run_id: string; expires_at: string } | null> {
	return db
		.prepare(
			`INSERT INTO skill_run_admission_dedup (
				fingerprint, run_id, expires_at, created_at
			) VALUES (?1, ?2, ?3, ?4)
			ON CONFLICT(fingerprint) DO UPDATE SET
				run_id = excluded.run_id,
				expires_at = excluded.expires_at,
				created_at = excluded.created_at
			WHERE skill_run_admission_dedup.expires_at <= ?4
			RETURNING run_id, expires_at`,
		)
		.bind(input.fingerprint, input.candidateRunId, input.expiresAt, input.now)
		.first();
}

export async function getSkillWorkflowAdmissionFence(
	db: D1Database,
	fingerprint: string,
): Promise<{ run_id: string; expires_at: string } | null> {
	return db
		.prepare(
			`SELECT run_id, expires_at
			 FROM skill_run_admission_dedup
			 WHERE fingerprint = ?1
			 LIMIT 1`,
		)
		.bind(fingerprint)
		.first();
}

export async function pruneSkillWorkflowAdmissionFences(
	db: D1Database,
	retentionCutoff: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM skill_run_admission_dedup WHERE expires_at < ?1")
		.bind(retentionCutoff)
		.run();
}

export async function releaseSkillWorkflowAdmissionFence(
	db: D1Database,
	input: { fingerprint: string; runId: string },
): Promise<void> {
	await db
		.prepare(
			`DELETE FROM skill_run_admission_dedup
			 WHERE fingerprint = ?1 AND run_id = ?2`,
		)
		.bind(input.fingerprint, input.runId)
		.run();
}
