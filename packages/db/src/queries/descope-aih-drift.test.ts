import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { loadDescopeAihD1SnapshotRows } from "./descope-aih-drift";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE apps (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL,
			name TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
		);
		CREATE TABLE tedis (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL,
			name TEXT NOT NULL, descope_mcp_resource_id TEXT, descope_user_id TEXT,
			mcp_capability_profile TEXT, retired_at TEXT
		);
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

describe("Descope AIH drift snapshot", () => {
	it("applies the organization boundary in D1 and excludes retired tedis", async () => {
		const { sqlite, db } = fixture();
		const insertApp = sqlite.prepare(
			"INSERT INTO apps(id,organization_id,slug,name,metadata) VALUES(?,?,?,?,?)",
		);
		insertApp.run("app-a", "org-a", "a", "A", "{}");
		insertApp.run("app-b", "org-b", "b", "B", "{}");
		const insertTedi = sqlite.prepare(
			"INSERT INTO tedis(id,organization_id,slug,name,retired_at) VALUES(?,?,?,?,?)",
		);
		insertTedi.run("tedi-a", "org-a", "a", "A", null);
		insertTedi.run("tedi-retired", "org-a", "retired", "Retired", "2026-01-01");
		insertTedi.run("tedi-b", "org-b", "b", "B", null);

		const snapshot = await loadDescopeAihD1SnapshotRows(db, "org-a");

		expect(snapshot.appRows.map((row) => row.id)).toEqual(["app-a"]);
		expect(snapshot.tediRows.map((row) => row.id)).toEqual(["tedi-a"]);
	});
});
