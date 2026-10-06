import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A row closes the site. Only an explicit exact-generation release opens it. */
export const cmsRestoreFences = sqliteTable("cms_restore_fences", {
	siteId: text("site_id").primaryKey(),
	slug: text("slug").notNull(),
	generation: text("generation").notNull(),
	captureId: text("capture_id").notNull(),
	/** Null for fences closed before epoch rotation was introduced. */
	restoreEpoch: integer("restore_epoch"),
	closedAt: text("closed_at")
		.notNull()
		.default(sql`(CURRENT_TIMESTAMP)`),
});

/** An expiring, exact-capture admission fence for tenant scheduled writes. */
export const cmsCaptureCronPauses = sqliteTable("cms_capture_cron_pauses", {
	siteId: text("site_id").primaryKey(),
	slug: text("slug").notNull(),
	captureId: text("capture_id").notNull(),
	expiresAtUnix: integer("expires_at_unix").notNull(),
	drainedAtUnix: integer("drained_at_unix"),
});

/** Durable in-flight claims; no lease or timeout can silently clear a claim. */
export const cmsRestorePermits = sqliteTable(
	"cms_restore_permits",
	{
		id: text("id").primaryKey(),
		siteId: text("site_id").notNull(),
		slug: text("slug").notNull(),
		restoreEpoch: integer("restore_epoch").notNull().default(0),
		kind: text("kind", { enum: ["legacy", "outer", "nested", "scheduled"] })
			.notNull()
			.default("legacy"),
		enteredAt: text("entered_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("cms_restore_permits_site_slug_idx").on(table.siteId, table.slug),
	],
);

export type CmsRestoreFenceRow = typeof cmsRestoreFences.$inferSelect;
export type CmsRestorePermitRow = typeof cmsRestorePermits.$inferSelect;
