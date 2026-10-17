import {
	sqliteTable,
	text,
	integer,
	primaryKey,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const tediConsoleGrants = sqliteTable(
	"tedi_console_grants",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
		workspaceIds: text("workspace_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		revision: text("revision").notNull(),
		grantedBy: text("granted_by").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.organizationId, table.tediId] })],
);
