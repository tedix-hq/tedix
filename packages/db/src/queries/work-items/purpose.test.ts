import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workItems } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import {
	activePurposeContext,
	assertValidWorkItemProject,
	hasActivePurposeContext,
	resolveWorkItemPurpose,
	workItemPurposeFor,
} from "./purpose";

const NOW = "2026-08-20T12:00:00.000Z";
const FUTURE = "2026-08-27T12:00:00.000Z";
const DDL = `
CREATE TABLE projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, objective_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE TABLE tedi_objectives (id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active', priority TEXT NOT NULL DEFAULT 'medium', target_value REAL, current_value REAL, unit TEXT, due_date TEXT, achieved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT);
`;

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	sqlite
		.prepare(
			"INSERT INTO tedi_objectives (id,tedi_id,org_id,title,created_at) VALUES ('objective','tedi','org','Goal',?)",
		)
		.run(NOW);
	sqlite
		.prepare(
			"INSERT INTO projects (id,org_id,key,name,objective_id,created_at) VALUES ('project','org','FACTORY','Factory','objective',?)",
		)
		.run(NOW);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

describe("canonical Work Item purpose", () => {
	it("fails expired operational exceptions and undeclared purpose closed while preserving objective purpose", () => {
		expect(
			hasActivePurposeContext(
				{
					workClass: "hygiene",
					objectiveId: null,
					purposeExceptionExpiresAt: NOW,
				},
				FUTURE,
			),
		).toBe(false);
		expect(
			hasActivePurposeContext(
				{
					workClass: "objective",
					objectiveId: "objective",
					purposeExceptionExpiresAt: null,
				},
				FUTURE,
			),
		).toBe(true);
		// Reversed contract: nullable `work_class` was a read-side migration grace
		// period, never authority to schedule undeclared work.
		expect(
			hasActivePurposeContext(
				{
					workClass: null,
					objectiveId: null,
					purposeExceptionExpiresAt: null,
				},
				FUTURE,
			),
		).toBe(false);
	});

	it("excludes undeclared legacy purpose from the scheduler candidate predicate while admitting objective and live-exception work", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE work_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, disposition TEXT NOT NULL, objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, created_at TEXT NOT NULL);",
		);
		sqlite.exec(`
			INSERT INTO work_items (id,org_id,title,disposition,objective_id,work_class,purpose_exception_expires_at,created_at) VALUES
				('legacy','org','Legacy','accepted',NULL,NULL,NULL,'${NOW}'),
				('objective-linked','org','Objective','accepted','objective','objective',NULL,'${NOW}'),
				('objective-orphaned','org','Orphan','accepted',NULL,'objective',NULL,'${NOW}'),
				('live-exception','org','Live','accepted',NULL,'hygiene','${FUTURE}','${NOW}'),
				('lapsed-exception','org','Lapsed','accepted',NULL,'hygiene','${NOW}','${NOW}');
		`);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const admissible = await db
			.select({ id: workItems.id })
			.from(workItems)
			.where(activePurposeContext(NOW));
		expect(admissible.map((row) => row.id).sort()).toEqual([
			"live-exception",
			"objective-linked",
		]);
	});
	it("validates a project id and returns its project key only as project metadata", async () => {
		const { db } = fixture();
		expect(
			await assertValidWorkItemProject(db, {
				orgId: "org",
				projectId: "project",
			}),
		).toEqual({ key: "FACTORY", objectiveId: "objective" });
	});

	it("rejects missing and cross-org project ids", async () => {
		const { sqlite, db } = fixture();
		await expect(
			assertValidWorkItemProject(db, { orgId: "org", projectId: "missing" }),
		).rejects.toMatchObject({ code: "not_found" });
		sqlite
			.prepare("UPDATE projects SET org_id='other' WHERE id='project'")
			.run();
		await expect(
			assertValidWorkItemProject(db, { orgId: "org", projectId: "project" }),
		).rejects.toMatchObject({ code: "wrong_org" });
	});

	it("prefers objective context over an operational exception default", () => {
		expect(
			workItemPurposeFor({
				objectiveId: "objective",
				workClass: "maintenance",
			}),
		).toEqual({ objectiveId: "objective" });
	});

	it("creates a bounded default operational context", () => {
		expect(
			workItemPurposeFor({ workClass: "incident", now: new Date(NOW) }),
		).toEqual({ workClass: "incident", purposeExceptionExpiresAt: FUTURE });
	});

	it("resolves and validates an explicit objective", async () => {
		const { db } = fixture();
		expect(
			await resolveWorkItemPurpose(db, {
				orgId: "org",
				now: NOW,
				objectiveId: "objective",
			}),
		).toEqual({
			objectiveId: "objective",
			workClass: "objective",
			purposeExceptionExpiresAt: null,
		});
	});

	it("inherits objective context from a canonical project id", async () => {
		const { db } = fixture();
		expect(
			await resolveWorkItemPurpose(db, {
				orgId: "org",
				now: NOW,
				project: { objectiveId: "objective" },
			}),
		).toMatchObject({ objectiveId: "objective", workClass: "objective" });
	});

	it("inherits objective context from a parent", async () => {
		const { db } = fixture();
		expect(
			await resolveWorkItemPurpose(db, {
				orgId: "org",
				now: NOW,
				parent: {
					id: "parent",
					objectiveId: "objective",
					workClass: "objective",
					purposeExceptionExpiresAt: null,
					projectId: null,
				},
			}),
		).toMatchObject({ objectiveId: "objective" });
	});

	it("rejects conflicting objective sources", async () => {
		const { sqlite, db } = fixture();
		sqlite
			.prepare(
				"INSERT INTO tedi_objectives (id,tedi_id,org_id,title,created_at) VALUES ('other','tedi','org','Other',?)",
			)
			.run(NOW);
		await expect(
			resolveWorkItemPurpose(db, {
				orgId: "org",
				now: NOW,
				objectiveId: "objective",
				project: { objectiveId: "other" },
			}),
		).rejects.toMatchObject({ code: "context_conflict" });
	});

	it.each(["missing", "cross-org"])(
		"rejects an objective that is %s",
		async (scenario) => {
			const { sqlite, db } = fixture();
			if (scenario === "cross-org")
				sqlite
					.prepare(
						"UPDATE tedi_objectives SET org_id='other' WHERE id='objective'",
					)
					.run();
			await expect(
				resolveWorkItemPurpose(db, {
					orgId: "org",
					now: NOW,
					objectiveId: scenario === "missing" ? "missing" : "objective",
				}),
			).rejects.toMatchObject({
				code:
					scenario === "missing"
						? "objective_not_found"
						: "objective_wrong_org",
			});
		},
	);

	it("accepts an explicitly bounded operational exception", async () => {
		const { db } = fixture();
		expect(
			await resolveWorkItemPurpose(db, {
				orgId: "org",
				now: NOW,
				workClass: "hygiene",
				purposeExceptionExpiresAt: FUTURE,
			}),
		).toEqual({
			objectiveId: null,
			workClass: "hygiene",
			purposeExceptionExpiresAt: FUTURE,
		});
	});

	it.each(["2026-08-20T11:00:00.000Z", "2026-10-20T12:00:00.000Z"])(
		"rejects invalid operational expiry %s",
		async (expiry) => {
			const { db } = fixture();
			await expect(
				resolveWorkItemPurpose(db, {
					orgId: "org",
					now: NOW,
					workClass: "maintenance",
					purposeExceptionExpiresAt: expiry,
				}),
			).rejects.toMatchObject({ code: "exception_invalid" });
		},
	);

	it("allows a stored lapsed expiry only for a non-purpose update", async () => {
		const { db } = fixture();
		expect(
			await resolveWorkItemPurpose(db, {
				orgId: "org",
				now: NOW,
				workClass: "maintenance",
				purposeExceptionExpiresAt: "2026-08-01T00:00:00.000Z",
				allowStoredExpiry: true,
			}),
		).toMatchObject({ workClass: "maintenance" });
	});

	it("prevents a child exception from outliving its parent", async () => {
		const { db } = fixture();
		await expect(
			resolveWorkItemPurpose(db, {
				orgId: "org",
				now: NOW,
				workClass: "maintenance",
				purposeExceptionExpiresAt: "2026-08-28T00:00:00.000Z",
				parent: {
					id: "p",
					objectiveId: null,
					workClass: "maintenance",
					purposeExceptionExpiresAt: FUTURE,
					projectId: null,
				},
			}),
		).rejects.toMatchObject({ code: "context_conflict" });
	});
});
