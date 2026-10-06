/**
 * Organization Query Helpers
 * Database queries for organization management
 *
 * Organizations are the top-level tenant/team entity that own multiple AI apps.
 * Each organization has:
 * - Explicit feature overrides
 * - Descope integration for SSO
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type {
	BillingSettlementMode,
	RuntimeEntitlementGrant,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import type { DbClient } from "../client";
import { apiKeys } from "../schema/api-keys";
import { apps } from "../schema/apps";
import { organizationMembers } from "../schema/organization-members";
import type {
	NewOrganization,
	Organization,
	OrganizationFeatures,
	OrganizationMetadata,
	OrganizationFeaturePlanKey,
} from "../schema/organizations";
import {
	DEFAULT_ORGANIZATION_FEATURES_BY_PLAN,
	organizations,
} from "../schema/organizations";
import { tedis } from "../schema/tedis";
import {
	buildProvisionBillingAccountStatement,
	getBillingEntitlement,
	requireActiveBillingPlan,
} from "./billing/plans";
import type { ExternalIdentity } from "./principal-identities";
import {
	bindPrincipalIdentity,
	resolvePrincipalIdentity,
} from "./principal-identities";

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get organization by ID with members and apps
 * Uses Relations API for efficient single-query loading
 *
 * @param db - Database client
 * @param id - Organization ID (UUID)
 * @returns Organization with nested members and apps, or undefined
 *
 * @example
 * const org = await getOrganizationById(db, orgId);
 * console.log(org?.members.length); // Type-safe access
 */
export async function getOrganizationById(
	db: DbClient,
	id: string,
): Promise<Organization | undefined> {
	return db.query.organizations.findFirst({ where: { id } });
}

/** Narrow identity-edge lookup that avoids hydrating an organization's relations. */
export async function getOrganizationDescopeTenantId(
	db: DbClient,
	id: string,
): Promise<string | null | undefined> {
	const [row] = await db
		.select({ descopeTenantId: organizations.descopeTenantId })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row?.descopeTenantId;
}

/**
 * Narrow display-name lookup that avoids hydrating an organization's relations.
 * Used where a name is recorded as provenance (blueprint fork lineage), so the
 * origin stays readable after the row itself is unreachable.
 */
export async function getOrganizationDisplayName(
	db: DbClient,
	id: string,
): Promise<string | undefined> {
	const [row] = await db
		.select({ name: organizations.name })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row?.name;
}

export interface OrganizationProfileRow {
	id: string;
	name: string;
	slug: string;
	type: string;
	descopeTenantId: string | null;
	logoUrl: string | null;
}

/**
 * Narrow tenant-identity projection: exactly the display fields an operator
 * surface needs, and nothing else.
 *
 * Deliberately a column list rather than `getOrganizationById`, which selects
 * every column — including the `metadata` blob. That must never ride along
 * into a read-only context projection just because the caller only meant to
 * render a name.
 */
export async function getOrganizationProfile(
	db: DbClient,
	id: string,
): Promise<OrganizationProfileRow | null> {
	const [row] = await db
		.select({
			id: organizations.id,
			name: organizations.name,
			slug: organizations.slug,
			type: organizations.type,
			descopeTenantId: organizations.descopeTenantId,
			logoUrl: organizations.logoUrl,
		})
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row ?? null;
}

/**
 * Narrow appearance projection kept separate from tenant identity so callers
 * that only need a name/logo never hydrate the organization's metadata bag.
 */
export async function getOrganizationOsTheme(
	db: DbClient,
	id: string,
): Promise<OrganizationMetadata["osTheme"] | null> {
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row?.metadata?.osTheme ?? null;
}

/**
 * Get organization by slug
 *
 * @param db - Database client
 * @param slug - Organization slug (unique identifier)
 */
export async function getOrganizationBySlug(
	db: DbClient,
	slug: string,
): Promise<Organization | undefined> {
	const [row] = await db
		.select()
		.from(organizations)
		.where(
			and(
				eq(organizations.slug, slug.toLowerCase()),
				sql`json_extract(${organizations.metadata}, '$.retiredAt') IS NULL`,
			),
		)
		.limit(1);
	return row;
}

/**
 * Get organization by Descope tenant ID
 * Used for SSO/identity provider integration
 *
 * @param db - Database client
 * @param descopeTenantId - Descope tenant ID
 */
export async function getOrganizationByDescopeId(
	db: DbClient,
	descopeTenantId: string,
): Promise<Organization | undefined> {
	const [row] = await db
		.select()
		.from(organizations)
		.where(
			and(
				eq(organizations.descopeTenantId, descopeTenantId),
				sql`json_extract(${organizations.metadata}, '$.retiredAt') IS NULL`,
			),
		)
		.limit(1);
	return row;
}

export async function getOrganizationByExternalIdentity(
	db: DbClient,
	identity: ExternalIdentity,
): Promise<Organization | undefined> {
	const mapping = await resolvePrincipalIdentity(db, identity, {
		principalType: "organization",
	});
	return mapping ? getOrganizationById(db, mapping.principalId) : undefined;
}

export async function bindOrganizationExternalIdentity(
	db: DbClient,
	organizationId: string,
	identity: ExternalIdentity,
	verifiedAt?: string,
): Promise<void> {
	await bindPrincipalIdentity(db, {
		organizationId,
		principalType: "organization",
		principalId: organizationId,
		...identity,
		verifiedAt,
	});
}

/**
 * List all organizations with pagination
 *
 * @param db - Database client
 * @param opts - Pagination and filter options
 */
export async function listOrganizations(
	db: DbClient,
	opts?: {
		limit?: number;
		offset?: number;
	},
): Promise<Organization[]> {
	const conditions = [
		sql`json_extract(${organizations.metadata}, '$.retiredAt') IS NULL`,
	];

	let query = db
		.select()
		.from(organizations)
		.orderBy(desc(organizations.createdAt))
		.limit(opts?.limit ?? 50)
		.offset(opts?.offset ?? 0);

	if (conditions.length > 0) {
		query = query.where(and(...conditions)) as typeof query;
	}

	return query;
}

/**
 * Get a user's personal organization
 * Joins through organization_members to find the org with type = "personal"
 * that the given Descope user ID belongs to.
 *
 * @param db - Database client
 * @param descopeUserId - Descope user ID (sub claim from JWT)
 */
export async function getPersonalOrganization(
	db: DbClient,
	descopeUserId: string,
): Promise<Organization | undefined> {
	// Deliberately the relational query builder and not a `.select()` join.
	//
	// A no-argument `.select()` across a join emits the raw column names of both
	// tables, so every name the two share — here `id`, `name`, `created_at`,
	// `updated_at` — appears twice in the result set. D1 hands Workers an object
	// per row, and Drizzle rebuilds the positional array with
	// `Object.keys(row).map((k) => row[k])` (see `d1ToRawMapping`, which carries
	// an upstream comment warning about exactly this). Duplicate keys collapse,
	// every later field shifts left, and the rows silently decode wrong: this
	// function used to return an organization whose `id` was the membership row's
	// id and whose `name` was the member's display name.
	//
	// The RQB aliases each column to its unique TS key and never emits a
	// top-level join, so no collision is possible regardless of table shape.
	const candidates = await db.query.organizations.findMany({
		where: {
			type: "personal",
			members: { descopeUserId },
		},
	});
	return candidates.find(
		(organization) =>
			!(organization.metadata as { retiredAt?: string } | null)?.retiredAt,
	);
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a new organization
 *
 * @param db - Database client
 * @param data - Organization data
 */
/** One month after an instant, matching `rollBillingPeriods`' own advance. */
function monthAfter(instant: string): string {
	const end = new Date(instant);
	end.setUTCMonth(end.getUTCMonth() + 1);
	return end.toISOString();
}

export async function createOrganization(
	db: DbClient,
	data: Omit<NewOrganization, "id" | "createdAt" | "updatedAt">,
	options: {
		settlementMode: BillingSettlementMode;
		runtimeEntitlementGrants?: RuntimeEntitlementGrant[];
	},
): Promise<Organization> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	const features =
		data.features ?? DEFAULT_ORGANIZATION_FEATURES_BY_PLAN.starter;
	const usesManagedSettlement = options.settlementMode === "managed";
	const periodStart = now;
	// A non-trial period is ONE MONTH from its start, derived the same way
	// `rollBillingPeriods` advances a closed window. Truncating to the 1st of
	// next month instead meant the first window was whatever was left of the
	// month — an account opened on the 29th got three days carrying a full
	// monthly allowance, and one opened on the 1st got thirty. The allowance is
	// sized per month, so the window has to be one.
	//
	// The managed-trial window stays a deliberate 14 days; it is a trial, not a
	// billing month.
	const periodEnd = usesManagedSettlement
		? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
		: monthAfter(now);

	// Resolve the plan before the write set: it is a read, so it does not belong
	// in the batch, and a missing plan must fail before the organization row
	// exists rather than leave one behind without a billing account.
	const plan = await requireActiveBillingPlan(db, "starter", now);

	// D1 rejects `BEGIN TRANSACTION` (Cloudflare error 7500), so `db.transaction()`
	// throws against a real database. `db.batch()` is D1's atomicity primitive —
	// Cloudflare wraps the batch in an implicit transaction — so the organization
	// and its billing account still land together or not at all.
	await db.batch([
		db.insert(organizations).values({
			...data,
			id,
			slug: data.slug.toLowerCase(),
			features,
			createdAt: now,
			updatedAt: now,
		}),
		buildProvisionBillingAccountStatement(db, {
			organizationId: id,
			planVersionId: plan.id,
			status: usesManagedSettlement ? "trial" : "active",
			billingMode: !usesManagedSettlement ? "internal" : "trial",
			periodStart,
			periodEnd,
			now,
			metadata: {
				provisionedWithOrganization: true,
				runtimeEntitlementSource:
					options.settlementMode === "managed"
						? "managed-plan"
						: options.settlementMode === "external"
							? "external"
							: "installation",
				runtimeEntitlementGrants: options.runtimeEntitlementGrants ?? [],
			},
		}),
	]);

	const created = await getOrganizationById(db, id);
	if (!created) {
		throw new Error(`Failed to create organization: ${id}`);
	}
	return created;
}

/**
 * Update an organization
 *
 * @param db - Database client
 * @param id - Organization ID
 * @param data - Fields to update
 */
export async function updateOrganization(
	db: DbClient,
	id: string,
	data: Partial<Omit<NewOrganization, "id" | "createdAt">>,
): Promise<Organization> {
	const now = new Date().toISOString();

	await db
		.update(organizations)
		.set({
			...data,
			...(data.slug && { slug: data.slug.toLowerCase() }),
			updatedAt: now,
		})
		.where(eq(organizations.id, id));

	const updated = await getOrganizationById(db, id);
	if (!updated) {
		throw new Error(`Organization not found: ${id}`);
	}
	return updated;
}

export interface RetireOrganizationParams {
	id: string;
	retiredAt: string;
	retiredBy: string | null;
	metadata: OrganizationMetadata & {
		retiredAt: string;
		retiredSlug: string;
		memoryRetained: true;
	};
	features: OrganizationFeatures;
}

/**
 * Retire an organization without firing its tedi cascade.
 *
 * This is one D1 batch: every live tedi is retired with the same preservation
 * semantics as `retireTedi`, credentials and routes are disabled, memberships
 * are deactivated, and the organization row is renamed and tombstoned. Keeping
 * both parent tables means their memory, rationale, skills and audit history
 * remain recoverable. The organization CAS is last so a concurrent retry
 * returns no row while the whole batch remains idempotent.
 */
export async function retireOrganization(
	db: DbClient,
	params: RetireOrganizationParams,
): Promise<Organization | undefined> {
	const [, , , , retiredOrganizations] = await db.batch([
		db
			.update(tedis)
			.set({
				retiredAt: params.retiredAt,
				retiredSlug: sql`${tedis.slug}`,
				slug: sql`${tedis.slug} || '-retired-' || ${tedis.id}`,
				isolateAgentId: sql`coalesce(${tedis.isolateAgentId}, ${tedis.slug})`,
				status: "paused",
				runtimeState: "archived",
				updatedAt: params.retiredAt,
			})
			.where(and(eq(tedis.organizationId, params.id), isNull(tedis.retiredAt))),
		db
			.update(apiKeys)
			.set({
				status: "revoked",
				revokedAt: params.retiredAt,
				revokedBy: params.retiredBy,
				revokeReason: "Organization retired",
				previousKeyHash: null,
				previousKeyExpiresAt: null,
				updatedAt: params.retiredAt,
			})
			.where(
				and(
					eq(apiKeys.organizationId, params.id),
					eq(apiKeys.status, "active"),
				),
			),
		db
			.update(apps)
			.set({ visibility: "disabled", updatedAt: params.retiredAt })
			.where(eq(apps.organizationId, params.id)),
		db
			.update(organizationMembers)
			.set({ status: "deactivated", updatedAt: params.retiredAt })
			.where(eq(organizationMembers.organizationId, params.id)),
		db
			.update(organizations)
			.set({
				slug: sql`${organizations.slug} || '-retired-' || ${organizations.id}`,
				features: params.features,
				metadata: params.metadata,
				updatedAt: params.retiredAt,
			})
			.where(
				and(
					eq(organizations.id, params.id),
					sql`json_extract(${organizations.metadata}, '$.retiredAt') IS NULL`,
				),
			)
			.returning(),
	]);
	return retiredOrganizations[0];
}

// ============================================================================
// Plan Feature Management
// ============================================================================

/**
 * Apply a billing plan's default organization features.
 *
 * @param db - Database client
 * @param id - Organization ID
 * @param tier - Canonical billing plan key
 */
export async function applyOrganizationPlanFeatures(
	db: DbClient,
	id: string,
	tier: OrganizationFeaturePlanKey,
): Promise<Organization> {
	const now = new Date().toISOString();

	await db
		.update(organizations)
		.set({
			// OS provisioning is an explicit lifecycle setting, not a plan
			// entitlement. Preserve its boolean value atomically so a Stripe
			// plan update cannot make an existing tenant hostname disappear.
			features: sql`json_patch(${JSON.stringify(DEFAULT_ORGANIZATION_FEATURES_BY_PLAN[tier])}, CASE json_type(${organizations.features}, '$.os') WHEN 'true' THEN '{"os":true}' WHEN 'false' THEN '{"os":false}' ELSE '{}' END)`,
			updatedAt: now,
		})
		.where(eq(organizations.id, id));

	const updated = await getOrganizationById(db, id);
	if (!updated) {
		throw new Error(`Organization not found: ${id}`);
	}
	return updated;
}

// ============================================================================
// Feature Management
// ============================================================================

/**
 * Get organization features
 * Returns the full features object with tier defaults merged
 *
 * @param db - Database client
 * @param id - Organization ID
 */
export async function getOrganizationFeatures(
	db: DbClient,
	id: string,
): Promise<OrganizationFeatures | null> {
	const org = await getOrganizationById(db, id);
	if (!org) return null;

	const entitlement = await getBillingEntitlement(db, id);
	if (!entitlement) return null;
	const tierDefaults =
		DEFAULT_ORGANIZATION_FEATURES_BY_PLAN[entitlement.plan.planKey];
	return {
		...tierDefaults,
		...org.features,
	};
}

/**
 * Update organization features
 * Merges with existing features (partial update)
 *
 * @param db - Database client
 * @param id - Organization ID
 * @param features - Features to update
 */
export async function updateOrganizationFeatures(
	db: DbClient,
	id: string,
	features: Partial<OrganizationFeatures>,
): Promise<Organization> {
	const existing = await getOrganizationById(db, id);
	if (!existing) {
		throw new Error(`Organization not found: ${id}`);
	}

	const mergedFeatures = {
		...existing.features,
		...features,
	};

	return updateOrganization(db, id, { features: mergedFeatures });
}

/**
 * Check if organization can create more apps
 *
 * @param db - Database client
 * @param id - Organization ID
 */
export async function canCreateApp(
	db: DbClient,
	id: string,
): Promise<{ allowed: boolean; reason?: string }> {
	const org = await getOrganizationById(db, id);
	if (!org) {
		return { allowed: false, reason: "Organization not found" };
	}

	const entitlement = await getBillingEntitlement(db, id);
	if (!entitlement) {
		return { allowed: false, reason: "Billing account not found" };
	}

	if (!["active", "trial"].includes(entitlement.account.status)) {
		return {
			allowed: false,
			reason: `Subscription is ${entitlement.account.status}`,
		};
	}

	if (
		entitlement.account.status === "trial" &&
		new Date(entitlement.account.periodEnd) < new Date()
	) {
		return { allowed: false, reason: "Trial has expired" };
	}

	// Check app limit
	const features = await getOrganizationFeatures(db, id);
	const maxApps = features?.maxApps ?? 1;

	// -1 means unlimited
	if (maxApps === -1) {
		return { allowed: true };
	}

	const currentCount = org.appsCount ?? 0;
	if (currentCount >= maxApps) {
		return {
			allowed: false,
			reason: `App limit reached (${currentCount}/${maxApps}). Upgrade to create more apps.`,
		};
	}

	return { allowed: true };
}

// ============================================================================
// Metadata Management
// ============================================================================

/**
 * Update organization metadata
 * Merges with existing metadata (partial update)
 *
 * @param db - Database client
 * @param id - Organization ID
 * @param metadata - Metadata to update
 */
export async function updateOrganizationMetadata(
	db: DbClient,
	id: string,
	metadata: Partial<OrganizationMetadata>,
): Promise<Organization> {
	const existing = await getOrganizationById(db, id);
	if (!existing) {
		throw new Error(`Organization not found: ${id}`);
	}

	const mergedMetadata = {
		...existing.metadata,
		...metadata,
	};

	return updateOrganization(db, id, { metadata: mergedMetadata });
}

// ============================================================================
// App Count Management
// ============================================================================

/**
 * Increment organization app count
 * Called when a new app is created for this organization
 *
 * @param db - Database client
 * @param id - Organization ID
 */
export async function incrementAppCount(
	db: DbClient,
	id: string,
): Promise<void> {
	const now = new Date().toISOString();

	await db
		.update(organizations)
		.set({
			appsCount: sql`${organizations.appsCount} + 1`,
			updatedAt: now,
		})
		.where(eq(organizations.id, id));
}

/**
 * Decrement organization app count
 * Called when an app is deleted from this organization
 *
 * @param db - Database client
 * @param id - Organization ID
 */
export async function decrementAppCount(
	db: DbClient,
	id: string,
): Promise<void> {
	const now = new Date().toISOString();

	await db
		.update(organizations)
		.set({
			appsCount: sql`MAX(0, ${organizations.appsCount} - 1)`,
			updatedAt: now,
		})
		.where(eq(organizations.id, id));
}

/**
 * Sync organization app count from actual app count
 * Used to fix any count drift
 *
 * @param db - Database client
 * @param id - Organization ID
 */
export async function syncAppCount(db: DbClient, id: string): Promise<number> {
	const actualCount = await db.$count(apps, eq(apps.organizationId, id));
	const now = new Date().toISOString();

	await db
		.update(organizations)
		.set({
			appsCount: actualCount,
			updatedAt: now,
		})
		.where(eq(organizations.id, id));

	return actualCount;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if slug is available
 *
 * @param db - Database client
 * @param slug - Slug to check
 * @param excludeId - Organization ID to exclude (for updates)
 */
export async function isSlugAvailable(
	db: DbClient,
	slug: string,
	excludeId?: string,
): Promise<boolean> {
	const existing = await getOrganizationBySlug(db, slug);
	if (!existing) return true;
	if (excludeId && existing.id === excludeId) return true;
	return false;
}

/**
 * Generate a unique slug from a name
 *
 * @param db - Database client
 * @param name - Organization name
 */
export async function generateUniqueSlug(
	db: DbClient,
	name: string,
): Promise<string> {
	// Convert name to slug format
	const baseSlug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

	// Check if base slug is available
	if (await isSlugAvailable(db, baseSlug)) {
		return baseSlug;
	}

	// Try with random suffix
	for (let i = 0; i < 10; i++) {
		const suffix = Math.random().toString(36).substring(2, 6);
		const slug = `${baseSlug}-${suffix}`;
		if (await isSlugAvailable(db, slug)) {
			return slug;
		}
	}

	// Fallback to UUID suffix
	return `${baseSlug}-${crypto.randomUUID().substring(0, 8)}`;
}

/** Replace only platform-owned onboarding defaults without overwriting other metadata. */
export async function setProviderOnboardingConfiguration(
	db: DbClient,
	organizationId: string,
	config: NonNullable<OrganizationMetadata["providerOnboarding"]>,
) {
	const [row] = await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.providerOnboarding', json(${JSON.stringify(config)}))`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(organizations.id, organizationId))
		.returning({ id: organizations.id });
	return row ?? null;
}
