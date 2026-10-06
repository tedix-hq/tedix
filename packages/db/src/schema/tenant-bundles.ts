/**
 * Tenant Bundles Schema
 *
 * Per-app CMS code bundles served by `apps/cms-runtime`. Each row is a
 * versioned snapshot of an Astro+Emdash build for a single app slug.
 * The actual JS lives in R2 (`tedix-cms-bundles`), keyed by
 * `{slug}/v{version}/{module}` plus a `manifest.json` listing the entry
 * module + chunked dependencies.
 *
 * Replaces the per-app dispatched user worker pattern (Workers for
 * Platforms `tedix-cms` namespace). The runtime parent Worker reads
 * `is_active = 1` to find which version to serve and fetches the bundle
 * from R2 on isolate cold-start.
 */

import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

export const tenantBundles = sqliteTable(
	"tenant_bundles",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull(),
		version: integer("version").notNull(),

		/** R2 key prefix: `{slug}/v{version}/`. */
		r2Prefix: text("r2_prefix").notNull(),
		/** Entry module path inside the bundle (e.g. `entry.mjs`). */
		mainModule: text("main_module").notNull(),
		/** Hash of the bundle for cache validation + uniqueness. */
		etag: text("etag").notNull(),
		/** JSON array of all module paths in the bundle. */
		modulesJson: text("modules_json", { mode: "json" })
			.notNull()
			.$type<string[]>(),
		/**
		 * Immutable source identity for this build. New deploys write either an
		 * `artifacts-commit:<full-sha1>` or `editable-sha256:<digest>` value.
		 * Null means the legacy deployment did not record source provenance.
		 */
		sourceRevision: text("source_revision"),

		/** Only one row per slug should be active at a time. */
		isActive: integer("is_active", { mode: "boolean" })
			.notNull()
			.default(false),

		createdAt: text("created_at")
			.notNull()
			.default(sql`(current_timestamp)`),
		deployedAt: text("deployed_at"),
		deployedBy: text("deployed_by"),
		summary: text("summary"),
	},
	(t) => [
		unique("tenant_bundles_slug_version_unique").on(t.slug, t.version),
		index("tenant_bundles_slug_active_idx").on(t.slug, t.isActive),
	],
);

export type TenantBundle = typeof tenantBundles.$inferSelect;
export type NewTenantBundle = typeof tenantBundles.$inferInsert;
