import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { moveSkillToFolder } from "./skill-folders";

describe("skill catalog folders", () => {
	let db: ReturnType<typeof createDbClient>;
	let sqlite: DatabaseSync;

	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE skill_entries (
				id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, title TEXT NOT NULL,
				slug TEXT, folder_path TEXT, content TEXT NOT NULL,
				success_count INTEGER NOT NULL DEFAULT 0,
				failure_count INTEGER NOT NULL DEFAULT 0,
				revision INTEGER NOT NULL DEFAULT 1,
				visibility TEXT NOT NULL DEFAULT 'private',
				pace_layer TEXT NOT NULL DEFAULT 'innovation', updated_at TEXT
			);
			INSERT INTO skill_entries (id, organization_id, title, slug, content)
			VALUES ('skill-1', 'org-1', 'Digest', 'digest', '# Digest');
		`);
		db = createDbClient(createD1Facade(sqlite));
	});

	it("moves within one tenant without changing runtime identity or revision", async () => {
		expect(
			await moveSkillToFolder(db, "org-1", "skill-1", "operations/reports"),
		).toBe(true);
		expect(
			sqlite
				.prepare("SELECT slug, folder_path, revision FROM skill_entries")
				.get(),
		).toEqual({
			slug: "digest",
			folder_path: "operations/reports",
			revision: 1,
		});
		expect(await moveSkillToFolder(db, "org-2", "skill-1", "foreign")).toBe(
			false,
		);
	});

	it("moves a skill back to the catalog root", async () => {
		await moveSkillToFolder(db, "org-1", "skill-1", "operations");
		expect(await moveSkillToFolder(db, "org-1", "skill-1", null)).toBe(true);
		expect(
			sqlite.prepare("SELECT folder_path FROM skill_entries").get(),
		).toEqual({ folder_path: null });
	});
});
