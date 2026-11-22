import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	findSiteUpgradeWork,
	listSiteVersionProjects,
	saveSiteVersionReport,
} from "./site-versions";

it("scopes version reports to configured projects and preserves unrelated metadata", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE projects (
		id TEXT PRIMARY KEY, org_id TEXT, key TEXT, name TEXT, description TEXT,
		status TEXT, lead_tedi_id TEXT, owner_user_id TEXT, objective_id TEXT,
		target_date TEXT, metadata TEXT, created_at TEXT, updated_at TEXT, archived_from_status TEXT, archived_at TEXT
	);
	CREATE TABLE work_items (id TEXT, org_id TEXT, project_id TEXT, title TEXT, created_at TEXT);
	INSERT INTO work_items VALUES ('other-upgrade', 'org-b', 'site-project', 'Upgrade emdash to 2.0.0', '2026-01-01');
	INSERT INTO work_items VALUES ('own-upgrade', 'org-a', 'site-project', 'Upgrade emdash to 2.0.0', '2026-01-02');`);
	const insert = sqlite.prepare(
		"INSERT INTO projects (id, org_id, metadata, archived_at) VALUES (?, ?, ?, ?)",
	);
	insert.run(
		"site-project",
		"org-a",
		JSON.stringify({
			siteVersionCheck: { enabled: true },
			other: { keep: true },
		}),
		null,
	);
	insert.run(
		"other-project",
		"org-b",
		JSON.stringify({ siteVersionCheck: { enabled: true } }),
		null,
	);
	insert.run("disabled", "org-a", "{}", null);
	insert.run(
		"archived",
		"org-a",
		JSON.stringify({ siteVersionCheck: { enabled: true } }),
		"2026-01-01",
	);
	const db = createDbClient(createD1Facade(sqlite));
	expect(
		await findSiteUpgradeWork(
			db,
			"org-a",
			"site-project",
			"Upgrade emdash to 2.0.0",
		),
	).toBe("own-upgrade");
	expect(
		await findSiteUpgradeWork(
			db,
			"org-a",
			"different-project",
			"Upgrade emdash to 2.0.0",
		),
	).toBeNull();
	expect(
		(await listSiteVersionProjects(db, "org-a")).map((project) => project.id),
	).toEqual(["site-project"]);
	const report = {
		checkedAt: "2026-01-01T00:00:00Z",
		productRevision: "a".repeat(40),
		sites: [],
		alerts: [],
	};
	await saveSiteVersionReport(db, "site-project", "org-b", report);
	expect(
		JSON.parse(
			sqlite
				.prepare("SELECT metadata FROM projects WHERE id = ?")
				.get("site-project")!.metadata as string,
		),
	).not.toHaveProperty("siteVersionReport");
	await saveSiteVersionReport(db, "site-project", "org-a", report);
	expect(
		JSON.parse(
			sqlite
				.prepare("SELECT metadata FROM projects WHERE id = ?")
				.get("site-project")!.metadata as string,
		),
	).toEqual({
		siteVersionCheck: { enabled: true },
		other: { keep: true },
		siteVersionReport: report,
	});
	sqlite.close();
});
