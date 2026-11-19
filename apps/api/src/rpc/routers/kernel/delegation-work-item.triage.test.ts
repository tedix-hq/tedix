import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { createDelegationWorkItem } from "./delegation-work-item";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-11-16T08:00:00.000Z";

function fixture() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('${ORG_ID}','Org','org');
		INSERT INTO tedis(id,organization_id,name,slug,status,mcp_capability_profile)
		VALUES('tedi-cfo','${ORG_ID}','CFO','cfo','active','standard');
	`);
	const facade = createD1Facade(sqlite);
	const context = {
		db: createDbClient(facade),
		env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		userId: "fictional-requester",
	} as BaseContext;
	const addProject = (id: string, leadTediId: string | null) =>
		sqlite
			.prepare(
				"INSERT INTO projects(id,org_id,key,name,status,lead_tedi_id,created_at) VALUES(?,?,?,?,'active',?,?)",
			)
			.run(id, ORG_ID, id, id, leadTediId, NOW);
	const delegate = (
		childRunId: string,
		content = "Draft the fictional invoice",
	) =>
		createDelegationWorkItem(context, {
			assigneeTediId: "tedi-cfo",
			childRunId,
			content,
			conversationId: "home:os:conv",
			createdAt: NOW,
			executionRequirement: {
				surface: "native",
				requiredCapabilities: [],
				fallbackSurface: null,
				prohibitedSurfaces: [],
				satisfiable: true,
				reason: "test",
			},
			homeRunId: "home-run",
			organizationId: ORG_ID,
		});
	const work = () =>
		sqlite
			.prepare(
				"SELECT disposition, project_id, accountable_owner_type, accountable_owner_id, json_extract(metadata,'$.needsProject') AS needsProject FROM work_items ORDER BY created_at, id",
			)
			.all();
	const attempts = () =>
		(
			sqlite.prepare("SELECT count(*) AS n FROM work_attempts").get() as {
				n: number;
			}
		).n;
	return { sqlite, addProject, delegate, work, attempts };
}

let f: ReturnType<typeof fixture>;
beforeEach(() => {
	f = fixture();
});
afterEach(() => f.sqlite.close());

describe("Home delegation and the project a request points at", () => {
	it("still starts a delegation when no project is known, and marks the task for sorting", async () => {
		f.addProject("finance", null);
		f.addProject("growth", null);
		await f.delegate("child-run-1");
		expect(f.work()).toEqual([
			{
				disposition: "accepted",
				project_id: null,
				accountable_owner_type: "tedi",
				accountable_owner_id: "tedi-cfo",
				needsProject: 1,
			},
		]);
		expect(f.attempts()).toBe(1);
		expect(
			f.sqlite
				.prepare("SELECT body FROM work_item_comments")
				.all()
				.map((row) => String(row.body)),
		).toEqual([expect.stringContaining("without a project")]);
	});

	it("files the delegation under the project the tedi leads and starts it", async () => {
		f.addProject("finance", "tedi-cfo");
		f.addProject("growth", null);
		await f.delegate(
			"child-run-1",
			"[[tedix-context:workspace:5eed0014-0000-4000-8000-000000000014:Finance]]\n\nPlease draft the fictional invoice: use the sample prices.",
		);
		expect(
			f.sqlite.prepare("SELECT title FROM work_items").get(),
		).toMatchObject({
			title: "Draft the fictional invoice",
		});
		expect(f.work()).toEqual([
			{
				disposition: "accepted",
				project_id: "finance",
				accountable_owner_type: "tedi",
				accountable_owner_id: "tedi-cfo",
				needsProject: null,
			},
		]);
		expect(f.attempts()).toBe(1);
	});

	it("falls back to the requesting person's default project", async () => {
		f.addProject("finance", null);
		f.addProject("growth", null);
		f.sqlite
			.prepare(
				"INSERT INTO user_configs(id,user_id,namespace,key,value,created_at,updated_at) VALUES(?,?,?,?,json(?),?,?)",
			)
			.run(
				"config-1",
				"fictional-requester",
				`organization:${ORG_ID}`,
				"request-auto-filing",
				JSON.stringify({ enabled: false, intakeProjectId: "growth" }),
				NOW,
				NOW,
			);
		await f.delegate("child-run-1");
		expect(f.work()).toMatchObject([
			{ disposition: "accepted", project_id: "growth" },
		]);
	});
});
