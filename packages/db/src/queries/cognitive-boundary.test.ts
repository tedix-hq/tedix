import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { organizations } from "../schema/organizations";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listSkillCoverageToolsForApp } from "./cognitive/skill-tool-metadata";

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, appCatalog, apps, appTools));
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES
			('org-1', 'One', 'one'),
			('org-2', 'Two', 'two');
		INSERT INTO apps (id, organization_id, name, slug) VALUES
			('app-1', 'org-1', 'App One', 'app-one'),
			('app-2', 'org-2', 'App Two', 'app-two');
		INSERT INTO app_tools (
			id, app_id, tool_id, title, input_schema, output_schema,
			annotations, meta, enabled, tool_type_id
		) VALUES
			('tool-1', 'app-1', 'read_one', 'Read One', '{"type":"object"}',
			 '{"type":"object"}', '{"readOnlyHint":true}', '{"coverage":"include"}', 1, 'rpc'),
			('tool-2', 'app-1', 'write_one', 'Write One', '{"type":"object"}',
			 NULL, NULL, NULL, 0, 'rpc'),
			('tool-private', 'app-2', 'private_two', 'Private Two', '{"type":"object"}',
			 NULL, NULL, NULL, 1, 'rpc');
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("cognitive query boundary", () => {
	it("loads only the requested app's skill-coverage tool projection through D1", async () => {
		const { db } = fixture();

		const tools = await listSkillCoverageToolsForApp(db, "app-1");

		expect(tools).toHaveLength(2);
		expect(tools.map(({ id }) => id).sort()).toEqual(["tool-1", "tool-2"]);
		expect(tools).toContainEqual({
			id: "tool-1",
			toolId: "read_one",
			title: "Read One",
			outputSchema: { type: "object" },
			annotations: { readOnlyHint: true },
			meta: { coverage: "include" },
			enabled: true,
		});
		expect(tools.find(({ id }) => id === "tool-2")?.enabled).toBe(false);
	});
});
