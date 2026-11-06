// Workspace-local memory tables keep local foreign keys. Object scope guards
// replace references to organization and tedi records in the control plane.
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { memoryFacts } from "./memory-graph";

export const memoryFactCitations = sqliteTable(
	"memory_fact_citations",
	{
		organizationId: text("organization_id").notNull(),
		citedFactId: text("cited_fact_id").notNull(),
		consolidatedFactId: text("consolidated_fact_id")
			.notNull()
			.references(() => memoryFacts.id, { onDelete: "cascade" }),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		primaryKey({ columns: [table.consolidatedFactId, table.citedFactId] }),
		index("idx_memory_fact_citations_org_cited").on(
			table.organizationId,
			table.citedFactId,
		),
	],
);
export const memoryFactCitationBackfills = sqliteTable(
	"memory_fact_citation_backfills",
	{
		organizationId: text("organization_id").primaryKey(),
		source: text("source").notNull(),
		factId: text("fact_id").notNull(),
		done: integer("done", { mode: "boolean" }).notNull().default(false),
	},
);
