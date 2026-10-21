import { and, desc, eq, sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbClient } from "../client";
import { appConfigVersions } from "../schema/app-config-versions";
import { apps } from "../schema/apps";
import type { AppConfigVersion } from "../schema/app-config-versions";
import { getAffectedRows } from "../utils/d1-result";

export async function listAppConfigVersions(
	db: DbClient,
	appId: string,
): Promise<AppConfigVersion[]> {
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
	const now = new Date().toISOString();
	const id = crypto.randomUUID();

	// Allocate inside the write; D1 serializes the insert and counter update
	// together, and rolls back the draft if either statement fails.
	const [createdRows] = await db.batch([
		db
			.insert(appConfigVersions)
			.values({
				id,
				appId: input.appId,
				version: sql<number>`(
					select max(
						coalesce(max(${appConfigVersions.version}), 0),
						coalesce((select ${apps.latestConfigVersion} from ${apps}
							where ${apps.id} = ${input.appId}), 0)
					) + 1
					from ${appConfigVersions}
					where ${appConfigVersions.appId} = ${input.appId}
				)`,
				status: "draft",
				config: input.config,
				createdBy: input.createdBy ?? null,
				changeSummary: input.changeSummary ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning(),
		db
			.update(apps)
			.set({
				latestConfigVersion: sql<number>`(select ${appConfigVersions.version}
					from ${appConfigVersions} where ${appConfigVersions.id} = ${id})`,
				updatedAt: now,
			})
			.where(eq(apps.id, input.appId)),
	]);

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
	const now = new Date().toISOString();

	const result = await db
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
		);

	const changes = getAffectedRows(result);
	if (changes === 0) {
		throw new Error(
			`Config version not found for app publish: appId=${input.appId} versionId=${input.versionId}`,
		);
	}

	const updated = await getAppConfigVersionById(db, input.versionId);
	if (!updated) throw new Error(`Config version not found: ${input.versionId}`);
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
	const now = new Date().toISOString();

	const versionResult = await db
		.update(appConfigVersions)
		.set({
			activatedAt: now,
			activatedBy: input.activatedBy ?? null,
			updatedAt: now,
		})
		.where(
			and(
				eq(appConfigVersions.id, input.versionId),
				eq(appConfigVersions.appId, input.appId),
				eq(appConfigVersions.status, "published"),
			),
		);

	const versionChanges = getAffectedRows(versionResult);
	if (versionChanges === 0) {
		throw new Error(
			`Config version must exist and be published before activation: appId=${input.appId} versionId=${input.versionId}`,
		);
	}

	const appResult = await db
		.update(apps)
		.set({
			activeConfigVersionId: input.versionId,
			updatedAt: now,
		})
		.where(eq(apps.id, input.appId));

	const appChanges = getAffectedRows(appResult);
	if (appChanges === 0) {
		throw new Error(
			`App not found for config activation: appId=${input.appId}`,
		);
	}

	const updated = await getAppConfigVersionById(db, input.versionId);
	if (!updated) throw new Error(`Config version not found: ${input.versionId}`);
	return updated;
}

async function getAppConfigVersionById(
	db: DbClient,
	id: string,
): Promise<AppConfigVersion | undefined> {
	const rows = await db
		.select()
		.from(appConfigVersions)
		.where(eq(appConfigVersions.id, id))
		.limit(1);
	return rows[0];
}
