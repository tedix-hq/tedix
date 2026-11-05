/**
 * Test-only Worker for the TenantStore workerd suite. The fixture class adds
 * one importable table on top of the production migration chain.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenantStoreMigrations } from "../../src/tenant-store/migrations";
import {
	TenantStore,
	type TenantStoreDefinition,
} from "../../src/tenant-store/store";

export { TenantStore };

export const fixtureNotes = sqliteTable("fixture_notes", {
	id: text("id").primaryKey(),
	organizationId: text("organization_id").notNull(),
	workspaceId: text("workspace_id").notNull(),
	body: text("body"),
	payload: text("payload", { mode: "json" }),
	pinned: integer("pinned", { mode: "boolean" }).notNull(),
});

export const fixtureDefinition: TenantStoreDefinition = {
	migrations: {
		...tenantStoreMigrations,
		"99991231000000_fixture_notes":
			"CREATE TABLE `fixture_notes` (`id` text PRIMARY KEY, `organization_id` text NOT NULL, `workspace_id` text NOT NULL, `body` text, `payload` text, `pinned` integer NOT NULL);",
	},
	importTables: { fixture_notes: fixtureNotes },
};

export class TenantStoreFixture extends TenantStore {
	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env, fixtureDefinition);
	}

	countNotes(): number {
		return this.ctx.storage.sql
			.exec<{ n: number }>("SELECT count(*) AS n FROM fixture_notes")
			.one().n;
	}

	readNote(id: string): Record<string, SqlStorageValue> | undefined {
		return this.ctx.storage.sql
			.exec("SELECT * FROM fixture_notes WHERE id = ?", id)
			.toArray()[0];
	}
}

export default {
	fetch: () => new Response("tenant-store fixture", { status: 404 }),
} satisfies ExportedHandler;
