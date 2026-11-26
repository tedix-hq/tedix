import { and, desc, eq, exists, sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { coreStore } from "../core-store/dialect";
import { appConfigVersions as schemaAppConfigVersions } from "../schema/app-config-versions";
import { apps as schemaApps } from "../schema/apps";
import type { AppConfigVersion } from "../schema/app-config-versions";

export async function listAppConfigVersions(
	db: DbClient,
	appId: string,
): Promise<AppConfigVersion[]> {
	const appConfigVersions = coreTable(db, schemaAppConfigVersions);
	return db
		.select()
		.from(appConfigVersions)
		.where(eq(appConfigVersions.appId, appId))
		.orderBy(
			desc(appConfigVersions.version),
			desc(appConfigVersions.createdAt),
		);
}

export async function createAppConfigVersion(
	db: DbClient,
	input: {
		appId: string;
		config: JsonValue;
		createdBy?: string | null;
		changeSummary?: string | null;
	},
): Promise<AppConfigVersion> {
	const apps = coreTable(db, schemaApps);
	const appConfigVersions = coreTable(db, schemaAppConfigVersions);
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	const postgres = coreStore(db) === "postgres";
	const maximum = postgres ? sql`greatest` : sql`max`;
	const nextVersion = sql<number>`(${maximum}(
		coalesce((select max(${appConfigVersions.version}) from ${appConfigVersions}
			where ${appConfigVersions.appId} = ${input.appId}), 0),
		coalesce(${apps.latestConfigVersion}, 0)) + 1)`;
	const insert = db
		.insert(appConfigVersions)
		.values({
			id,
			appId: input.appId,
			version: postgres
				? sql`(select ${apps.latestConfigVersion} from ${apps} where ${apps.id} = ${input.appId})`
				: sql`(select ${nextVersion} from ${apps} where ${apps.id} = ${input.appId})`,
			status: "draft",
			config: input.config,
			createdBy: input.createdBy ?? null,
			changeSummary: input.changeSummary ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	// Lock the parent before allocating on Postgres, so concurrent creators use
	// the updated counter. Both statements share one atomic protocol batch.
	const counter = db
		.update(apps)
		.set({
			latestConfigVersion: postgres
				? nextVersion
				: sql<number>`(select ${appConfigVersions.version}
			from ${appConfigVersions} where ${appConfigVersions.id} = ${id})`,
			updatedAt: now,
		})
		.where(eq(apps.id, input.appId));
	const createdRows = postgres
		? (await db.batch([counter, insert]))[1]
		: (await db.batch([insert, counter]))[0];
	const created = createdRows[0];
	if (!created) throw new Error(`Failed to create app config version: ${id}`);
	return created;
}

export async function publishAppConfigVersion(
	db: DbClient,
	input: {
		appId: string;
		versionId: string;
		publishedBy?: string | null;
	},
): Promise<AppConfigVersion> {
	const appConfigVersions = coreTable(db, schemaAppConfigVersions);
	const now = new Date().toISOString();
	const [updated] = await db
		.update(appConfigVersions)
		.set({
			status: "published",
			publishedAt: now,
			publishedBy: input.publishedBy ?? null,
			updatedAt: now,
		})
		.where(
			and(
				eq(appConfigVersions.id, input.versionId),
				eq(appConfigVersions.appId, input.appId),
			),
		)
		.returning();
	if (!updated)
		throw new Error(
			`Config version not found for app publish: appId=${input.appId} versionId=${input.versionId}`,
		);
	return updated;
}

export async function activateAppConfigVersion(
	db: DbClient,
	input: {
		appId: string;
		versionId: string;
		activatedBy?: string | null;
	},
): Promise<AppConfigVersion> {
	const apps = coreTable(db, schemaApps);
	const appConfigVersions = coreTable(db, schemaAppConfigVersions);
	const now = new Date().toISOString();
	const published = and(
		eq(appConfigVersions.id, input.versionId),
		eq(appConfigVersions.appId, input.appId),
		eq(appConfigVersions.status, "published"),
	);
	const [versions] = await db.batch([
		db
			.update(appConfigVersions)
			.set({
				activatedAt: now,
				activatedBy: input.activatedBy ?? null,
				updatedAt: now,
			})
			.where(published)
			.returning(),
		db
			.update(apps)
			.set({ activeConfigVersionId: input.versionId, updatedAt: now })
			.where(
				and(
					eq(apps.id, input.appId),
					exists(
						db
							.select({ id: appConfigVersions.id })
							.from(appConfigVersions)
							.where(published),
					),
				),
			),
	]);
	const updated = versions[0];
	if (!updated)
		throw new Error(
			`Config version must exist and be published before activation: appId=${input.appId} versionId=${input.versionId}`,
		);
	return updated;
}
