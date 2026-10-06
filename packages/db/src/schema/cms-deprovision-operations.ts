import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/** Persists the operation after its CMS site row has been removed. */
export const cmsDeprovisionOperations = sqliteTable(
	"cms_deprovision_operations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		authoringAppId: text("authoring_app_id"),
		status: text("status", {
			enum: ["queued", "running", "succeeded", "failed"],
		})
			.notNull()
			.default("queued"),
		stage: text("stage").notNull().default("queued"),
		deleted: text("deleted", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		errors: text("errors", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("cms_deprovision_operations_org_idx").on(table.organizationId),
	],
);

export type CmsDeprovisionOperationRow =
	typeof cmsDeprovisionOperations.$inferSelect;
export type NewCmsDeprovisionOperationRow =
	typeof cmsDeprovisionOperations.$inferInsert;
