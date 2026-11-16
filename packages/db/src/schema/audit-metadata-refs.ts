import {
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Store-local dictionary for repeated identifiers in compact audit metadata. */
export const auditMetadataRefs = sqliteTable(
	"audit_metadata_refs",
	{
		organizationId: text("organization_id").notNull(),
		ref: text("ref").notNull(),
		kind: text("kind", { enum: ["app", "client"] }).notNull(),
		value: text("value").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.organizationId, table.ref] }),
		uniqueIndex("audit_metadata_refs_org_kind_value_idx").on(
			table.organizationId,
			table.kind,
			table.value,
		),
	],
);

export type AuditMetadataRefRow = typeof auditMetadataRefs.$inferSelect;
export type NewAuditMetadataRefRow = typeof auditMetadataRefs.$inferInsert;
