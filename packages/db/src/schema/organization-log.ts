/**
 * Which organizations the organization log cutover may move
 * (`apps/api/src/jobs/organization-log-cutover.ts`). One row per allowed
 * organization; the row `*` allows every organization. An empty table moves
 * none, so switching the cutover on for one organization, or for all, is a
 * data change. Removing a row stops further moves for that organization; it
 * does not undo a move that finished.
 */

import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The `organization_id` that allows every organization. */
export const ORGANIZATION_LOG_CUTOVER_ALL = "*";

export const organizationLogCutoverAllowlist = sqliteTable(
	"organization_log_cutover_allowlist",
	{
		organizationId: text("organization_id").primaryKey(),
		/** Who allowed it and why, for the people reading the table later. */
		note: text("note"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
);
