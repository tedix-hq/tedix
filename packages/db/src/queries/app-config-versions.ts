import { and, desc, eq, max } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbClient } from "../client";
import { appConfigVersions } from "../schema/app-config-versions";
import { apps } from "../schema/apps";
import type {
	AppConfigVersion,
	NewAppConfigVersion,
} from "../schema/app-config-versions";
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
	const nextVersion = await getNextConfigVersionNumber(db, input.appId);
	const id = crypto.randomUUID();

	const row: NewAppConfigVersion = {
		id,
		appId: input.appId,
		version: nextVersion,
		status: "draft",
		config: input.config,
		createdBy: input.createdBy ?? null,
		changeSummary: input.changeSummary ?? null,
		createdAt: now,
		updatedAt: now,
	};

	await db.insert(appConfigVersions).values(row);

	await db
		.update(apps)
		.set({
			latestConfigVersion: nextVersion,
			updatedAt: now,
		})
		.where(eq(apps.id, input.appId));

	const created = await getAppConfigVersionById(db, id);
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

async function getLatestConfigVersionNumber(
	db: DbClient,
	appId: string,
): Promise<number> {
	const rows = await db
		.select({ maxVersion: max(appConfigVersions.version) })
		.from(appConfigVersions)
		.where(eq(appConfigVersions.appId, appId));
	return rows[0]?.maxVersion ?? 0;
}

async function getNextConfigVersionNumber(
	db: DbClient,
	appId: string,
): Promise<number> {
	const latestFromVersions = await getLatestConfigVersionNumber(db, appId);

	const appRows = await db
		.select({ latestConfigVersion: apps.latestConfigVersion })
		.from(apps)
		.where(eq(apps.id, appId))
		.limit(1);
	const app = appRows[0];

	const latest = Math.max(latestFromVersions, app?.latestConfigVersion ?? 0);
	return latest + 1;
}
