/**
 * Identity rules for `mcpConfig.aggregateApps` links.
 *
 * An aggregate entry links one app to another. The stable link is the target
 * app's id (`appId`); `slug` is a display name that may be renamed. Entries
 * written before ids were stored carry only a slug, so matching prefers the id
 * when both sides have one and falls back to the slug otherwise. Writers always
 * store both.
 */

import { coreTable } from "../core-store/client";
import { or, type SQL, sql } from "drizzle-orm";
import { anyIds, jsonRead, jsonType } from "../core-store/dialect";
import type { DbClient } from "../client";
import { apps as schemaApps } from "../schema/apps";

/**
 * The identity an aggregate entry is matched against. Both keys are required
 * (either may be null) so an app row (`{ id, slug }`) cannot be passed by
 * mistake; use {@link aggregateAppLink} to build one from an app.
 */
export type AggregateAppLinkTarget = {
	appId: string | null | undefined;
	slug: string | null | undefined;
};

function stringField(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

/**
 * True when `entry` links to `target`: by `appId` when both carry one,
 * otherwise by slug.
 */
export function aggregateAppEntryMatches(
	entry: unknown,
	target: AggregateAppLinkTarget,
): boolean {
	const entryAppId = stringField(entry, "appId");
	if (entryAppId && target.appId) return entryAppId === target.appId;
	const entrySlug = stringField(entry, "slug");
	return Boolean(entrySlug && target.slug && entrySlug === target.slug);
}

/** The `{ appId, slug }` pair a writer stores for `app`. */
export function aggregateAppLink(app: { id: string; slug: string }): {
	appId: string;
	slug: string;
} {
	return { appId: app.id, slug: app.slug };
}

/**
 * SQL predicate over a `json_each` row (`value`) equivalent to
 * {@link aggregateAppEntryMatches} for a target that has an id.
 */
export function aggregateAppEntryMatchesSql(
	db: DbClient,
	target: {
		appId: string;
		slug: string;
	},
): SQL {
	return sql`(case when ${jsonType(db, sql`value`, ["appId"])} = 'string' then ${jsonRead(db, sql`value`, ["appId"])} = ${target.appId} else ${jsonRead(db, sql`value`, ["slug"])} = ${target.slug} end)`;
}

/**
 * Resolve the current `{ id, slug, organizationId }` of the apps that aggregate
 * entries name by id or slug. Unknown ids/slugs are simply absent.
 */
export async function getAggregateAppLinkTargets(
	db: DbClient,
	refs: { ids: string[]; slugs: string[] },
): Promise<Array<{ id: string; slug: string; organizationId: string }>> {
	const apps = coreTable(db, schemaApps);
	const ids = [...new Set(refs.ids)];
	const slugs = [...new Set(refs.slugs)];
	if (!ids.length && !slugs.length) return [];
	return db
		.select({
			id: apps.id,
			slug: apps.slug,
			organizationId: apps.organizationId,
		})
		.from(apps)
		.where(or(anyIds(db, apps.id, ids), anyIds(db, apps.slug, slugs)));
}
