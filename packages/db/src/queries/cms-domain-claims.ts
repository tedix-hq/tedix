import {
	and,
	eq,
	exists,
	gt,
	isNotNull,
	isNull,
	ne,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import {
	cmsDomainClaims,
	type CmsDomainClaimRow,
} from "../schema/cms-domain-claims";
import { cmsSites } from "../schema/cms-sites";

const PROVISIONING_STALE_MS = 5 * 60 * 1000;

export interface CmsDomainClaimKey {
	id: string;
	organizationId: string;
	siteId: string;
}

export interface ReserveCmsDomainClaimParams extends CmsDomainClaimKey {
	hostname: string;
	kind?: "primary" | "www_alias";
	verificationToken: string;
	expiresAt: string;
}

/** Atomic reservation; a legacy active cms_sites hostname blocks a new claim. */
export async function reserveCmsDomainClaim(
	db: DbQueryClient,
	input: ReserveCmsDomainClaimParams,
): Promise<CmsDomainClaimRow | null> {
	const hostname = input.hostname.toLowerCase();
	const kind = input.kind ?? "primary";
	if (kind === "www_alias" && !hostname.startsWith("www.")) return null;
	const now = new Date().toISOString();
	const existingSite = alias(cmsSites, "existing_cms_site");
	const existingClaim = alias(cmsDomainClaims, "existing_cms_domain_claim");
	const [claim] = await db
		.insert(cmsDomainClaims)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: cmsSites.organizationId,
					siteId: cmsSites.id,
					hostname: sql<string>`${hostname}`.as("hostname"),
					kind: sql<"primary" | "www_alias">`${kind}`.as("kind"),
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
				.from(cmsSites)
				.where(
					and(
						eq(cmsSites.id, input.siteId),
						eq(cmsSites.organizationId, input.organizationId),
						eq(cmsSites.status, "active"),
						...(kind === "www_alias"
							? [
									isNotNull(cmsSites.customDomain),
									sql`${hostname} = 'www.' || ${cmsSites.customDomain}`,
									exists(
										db
											.select({ id: existingClaim.id })
											.from(existingClaim)
											.where(
												and(
													eq(
														existingClaim.organizationId,
														input.organizationId,
													),
													eq(existingClaim.siteId, input.siteId),
													eq(existingClaim.kind, "primary"),
													eq(existingClaim.status, "active"),
													isNotNull(existingClaim.providerHostnameId),
													eq(existingClaim.hostname, cmsSites.customDomain),
												),
											),
									),
								]
							: []),
						notExists(
							db
								.select({ id: existingClaim.id })
								.from(existingClaim)
								.where(
									and(
										eq(existingClaim.siteId, input.siteId),
										or(
											eq(existingClaim.status, "pending"),
											eq(existingClaim.status, "provisioning"),
										),
									),
								),
						),
						notExists(
							db
								.select({ id: existingSite.id })
								.from(existingSite)
								.where(
									and(
										eq(existingSite.customDomain, hostname),
										ne(existingSite.id, input.siteId),
									),
								),
						),
					),
				),
		)
		.onConflictDoNothing()
		.returning();
	return claim ?? null;
}

export async function getCmsDomainClaimForSite(
	db: DbQueryClient,
	key: CmsDomainClaimKey,
): Promise<CmsDomainClaimRow | null> {
	const [claim] = await db
		.select()
		.from(cmsDomainClaims)
		.where(
			and(
				eq(cmsDomainClaims.id, key.id),
				eq(cmsDomainClaims.organizationId, key.organizationId),
				eq(cmsDomainClaims.siteId, key.siteId),
			),
		)
		.limit(1);
	return claim ?? null;
}

export async function listCmsDomainClaimsForSite(
	db: DbQueryClient,
	key: Pick<CmsDomainClaimKey, "organizationId" | "siteId">,
): Promise<CmsDomainClaimRow[]> {
	return db
		.select()
		.from(cmsDomainClaims)
		.where(
			and(
				eq(cmsDomainClaims.organizationId, key.organizationId),
				eq(cmsDomainClaims.siteId, key.siteId),
			),
		);
}

/** Reserve one provider mutation; removal waits for this lease to finish. */
export async function beginCmsDomainProvisioning(
	db: DbQueryClient,
	input: CmsDomainClaimKey,
	now = new Date(),
): Promise<CmsDomainClaimRow | null> {
	const timestamp = now.toISOString();
	const staleBefore = new Date(
		now.getTime() - PROVISIONING_STALE_MS,
	).toISOString();
	const [claim] = await db
		.update(cmsDomainClaims)
		.set({ status: "provisioning", updatedAt: timestamp })
		.where(
			and(
				eq(cmsDomainClaims.id, input.id),
				eq(cmsDomainClaims.organizationId, input.organizationId),
				eq(cmsDomainClaims.siteId, input.siteId),
				or(
					eq(cmsDomainClaims.status, "pending"),
					and(
						eq(cmsDomainClaims.status, "provisioning"),
						sql`${cmsDomainClaims.updatedAt} <= ${staleBefore}`,
					),
				),
				isNull(cmsDomainClaims.providerHostnameId),
				gt(cmsDomainClaims.expiresAt, timestamp),
				exists(
					db
						.select({ id: cmsSites.id })
						.from(cmsSites)
						.where(
							and(
								eq(cmsSites.id, input.siteId),
								eq(cmsSites.organizationId, input.organizationId),
								eq(cmsSites.status, "active"),
							),
						),
				),
			),
		)
		.returning();
	return claim ?? null;
}

/** Bind the provider identity even if deprovision paused the site meanwhile. */
export async function finishCmsDomainProvisioning(
	db: DbQueryClient,
	input: CmsDomainClaimKey & {
		providerHostnameId: string;
		provisioningStartedAt: string;
	},
): Promise<CmsDomainClaimRow | null> {
	const [claim] = await db
		.update(cmsDomainClaims)
		.set({
			providerHostnameId: input.providerHostnameId,
			status: "pending",
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(cmsDomainClaims.id, input.id),
				eq(cmsDomainClaims.organizationId, input.organizationId),
				eq(cmsDomainClaims.siteId, input.siteId),
				eq(cmsDomainClaims.status, "provisioning"),
				eq(cmsDomainClaims.updatedAt, input.provisioningStartedAt),
				or(
					isNull(cmsDomainClaims.providerHostnameId),
					eq(cmsDomainClaims.providerHostnameId, input.providerHostnameId),
				),
			),
		)
		.returning();
	return claim ?? null;
}

/** Attach an already-routed legacy hostname without changing the public route. */
export async function adoptLegacyCmsDomainClaim(
	db: DbQueryClient,
	input: CmsDomainClaimKey & { providerHostnameId: string },
): Promise<CmsDomainClaimRow | null> {
	if (!input.providerHostnameId.trim()) return null;
	const now = new Date().toISOString();
	const [claim] = await db
		.update(cmsDomainClaims)
		.set({
			status: "active",
			providerHostnameId: input.providerHostnameId,
			updatedAt: now,
		})
		.where(
			and(
				eq(cmsDomainClaims.id, input.id),
				eq(cmsDomainClaims.organizationId, input.organizationId),
				eq(cmsDomainClaims.siteId, input.siteId),
				eq(cmsDomainClaims.status, "pending"),
				eq(cmsDomainClaims.kind, "primary"),
				gt(cmsDomainClaims.expiresAt, now),
				or(
					isNull(cmsDomainClaims.providerHostnameId),
					eq(cmsDomainClaims.providerHostnameId, input.providerHostnameId),
				),
				exists(
					db
						.select({ id: cmsSites.id })
						.from(cmsSites)
						.where(
							and(
								eq(cmsSites.id, input.siteId),
								eq(cmsSites.organizationId, input.organizationId),
								eq(cmsSites.status, "active"),
								eq(cmsSites.customDomain, cmsDomainClaims.hostname),
							),
						),
				),
			),
		)
		.returning();
	return claim ?? null;
}

/** Commit the verified claim and public route in one D1 batch. */
export async function activateCmsDomainClaim(
	db: DbQueryClient,
	input: CmsDomainClaimKey,
): Promise<CmsDomainClaimRow | null> {
	const claim = await getCmsDomainClaimForSite(db, input);
	if (
		!claim ||
		claim.kind !== "primary" ||
		claim.status !== "pending" ||
		!claim.providerHostnameId
	)
		return null;
	const now = new Date().toISOString();
	const currentClaim = exists(
		db
			.select({ id: cmsDomainClaims.id })
			.from(cmsDomainClaims)
			.where(
				and(
					eq(cmsDomainClaims.id, input.id),
					eq(cmsDomainClaims.organizationId, input.organizationId),
					eq(cmsDomainClaims.siteId, input.siteId),
					eq(cmsDomainClaims.hostname, claim.hostname),
					eq(cmsDomainClaims.status, "pending"),
					eq(cmsDomainClaims.kind, "primary"),
					isNotNull(cmsDomainClaims.providerHostnameId),
					gt(cmsDomainClaims.expiresAt, now),
				),
			),
	);
	const [siteRows, claimRows] = await db.batch([
		db
			.update(cmsSites)
			.set({
				customDomain: claim.hostname,
				canonicalUrl: `https://${claim.hostname}`,
				updatedAt: now,
			})
			.where(
				and(
					eq(cmsSites.id, input.siteId),
					eq(cmsSites.organizationId, input.organizationId),
					eq(cmsSites.status, "active"),
					currentClaim,
				),
			)
			.returning({ id: cmsSites.id }),
		db
			.update(cmsDomainClaims)
			.set({ status: "active", updatedAt: now })
			.where(
				and(
					eq(cmsDomainClaims.id, input.id),
					eq(cmsDomainClaims.organizationId, input.organizationId),
					eq(cmsDomainClaims.siteId, input.siteId),
					eq(cmsDomainClaims.status, "pending"),
					eq(cmsDomainClaims.kind, "primary"),
					gt(cmsDomainClaims.expiresAt, now),
					exists(
						db
							.select({ id: cmsSites.id })
							.from(cmsSites)
							.where(
								and(
									eq(cmsSites.id, input.siteId),
									eq(cmsSites.organizationId, input.organizationId),
									eq(cmsSites.status, "active"),
									eq(cmsSites.customDomain, claim.hostname),
								),
							),
					),
				),
			)
			.returning(),
	]);
	return siteRows.length === 1 ? (claimRows[0] ?? null) : null;
}

/** Activate a verified www companion without changing the site's canonical route. */
export async function activateCmsWwwAliasClaim(
	db: DbQueryClient,
	input: CmsDomainClaimKey,
): Promise<CmsDomainClaimRow | null> {
	const now = new Date().toISOString();
	const primary = alias(cmsDomainClaims, "active_primary_claim");
	const [claim] = await db
		.update(cmsDomainClaims)
		.set({ status: "active", updatedAt: now })
		.where(
			and(
				eq(cmsDomainClaims.id, input.id),
				eq(cmsDomainClaims.organizationId, input.organizationId),
				eq(cmsDomainClaims.siteId, input.siteId),
				eq(cmsDomainClaims.kind, "www_alias"),
				eq(cmsDomainClaims.status, "pending"),
				isNotNull(cmsDomainClaims.providerHostnameId),
				gt(cmsDomainClaims.expiresAt, now),
				exists(
					db
						.select({ id: cmsSites.id })
						.from(cmsSites)
						.where(
							and(
								eq(cmsSites.id, input.siteId),
								eq(cmsSites.organizationId, input.organizationId),
								eq(cmsSites.status, "active"),
								isNotNull(cmsSites.customDomain),
								sql`${cmsDomainClaims.hostname} = 'www.' || ${cmsSites.customDomain}`,
								exists(
									db
										.select({ id: primary.id })
										.from(primary)
										.where(
											and(
												eq(primary.organizationId, input.organizationId),
												eq(primary.siteId, input.siteId),
												eq(primary.kind, "primary"),
												eq(primary.status, "active"),
												isNotNull(primary.providerHostnameId),
												eq(primary.hostname, cmsSites.customDomain),
											),
										),
								),
							),
						),
				),
			),
		)
		.returning();
	return claim ?? null;
}

/** Stop routing immediately; provider deletion and final row removal may retry. */
export async function beginRemovingCmsDomainClaim(
	db: DbQueryClient,
	input: CmsDomainClaimKey,
	now = new Date(),
): Promise<CmsDomainClaimRow | null> {
	const claim = await getCmsDomainClaimForSite(db, input);
	if (!claim) return null;
	if (
		claim.status === "removing" ||
		claim.status === "removing_provisioning" ||
		claim.status === "removing_legacy"
	)
		return claim;
	const timestamp = now.toISOString();
	const staleBefore = new Date(
		now.getTime() - PROVISIONING_STALE_MS,
	).toISOString();
	if (claim.status === "provisioning" && claim.updatedAt > staleBefore)
		return null;
	const legacyRoute = exists(
		db
			.select({ id: cmsSites.id })
			.from(cmsSites)
			.where(
				and(
					eq(cmsSites.id, input.siteId),
					eq(cmsSites.organizationId, input.organizationId),
					eq(cmsSites.customDomain, claim.hostname),
				),
			),
	);
	const removingStatus =
		claim.status === "provisioning" && !claim.providerHostnameId
			? "removing_provisioning"
			: claim.status === "pending" && !claim.providerHostnameId
				? sql<
						"removing_legacy" | "removing"
					>`CASE WHEN ${legacyRoute} THEN 'removing_legacy' ELSE 'removing' END`
				: "removing";
	const [claimRows] = await db.batch([
		db
			.update(cmsDomainClaims)
			.set({ status: removingStatus, updatedAt: timestamp })
			.where(
				and(
					eq(cmsDomainClaims.id, input.id),
					eq(cmsDomainClaims.organizationId, input.organizationId),
					eq(cmsDomainClaims.siteId, input.siteId),
					eq(cmsDomainClaims.status, claim.status),
					...(claim.status === "provisioning"
						? [sql`${cmsDomainClaims.updatedAt} <= ${staleBefore}`]
						: []),
				),
			)
			.returning(),
		db
			.update(cmsSites)
			.set({
				customDomain: null,
				canonicalUrl: sql<string>`'https://' || ${cmsSites.slug} || '.cms.tedix.dev'`,
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(cmsSites.id, input.siteId),
					eq(cmsSites.organizationId, input.organizationId),
					eq(cmsSites.customDomain, claim.hostname),
					exists(
						db
							.select({ id: cmsDomainClaims.id })
							.from(cmsDomainClaims)
							.where(
								and(
									eq(cmsDomainClaims.id, input.id),
									eq(cmsDomainClaims.organizationId, input.organizationId),
									eq(cmsDomainClaims.siteId, input.siteId),
									or(
										eq(cmsDomainClaims.status, "removing"),
										eq(cmsDomainClaims.status, "removing_provisioning"),
										eq(cmsDomainClaims.status, "removing_legacy"),
									),
								),
							),
					),
				),
			),
	]);
	return claimRows[0] ?? null;
}

/** Retire only a superseded claim; never unset or delete the live hostname. */
export async function beginRemovingReplacedCmsDomainClaim(
	db: DbQueryClient,
	input: CmsDomainClaimKey,
): Promise<CmsDomainClaimRow | null> {
	const [claim] = await db
		.update(cmsDomainClaims)
		.set({ status: "removing", updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(cmsDomainClaims.id, input.id),
				eq(cmsDomainClaims.organizationId, input.organizationId),
				eq(cmsDomainClaims.siteId, input.siteId),
				or(
					eq(cmsDomainClaims.status, "active"),
					eq(cmsDomainClaims.status, "removing"),
				),
				exists(
					db
						.select({ id: cmsSites.id })
						.from(cmsSites)
						.where(
							and(
								eq(cmsSites.id, input.siteId),
								eq(cmsSites.organizationId, input.organizationId),
								or(
									isNull(cmsSites.customDomain),
									ne(cmsSites.customDomain, cmsDomainClaims.hostname),
								),
							),
						),
				),
			),
		)
		.returning();
	return claim ?? null;
}

export async function removeCmsDomainClaim(
	db: DbQueryClient,
	input: CmsDomainClaimKey,
): Promise<boolean> {
	const deleted = await db
		.delete(cmsDomainClaims)
		.where(
			and(
				eq(cmsDomainClaims.id, input.id),
				eq(cmsDomainClaims.organizationId, input.organizationId),
				eq(cmsDomainClaims.siteId, input.siteId),
				or(
					eq(cmsDomainClaims.status, "removing"),
					eq(cmsDomainClaims.status, "removing_provisioning"),
					eq(cmsDomainClaims.status, "removing_legacy"),
				),
			),
		)
		.returning({ id: cmsDomainClaims.id });
	return deleted.length === 1;
}
