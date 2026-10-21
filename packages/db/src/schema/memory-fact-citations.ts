import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { memoryFacts } from "./memory-graph";
import { organizations } from "./organizations";

export const memoryFactCitations = sqliteTable(
	"memory_fact_citations",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		// Retain the citation when its source disappears so dependents can still be found.
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

// A high-water mark also records empty/malformed evidence, which has no link rows.
export const memoryFactCitationBackfills = sqliteTable(
	"memory_fact_citation_backfills",
	{
		organizationId: text("organization_id")
			.primaryKey()
			.references(() => organizations.id, { onDelete: "cascade" }),
		source: text("source").notNull(),
		factId: text("fact_id").notNull(),
		done: integer("done", { mode: "boolean" }).notNull().default(false),
	},
);
