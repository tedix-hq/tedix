import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { appCatalog, appCatalogMcpSkills } from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { syncCatalogMcpSkills } from "./mcp-skills";

function realDb(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(appCatalog, appCatalogMcpSkills));
	sqlite.exec(`
		INSERT INTO app_catalog (id, slug, name, connector_type, last_synced_at)
		VALUES ('app-1', 'one', 'One', 'MCP', '2026-01-01T00:00:00Z'),
		       ('app-2', 'two', 'Two', 'MCP', '2026-01-01T00:00:00Z');
	`);
	return createDbClient(createD1Facade(sqlite));
}

const sha256 = `sha256:${"a".repeat(64)}`;

describe("syncCatalogMcpSkills", () => {
	it("stores complete manifests with app-scoped URI identity", async () => {
		const db = realDb();
		const skill = {
			skillUri: "skill://refunds/SKILL.md",
			frontmatter: { name: "refunds", description: "Process refunds" },
			resources: [
				{ uri: "skill://refunds/SKILL.md", digest: sha256, size: 50 },
			],
		};

		expect(await syncCatalogMcpSkills(db, "app-1", [skill])).toEqual({
			added: 1,
			updated: 0,
			removed: 0,
		});
		expect(await syncCatalogMcpSkills(db, "app-2", [skill])).toEqual({
			added: 1,
			updated: 0,
			removed: 0,
		});

		const rows = await db.select().from(appCatalogMcpSkills);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.catalogAppId).sort()).toEqual([
			"app-1",
			"app-2",
		]);
		expect(rows[0]?.resources).toEqual(skill.resources);
	});

	it("updates an observed manifest but leaves omitted skills intact", async () => {
		const db = realDb();
		const original = {
			skillUri: "skill://acme/refunds/SKILL.md",
			frontmatter: { name: "refunds", description: "Old description" },
			resources: "dynamic" as const,
		};
		await syncCatalogMcpSkills(db, "app-1", [original]);
		const before = (await db.select().from(appCatalogMcpSkills))[0];

		const updated = {
			...original,
			frontmatter: { name: "refunds", description: "New description" },
			resources: [{ uri: original.skillUri, digest: sha256, size: 80 }],
		};
		expect(await syncCatalogMcpSkills(db, "app-1", [updated])).toEqual({
			added: 0,
			updated: 1,
			removed: 0,
		});
		const after = (await db.select().from(appCatalogMcpSkills))[0];
		expect(after?.detectedAt).toBe(before?.detectedAt);
		expect(after?.frontmatter).toEqual(updated.frontmatter);
		expect(after?.resources).toEqual(updated.resources);

		// An empty/partial list is not evidence that an earlier skill was removed.
		expect(await syncCatalogMcpSkills(db, "app-1", [])).toEqual({
			added: 0,
			updated: 0,
			removed: 0,
		});
		expect(await db.select().from(appCatalogMcpSkills)).toHaveLength(1);
	});
});
