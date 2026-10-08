/**
 * Tedi Capability Cards — bounded, canonical-D1 capability projection.
 *
 * The Kernel's per-turn context lists tedis thin (id/slug/name/runtimeKind/
 * status). This module enriches each org tedi into a BOUNDED capability card
 * sourced from canonical D1 (+ config-driven assignment policy), so the kernel's
 * `delegate_tedi` step can move from recognition to authorized dispatch.
 *
 * SOURCING (all canonical, no Neo4j / no A2A):
 *   - tedis             → `getTedisByOrganization` (org-indexed)
 *   - apps              → `getAppsByOrganization` (org-indexed) + the
 *                         config-driven `computeManagedAssignmentsForTedi`
 *                         projection. NOTE: the AUTHORITATIVE app→tedi binding
 *                         is Descope FGA (operator/observer relations). FGA
 *                         resolution requires a Descope management client and
 *                         per-app `whoCanAccess` round-trips — NOT available on
 *                         the kernel's `db`-only hot path, and an N×apps fan-out
 *                         we deliberately avoid. We use the cheap D1 projection
 *                         (`mcpConfig.assignmentConfig` profile-default rules)
 *                         which mirrors what provisioning grants in FGA. This
 *                         can diverge from manual FGA grants; the card is a
 *                         planning hint, not the dispatch authority.
 *   - skills            → `skill_entries` rows for the org, grouped by tediId
 *                         (org + tedi indexed: `idx_skill_entries_tedi`).
 *   - scopeGroups       → coarse capability/scope groups derived from assigned
 *                         apps' capabilities + the tedi's `mcpCapabilityProfile`
 *                         scope set (`resolveTediScopes`).
 *   - requiresApproval  → policy pack governance flag (autoDispatch/autoApprove);
 *                         default `true` (fail-safe) when not cheaply derivable.
 *
 * COST: bounded, fixed read path — exactly four indexed org-scoped reads
 * (tedis, apps, skill_entries, policy_packs), regardless of tedi count. No FGA,
 * no N+1. Per-tedi enrichment is pure in-memory. Fail-soft: a tedi whose
 * enrichment throws degrades to a thin card (empty arrays, requiresApproval
 * true) rather than failing the whole assembly.
 */

import {
	computeManagedAssignmentsForTedi,
	resolveTediScopes,
} from "@tedix/auth/app-assignment-policy";
import type { DbClient } from "@tedix/db/client";
import { getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import {
	getTediLearnedCapabilities,
	type TediLearnedCapability,
} from "@tedix/db/queries/cognitive/learned-capabilities";
import { listSkillLabelsByTediIds } from "@tedix/db/queries/cognitive/skill-catalog";
import {
	getActiveOrganizationPolicyPackDefinition,
	getPolicyPackDefinitionsByIds,
} from "@tedix/db/queries/control-plane/definitions";
import {
	type ActiveDelegationEntrustmentProjection,
	getActiveDelegationEntrustmentProjections,
} from "@tedix/db/queries/earned-delegation/entrustments";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import {
	getWorkstationReadinessByTedi,
	type WorkstationReadiness,
} from "@tedix/db/queries/workstations";
import type { App } from "@tedix/db/schema/apps";
import type { Tedi } from "@tedix/db/schema/tedis";
import {
	type DispatchPolicyLayer,
	parseDispatchPolicyLayer,
} from "./dispatch-policy";

// ============================================================================
// Public contract — SHARED with delegation-dispatch.ts. Keep verbatim.
// ============================================================================

export interface TediCapabilityCard {
	tediId: string;
	/** Stable tedi slug — subdomain/identity key. */
	slug: string;
	/** displayName || name || slug. */
	name: string;
	/** Assigned app slugs (config-driven D1 projection of FGA assignment). */
	apps: string[];
	/** Coarse capability/scope groups, e.g. "deploy:read". Small + deduped. */
	scopeGroups: string[];
	/** Registered skill slugs/names for this tedi. */
	skills: string[];
	/** isolate | container. */
	runtimeKind: string;
	/**
	 * Whether this tedi can carry embodied work — shell, filesystem,
	 * long-running processes, coding sessions. This may come from a runtime body
	 * or from a configured workstation adapter.
	 */
	embodied: boolean;
	/** running | standby | archived | sleeping. */
	availability: string;
	/**
	 * Whether the tedi currently holds a WARM workstation lease — the durable,
	 * config-driven "the workstation is up right now" signal (a current
	 * `workstation_leases` seat via `getWorkstationCapableTediIds`). This is the
	 * precise warm-surface signal the dispatch boot-gate keys on for embodied
	 * isolates: `embodied` can be set from a `repoConfig.repoUrl` ALONE (which
	 * would force a cold on-demand workstation spawn), so `embodied === true` does
	 * NOT imply a warm surface — only this flag does.
	 */
	hasWarmWorkstationLease: boolean;
	/**
	 * Whether this tedi carries a CONFIGURED configured repository (`repoConfig.repoUrl`);
	 * the precise CODING signal, narrower than `embodied` (which can be set from a
	 * warm lease alone, e.g. browser/shell work). Used to gate the coding
	 * validation contract injected into the delegation work order.
	 */
	hasRepository: boolean;
	/**
	 * Live workstation CODING readiness, projected from the warm lease row's
	 * metadata (deps installed + tools/secrets/repo ready). The kernel uses this
	 * to avoid dispatching a coding task into a warm-but-not-ready workstation
	 * (the "vitest not found"/`depsReady:false` mid-task failure): a coding route
	 * to a warm lease with `depsReady:false` is held as "warming" rather than
	 * auto-dispatched. Fail-soft: absent readiness ⇒ false (safe false-negative).
	 */
	depsReady: boolean;
	/** All four readiness dimensions ready (tools && secrets && repo && deps). */
	environmentReady: boolean;
	/** Whether work for this tedi requires human approval (default true). */
	requiresApproval: boolean;
	/** Active, unexpired, independently applied task-scoped authority records. */
	delegationEntrustments: DelegationEntrustmentProjection[];
	/**
	 * Evidence-learned capability description (capability flywheel): distilled
	 * nightly by the MemoryReflectionWorkflow from this tedi's graded delegation
	 * outcomes (the `tsel:` rows in `harness_subject_eval_results`) and stored
	 * as a `knowledge_entries` row (`tcap:{tediId}`). Rendered into the router
	 * prompt clearly labeled as evidence-derived, e.g.
	 * `evidence: <description> (n=<evidenceCount>)` — the qualitative
	 * counterpart to the quantitative `track-record=NN%` selection prior.
	 * OPTIONAL so external card constructors are untouched; `null`/absent until
	 * the tedi has enough graded outcomes. Fail-soft: a failed read → null.
	 */
	learnedCapability?: {
		description: string;
		evidenceCount: number;
		updatedAt: string;
	} | null;
	/**
	 * Per-tedi dispatch gating layer, parsed from the tedi policy pack's
	 * `gatingPolicy` slot (the "tedi" layer of the session→tedi→org precedence).
	 * `null` when the pack carries no recognized gating signal — the layered
	 * resolver then defers (behavior unchanged).
	 */
	dispatchPolicy: DispatchPolicyLayer | null;
	mcpCapabilityProfile: string | null;
}

export type DelegationEntrustmentProjection = Omit<
	ActiveDelegationEntrustmentProjection,
	"tediId"
>;

// ============================================================================
// Bounds — keep each card's lists small so the rendered prompt can't balloon
// for a tedi with many assignments.
// ============================================================================

const APPS_CAP = 12;
const SCOPE_GROUPS_CAP = 12;
const SKILLS_CAP = 12;

// ============================================================================
// Derivations (pure)
// ============================================================================

/**
 * Map a tedi's runtime tier + deployment status into a single coarse
 * availability token the planner can reason about.
 *
 *   archived runtimeState                 → "archived"
 *   LEGACY container sleeping/unreachable → "sleeping"
 *   active runtimeState + healthy          → "running"
 *   everything else (standby, etc.)        → "standby"
 *
 * `runtime_status` is a legacy-only signal; availability derives from
 * runtimeState/status for all Agent-runtime tedis.
 */
export function deriveAvailability(tedi: {
	runtimeState?: string | null;
	status?: string | null;
	runtimeStatus?: string | null;
	runtimeKind?: string | null;
}): string {
	if (tedi.runtimeState === "archived" || tedi.status === "error") {
		return "archived";
	}
	if (tedi.runtimeState === "active") return "running";
	return "standby";
}

export function isKernelVisibleTedi(tedi: {
	runtimeState?: string | null;
	status?: string | null;
}): boolean {
	if (tedi.runtimeState === "archived") return false;
	return !["error", "paused", "provisioning"].includes(tedi.status ?? "");
}

/**
 * Whether a tedi has a WORKSTATION capability signal — the durable,
 * config-driven markers that an isolate tedi can carry embodied (shell / files /
 * coding / process) work through a workstation lease, even though its body is an
 * isolate (decisions/workstations-over-bodies.md).
 *
 * Two durable signals, EITHER is sufficient:
 *   - `hasWorkstationLease` — the tedi currently holds a warm/available
 *     `workstation_leases` seat (read once per org by
 *     `getWorkstationCapableTediIds`). The ADR-named durable stamp.
 *   - `repoConfig.repoUrl` — a configured configured repository (the pre-existing signal;
 *     the on-demand Tedix Sandbox workstation derives its checkout from
 *     it). Kept verbatim so nothing regresses.
 */
export function hasWorkstationCapability(tedi: {
	repoConfig?: { repoUrl?: string | null } | null;
	hasWorkstationLease?: boolean;
}): boolean {
	if (tedi.hasWorkstationLease === true) return true;
	return typeof tedi.repoConfig?.repoUrl === "string"
		? tedi.repoConfig.repoUrl.trim().length > 0
		: false;
}

export function deriveEmbodiedCapability(tedi: {
	runtimeKind?: string | null;
	repoConfig?: { repoUrl?: string | null } | null;
	hasWorkstationLease?: boolean;
}): boolean {
	// Embodiment is NEEDS-derived: a tedi carries embodied (shell / files /
	// coding / process) capability ONLY when it has a real additive
	// workstation-capability signal (a warm lease or a configured configured repository).
	return hasWorkstationCapability(tedi);
}

/**
 * Coarsen a capability scope into a stable group token. The tedi profile scope
 * set is already coarse (`mcp:tedis`, `mcp:apps`, …) and passes through. A
 * `tedi:<category>.<action>` form (used elsewhere in the scope vocabulary) is
 * folded to `<category>:<action>`. App capability flags (`deploy`, `checkout`,
 * …) pass through as-is.
 */
function coarsenScope(scope: string): string {
	const mcpGranular = scope.match(
		/^(mcp:[a-z0-9-]+)\.(?:read|write|admin)$/,
	)?.[1];
	if (mcpGranular) return mcpGranular;
	const stripped = scope.startsWith("tedi:")
		? scope.slice("tedi:".length)
		: scope;
	return stripped.replace(".", ":");
}

/**
 * Derive coarse scope groups from the tedi's capability profile scope set plus
 * the capability flags of its assigned apps. Deduped + capped.
 */
export function deriveScopeGroups(
	mcpCapabilityProfile: string | null,
	assignedApps: App[],
): string[] {
	const groups = new Set<string>();

	for (const scope of resolveTediScopes(mcpCapabilityProfile)) {
		groups.add(coarsenScope(scope));
	}

	for (const app of assignedApps) {
		const caps = app.metadata?.capabilities;
		if (!caps || typeof caps !== "object") continue;
		if (typeof caps.vertical === "string" && caps.vertical.length > 0) {
			groups.add(caps.vertical);
		}
		for (const [key, value] of Object.entries(caps)) {
			if (key === "vertical") continue;
			if (value === true) {
				groups.add(key);
				continue;
			}
			if (
				value &&
				typeof value === "object" &&
				(value as { enabled?: unknown }).enabled === true
			) {
				groups.add(key);
			}
		}
	}

	return [...groups].slice(0, SCOPE_GROUPS_CAP);
}

/**
 * Derive `requiresApproval` from a per-tedi governance override (wins) and/or
 * the tedi's policy pack governance definition (fallback).
 *
 * Priority:
 *   1. Per-tedi override (`governanceOverride.requiresApproval`) — set via
 *      `updateTediGovernance`. When it is a boolean it wins unconditionally,
 *      allowing a CTO to flip a gated tedi to autonomous without touching
 *      shared policy packs. Fail-soft: malformed or absent override → ignored.
 *   2. Policy pack governance (`governancePolicy.*`) — existing semantics,
 *      unchanged.
 *   3. Fail-safe default `true` — unknown policy never silently authorizes
 *      unattended dispatch.
 *
 * Recognized "no approval needed" signals from the pack (any one is sufficient):
 *   governancePolicy.autoDispatch === true
 *   governancePolicy.autoApprove  === true
 *   governancePolicy.requiresApproval === false
 */
export function deriveRequiresApproval(
	definition: Record<string, unknown> | null | undefined,
	governanceOverride?: { requiresApproval?: boolean } | null,
): boolean {
	// Override wins when it carries a well-typed boolean.
	if (
		governanceOverride !== null &&
		governanceOverride !== undefined &&
		typeof governanceOverride === "object" &&
		typeof governanceOverride.requiresApproval === "boolean"
	) {
		return governanceOverride.requiresApproval;
	}

	// Fall through to policy-pack derivation (existing logic, unchanged).
	const governance = definition?.governancePolicy;
	if (!governance || typeof governance !== "object") return true;
	const gov = governance as Record<string, unknown>;
	if (gov.autoDispatch === true) return false;
	if (gov.autoApprove === true) return false;
	if (gov.requiresApproval === false) return false;
	return true;
}

// ============================================================================
// Card assembly
// ============================================================================

/**
 * Build bounded capability cards for every tedi in an org, from a fixed set of
 * indexed D1 reads. Org-scoped, fail-soft per tedi.
 *
 * Hot-path efficiency: `assembleHomeContext` already reads tedis + apps for the
 * thin context, so it passes those rows in via `opts` and this function SKIPS
 * the duplicate `getTedisByOrganization`/`getAppsByOrganization` reads — the
 * card enrichment collapses to just the skills + policy-pack reads. When `opts`
 * (or either field) is absent the function re-reads, so it still works standalone.
 */
export async function getTediCapabilityCards(
	db: DbClient,
	organizationId: string,
	opts?: { tedis?: Tedi[]; apps?: App[] },
): Promise<TediCapabilityCard[]> {
	const [allTediRows, appRows] = await Promise.all([
		opts?.tedis ?? getTedisByOrganization(db, organizationId),
		opts?.apps ?? getAppsByOrganization(db, organizationId),
	]);
	const tediRows = allTediRows.filter(isKernelVisibleTedi);

	if (tediRows.length === 0) return [];

	const tediIds = tediRows.map((t) => t.id);

	// One batched read each for skills + policy packs (both org+key indexed) plus
	// the bounded org-scoped workstation readiness map (TWO indexed reads, no
	// per-tedi fan-out — same cost as the capable-set read, plus the lease
	// status/metadata columns) plus the learned-capability rows (chunked PK read
	// — one query per 80 tedis, no per-tedi fan-out). Each is fail-soft: a
	// workstation-read failure degrades to an EMPTY map (no isolate falsely
	// marked embodied, no tedi falsely marked deps-ready) and a learned-read
	// failure degrades to cards with no evidence line, preserving
	// safe-by-default.
	const [
		skillRows,
		packRows,
		workstationReadinessByTedi,
		learnedByTedi,
		delegationEntrustmentsByTedi,
	] = await Promise.all([
		safeBatch(
			() => listSkillLabelsByTediIds(db, organizationId, tediIds),
			[] as { tediId: string | null; slug: string | null; title: string }[],
		),
		safeBatch(
			() => loadPolicyPacks(db, tediRows),
			new Map<string, Record<string, unknown> | null>(),
		),
		safeBatch(
			() => getWorkstationReadinessByTedi(db, organizationId),
			new Map<string, WorkstationReadiness>(),
		),
		safeBatch(
			() => getTediLearnedCapabilities(db, organizationId, tediIds),
			new Map<string, TediLearnedCapability>(),
		),
		safeBatch(async () => {
			const rows = await getActiveDelegationEntrustmentProjections(db, {
				organizationId,
				tediIds,
				now: new Date().toISOString(),
			});
			const byTedi = new Map<string, DelegationEntrustmentProjection[]>();
			for (const { tediId, ...projection } of rows) {
				const current = byTedi.get(tediId) ?? [];
				current.push(projection);
				byTedi.set(tediId, current);
			}
			return byTedi;
		}, new Map<string, DelegationEntrustmentProjection[]>()),
	]);
	// The warm-lease capability set is exactly the keys of the readiness map (a
	// tedi appears iff it holds a warm/available lease seat), so the existing
	// embodied/hasWarmWorkstationLease logic is unchanged while we additionally
	// carry the per-tedi readiness flags.
	const workstationCapableTediIds = new Set(workstationReadinessByTedi.keys());

	// Group skill slugs/names by tedi (deduped, capped).
	const skillsByTedi = new Map<string, string[]>();
	for (const row of skillRows) {
		if (!row.tediId) continue;
		const label = row.slug ?? row.title;
		if (!label) continue;
		const list = skillsByTedi.get(row.tediId) ?? [];
		if (list.length < SKILLS_CAP && !list.includes(label)) list.push(label);
		skillsByTedi.set(row.tediId, list);
	}

	const appsById = new Map(appRows.map((app) => [app.id, app]));

	return tediRows.map((tedi) =>
		buildCard(
			tedi,
			appRows,
			appsById,
			skillsByTedi,
			packRows,
			workstationCapableTediIds,
			workstationReadinessByTedi,
			learnedByTedi,
			delegationEntrustmentsByTedi,
		),
	);
}

/**
 * Build one card. Per-tedi enrichment is wrapped so a single failure degrades
 * to the thin card (empty arrays, requiresApproval true) instead of throwing.
 */
function buildCard(
	tedi: Tedi,
	allApps: App[],
	appsById: Map<string, App>,
	skillsByTedi: Map<string, string[]>,
	packByTedi: Map<string, Record<string, unknown> | null>,
	workstationCapableTediIds: Set<string>,
	workstationReadinessByTedi: Map<string, WorkstationReadiness>,
	learnedByTedi: Map<string, TediLearnedCapability>,
	delegationEntrustmentsByTedi: Map<string, DelegationEntrustmentProjection[]>,
): TediCapabilityCard {
	const readiness = workstationReadinessByTedi.get(tedi.id);
	const learned = learnedByTedi.get(tedi.id);
	const base: TediCapabilityCard = {
		tediId: tedi.id,
		slug: tedi.slug,
		name: tedi.displayName || tedi.name || tedi.slug,
		apps: [],
		scopeGroups: [],
		skills: [],
		runtimeKind: tedi.runtimeKind ?? "agent",
		embodied: deriveEmbodiedCapability({
			runtimeKind: tedi.runtimeKind,
			repoConfig: tedi.repoConfig,
			hasWorkstationLease: workstationCapableTediIds.has(tedi.id),
		}),
		availability: deriveAvailability(tedi),
		// The actual warm-lease signal (independent of `embodied`/`availability`):
		// sourced from the org-scoped warm-lease set, so it never throws here.
		hasWarmWorkstationLease: workstationCapableTediIds.has(tedi.id),
		// CODING signal: a configured configured repository only (NOT a warm lease), so a
		// warm-lease-only / browser tedi is not marked as coding. Fail-soft: absent
		// repoConfig means false.
		hasRepository: hasWorkstationCapability({
			repoConfig: tedi.repoConfig,
		}),
		// Live coding readiness off the warm lease metadata (fail-soft: absent ⇒
		// false → kernel holds "warming" rather than dispatching into an unproven env).
		depsReady: readiness?.depsReady ?? false,
		environmentReady: readiness?.environmentReady ?? false,
		requiresApproval: true,
		delegationEntrustments: delegationEntrustmentsByTedi.get(tedi.id) ?? [],
		// Evidence-derived description (fail-soft: absent row / failed read → null).
		// Set on the BASE card — like the workstation signals — so a later
		// enrichment failure can't drop the evidence line.
		learnedCapability: learned
			? {
					description: learned.learnedDescription,
					evidenceCount: learned.evidenceCount,
					updatedAt: learned.updatedAt,
				}
			: null,
		dispatchPolicy: null,
		mcpCapabilityProfile: tedi.mcpCapabilityProfile ?? null,
	};

	try {
		const decisions = computeManagedAssignmentsForTedi(
			allApps.map((app) => ({
				id: app.id,
				name: app.name,
				slug: app.slug ?? app.id,
				metadata: getAppMetadataJson(app),
			})),
			{
				id: tedi.id,
				slug: tedi.slug,
				mcpCapabilityProfile: tedi.mcpCapabilityProfile,
				tags: tedi.tags,
			},
		);

		const assignedApps = decisions
			.map((d) => appsById.get(d.appId))
			.filter((app): app is App => app !== undefined);

		base.apps = decisions.map((d) => d.appSlug).slice(0, APPS_CAP);
		base.scopeGroups = deriveScopeGroups(
			tedi.mcpCapabilityProfile,
			assignedApps,
		);
		base.skills = skillsByTedi.get(tedi.id) ?? [];
		const packDefinition = packByTedi.get(tedi.id);
		base.requiresApproval = deriveRequiresApproval(
			packDefinition,
			// Per-tedi override wins over the pack when set. Fail-soft: the field
			// is typed as TediGovernanceOverride | null | undefined so any malformed
			// JSON parses to an unknown shape; `deriveRequiresApproval` guards on
			// `typeof .requiresApproval === "boolean"` and falls through to pack.
			tedi.governanceOverride,
		);
		// Tedi gating layer: parse the pack's `gatingPolicy` slot (distinct from the
		// `governancePolicy` slot that feeds `requiresApproval`). Fail-soft → null.
		base.dispatchPolicy = parseDispatchPolicyLayer(
			packDefinition?.gatingPolicy,
		);
	} catch (error) {
		console.warn(
			`[tediCapabilities] enrichment failed for tedi ${tedi.id}; degrading to thin card`,
			error instanceof Error ? error.message : String(error),
		);
	}

	return base;
}

/**
 * Load the governance definition of each tedi's policy pack in ONE batched read
 * (deduped pack ids), keyed back by tediId. Tedis with no `policyPackId` map to
 * `null` (→ requiresApproval defaults true).
 */
async function loadPolicyPacks(
	db: DbClient,
	tediRows: Tedi[],
): Promise<Map<string, Record<string, unknown> | null>> {
	const result = new Map<string, Record<string, unknown> | null>();
	const packIds = [
		...new Set(
			tediRows
				.map((t) => t.policyPackId)
				.filter((id): id is string => Boolean(id)),
		),
	];

	if (packIds.length === 0) {
		for (const tedi of tediRows) result.set(tedi.id, null);
		return result;
	}

	const defById = await getPolicyPackDefinitionsByIds(db, packIds);

	for (const tedi of tediRows) {
		result.set(
			tedi.id,
			tedi.policyPackId ? (defById.get(tedi.policyPackId) ?? null) : null,
		);
	}
	return result;
}

/**
 * Read the ORG dispatch gating layer — the `gatingPolicy` slot of the org's
 * first active policy pack (the "org" layer of session→tedi→org precedence).
 * Mirrors the `readOrgGovernancePolicy` query (org + status=active) but extracts
 * `gatingPolicy` instead of `governancePolicy`. Fail-soft: returns `null` when
 * no active pack, no recognized gating signal, or the read throws — so an absent
 * org gatingPolicy leaves dispatch behavior exactly unchanged.
 */
export async function readOrgDispatchPolicyLayer(
	db: DbClient,
	organizationId: string,
): Promise<DispatchPolicyLayer | null> {
	try {
		const definition = await getActiveOrganizationPolicyPackDefinition(
			db,
			organizationId,
		);
		return parseDispatchPolicyLayer(definition?.gatingPolicy);
	} catch {
		return null;
	}
}

/**
 * Run a single batched read defensively: any failure degrades to the fallback
 * rather than throwing, keeping the whole card assembly fail-soft.
 */
async function safeBatch<T>(read: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await read();
	} catch (error) {
		console.warn(
			"[tediCapabilities] batch read failed; degrading",
			error instanceof Error ? error.message : String(error),
		);
		return fallback;
	}
}
