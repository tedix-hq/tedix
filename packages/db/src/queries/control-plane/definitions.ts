import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../../client";
import { chunkForBoundParams } from "../../utils/batch";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../../schema";
import type {
	NewPolicyPack,
	NewRuntimeProfile,
	NewWorkspaceTemplateSet,
	PolicyPack,
	PolicyPackTarget,
	RuntimeProfile,
	WorkspaceTemplateSet,
} from "../../schema/control-plane";
import {
	publishPolicyPackRevision,
	publishRuntimeProfileRevision,
	publishWorkspaceTemplateSetRevision,
} from "./revisions";

function normalizeSlug(value: string): string {
	return value.trim().toLowerCase();
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeJson(
	base: Record<string, unknown>,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		const current = merged[key];
		if (isJsonRecord(current) && isJsonRecord(value)) {
			merged[key] = deepMergeJson(current, value);
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

export async function listRuntimeProfiles(
	db: DbClient,
	options?: { organizationId?: string; includeSystem?: boolean },
): Promise<RuntimeProfile[]> {
	const includeSystem = options?.includeSystem !== false;
	const organizationId = options?.organizationId;

	const visibilityCondition = organizationId
		? includeSystem
			? or(
					eq(runtimeProfiles.organizationId, organizationId),
					eq(runtimeProfiles.scope, "system"),
				)
			: eq(runtimeProfiles.organizationId, organizationId)
		: includeSystem
			? undefined
			: eq(runtimeProfiles.scope, "organization");

	const headCondition = sql`${runtimeProfiles.version} = (
		select max(candidate.version)
		from runtime_profiles candidate
		where candidate.scope = ${runtimeProfiles.scope}
			and candidate.slug = ${runtimeProfiles.slug}
	)`;
	const conditions = visibilityCondition
		? and(visibilityCondition, headCondition)
		: headCondition;
	const filtered = db.select().from(runtimeProfiles).where(conditions);
	return filtered.orderBy(
		asc(runtimeProfiles.scope),
		asc(runtimeProfiles.name),
		desc(runtimeProfiles.version),
	);
}

export async function getRuntimeProfileById(
	db: DbClient,
	id: string,
): Promise<RuntimeProfile | null> {
	return (await db.query.runtimeProfiles.findFirst({ where: { id } })) ?? null;
}

export async function createRuntimeProfile(
	db: DbClient,
	input: Omit<NewRuntimeProfile, "id" | "createdAt" | "updatedAt">,
): Promise<RuntimeProfile> {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	await db.insert(runtimeProfiles).values({
		...input,
		id,
		slug: normalizeSlug(input.slug),
		createdAt: now,
		updatedAt: now,
		publishedAt: now,
	});
	const created = await getRuntimeProfileById(db, id);
	if (!created) throw new Error(`Failed to create runtime profile: ${id}`);
	return created;
}

export async function listPolicyPacks(
	db: DbClient,
	options?: {
		organizationId?: string;
		includeSystem?: boolean;
		target?: PolicyPackTarget;
	},
): Promise<PolicyPack[]> {
	const includeSystem = options?.includeSystem !== false;
	const organizationId = options?.organizationId;
	const target = options?.target;

	const ownershipCondition = organizationId
		? includeSystem
			? or(
					eq(policyPacks.organizationId, organizationId),
					eq(policyPacks.scope, "system"),
				)
			: eq(policyPacks.organizationId, organizationId)
		: includeSystem
			? undefined
			: eq(policyPacks.scope, "organization");

	const visibilityConditions = target
		? ownershipCondition
			? and(ownershipCondition, eq(policyPacks.target, target))
			: eq(policyPacks.target, target)
		: ownershipCondition;

	const headCondition = sql`${policyPacks.version} = (
		select max(candidate.version)
		from policy_packs candidate
		where candidate.scope = ${policyPacks.scope}
			and candidate.slug = ${policyPacks.slug}
	)`;
	const conditions = visibilityConditions
		? and(visibilityConditions, headCondition)
		: headCondition;
	const filtered = db.select().from(policyPacks).where(conditions);
	return filtered.orderBy(
		asc(policyPacks.scope),
		asc(policyPacks.name),
		desc(policyPacks.version),
	);
}

export async function getPolicyPackById(
	db: DbClient,
	id: string,
): Promise<PolicyPack | null> {
	return (await db.query.policyPacks.findFirst({ where: { id } })) ?? null;
}

/**
 * Resolve one policy pack by its declared `(scope, slug)` identity.
 *
 * Revision identity is globally unique on `(scope, slug, version)`, and a
 * lookup that omits `organization_id` could return ANOTHER tenant's private
 * pack. That is the cross-tenant read a Blueprint imported from the gallery
 * would otherwise perform, since it carries the publisher's slugs verbatim.
 *
 * `organizationId` is therefore a REQUIRED positional argument (mirroring
 * `getSkillEntryBySlug`) and is bound into the predicate for BOTH scopes.
 *
 * System scope is bound too, which is not obvious: a system pack is *meant* to
 * be global and ownerless, but nothing in the schema enforces that — the
 * platform-admin create path writes `organizationId: input.organizationId ??
 * orgId`, so system packs DO carry an owner in practice. Resolving system
 * scope unbound therefore let one tenant's blueprint pin bind to another
 * tenant's row, and the foreign pack's id and version were then persisted into
 * `os_workspaces.instantiation_preflight` and returned on the wire. A
 * genuinely global pack has a NULL organization, so it still resolves here.
 */
export async function getPolicyPackBySlugForOrganization(
	db: DbClient,
	organizationId: string,
	params: { scope: "system" | "organization"; slug: string; version?: number },
): Promise<PolicyPack | null> {
	const conditions = [
		eq(policyPacks.scope, params.scope),
		eq(policyPacks.slug, normalizeSlug(params.slug)),
	];
	if (params.scope === "organization") {
		conditions.push(eq(policyPacks.organizationId, organizationId));
	} else {
		// Global (ownerless) OR this caller's own — never another tenant's.
		const ownership = or(
			isNull(policyPacks.organizationId),
			eq(policyPacks.organizationId, organizationId),
		);
		if (ownership) conditions.push(ownership);
	}
	if (params.version !== undefined) {
		conditions.push(eq(policyPacks.version, params.version));
	}
	const [row] = await db
		.select()
		.from(policyPacks)
		.where(and(...conditions))
		.orderBy(desc(policyPacks.version))
		.limit(1);
	return row ?? null;
}

export async function getPolicyPackDefinitionsByIds(
	db: DbClient,
	ids: string[],
): Promise<Map<string, Record<string, unknown> | null>> {
	if (ids.length === 0) return new Map();
	const map = new Map<string, Record<string, unknown> | null>();
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams([...new Set(ids)], 50)) {
		const rows = await db
			.select({ id: policyPacks.id, definition: policyPacks.definition })
			.from(policyPacks)
			.where(inArray(policyPacks.id, chunk));
		for (const row of rows) {
			map.set(row.id, row.definition as Record<string, unknown> | null);
		}
	}
	return map;
}

export async function getActiveOrganizationPolicyPackDefinition(
	db: DbClient,
	organizationId: string,
): Promise<Record<string, unknown> | null> {
	const [row] = await db
		.select({ definition: policyPacks.definition })
		.from(policyPacks)
		.where(
			and(
				eq(policyPacks.organizationId, organizationId),
				eq(policyPacks.status, "active"),
				sql`${policyPacks.version} = (
					select max(candidate.version)
					from policy_packs candidate
					where candidate.scope = ${policyPacks.scope}
						and candidate.slug = ${policyPacks.slug}
				)`,
			),
		)
		.limit(1);
	return (row?.definition as Record<string, unknown> | null) ?? null;
}

export async function createPolicyPack(
	db: DbClient,
	input: Omit<NewPolicyPack, "id" | "createdAt" | "updatedAt">,
): Promise<PolicyPack> {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	await db.insert(policyPacks).values({
		...input,
		id,
		slug: normalizeSlug(input.slug),
		createdAt: now,
		updatedAt: now,
		publishedAt: now,
	});
	const created = await getPolicyPackById(db, id);
	if (!created) throw new Error(`Failed to create policy pack: ${id}`);
	return created;
}

export async function listWorkspaceTemplateSets(
	db: DbClient,
	options?: { organizationId?: string; includeSystem?: boolean },
): Promise<WorkspaceTemplateSet[]> {
	const includeSystem = options?.includeSystem !== false;
	const organizationId = options?.organizationId;

	const visibilityCondition = organizationId
		? includeSystem
			? or(
					eq(workspaceTemplateSets.organizationId, organizationId),
					eq(workspaceTemplateSets.scope, "system"),
				)
			: eq(workspaceTemplateSets.organizationId, organizationId)
		: includeSystem
			? undefined
			: eq(workspaceTemplateSets.scope, "organization");

	const headCondition = sql`${workspaceTemplateSets.version} = (
		select max(candidate.version)
		from workspace_template_sets candidate
		where candidate.scope = ${workspaceTemplateSets.scope}
			and candidate.slug = ${workspaceTemplateSets.slug}
	)`;
	const conditions = visibilityCondition
		? and(visibilityCondition, headCondition)
		: headCondition;
	const filtered = db.select().from(workspaceTemplateSets).where(conditions);
	return filtered.orderBy(
		asc(workspaceTemplateSets.scope),
		asc(workspaceTemplateSets.name),
		desc(workspaceTemplateSets.version),
	);
}

export async function getWorkspaceTemplateSetById(
	db: DbClient,
	id: string,
): Promise<WorkspaceTemplateSet | null> {
	return (
		(await db.query.workspaceTemplateSets.findFirst({ where: { id } })) ?? null
	);
}

export async function createWorkspaceTemplateSet(
	db: DbClient,
	input: Omit<NewWorkspaceTemplateSet, "id" | "createdAt" | "updatedAt">,
): Promise<WorkspaceTemplateSet> {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	await db.insert(workspaceTemplateSets).values({
		...input,
		id,
		slug: normalizeSlug(input.slug),
		createdAt: now,
		updatedAt: now,
		publishedAt: now,
	});
	const created = await getWorkspaceTemplateSetById(db, id);
	if (!created)
		throw new Error(`Failed to create workspace template set: ${id}`);
	return created;
}

export async function deleteRuntimeProfile(
	db: DbClient,
	id: string,
): Promise<boolean> {
	const published = await publishRuntimeProfileRevision(db, {
		revisionId: id,
		status: "archived",
		changeSummary: "Archived definition",
	});
	return published.ok;
}

export async function deletePolicyPack(
	db: DbClient,
	id: string,
): Promise<boolean> {
	const published = await publishPolicyPackRevision(db, {
		revisionId: id,
		status: "archived",
		changeSummary: "Archived definition",
	});
	return published.ok;
}

export async function deleteWorkspaceTemplateSet(
	db: DbClient,
	id: string,
): Promise<boolean> {
	const published = await publishWorkspaceTemplateSetRevision(db, {
		revisionId: id,
		status: "archived",
		changeSummary: "Archived definition",
	});
	return published.ok;
}

export interface EffectiveActiveAppConfig {
	appId: string;
	activeConfigVersionId: string | null;
	activeConfigVersionNumber: number | null;
	source: "live_app" | "active_version";
	config: Record<string, unknown>;
}

/**
 * `organizationId` is REQUIRED, not optional. Resolving an app config by id
 * alone returned any tenant's config to any authenticated caller — `apps` is
 * org-scoped (`uniq_app_org_slug`), and the single caller only checked that the
 * CALLER had an organization, never that this app belonged to it. Scoped here
 * rather than in the router so the boundary cannot be forgotten at a future
 * call site; a non-matching pair reads as "not found", which is also what keeps
 * the endpoint from confirming that another tenant's app id exists.
 */
export async function getEffectiveActiveAppConfig(
	db: DbClient,
	appId: string,
	organizationId: string,
): Promise<EffectiveActiveAppConfig | null> {
	const app = await db.query.apps.findFirst({
		where: { id: appId, organizationId },
	});
	if (!app) return null;

	const baseConfig: Record<string, unknown> = {
		metadata: app.metadata ?? null,
		gatingMetadata: app.gatingMetadata ?? null,
	};

	if (!app.activeConfigVersionId) {
		return {
			appId: app.id,
			activeConfigVersionId: null,
			activeConfigVersionNumber: null,
			source: "live_app",
			config: baseConfig,
		};
	}

	const activeVersion = await db.query.appConfigVersions.findFirst({
		where: { id: app.activeConfigVersionId, appId: app.id },
	});

	if (!activeVersion) {
		return {
			appId: app.id,
			activeConfigVersionId: app.activeConfigVersionId,
			activeConfigVersionNumber: null,
			source: "live_app",
			config: baseConfig,
		};
	}

	const versionConfig = activeVersion.config as Record<string, unknown> | null;

	return {
		appId: app.id,
		activeConfigVersionId: activeVersion.id,
		activeConfigVersionNumber: activeVersion.version,
		source: versionConfig ? "active_version" : "live_app",
		config: versionConfig
			? deepMergeJson(baseConfig, versionConfig)
			: baseConfig,
	};
}

/**
 * The slug every system-scoped default record shares. The platform default is
 * whichever ACTIVE PUBLISHED revision of this slug carries the highest version
 * — a D1 fact, not a compiled-in id.
 *
 * It used to be three hardcoded UUID constants in `schema/control-plane.ts`,
 * which drifted the moment anyone published a new revision: the policy-pack
 * constant still pointed at v26 while the live head was v27, so every caller
 * that took the hardcoded fallback silently ran an outdated policy. Publishing
 * a revision is the supported way to change a platform default, so resolution
 * has to follow the head rather than a literal written months earlier.
 */
const SYSTEM_DEFAULT_SLUG = "system-default";

/** Newest active published system-default runtime profile, or `null`. */
export async function getSystemDefaultRuntimeProfile(
	db: DbClient,
): Promise<RuntimeProfile | null> {
	const rows = await db
		.select()
		.from(runtimeProfiles)
		.where(
			and(
				eq(runtimeProfiles.scope, "system"),
				eq(runtimeProfiles.slug, SYSTEM_DEFAULT_SLUG),
				eq(runtimeProfiles.status, "active"),
				isNotNull(runtimeProfiles.publishedAt),
			),
		)
		.orderBy(desc(runtimeProfiles.version))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Newest active published system-default tedi policy pack, or `null`.
 *
 * Constrained to a tedi-assignable target for the same reason the tedi-create
 * path is: a pack targeting something else is not a usable tedi default.
 */
export async function getSystemDefaultPolicyPack(
	db: DbClient,
): Promise<PolicyPack | null> {
	const rows = await db
		.select()
		.from(policyPacks)
		.where(
			and(
				eq(policyPacks.scope, "system"),
				eq(policyPacks.slug, SYSTEM_DEFAULT_SLUG),
				eq(policyPacks.status, "active"),
				isNotNull(policyPacks.publishedAt),
				inArray(policyPacks.target, ["tedi", "shared"]),
			),
		)
		.orderBy(desc(policyPacks.version))
		.limit(1);
	return rows[0] ?? null;
}

/** Newest active published system-default workspace template set, or `null`. */
export async function getSystemDefaultWorkspaceTemplateSet(
	db: DbClient,
): Promise<WorkspaceTemplateSet | null> {
	const rows = await db
		.select()
		.from(workspaceTemplateSets)
		.where(
			and(
				eq(workspaceTemplateSets.scope, "system"),
				eq(workspaceTemplateSets.slug, SYSTEM_DEFAULT_SLUG),
				eq(workspaceTemplateSets.status, "active"),
				isNotNull(workspaceTemplateSets.publishedAt),
			),
		)
		.orderBy(desc(workspaceTemplateSets.version))
		.limit(1);
	return rows[0] ?? null;
}
