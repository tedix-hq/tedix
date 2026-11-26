import { and, eq, isNotNull, sql } from "drizzle-orm";
import { likeText } from "../core-store/dialect";
import { coreTable } from "../core-store/client";
import type { DbClient } from "../client";
import { apps as schemaApps } from "../schema/apps";
import { organizations as schemaOrganizations } from "../schema/organizations";
import { tedis as schemaTedis } from "../schema/tedis";

export type ImageEntityType = "organization" | "app" | "tedi";

/** Platform-admin inventory read. Deliberately spans tenants for migration. */
export async function listLegacyEntityImagesForPlatform(
	db: DbClient,
	entityType: ImageEntityType,
	limit: number,
): Promise<Array<{ id: string; url: string | null }>> {
	const apps = coreTable(db, schemaApps);
	const organizations = coreTable(db, schemaOrganizations);
	const tedis = coreTable(db, schemaTedis);
	const legacyPattern = "%imagedelivery.net%";
	switch (entityType) {
		case "organization":
			return db
				.select({ id: organizations.id, url: organizations.logoUrl })
				.from(organizations)
				.where(
					and(
						isNotNull(organizations.logoUrl),
						sql`NOT (${likeText(db, organizations.logoUrl, legacyPattern)})`,
					),
				)
				.limit(limit);
		case "app":
			return db
				.select({ id: apps.id, url: apps.logoUrl })
				.from(apps)
				.where(
					and(
						isNotNull(apps.logoUrl),
						sql`NOT (${likeText(db, apps.logoUrl, legacyPattern)})`,
					),
				)
				.limit(limit);
		case "tedi":
			return db
				.select({ id: tedis.id, url: tedis.avatar })
				.from(tedis)
				.where(
					and(
						isNotNull(tedis.avatar),
						sql`NOT (${likeText(db, tedis.avatar, legacyPattern)})`,
					),
				)
				.limit(limit);
	}
}

export async function getEntityImageUrl(
	db: DbClient,
	input: {
		entityType: ImageEntityType;
		entityId: string;
		organizationId: string;
	},
): Promise<string | null> {
	const apps = coreTable(db, schemaApps);
	const organizations = coreTable(db, schemaOrganizations);
	const tedis = coreTable(db, schemaTedis);
	switch (input.entityType) {
		case "organization": {
			const [row] = await db
				.select({ url: organizations.logoUrl })
				.from(organizations)
				.where(
					and(
						eq(organizations.id, input.entityId),
						eq(organizations.id, input.organizationId),
					),
				)
				.limit(1);
			return row?.url ?? null;
		}
		case "app": {
			const [row] = await db
				.select({ url: apps.logoUrl })
				.from(apps)
				.where(
					and(
						eq(apps.id, input.entityId),
						eq(apps.organizationId, input.organizationId),
					),
				)
				.limit(1);
			return row?.url ?? null;
		}
		case "tedi": {
			const [row] = await db
				.select({ url: tedis.avatar })
				.from(tedis)
				.where(
					and(
						eq(tedis.id, input.entityId),
						eq(tedis.organizationId, input.organizationId),
					),
				)
				.limit(1);
			return row?.url ?? null;
		}
	}
}

export async function updateEntityImageUrl(
	db: DbClient,
	input: {
		entityType: ImageEntityType;
		entityId: string;
		organizationId: string;
		url: string | null;
	},
): Promise<void> {
	const apps = coreTable(db, schemaApps);
	const organizations = coreTable(db, schemaOrganizations);
	const tedis = coreTable(db, schemaTedis);
	switch (input.entityType) {
		case "organization":
			await db
				.update(organizations)
				.set({ logoUrl: input.url })
				.where(
					and(
						eq(organizations.id, input.entityId),
						eq(organizations.id, input.organizationId),
					),
				);
			return;
		case "app":
			await db
				.update(apps)
				.set({ logoUrl: input.url })
				.where(
					and(
						eq(apps.id, input.entityId),
						eq(apps.organizationId, input.organizationId),
					),
				);
			return;
		case "tedi":
			await db
				.update(tedis)
				.set({ avatar: input.url })
				.where(
					and(
						eq(tedis.id, input.entityId),
						eq(tedis.organizationId, input.organizationId),
					),
				);
	}
}

/** Platform-admin migration write. Deliberately targets an entity across tenants. */
export async function updateEntityImageUrlForPlatform(
	db: DbClient,
	input: {
		entityType: ImageEntityType;
		entityId: string;
		url: string | null;
	},
): Promise<void> {
	const apps = coreTable(db, schemaApps);
	const organizations = coreTable(db, schemaOrganizations);
	const tedis = coreTable(db, schemaTedis);
	switch (input.entityType) {
		case "organization":
			await db
				.update(organizations)
				.set({ logoUrl: input.url })
				.where(eq(organizations.id, input.entityId));
			return;
		case "app":
			await db
				.update(apps)
				.set({ logoUrl: input.url })
				.where(eq(apps.id, input.entityId));
			return;
		case "tedi":
			await db
				.update(tedis)
				.set({ avatar: input.url })
				.where(eq(tedis.id, input.entityId));
	}
}
