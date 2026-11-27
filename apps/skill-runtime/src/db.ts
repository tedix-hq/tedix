import type { OsDerivedAccessEnvelope } from "@tedix/api-contract/schemas/os-workspaces";
/**
 * Skill + skill_runs data access.
 *
 * Worker-local adapter for the authoritative `skill_runs` snapshot and the
 * engine-confirmed lifecycle transitions owned by this runtime. The public
 * API uses `@tedix/db/queries/skill-runs`; this module deliberately keeps the
 * smaller binding-level projection needed during Workflow dispatch/resume.
 */

import type { DbClient } from "@tedix/db/client";
import { coreDb, scopedCoreQueryDb } from "@tedix/db/core-store/scope";
import * as runtimeStore from "@tedix/db/queries/skill-runtime-store";

import {
	createPinnedSkillRun,
	createPinnedSkillRunWithinCap,
	getPinnedSkillWorkflowSource,
	listSkillRunsAwaitingReconcile,
	type CreatePinnedSkillRunParams,
} from "@tedix/db/queries/skill-runs";
import { reconcileSkillWorkflowDispatchRationale } from "@tedix/db/queries/rationale-records";
import {
	recordMissingSkillMcpAppBindings,
	repairSkillMcpAppBindings,
	resolveSkillMcpNamespaceSlugs,
} from "@tedix/db/queries/cognitive/skill-mcp-bindings";
import { recordSkillRunOutcome } from "@tedix/db/queries/skill-usage";
import { logRuntimeFailure } from "./control-log";
import { isWorkflowRetirementError } from "./workflow-retirement";

/** Preserve binding callers while selecting the request's core store.
 * Inside a Postgres scope the scoped client wins, so a D1 binding or client
 * can never silently read D1 there. */
export function skillRuntimeDb(db: D1Database | DbClient): DbClient {
	const scoped = scopedCoreQueryDb();
	if (scoped) return scoped as unknown as DbClient;
	return "prepare" in db ? coreDb({ DB: db }) : db;
}

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
	createdAt: string | null;
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
	db: D1Database | DbClient,
	input: CreatePinnedSkillRunParams,
): Promise<void> {
	await createPinnedSkillRun(skillRuntimeDb(db), input);
}

/** Same snapshot insert, refused (false) once `cap.max` runs of the skill are open. */
export function createSkillRunWithinCap(
	db: D1Database | DbClient,
	input: CreatePinnedSkillRunParams,
	cap: { max: number; since: string },
): Promise<boolean> {
	return createPinnedSkillRunWithinCap(skillRuntimeDb(db), input, cap);
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
	certification?: boolean;
	createdBy: string | null;
	workItemId: string | null;
	originTediRunId: string | null;
}

export async function loadSkillRunSnapshot(
	db: D1Database | DbClient,
	runId: string,
): Promise<SkillRunSnapshot | null> {
	const row = await runtimeStore.loadSkillRunSnapshotRow(
		skillRuntimeDb(db),
		runId,
	);
	if (row && !row.workflow_source)
		row.workflow_source = await getPinnedSkillWorkflowSource(
			skillRuntimeDb(db),
			runId,
		);
	if (
		!row?.workflow_source ||
		!row.started_at ||
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
		certification: row.certification === true,
		createdBy: row.created_by ?? null,
		workItemId: row.work_item_id ?? null,
		originTediRunId: row.origin_tedi_run_id ?? null,
	};
}

export async function getSkillRun(
	db: D1Database | DbClient,
	runId: string,
	expectedEnvironment?: "development" | "staging" | "production",
): Promise<SkillRunRow | null> {
	const row = await runtimeStore.getSkillRunRow(skillRuntimeDb(db), runId);
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
	db: D1Database | DbClient,
	runId: string,
	expectedExecutionEpoch: number,
	restartCommandId: string,
): Promise<number | null> {
	return runtimeStore.reserveSkillRunExecutionEpoch(
		skillRuntimeDb(db),
		runId,
		expectedExecutionEpoch,
		restartCommandId,
	);
}

/**
 * Persist a control state accepted by the Cloudflare Workflow engine. Pause,
 * resume, and cancel use a confirmed status read; restart uses the resolved
 * restart call plus its durable receipt and deliberately writes provisional
 * `queued` without trusting an immediate (possibly stale) terminal snapshot.
 * Restart clears stale terminal output/error data.
 */
export async function updateSkillRunAfterControl(
	db: D1Database | DbClient,
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
	return runtimeStore.updateSkillRunAfterControl(
		skillRuntimeDb(db),
		runId,
		status,
		options,
	);
}

/**
 * Release an accepted restart fence only after the new execution epoch has
 * produced durable start evidence. The epoch predicate prevents a late poll
 * from clearing a newer restart's intent.
 */
export async function clearSkillRunRestartIntent(
	db: D1Database | DbClient,
	runId: string,
	executionEpoch: number,
): Promise<boolean> {
	return runtimeStore.clearSkillRunRestartIntent(
		skillRuntimeDb(db),
		runId,
		executionEpoch,
	);
}

/**
 * Burn a verified no-start restart epoch as canceled after its exact durable
 * submission attempt has been canceled. The intent/command predicates make
 * this the final one-shot CAS in operator-abort recovery; retries recognize
 * the already-canceled row after this mutation rather than reopening it.
 */
export async function finalizeAbortedSkillRunRestart(
	db: D1Database | DbClient,
	runId: string,
	executionEpoch: number,
	restartCommandId: string,
): Promise<boolean> {
	return runtimeStore.finalizeAbortedSkillRunRestart(
		skillRuntimeDb(db),
		runId,
		executionEpoch,
		restartCommandId,
	);
}

/**
 * Reconcile a row to the engine-reported state. Sets `completed_at` /
 * `paused_at` based on transitions. Idempotent — callers can run this on a
 * cron without checking current status.
 */
export async function reconcileSkillRun(
	db: D1Database | DbClient,
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
	// RETURNING captures the execution epoch + restart intent ATOMICALLY with
	// the CAS so the terminal usage stamp below can be pinned to the epoch this
	// transition belongs to (an operator restart racing in between would
	// otherwise re-read a bumped epoch and mis-attribute the old outcome).
	const casRow = await runtimeStore.reconcileSkillRunRow(
		skillRuntimeDb(db),
		runId,
		patch,
		now,
	);
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
					await recordSkillRunOutcome(skillRuntimeDb(db), runId, {
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
				await recordSkillRunOutcome(skillRuntimeDb(db), runId);
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
			await reconcileSkillWorkflowDispatchRationale(skillRuntimeDb(db), {
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
	db: D1Database | DbClient,
	namespaces: string[],
): Promise<Record<string, string>> {
	if (namespaces.length === 0) return {};
	const candidates = new Set<string>();
	for (const ns of namespaces) {
		candidates.add(ns);
		candidates.add(`${ns}-tedix`);
		candidates.add(ns.replace(/_/g, "-"));
	}
	const rows = await runtimeStore.listRuntimeAppSlugs(
		skillRuntimeDb(db),
		Array.from(candidates),
	);
	const known = new Set(rows.map((row) => row.slug));

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
	db: D1Database | DbClient,
	params: {
		orgId: string;
		skillId: string;
		namespaces: string[];
		runId?: string;
	},
): Promise<Record<string, string>> {
	if (params.namespaces.length === 0) return {};
	const client = skillRuntimeDb(db);
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
	if (Object.keys(resolved.repair).length > 0) {
		try {
			await repairSkillMcpAppBindings(client, {
				organizationId: params.orgId,
				skillId: params.skillId,
				bindings: resolved.repair,
			});
		} catch (error) {
			logRuntimeFailure(
				"workflow.mcp_app_binding_repair.failed",
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
	db: D1Database | DbClient,
	organizationId: string,
	tediId: string,
): Promise<SkillWorkflowMcpGateway | null> {
	const tedi = await runtimeStore.getRuntimeTediSlug(
		skillRuntimeDb(db),
		organizationId,
		tediId,
	);
	if (!tedi?.slug) return null;

	const rows = await runtimeStore.listRuntimeGatewayApps(
		skillRuntimeDb(db),
		organizationId,
	);
	const candidates: SkillWorkflowMcpGateway[] = [];
	for (const row of rows) {
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
	db: D1Database | DbClient,
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
		startedAt: string | null;
	}>
> {
	const rows = await listSkillRunsAwaitingReconcile(
		skillRuntimeDb(db),
		runtimeEnvironment,
		limit,
	);
	return rows.map((r) => ({
		runId: r.id,
		skillId: r.skillId,
		tediId: r.tediId,
		workflowInstanceId: r.workflowInstanceId,
		organizationId: r.organizationId,
		params: r.params ?? {},
		status: r.status,
		admissionRecovery:
			r.status === "failed" &&
			(r.error?.startsWith("WORKFLOW_ADMISSION_CREATE_FAILED:") === true ||
				r.error?.startsWith("WORKFLOW_ADMISSION_PENDING:") === true),
		executionEpoch: r.executionEpoch,
		restartRequestedAt: r.restartRequestedAt ?? null,
		restartCommandId: r.restartCommandId ?? null,
		startedAt: r.startedAt ?? null,
	}));
}

/** Advance the fair-scan cursor even when engine state did not change. */
export async function touchSkillRunReconciled(
	db: D1Database | DbClient,
	runId: string,
): Promise<void> {
	return runtimeStore.touchSkillRunReconciled(skillRuntimeDb(db), runId);
}

export type SkillRunArtifactStorageRow = NonNullable<
	Awaited<ReturnType<typeof runtimeStore.getSkillRunArtifactStorageRow>>
>;

export async function getSkillRunArtifactStorageRow(
	db: D1Database | DbClient,
	runId: string,
	path: string,
): Promise<SkillRunArtifactStorageRow | null> {
	return runtimeStore.getSkillRunArtifactStorageRow(
		skillRuntimeDb(db),
		runId,
		path,
	);
}

export async function insertSkillRunArtifactOnce(
	db: D1Database | DbClient,
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
	return runtimeStore.insertSkillRunArtifactOnce(skillRuntimeDb(db), input);
}

export async function listSkillRunArtifactInlineContent(
	db: D1Database | DbClient,
	runId: string,
	paths: string[],
	bucket?: R2Bucket,
): Promise<Array<{ path: string; content_inline: string | null }>> {
	const rows: Array<{ path: string; content_inline: string | null }> = [];
	for (const path of paths)
		rows.push({
			path,
			content_inline: await getSkillRunArtifactInlineContent(
				db,
				runId,
				path,
				bucket,
			),
		});
	return rows;
}

export async function getSkillRunArtifactInlineContent(
	db: D1Database | DbClient,
	runId: string,
	path: string,
	bucket?: R2Bucket,
): Promise<string | null> {
	const inline = await runtimeStore.getRuntimeArtifactInlineContent(
		skillRuntimeDb(db),
		runId,
		path,
	);
	if (inline?.content_inline != null) return inline.content_inline;
	if (!bucket) return null;
	const { getRunArtifact } =
		await import("@tedix/db/queries/skill-run-artifacts");
	const run = await getSkillRun(db, runId);
	if (!run) return null;
	const row = await getRunArtifact(
		skillRuntimeDb(db),
		{ organizationId: run.orgId },
		runId,
		path,
	);
	if (!row?.contentR2Key) return null;
	const object = await bucket.get(row.contentR2Key);
	if (!object) throw new Error("SKILL_ARTIFACT_BODY_UNAVAILABLE");
	return object.text();
}

export async function claimSkillWorkflowAdmissionFence(
	db: D1Database | DbClient,
	input: {
		fingerprint: string;
		candidateRunId: string;
		expiresAt: string;
		now: string;
	},
): Promise<{ run_id: string; expires_at: string } | null> {
	return runtimeStore.claimSkillWorkflowAdmissionFence(
		skillRuntimeDb(db),
		input,
	);
}

export async function getSkillWorkflowAdmissionFence(
	db: D1Database | DbClient,
	fingerprint: string,
): Promise<{ run_id: string; expires_at: string } | null> {
	return runtimeStore.getSkillWorkflowAdmissionFence(
		skillRuntimeDb(db),
		fingerprint,
	);
}

export async function pruneSkillWorkflowAdmissionFences(
	db: D1Database | DbClient,
	retentionCutoff: string,
): Promise<void> {
	return runtimeStore.pruneSkillWorkflowAdmissionFences(
		skillRuntimeDb(db),
		retentionCutoff,
	);
}

export async function releaseSkillWorkflowAdmissionFence(
	db: D1Database | DbClient,
	input: { fingerprint: string; runId: string },
): Promise<void> {
	return runtimeStore.releaseSkillWorkflowAdmissionFence(
		skillRuntimeDb(db),
		input,
	);
}

/** Bounded, epoch-scoped scan used before asserting workflow completion. */
export async function listWorkflowCallReceiptStorage(
	db: D1Database | DbClient,
	organizationId: string,
	runId: string,
	executionEpoch: number,
	after: string,
): Promise<
	Array<{
		path: string;
		content_inline: string | null;
		content_r2_key: string | null;
	}>
> {
	return runtimeStore.listWorkflowCallReceiptStorage(
		skillRuntimeDb(db),
		organizationId,
		runId,
		executionEpoch,
		after,
	);
}
