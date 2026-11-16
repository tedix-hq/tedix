import { projects } from "../schema/projects";
import { apiKeys } from "../schema/api-keys";
import type { RetireOrganizationParams } from "../../queries/organizations";
import { apps } from "../schema/apps";
import { tedis } from "../schema/tedis";
import type {
	BillingSettlementMode,
	RuntimeEntitlementGrant,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import { billingAccounts, billingPlanVersions } from "../schema/billing";
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
	ConnectionConsumerGrantsSchema,
	type ConnectionConsumerGrants,
} from "@tedix/api-contract/schemas/connections";
import type { PgQueryClient } from "../query-client";
import { organizations, organizationMembers } from "../schema/organizations";
import { DEFAULT_ORGANIZATION_FEATURES_BY_PLAN } from "../../schema/organizations";
import type {
	Organization,
	NewOrganization,
	OrganizationFeatures,
	OrganizationMetadata,
	OrganizationFeaturePlanKey,
} from "../../schema/organizations";
import type {
	OrganizationProfileRow,
	OrganizationGuestProfileRow,
	OrganizationWidgetQuotaStatus,
} from "../../queries/organizations";
import { projectOrganizationWidgetQuota } from "../../utils/organizations";
import {
	bindPrincipalIdentity,
	resolvePrincipalIdentity,
	type ExternalIdentity,
} from "./principal-identities";
function connectionConsumerGrantsPath(providerId: string, instanceId?: string) {
	return `${encodeURIComponent(providerId)}:${encodeURIComponent(instanceId ?? "")}`;
}

export async function getOrganizationById(
	db: PgQueryClient,
	id: string,
): Promise<Organization | undefined> {
	const [row] = await db
		.select()
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row;
}

export async function getOrganizationDescopeTenantId(
	db: PgQueryClient,
	id: string,
): Promise<string | null | undefined> {
	const [row] = await db
		.select({ descopeTenantId: organizations.descopeTenantId })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row?.descopeTenantId;
}

export async function getOrganizationDisplayName(
	db: PgQueryClient,
	id: string,
): Promise<string | undefined> {
	const [row] = await db
		.select({ name: organizations.name })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row?.name;
}

export async function getOrganizationProfile(
	db: PgQueryClient,
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

export async function getOrganizationGuestProfile(
	db: PgQueryClient,
	id: string,
): Promise<OrganizationGuestProfileRow | null> {
	const [row] = await db
		.select({
			name: organizations.name,
			logoUrl: organizations.logoUrl,
			locale: sql<unknown>`${organizations.metadata} #> '{tediWidget,locale}'`,
			translations: sql<
				string | null
			>`${organizations.metadata} #>> '{tediWidget,translations}'`,
		})
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	if (!row) return null;
	let translations: OrganizationGuestProfileRow["translations"] = null;
	try {
		const parsed: unknown = row.translations && JSON.parse(row.translations);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			translations = parsed as OrganizationGuestProfileRow["translations"];
	} catch {
		// Match SQLite's recovery for malformed override bags.
	}
	return {
		name: row.name,
		logoUrl: row.logoUrl,
		locale: typeof row.locale === "string" ? row.locale : null,
		translations,
	};
}

export async function getOrganizationOsTheme(
	db: PgQueryClient,
	id: string,
): Promise<OrganizationMetadata["osTheme"] | null> {
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row?.metadata?.osTheme ?? null;
}

export async function getOrganizationBySlug(
	db: PgQueryClient,
	slug: string,
): Promise<Organization | undefined> {
	const [row] = await db
		.select()
		.from(organizations)
		.where(
			and(
				eq(organizations.slug, slug.toLowerCase()),
				sql`(${organizations.metadata} ->> 'retiredAt') IS NULL`,
			),
		)
		.limit(1);
	return row;
}

export async function getOrganizationByDescopeId(
	db: PgQueryClient,
	descopeTenantId: string,
): Promise<Organization | undefined> {
	const [row] = await db
		.select()
		.from(organizations)
		.where(
			and(
				eq(organizations.descopeTenantId, descopeTenantId),
				sql`(${organizations.metadata} ->> 'retiredAt') IS NULL`,
			),
		)
		.limit(1);
	return row;
}

export async function getOrganizationByExternalIdentity(
	db: PgQueryClient,
	identity: ExternalIdentity,
): Promise<Organization | undefined> {
	const mapping = await resolvePrincipalIdentity(db, identity, {
		principalType: "organization",
	});
	return mapping ? getOrganizationById(db, mapping.principalId) : undefined;
}

export async function bindOrganizationExternalIdentity(
	db: PgQueryClient,
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

export async function listOrganizations(
	db: PgQueryClient,
	opts?: {
		limit?: number;
		offset?: number;
	},
): Promise<Organization[]> {
	const conditions = [sql`(${organizations.metadata} ->> 'retiredAt') IS NULL`];

	let query = db
		.select()
		.from(organizations)
		.orderBy(sql`${organizations.createdAt} DESC NULLS LAST`)
		.limit(opts?.limit ?? 50)
		.offset(opts?.offset ?? 0);

	if (conditions.length > 0) {
		query = query.where(and(...conditions)) as typeof query;
	}

	return query;
}

export async function listOrganizationWidgetQuotaStatus(
	db: PgQueryClient,
): Promise<OrganizationWidgetQuotaStatus[]> {
	const rows = await db
		.select({
			id: organizations.id,
			slug: organizations.slug,
			name: organizations.name,
			metadata: organizations.metadata,
		})
		.from(organizations)
		.where(sql`(${organizations.metadata} ->> 'retiredAt') IS NULL`)
		.orderBy(organizations.slug);
	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		name: row.name,
		...projectOrganizationWidgetQuota(row.metadata),
	}));
}

export async function updateOrganization(
	db: PgQueryClient,
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

export async function applyOrganizationPlanFeatures(
	db: PgQueryClient,
	id: string,
	tier: OrganizationFeaturePlanKey,
): Promise<Organization> {
	const now = new Date().toISOString();

	await db
		.update(organizations)
		.set({
			features: sql`${JSON.stringify(DEFAULT_ORGANIZATION_FEATURES_BY_PLAN[tier])}::jsonb || CASE WHEN jsonb_typeof(${organizations.features} -> 'os') = 'boolean' THEN jsonb_build_object('os', ${organizations.features} -> 'os') ELSE '{}'::jsonb END`,
			updatedAt: now,
		})
		.where(eq(organizations.id, id));

	const updated = await getOrganizationById(db, id);
	if (!updated) {
		throw new Error(`Organization not found: ${id}`);
	}
	return updated;
}

export async function updateOrganizationFeatures(
	db: PgQueryClient,
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

export async function updateOrganizationMetadata(
	db: PgQueryClient,
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

export async function incrementAppCount(
	db: PgQueryClient,
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

export async function decrementAppCount(
	db: PgQueryClient,
	id: string,
): Promise<void> {
	const now = new Date().toISOString();

	await db
		.update(organizations)
		.set({
			appsCount: sql`CASE WHEN ${organizations.appsCount} IS NULL THEN NULL ELSE GREATEST(0, ${organizations.appsCount} - 1) END`,
			updatedAt: now,
		})
		.where(eq(organizations.id, id));
}

export async function isSlugAvailable(
	db: PgQueryClient,
	slug: string,
	excludeId?: string,
): Promise<boolean> {
	const existing = await getOrganizationBySlug(db, slug);
	if (!existing) return true;
	if (excludeId && existing.id === excludeId) return true;
	return false;
}

export async function generateUniqueSlug(
	db: PgQueryClient,
	name: string,
): Promise<string> {
	const baseSlug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

	if (await isSlugAvailable(db, baseSlug)) {
		return baseSlug;
	}

	for (let i = 0; i < 10; i++) {
		const suffix = Math.random().toString(36).substring(2, 6);
		const slug = `${baseSlug}-${suffix}`;
		if (await isSlugAvailable(db, slug)) {
			return slug;
		}
	}

	return `${baseSlug}-${crypto.randomUUID().substring(0, 8)}`;
}

export async function setProviderOnboardingConfiguration(
	db: PgQueryClient,
	organizationId: string,
	config: NonNullable<OrganizationMetadata["providerOnboarding"]>,
) {
	const [row] = await db
		.update(organizations)
		.set({
			metadata: sql`jsonb_set(coalesce(${organizations.metadata}, '{}'::jsonb), '{providerOnboarding}', ${JSON.stringify(config)}::jsonb)`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(organizations.id, organizationId))
		.returning({ id: organizations.id });
	return row ?? null;
}

export async function getConnectionConsumerGrants(
	db: PgQueryClient,
	organizationId: string,
	providerId: string,
	instanceId?: string,
): Promise<ConnectionConsumerGrants> {
	const [row] = await db
		.select({
			policy: sql<unknown>`${organizations.metadata} #> ARRAY['connectionConsumerGrants', ${connectionConsumerGrantsPath(providerId, instanceId)}]`,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!row)
		throw new Error("Organization not found while resolving connection grants");
	return row.policy === null
		? { mode: "all" }
		: ConnectionConsumerGrantsSchema.parse(row.policy);
}

export async function setConnectionConsumerGrants(
	db: PgQueryClient,
	organizationId: string,
	providerId: string,
	policy: ConnectionConsumerGrants,
	instanceId?: string,
) {
	const validated = ConnectionConsumerGrantsSchema.parse(policy);
	const [row] = await db
		.update(organizations)
		.set({
			metadata: sql`jsonb_set(coalesce(${organizations.metadata}, '{}'::jsonb), '{connectionConsumerGrants}', coalesce(${organizations.metadata} -> 'connectionConsumerGrants', '{}'::jsonb) || jsonb_build_object(${connectionConsumerGrantsPath(providerId, instanceId)}::text, ${JSON.stringify(validated)}::jsonb))`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(organizations.id, organizationId))
		.returning({ id: organizations.id });
	return row ?? null;
}

function monthAfter(instant: string): string {
	const end = new Date(instant);
	end.setUTCMonth(end.getUTCMonth() + 1);
	return end.toISOString();
}
async function getBillingEntitlement(
	db: PgQueryClient,
	organizationId: string,
) {
	const [row] = await db
		.select({ account: billingAccounts, plan: billingPlanVersions })
		.from(billingAccounts)
		.innerJoin(
			billingPlanVersions,
			eq(billingAccounts.planVersionId, billingPlanVersions.id),
		)
		.where(eq(billingAccounts.organizationId, organizationId))
		.limit(1);
	return row
		? {
				...row,
				plan: {
					...row.plan,
					planKey: row.plan.planKey as OrganizationFeaturePlanKey,
				},
			}
		: null;
}
export async function getPersonalOrganization(
	db: PgQueryClient,
	descopeUserId: string,
): Promise<Organization | undefined> {
	const candidates = await db
		.select()
		.from(organizations)
		.where(
			and(
				eq(organizations.type, "personal"),
				sql`EXISTS (SELECT 1 FROM ${organizationMembers} WHERE ${organizationMembers.organizationId} = ${organizations.id} AND ${organizationMembers.descopeUserId} = ${descopeUserId})`,
			),
		);
	return candidates.find(
		(organization) =>
			!(organization.metadata as { retiredAt?: string } | null)?.retiredAt,
	);
}

export async function createOrganization(
	db: PgQueryClient,
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
	const periodEnd = usesManagedSettlement
		? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
		: monthAfter(now);

	const [plan] = await db
		.select()
		.from(billingPlanVersions)
		.where(
			and(
				eq(billingPlanVersions.planKey, "starter"),
				eq(billingPlanVersions.status, "active"),
				lte(billingPlanVersions.effectiveAt, now),
			),
		)
		.orderBy(desc(billingPlanVersions.version))
		.limit(1);
	if (!plan) throw new Error("Active billing plan not found: starter");

	await db.transaction(async (tx) => {
		await tx.insert(organizations).values({
			...data,
			id,
			slug: data.slug.toLowerCase(),
			features,
			createdAt: now,
			updatedAt: now,
		});
		await tx.insert(billingAccounts).values({
			organizationId: id,
			planVersionId: plan.id,
			status: usesManagedSettlement ? "trial" : "active",
			billingMode: usesManagedSettlement ? "trial" : "internal",
			periodStart,
			periodEnd,
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
			createdAt: now,
			updatedAt: now,
		});
	});

	const created = await getOrganizationById(db, id);
	if (!created) {
		throw new Error(`Failed to create organization: ${id}`);
	}
	return created;
}

export async function getOrganizationFeatures(
	db: PgQueryClient,
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

export async function canCreateApp(
	db: PgQueryClient,
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

	const features = await getOrganizationFeatures(db, id);
	const maxApps = features?.maxApps ?? 1;

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

export async function getOrganizationSessionProjectBindings(
	db: PgQueryClient,
	id: string,
) {
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	const bindings = row?.metadata?.sessionProjectBindings ?? [];
	const ids = [...new Set(bindings.map((binding) => binding.projectId))];
	const valid = new Set<string>();
	for (let offset = 0; offset < ids.length; offset += 50) {
		const targets = await db
			.select({ id: projects.id })
			.from(projects)
			.where(
				and(
					eq(projects.orgId, id),
					inArray(projects.id, ids.slice(offset, offset + 50)),
				),
			);
		for (const target of targets) valid.add(target.id);
	}
	return bindings.filter((binding) => valid.has(binding.projectId));
}

export async function retireOrganization(
	db: PgQueryClient,
	params: RetireOrganizationParams,
): Promise<Organization | undefined> {
	const [, , , , retiredOrganizations] = await db.transaction(async (tx) => [
		await tx
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
		await tx
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
		await tx
			.update(apps)
			.set({ visibility: "disabled", updatedAt: params.retiredAt })
			.where(eq(apps.organizationId, params.id)),
		await tx
			.update(organizationMembers)
			.set({ status: "deactivated", updatedAt: params.retiredAt })
			.where(eq(organizationMembers.organizationId, params.id)),
		await tx
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
					sql`(${organizations.metadata} ->> 'retiredAt') IS NULL`,
				),
			)
			.returning(),
	]);
	return retiredOrganizations[0];
}

export async function syncAppCount(
	db: PgQueryClient,
	id: string,
): Promise<number> {
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

export async function getOrganizationSecretEgressMode(
	db: PgQueryClient,
	id: string,
): Promise<"block" | "warn"> {
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row?.metadata?.secretEgressMode === "warn" ? "warn" : "block";
}

export async function getOrganizationPersonalDataRedaction(
	db: PgQueryClient,
	id: string,
): Promise<boolean> {
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row?.metadata?.personalDataRedaction?.enabled === true;
}
