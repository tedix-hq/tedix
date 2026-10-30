/**
 * Query helpers for Role Templates (reusable role primitive).
 *
 * A role template bundles the four ingredients a tedi's role is otherwise
 * hand-assembled from — persona (SOUL), standing objectives, app-assignment
 * tags, and a requested capability profile — into one provisionable unit.
 *
 * `applyRoleTemplate()` provisions a template onto an EXISTING tedi by REUSING
 * the canonical writers rather than reimplementing any plumbing:
 *   - persona/tags                   → `updateTedi` (queries/tedis.ts)
 *   - role track                     → `assignInitialRoleTrack`
 *   - standing objectives            → `createObjective` (queries/tedi-objectives.ts),
 *                                       with the mission-os first_n gate default
 *                                       (`DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG`),
 *                                       titles normalized via `buildMissionObjectiveTitle`,
 *                                       and idempotency via `scoreMissionTextOverlap`.
 *
 * It deliberately does NOT call FGA / managed app-assignment reconcile — setting
 * `tedis.tags` is the trigger that reconcile keys off, and that reconcile runs
 * as its own step. The returned summary says so.
 */

import { DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG } from "@tedix/api-contract/contracts/tedi-objectives";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type NewRoleTemplate,
	type RoleTemplate,
	type RoleTemplateStandingObjective,
	roleTemplates,
} from "../schema/role-templates";
import {
	MCP_CAPABILITY_PROFILE_VALUES,
	type McpCapabilityProfile,
	tedis,
} from "../schema/tedis";
import {
	buildMissionObjectiveTitle,
	scoreMissionTextOverlap,
} from "@tedix/context-core/mission-text";
import { assignInitialRoleTrack } from "./earned-delegation/role-assignments";
import {
	createObjective,
	listObjectives,
	updateObjective,
} from "./tedi-objectives";
import { updateTedi } from "./tedis";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Typed failure surface for `applyRoleTemplate`, mirroring `WorkItemParentError`.
 * The oRPC router maps `tedi_out_of_scope` → FORBIDDEN, everything else →
 * BAD_REQUEST / NOT_FOUND.
 */
export class RoleTemplateError extends Error {
	readonly reason:
		| "template_not_found"
		| "tedi_not_found"
		| "tedi_out_of_scope";
	constructor(
		reason: "template_not_found" | "tedi_not_found" | "tedi_out_of_scope",
		message: string,
	) {
		super(message);
		this.name = "RoleTemplateError";
		this.reason = reason;
	}
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateRoleTemplateParams {
	id?: string;
	/** Owning org, or null for a platform-wide template. */
	orgId?: string | null;
	key: string;
	name: string;
	description?: string | null;
	persona: string;
	standingObjectives?: RoleTemplateStandingObjective[];
	tags?: string[];
	capabilityProfile?: McpCapabilityProfile;
	cronTemplateNames?: string[];
	metadata?: Record<string, JsonValue>;
	createdAt?: string;
}

export interface ListRoleTemplatesOptions {
	/** Returns this org's templates PLUS platform-wide (orgId null) templates. */
	orgId?: string | null;
	includeArchived?: boolean;
	limit?: number;
	offset?: number;
}

export async function createRoleTemplate(
	db: DbClient,
	params: CreateRoleTemplateParams,
): Promise<RoleTemplate> {
	const values: NewRoleTemplate = {
		id: params.id ?? crypto.randomUUID(),
		orgId: params.orgId ?? null,
		key: params.key,
		name: params.name,
		description: params.description ?? null,
		persona: params.persona,
		standingObjectives: params.standingObjectives ?? [],
		tags: params.tags ?? [],
		capabilityProfile: params.capabilityProfile ?? "standard",
		cronTemplateNames: params.cronTemplateNames ?? [],
		metadata: params.metadata ?? {},
		createdAt: params.createdAt ?? new Date().toISOString(),
	};
	const rows = await db.insert(roleTemplates).values(values).returning();
	return rows[0]!;
}

export async function getRoleTemplateById(
	db: DbClient,
	id: string,
): Promise<RoleTemplate | undefined> {
	const rows = await db
		.select()
		.from(roleTemplates)
		.where(eq(roleTemplates.id, id));
	return rows[0];
}

/** Copy one current platform blueprint into an organization without overwriting
 * an existing (including archived) organization template. The single statement
 * copies the same source revision across all fields, even for large personas. */
export async function copyPlatformRoleTemplate(
	db: DbClient,
	params: { sourceId: string; orgId: string; now?: string },
): Promise<RoleTemplate | undefined> {
	const id = crypto.randomUUID();
	const now = params.now ?? new Date().toISOString();
	const rows = await db
		.insert(roleTemplates)
		.select(
			db
				.select({
					id: sql<string>`${id}`.as("id"),
					orgId: sql<string>`${params.orgId}`.as("org_id"),
					key: roleTemplates.key,
					name: roleTemplates.name,
					description: roleTemplates.description,
					persona: roleTemplates.persona,
					standingObjectives: roleTemplates.standingObjectives,
					tags: roleTemplates.tags,
					capabilityProfile: roleTemplates.capabilityProfile,
					cronTemplateNames: roleTemplates.cronTemplateNames,
					metadata: roleTemplates.metadata,
					createdAt: sql<string>`${now}`.as("created_at"),
					updatedAt: sql<string | null>`null`.as("updated_at"),
					archivedAt: sql<string | null>`null`.as("archived_at"),
				})
				.from(roleTemplates)
				.where(
					and(
						eq(roleTemplates.id, params.sourceId),
						isNull(roleTemplates.orgId),
						isNull(roleTemplates.archivedAt),
					),
				),
		)
		.onConflictDoNothing()
		.returning();
	return rows[0];
}

/**
 * Exact-key lookup scoped to one owner. `orgId: null` targets platform-wide
 * templates specifically (NOT "any org"). Archived rows are included so callers
 * can detect a soft-archived key before re-creating it.
 */
export async function getRoleTemplateByKey(
	db: DbClient,
	params: { key: string; orgId: string | null },
): Promise<RoleTemplate | undefined> {
	const ownerCondition =
		params.orgId === null
			? isNull(roleTemplates.orgId)
			: eq(roleTemplates.orgId, params.orgId);
	const rows = await db
		.select()
		.from(roleTemplates)
		.where(and(eq(roleTemplates.key, params.key), ownerCondition));
	return rows[0];
}

/**
 * List an org's templates plus platform-wide (orgId null) blueprints. When
 * `orgId` is omitted, only platform templates are returned. Archived templates
 * are excluded unless `includeArchived` is set.
 */
export async function listRoleTemplates(
	db: DbClient,
	options: ListRoleTemplatesOptions = {},
): Promise<{ data: RoleTemplate[]; total: number }> {
	const { limit = 50, offset = 0, includeArchived = false } = options;
	const scopeCondition =
		options.orgId != null
			? or(eq(roleTemplates.orgId, options.orgId), isNull(roleTemplates.orgId))
			: isNull(roleTemplates.orgId);
	const whereClause = includeArchived
		? scopeCondition
		: and(scopeCondition, isNull(roleTemplates.archivedAt));

	const data = await db
		.select()
		.from(roleTemplates)
		.where(whereClause)
		.orderBy(asc(roleTemplates.key))
		.limit(limit)
		.offset(offset);
	const total = await db.$count(roleTemplates, whereClause);
	return { data, total };
}

/** Soft-archive: stamp archivedAt (+ updatedAt). Audit-preserving. */
export async function archiveRoleTemplate(
	db: DbClient,
	id: string,
	archivedAt: string,
): Promise<RoleTemplate | undefined> {
	const rows = await db
		.update(roleTemplates)
		.set({ archivedAt, updatedAt: archivedAt })
		.where(eq(roleTemplates.id, id))
		.returning();
	return rows[0];
}

/**
 * Resolve the effective, non-archived template for an org+key: an org-scoped
 * template wins over a platform-wide one with the same key. Returns undefined
 * when neither exists.
 */
async function resolveRoleTemplate(
	db: DbClient,
	key: string,
	orgId: string,
): Promise<RoleTemplate | undefined> {
	const orgScoped = await getRoleTemplateByKey(db, { key, orgId });
	if (orgScoped && !orgScoped.archivedAt) return orgScoped;
	const platform = await getRoleTemplateByKey(db, { key, orgId: null });
	if (platform && !platform.archivedAt) return platform;
	return undefined;
}

// ---------------------------------------------------------------------------
// Apply — provision a template onto an existing tedi (reuses canonical writers)
// ---------------------------------------------------------------------------

export interface ApplyRoleTemplateParams {
	tediId: string;
	templateKey: string;
	orgId: string;
}

export interface ApplyRoleTemplateSummary {
	templateId: string;
	templateKey: string;
	tediId: string;
	/** persona written to `tedis.personality`. */
	personaSet: boolean;
	/** Template request retained for review; applying a role never grants it. */
	requestedCapabilityProfile: McpCapabilityProfile;
	capabilityProfileChange: "not_applied_role_does_not_grant_authority";
	careerStage:
		| "shadow"
		| "apprentice"
		| "operator"
		| "specialist"
		| "lead"
		| "executive";
	/** Tags newly added (union delta) onto `tedis.tags`. */
	tagsAdded: string[];
	/** Full tag set after the union. */
	tagsAfter: string[];
	/** Standing-objective titles created this run. */
	objectivesCreated: string[];
	/** Existing standing objectives whose stale content/policy was reconciled. */
	objectivesUpdated: string[];
	/** Standing-objective titles already equal to the template. */
	objectivesSkipped: string[];
	/**
	 * Managed app-assignment reconcile (FGA) is NOT run here. Setting
	 * `tedis.tags` is the trigger; run tag-based assignment reconcile separately.
	 */
	assignmentReconcile: "not_run_setting_tags_is_the_trigger";
}

/**
 * Idempotency threshold for skipping a standing objective whose normalized
 * title already overlaps an existing active standing objective.
 */
const OBJECTIVE_OVERLAP_SKIP_THRESHOLD = 0.7;

export async function applyRoleTemplate(
	db: DbClient,
	params: ApplyRoleTemplateParams,
): Promise<ApplyRoleTemplateSummary> {
	// 1. Load + cross-org guard the target tedi. A narrow core select (id/org/
	// tags) — the write below reuses the canonical `updateTedi` writer.
	const tediRows = await db
		.select({
			organizationId: tedis.organizationId,
			tags: tedis.tags,
		})
		.from(tedis)
		.where(eq(tedis.id, params.tediId));
	const tedi = tediRows[0];
	if (!tedi) {
		throw new RoleTemplateError("tedi_not_found", "Tedi not found");
	}
	if (tedi.organizationId !== params.orgId) {
		throw new RoleTemplateError(
			"tedi_out_of_scope",
			"Tedi is out of scope for this organization",
		);
	}

	// 2. Resolve the template (org-scoped wins over platform-wide).
	const template = await resolveRoleTemplate(
		db,
		params.templateKey,
		params.orgId,
	);
	if (!template) {
		throw new RoleTemplateError(
			"template_not_found",
			`Role template "${params.templateKey}" not found for this organization`,
		);
	}

	// 3. Establish (or verify) the governed role track before mutating any
	// descriptive configuration. `assignInitialRoleTrack` is idempotent for the
	// same role and rejects a different active role, so a rejected role change
	// cannot leave the template's persona or tags behind.
	const now = new Date().toISOString();
	const roleAssignment = await assignInitialRoleTrack(db, {
		organizationId: params.orgId,
		tediId: params.tediId,
		roleTemplateId: template.id,
		roleKey: template.key,
		roleName: template.name,
		metadata: { source: "role-template" },
		now,
	});

	// 4. Persona + tags are descriptive configuration. A role title/template
	// never mutates the MCP capability profile or task-scoped authority.
	const existingTags = tedi.tags ?? [];
	const tagsAdded = template.tags.filter((tag) => !existingTags.includes(tag));
	const tagsAfter = [...existingTags, ...tagsAdded];
	const capabilityProfile: McpCapabilityProfile =
		MCP_CAPABILITY_PROFILE_VALUES.includes(template.capabilityProfile)
			? template.capabilityProfile
			: "standard";

	await updateTedi(db, params.tediId, {
		personality: template.persona,
		tags: tagsAfter,
	});

	// 5. Standing objectives → seed via the canonical create query, gated by the
	// mission-os first_n default, deduped against existing active standing
	// objectives (and against objectives created earlier in this same run).
	const activeStanding = await listObjectives(db, {
		tediId: params.tediId,
		type: "standing",
		status: "active",
		limit: 100,
		offset: 0,
	});
	const seenObjectives = [...activeStanding.data];

	const objectivesCreated: string[] = [];
	const objectivesUpdated: string[] = [];
	const objectivesSkipped: string[] = [];

	for (const objective of template.standingObjectives) {
		const title = buildMissionObjectiveTitle(objective.title);
		const existing = seenObjectives.find(
			(candidate) =>
				scoreMissionTextOverlap(candidate.title, title) >=
				OBJECTIVE_OVERLAP_SKIP_THRESHOLD,
		);
		const gateConfig = {
			...(objective.gateConfig ?? DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG),
			autonomyLevel: "supervised" as const,
			gateType: "always" as const,
			currentStreak: 0,
			lastGraduatedAt: null,
		};
		const budgetConfig = {
			source: "role-template",
			roleTemplateKey: template.key,
			standing: true,
		};
		if (existing) {
			const changed =
				(existing.approach ?? undefined) !== objective.approach ||
				(existing.successCriteria ?? undefined) !== objective.successCriteria ||
				existing.riskLevel !== (objective.riskLevel ?? "medium") ||
				JSON.stringify(existing.gateConfig ?? {}) !==
					JSON.stringify(gateConfig) ||
				JSON.stringify(existing.budgetConfig ?? {}) !==
					JSON.stringify(budgetConfig);
			if (!changed) {
				objectivesSkipped.push(title);
				continue;
			}
			await updateObjective(db, existing.id, {
				approach: objective.approach,
				successCriteria: objective.successCriteria,
				riskLevel: objective.riskLevel ?? "medium",
				gateConfig,
				budgetConfig,
				updatedAt: new Date().toISOString(),
			});
			objectivesUpdated.push(title);
			continue;
		}
		const created = await createObjective(db, {
			id: crypto.randomUUID(),
			tediId: params.tediId,
			orgId: params.orgId,
			title,
			approach: objective.approach,
			successCriteria: objective.successCriteria,
			type: "standing",
			riskLevel: objective.riskLevel ?? "medium",
			priority: 200,
			gateConfig,
			budgetConfig,
			createdAt: new Date().toISOString(),
		});
		seenObjectives.push(created);
		objectivesCreated.push(title);
	}

	return {
		templateId: template.id,
		templateKey: template.key,
		tediId: params.tediId,
		personaSet: template.persona.length > 0,
		requestedCapabilityProfile: capabilityProfile,
		capabilityProfileChange: "not_applied_role_does_not_grant_authority",
		careerStage: roleAssignment.careerStage,
		tagsAdded,
		tagsAfter,
		objectivesCreated,
		objectivesUpdated,
		objectivesSkipped,
		assignmentReconcile: "not_run_setting_tags_is_the_trigger",
	};
}

// ---------------------------------------------------------------------------
// Role-template seed upsert
// ---------------------------------------------------------------------------

/** The seed shape — the mutable fields of a role template blueprint. */
export interface RoleTemplateSeed {
	key: string;
	name: string;
	description?: string;
	persona: string;
	standingObjectives: RoleTemplateStandingObjective[];
	tags: string[];
	capabilityProfile?: McpCapabilityProfile;
	cronTemplateNames?: string[];
	metadata?: Record<string, JsonValue>;
}

/**
 * Migration-safe upsert of a role-template seed. Idempotent: keyed on
 * (orgId, key), it updates the mutable fields of an existing (even archived —
 * revived) row or inserts a fresh one. Safe to run repeatedly. `orgId` defaults
 * to null (platform-wide).
 */
export async function upsertRoleTemplateSeed(
	db: DbClient,
	seed: RoleTemplateSeed,
	options: { orgId?: string | null; now?: string } = {},
): Promise<RoleTemplate> {
	const orgId = options.orgId ?? null;
	const now = options.now ?? new Date().toISOString();
	const existing = await getRoleTemplateByKey(db, { key: seed.key, orgId });

	if (existing) {
		const rows = await db
			.update(roleTemplates)
			.set({
				name: seed.name,
				description: seed.description ?? null,
				persona: seed.persona,
				standingObjectives: seed.standingObjectives,
				tags: seed.tags,
				capabilityProfile: seed.capabilityProfile ?? "standard",
				cronTemplateNames: seed.cronTemplateNames ?? [],
				metadata: seed.metadata ?? {},
				archivedAt: null,
				updatedAt: now,
			})
			.where(eq(roleTemplates.id, existing.id))
			.returning();
		return rows[0]!;
	}

	return createRoleTemplate(db, {
		orgId,
		key: seed.key,
		name: seed.name,
		description: seed.description ?? null,
		persona: seed.persona,
		standingObjectives: seed.standingObjectives,
		tags: seed.tags,
		capabilityProfile: seed.capabilityProfile ?? "standard",
		cronTemplateNames: seed.cronTemplateNames ?? [],
		metadata: seed.metadata ?? {},
		createdAt: now,
	});
}
