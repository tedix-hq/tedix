import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { createMigratedSqlite } from "../src/test/migrated-sqlite";

const migration = "20261026202309_installed-attention-app-names";
const sql = readFileSync(
	new URL(`../drizzle/${migration}/migration.sql`, import.meta.url),
	"utf8",
);

it("renames only default built-in titles across organizations and preserves name collisions", () => {
	const db = createMigratedSqlite({
		beforeMigration: migration,
		foreignKeys: false,
	});
	try {
		const insertApp = db.prepare(
			"INSERT INTO os_gadgets (id, organization_id, workspace_id, name, current_revision_id, created_by_kind, created_by_id, updated_at) VALUES (?, ?, ?, ?, ?, 'user', 'fixture', '2026-01-01')",
		);
		const insertRevision = db.prepare(
			"INSERT INTO os_gadget_revisions (id, organization_id, gadget_id, revision, manifest, created_by_kind, created_by_id) VALUES (?, ?, ?, 1, ?, 'user', 'fixture')",
		);
		const fixtures = [
			{ id: "feed", name: "Feed", role: "feed", expected: "Activity" },
			{ id: "deck", name: "Deck", role: "deck", expected: "Decisions" },
			{
				id: "other-org",
				name: "Feed",
				role: "feed",
				org: "orchard",
				expected: "Activity",
			},
			{ id: "renamed-feed", name: "Team news", role: "feed" },
			{ id: "renamed-deck", name: "My decisions", role: "deck" },
			{ id: "case", name: "feed", role: "feed" },
			{ id: "space", name: "Deck ", role: "deck" },
			{ id: "custom", name: "Feed", role: "feed", entry: "custom.ts" },
			{ id: "wrong-role", name: "Feed", role: "deck" },
			{ id: "wrong-org", name: "Deck", role: "deck", revisionOrg: "orchard" },
			{ id: "missing-revision", name: "Feed", role: "feed", missing: true },
			{
				id: "occupied-feed",
				name: "Feed",
				role: "feed",
				workspace: "occupied-feed",
			},
			{
				id: "activity",
				name: "Activity",
				role: "feed",
				workspace: "occupied-feed",
			},
			{
				id: "occupied-deck",
				name: "Deck",
				role: "deck",
				workspace: "occupied-deck",
			},
			{
				id: "decisions",
				name: "Decisions",
				role: "deck",
				workspace: "occupied-deck",
			},
		];
		for (const fixture of fixtures) {
			const org = fixture.org ?? "maple";
			insertApp.run(
				fixture.id,
				org,
				fixture.workspace ?? fixture.id,
				fixture.name,
				`${fixture.id}-revision`,
			);
			if (!fixture.missing)
				insertRevision.run(
					`${fixture.id}-revision`,
					fixture.revisionOrg ?? org,
					fixture.id,
					JSON.stringify({
						entry:
							fixture.entry ??
							`tedix:app/${fixture.role === "feed" ? "activity-feed" : "decision-deck"}`,
						navigation: { work: fixture.role },
					}),
				);
		}
		for (let pass = 0; pass < 2; pass++) {
			db.exec(sql);
			expect(db.prepare("SELECT changes() AS count").get()!.count).toBe(
				pass === 0 ? 3 : 0,
			);
			for (const fixture of fixtures) {
				const row = db
					.prepare("SELECT name, updated_at FROM os_gadgets WHERE id = ?")
					.get(fixture.id)!;
				expect(row.name).toBe(fixture.expected ?? fixture.name);
				if (!fixture.expected) expect(row.updated_at).toBe("2026-01-01");
			}
		}
	} finally {
		db.close();
	}
});
