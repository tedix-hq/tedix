import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

describe("tenant policy dependency generations", () => {
	it("increments only the changed dependency across change, revert, deletion and recreation", () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE organizations (id TEXT PRIMARY KEY);
			CREATE TABLE apps (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, metadata TEXT, slug TEXT, visibility TEXT, source_app_id TEXT, active_config_version_id TEXT, latest_config_version INTEGER, gating_metadata TEXT, custom_mcp_domain TEXT);
			CREATE TABLE app_tools (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, config TEXT);
			CREATE TABLE connection_instances (id TEXT PRIMARY KEY, organization_id TEXT, provider_id TEXT, owner_user_id TEXT, token_ids TEXT, token_sub TEXT, allowed_resources TEXT);
			CREATE TABLE tenant_tool_policy_resource_generations (organization_id TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (organization_id, resource_kind, resource_id));
		`);
		const sql = readFileSync(
			new URL(
				"../../drizzle/20261030142026_tenant_policy_dependency_generations/migration.sql",
				import.meta.url,
			),
			"utf8",
		);
		const triggers = sql
			.slice(sql.indexOf("CREATE TRIGGER"))
			.replaceAll("--> statement-breakpoint", "");
		sqlite.exec(triggers);
		sqlite.exec(`INSERT INTO organizations VALUES ('org-a'), ('org-b');
			INSERT INTO apps (id, organization_id, metadata) VALUES ('app-a', 'org-a', '{}'), ('app-b', 'org-b', '{}');
			INSERT INTO app_tools (id, app_id, config) VALUES ('tool-a', 'app-a', '{}');
			INSERT INTO connection_instances (id, organization_id, provider_id, owner_user_id, token_ids) VALUES ('account-a', 'org-a', 'provider', 'owner', '[]');`);
		const generation = (org: string, kind: string, id: string) =>
			(
				sqlite
					.prepare(
						"SELECT generation FROM tenant_tool_policy_resource_generations WHERE organization_id = ? AND resource_kind = ? AND resource_id = ?",
					)
					.get(org, kind, id) as { generation: number } | undefined
			)?.generation;
		expect(generation("org-a", "app", "app-a")).toBe(1);
		sqlite.exec(
			`UPDATE apps SET metadata = '{"mount":1}' WHERE id = 'app-a'; UPDATE apps SET metadata = '{}' WHERE id = 'app-a'; UPDATE app_tools SET config = '{"changed":true}' WHERE id = 'tool-a'; UPDATE app_tools SET config = '{}' WHERE id = 'tool-a'; UPDATE connection_instances SET token_sub = 'first' WHERE id = 'account-a'; UPDATE connection_instances SET token_sub = NULL WHERE id = 'account-a';`,
		);
		expect(generation("org-a", "app", "app-a")).toBe(3);
		expect(generation("org-a", "tool", "tool-a")).toBe(3);
		expect(generation("org-a", "connection", "account-a")).toBe(3);
		expect(generation("org-b", "app", "app-b")).toBe(1);
		sqlite.exec(
			`DELETE FROM app_tools WHERE id = 'tool-a'; INSERT INTO app_tools VALUES ('tool-a', 'app-a', '{}');`,
		);
		expect(generation("org-a", "tool", "tool-a")).toBe(5);
	});
});
