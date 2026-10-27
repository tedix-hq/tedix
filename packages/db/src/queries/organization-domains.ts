import {
	and,
	eq,
	gt,
	isNotNull,
	isNull,
	lt,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { cmsDomainClaims } from "../schema/cms-domain-claims";
import { cmsSites } from "../schema/cms-sites";
import { organizations } from "../schema/organizations";

function scope(organizationId: string, id?: string) {
	return and(
		eq(cmsDomainClaims.organizationId, organizationId),
		eq(cmsDomainClaims.kind, "organization"),
		isNull(cmsDomainClaims.siteId),
		...(id ? [eq(cmsDomainClaims.id, id)] : []),
	);
}
export async function getOrganizationDomain(
	db: DbQueryClient,
	organizationId: string,
) {
	const [row] = await db
		.select()
		.from(cmsDomainClaims)
		.where(scope(organizationId))
		.limit(1);
	return row ?? null;
}

/** Use the CMS reservation namespace so a hostname can never serve both products. */
export async function reserveOrganizationDomain(
	db: DbQueryClient,
	input: {
		id: string;
		organizationId: string;
		hostname: string;
		verificationToken: string;
		expiresAt: string;
	},
) {
	const now = new Date().toISOString();
	const [row] = await db
		.insert(cmsDomainClaims)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: organizations.id,
					siteId: sql<string | null>`NULL`.as("site_id"),
					hostname: sql<string>`${input.hostname}`.as("hostname"),
					kind: sql<"organization">`'organization'`.as("kind"),
					verificationToken: sql<string>`${input.verificationToken}`.as(
						"verification_token",
					),
					providerHostnameId: sql<string | null>`NULL`.as(
						"provider_hostname_id",
					),
					status: sql<"pending">`'pending'`.as("status"),
					expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
					createdAt: sql<string>`${now}`.as("created_at"),
					updatedAt: sql<string>`${now}`.as("updated_at"),
				})
				.from(organizations)
				.where(
					and(
						eq(organizations.id, input.organizationId),
						sql`json_extract(${organizations.features}, '$.os') = 1`,
						notExists(
							db
								.select({ id: cmsSites.id })
								.from(cmsSites)
								.where(eq(cmsSites.customDomain, input.hostname)),
						),
					),
				),
		)
		.onConflictDoNothing()
		.returning();
	return row ?? null;
}

export async function lockOrganizationDomain(
	db: DbQueryClient,
	organizationId: string,
	id: string,
	action: "provisioning" | "removing",
) {
	const now = new Date().toISOString();
	const stale = new Date(Date.now() - 5 * 60_000).toISOString();
	const [row] = await db
		.update(cmsDomainClaims)
		.set({ status: action, updatedAt: now })
		.where(
			and(
				scope(organizationId, id),
				action === "provisioning"
					? and(
							or(
								gt(cmsDomainClaims.expiresAt, now),
								and(
									eq(cmsDomainClaims.status, "provisioning"),
									lt(cmsDomainClaims.updatedAt, stale),
								),
							),
							or(
								eq(cmsDomainClaims.status, "pending"),
								eq(cmsDomainClaims.status, "active"),
								and(
									eq(cmsDomainClaims.status, "provisioning"),
									lt(cmsDomainClaims.updatedAt, stale),
								),
							),
						)
					: or(
							eq(cmsDomainClaims.status, "pending"),
							eq(cmsDomainClaims.status, "active"),
							eq(cmsDomainClaims.status, "removing"),
						),
			),
		)
		.returning();
	return row ?? null;
}

export async function finishOrganizationDomainVerification(
	db: DbQueryClient,
	input: {
		organizationId: string;
		id: string;
		lease: string;
		status: "pending" | "active";
		providerHostnameId: string | null;
	},
) {
	const [row] = await db
		.update(cmsDomainClaims)
		.set({
			status: input.status,
			providerHostnameId: input.providerHostnameId,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				scope(input.organizationId, input.id),
				eq(cmsDomainClaims.status, "provisioning"),
				eq(cmsDomainClaims.updatedAt, input.lease),
			),
		)
		.returning();
	return row ?? null;
}
export async function deleteOrganizationDomain(
	db: DbQueryClient,
	organizationId: string,
	id: string,
) {
	const rows = await db
		.delete(cmsDomainClaims)
		.where(
			and(scope(organizationId, id), eq(cmsDomainClaims.status, "removing")),
		)
		.returning({ id: cmsDomainClaims.id });
	return rows.length === 1;
}

/** Deliberately uncached: removal and ownership changes take effect on the next request. */
export async function resolveOrganizationHostname(
	db: DbQueryClient,
	hostname: string,
) {
	const [row] = await db
		.select({
			organizationId: organizations.id,
			slug: organizations.slug,
			descopeTenantId: organizations.descopeTenantId,
			metadata: organizations.metadata,
		})
		.from(cmsDomainClaims)
		.innerJoin(
			organizations,
			eq(organizations.id, cmsDomainClaims.organizationId),
		)
		.where(
			and(
				eq(cmsDomainClaims.hostname, hostname.toLowerCase().replace(/\.$/, "")),
				eq(cmsDomainClaims.kind, "organization"),
				isNull(cmsDomainClaims.siteId),
				eq(cmsDomainClaims.status, "active"),
				isNotNull(cmsDomainClaims.providerHostnameId),
				sql`json_extract(${organizations.features}, '$.os') = 1`,
			),
		)
		.limit(1);
	return row ?? null;
}
