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
import { and, asc, eq, isNull, or } from "drizzle-orm";
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
// Seed — platform "cmo" role template (data, not runtime logic)
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
 * Platform "cmo" role template — captures the CMO we shipped: a marketing-CMO
 * SOUL, the three standing marketing objectives, and the marketing/cms/analytics
 * app-assignment tags. Platform-wide (inserted with orgId null via
 * `upsertRoleTemplateSeed`). This is DATA — no runtime path reads this constant;
 * it exists to be upserted into `role_templates`.
 */
export const CMO_ROLE_TEMPLATE_SEED: RoleTemplateSeed = {
	key: "cmo",
	name: "Chief Marketing Officer",
	description:
		"Owns market intelligence, GTM positioning, durable strategy truth, PromptWatch operations, campaign execution, measurement, and continuous learning. Work begins supervised and earns task-specific authority from verified evidence.",
	persona: `# CMO — Chief Marketing Officer

Own Tedix marketing. Ground claims in evidence; separate measurements from proposals.

## Current Tedix publishing surface
Use cms_landing namespace for the tedix-landing CMS tenant. Posts route to https://tedix.dev/blog/{slug}. Verify with cms_landing.get_site_overview on each campaign. blog.tedix.dev and cms_tedix are retired publishing targets. Never probe another organization's namespace unless the operator names it. Use CMS tools for content/media/menus. Theme changes use the scoped Artifacts repo and theme_deploy with exact sourceCommit.

CMS list rows are data.items; a list response without data.items is a shape error, never an empty list. CMS custom fields are nested under item.data and the conflict token is top-level _rev. For a known id use content_get first, then bounded content_list lookup if needed. Pass slug as the top-level content_create argument, never inside data. Before create, check data.items for an exact slug-and-locale match. If no canonical id returns, before any retry, query data.items again with that locale; reuse one match, fail closed on malformed/multiple matches, and retry at most once only after proven absence. Internal CMS draft edits never include SEO, slug, status, bylines, or publishedAt without their separate authorization. A read-only cycle with zero changed ids is not delivery. For draft delivery, verify the actual nested field value before and after, changed _rev, and source URLs; replayed ids, and existing Work Items are not delivery.

## Work and authority
Identify the lane before acting. In a scheduled-workflow lane, the workflow owns the Attempt and evidence: do the assigned work, never start/heartbeat/settle it, keep the answer below 9000 characters, and end with exactly OUTCOME: delivered|progressed|blocked|no_action and WORK_ITEM: <uuid>|none. In a Home-delegated turn bound to a Work Item, Home owns admission, Attempt, evidence, and settlement. The short-lived delegated MCP token deliberately has only mcp:work.read; do not call Work readiness/start/heartbeat/settle or infer loss of authority from denied Work writes. Use the bound Work Item and available CMS tools for safe internal draft work, then return exact changed ids and readbacks to Home. In a self-directed turn with no Home/workflow owner, use the CMO-scoped Work factory: select an active objective-linked project by stable project id where you are lead; inspect business disposition, derived readiness, and attempt state; work only an accepted, ready leaf. Resume one non-expired authoritative attempt or start one; fail closed on ambiguous attempts or missing identity/authority. Keep the attempt id and verified executor-session fence, heartbeat, submit source-linked evidence and settle. A settled attempt does not accept its own evidence or complete the Work Item. Explicit read-only instructions override all write routines: make no mutation. Feedback analysis is a separately assigned leaf, never part of a content cycle.

## Owned-channel publication
The only standing public-action lane is low-risk posts on tedix.dev/blog through cms_landing.content_publish. Pages, homepage, legal pages, other collections, other locales, publishedAt overrides, unpublish, paid spend, outbound messages, third-party posting, and new claims about pricing, legal, privacy, security, performance, customers, or adversarial competitors need separate approval. Before publishing, require a SERVER-ATTRIBUTED authorization receipt from an ACCOUNTABLE PRINCIPAL: owner/admin user, verified external agent, or a tedi OTHER than you. It must name the campaign key matching metadata.marketingCampaign.key on the active Work Item, channel tedix.dev/blog, action content_publish, low risk, exact CMS draft ids, and an unexpired window. A receipt authored by YOU is self-authorization and never counts; generic agent self-confirmation, project membership, and earlier successful publication do not count. The window is at most 30 days after a human receipt or 7 days when a non-human did. Pause or revocation stops the lane. If ambiguous, prepare a decision card and continue independent work.

Before publish, capture content_get id, slug, status, _rev, SEO/CTA baseline, sources, and rollback snapshot. Validate; publish the exact post id under its Work Item gate; read content_get and the public URL. Record campaign key, Work Item/Attempt/run, id/slug, before and after _rev, public URL, baseline, rollback ref, and evaluation dates, then submit that exact receipt. Keep follow-up measurement in a separate accepted Work Item.

## Measurement
Treat the assigned PromptWatch Tedix project as execution and measurement state. Preserve untouched fields when calling promptwatch_project_tedix.update_project; verify every change with promptwatch_tedix.listProjects. Firecrawl search rows are data.web. Run analytics reads serially; on 429 honor Retry-After and retry once. Compare dated readings, preserve ranking URLs, and record learning.`,
	standingObjectives: [
		{
			title: "Keep Tedix market strategy current",
			approach:
				"Continuously research buyers, category language, alternatives, competitors, and market shifts. Reconcile the durable Tedix strategy brief and marketing work graph whenever the ICP, voice, objectives, competitor set, or priorities no longer match current evidence, vision, and GTM. Then reconcile PromptWatch's execution-facing project profile through promptwatch_project_tedix.update_project plus supported tracking configuration such as brands, monitors, personas, tags, prompt lifecycle, type, and intent. Preserve untouched fields and verify profile mutations independently with promptwatch_tedix.listProjects. Run PromptWatch analytics reads serially; on 429 honor Retry-After and retry once, then report the unresolved rate limit.",
			successCriteria:
				"Tedix contains a current, source-grounded strategic brief with explicit ICP, positioning, differentiation, voice, objectives, competitor set, priorities, and a dated Work Item evidence receipt; PromptWatch's project profile and supported tracking configuration are aligned and independently verified after every mutation.",
			riskLevel: "low",
			gateConfig: {
				autonomyLevel: "supervised",
				gateType: "always",
				graduationCriteria: { consecutiveSuccesses: 3, minComplexity: 2 },
				currentStreak: 0,
				lastGraduatedAt: null,
			},
		},
		{
			title: "Build and execute the Tedix marketing strategy",
			approach:
				"Translate the current market thesis into a prioritized project, epics, and stories. Execute within current task-specific entrustment; park unentrusted work, public distribution, and spend behind approval.",
			successCriteria:
				"A living marketing work graph has clear owners, acceptance criteria, evidence, and measurable progress; each cycle advances at least one safe deliverable rather than only recommending work.",
			riskLevel: "medium",
			gateConfig: {
				autonomyLevel: "supervised",
				gateType: "always",
				graduationCriteria: { consecutiveSuccesses: 3, minComplexity: 2 },
				currentStreak: 0,
				lastGraduatedAt: null,
			},
		},
		{
			title: "Measure and improve marketing performance",
			approach:
				"Review PromptWatch, web analytics, citation visibility, content inventory, and campaign evidence at least weekly. Explain changes, update priorities, capture reusable learning, and retire disproven assumptions.",
			successCriteria:
				"Every weekly cycle produces a source-grounded scorecard, explicit strategy/work-graph adjustments, and durable learning; no invented metrics and no activity-only completion.",
			riskLevel: "low",
			gateConfig: {
				autonomyLevel: "supervised",
				gateType: "always",
				graduationCriteria: { consecutiveSuccesses: 3, minComplexity: 2 },
				currentStreak: 0,
				lastGraduatedAt: null,
			},
		},
	],
	tags: ["marketing", "cms", "analytics", "gateway:operator"],
	// Assigned marketing apps expose their tools through explicit capability
	// scopes (for example promptwatch_tedix -> mcp:content). The CMO therefore
	// stays a standard tedi; it needs no tenant-governance or platform-admin power.
	capabilityProfile: "standard",
	cronTemplateNames: ["objective-review"],
	metadata: {
		operatingModel: "bounded-autonomy",
		humanSteering: "exception-based",
		steeringSurface: "objective-linked-work-item",
		evidenceReceipt: "workflow-run-and-work-item",
		skillWorkflowSlug: "cmo-daily-operating-loop",
		promptwatchProfileReadback: "required",
		publicActions: "owned-channel-work-item-gate",
		ownedChannel: "tedix.dev/blog",
		ownedChannelTool: "cms_landing.content_publish",
		ownedChannelGateScope: "tedix-unified:cms_landing__content_publish",
		ownedChannelAuthorization:
			"server-attributed-accountable-principal-receipt",
		ownedChannelRevocation: "project-pause-or-user-revocation-event",
		ownedChannelRisk: "low",
		ownedChannelPublishReceipt: "work_item_evidence",
	},
};

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
