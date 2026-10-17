import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { workItems } from "../schema/work-items";
import {
	archiveProject,
	createProject,
	getProjectById,
	getProjectByKey,
	getProjectRollup,
	listProjectPortfolio,
	listProjects,
	ProjectPurposeError,
	updateProject,
} from "./projects";
import { createWorkItem } from "./work-items/crud";

/**
 * Projects (work hierarchy v1) — CRUD + rollup against a REAL in-memory SQLite
 * engine via the production createDbClient path (mirrors capabilities.test.ts).
 */

const DDL = `
CREATE TABLE projects (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	key TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	lead_tedi_id TEXT,
	owner_user_id TEXT,
	objective_id TEXT,
	target_date TEXT,
	metadata TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT,
	archived_at TEXT
);
CREATE UNIQUE INDEX uniq_projects_org_key ON projects (org_id, key);
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER,
 provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX uniq_work_items_org_source_intent
	ON work_items (org_id, source_intent_id);
`;

const ORG = "org-1";
const NOW = "2026-07-17T00:00:00.000Z";
const LATER = "2026-07-18T00:00:00.000Z";
// Purpose-exception expiry anchored to the fixture clock, NOT the wall clock:
// createWorkItem validates expiry within (createdAt, createdAt + 30d], and no
// call here touches wall-clock selection, so NOW+7d stays valid-at-write
// forever (wall-clock-relative class: see work-items-selection.test.ts T_BASE
// note — a literal date here reads as expired once real time passes it).
const EXPIRY = new Date(
	Date.parse(NOW) + 7 * 24 * 60 * 60 * 1000,
).toISOString();

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

let counter = 0;
function nextId(prefix: string): string {
	counter += 1;
	return `${prefix}-${counter}`;
}

describe("projects CRUD", () => {
	it("creates, reads by id and key", async () => {
		const { db } = fixture();
		const project = await createProject(db, {
			id: nextId("proj"),
			orgId: ORG,
			key: "PLAT",
			name: "Platform",
			leadTediId: "tedi-1",
			createdAt: NOW,
		});
		expect(project.status).toBe("active");
		expect((await getProjectById(db, project.id))?.key).toBe("PLAT");
		expect((await getProjectByKey(db, ORG, "PLAT"))?.id).toBe(project.id);
		expect(await getProjectByKey(db, "other-org", "PLAT")).toBeUndefined();
	});

	it("lists with a status filter", async () => {
		const { db } = fixture();
		await createProject(db, {
			id: nextId("proj"),
			orgId: ORG,
			key: "A",
			name: "A",
			createdAt: NOW,
		});
		await createProject(db, {
			id: nextId("proj"),
			orgId: ORG,
			key: "B",
			name: "B",
			status: "paused",
			createdAt: NOW,
		});
		const all = await listProjects(db, { orgId: ORG });
		expect(all.total).toBe(2);
		const paused = await listProjects(db, { orgId: ORG, status: "paused" });
		expect(paused.data.map((p) => p.key)).toEqual(["B"]);
	});

	it("searches the full tenant project set before paging and counts matches", async () => {
		const { db } = fixture();
		for (let index = 0; index < 105; index++) {
			await createProject(db, {
				id: nextId("proj"),
				orgId: ORG,
				key: `P${String(index).padStart(3, "0")}`,
				name: index === 104 ? "100% Keystone" : `Project ${index}`,
				ownerUserId: index === 104 ? "owner-keystone" : undefined,
				createdAt: NOW,
			});
		}
		const lastPage = await listProjects(db, {
			orgId: ORG,
			limit: 20,
			offset: 100,
		});
		expect(lastPage.total).toBe(105);
		expect(lastPage.data).toHaveLength(5);
		const matches = await listProjects(db, {
			orgId: ORG,
			search: "KEYSTONE",
			limit: 20,
		});
		expect(matches.total).toBe(1);
		expect(matches.data.map((row) => row.key)).toEqual(["P104"]);
		expect((await listProjects(db, { orgId: ORG, search: "100%" })).total).toBe(
			1,
		);
		expect(
			(await listProjects(db, { orgId: ORG, search: "owner-keystone" })).total,
		).toBe(1);
	});

	it("updates fields", async () => {
		const { db } = fixture();
		const project = await createProject(db, {
			id: nextId("proj"),
			orgId: ORG,
			key: "PLAT",
			name: "Platform",
			createdAt: NOW,
		});
		const updated = await updateProject(db, project.id, {
			name: "Platform (renamed)",
			status: "done",
			updatedAt: LATER,
		});
		expect(updated?.name).toBe("Platform (renamed)");
		expect(updated?.status).toBe("done");
		expect(updated?.updatedAt).toBe(LATER);
	});

	it("rejects changing objective context after work links to the project", async () => {
		const { db } = fixture();
		const project = await createProject(db, {
			id: nextId("proj"),
			orgId: ORG,
			key: "LOCKED",
			name: "Locked purpose",
			createdAt: NOW,
		});
		await createWorkItem(db, {
			id: nextId("wi"),
			orgId: ORG,
			title: "linked",
			projectId: project.id,
			workClass: "maintenance",
			purposeExceptionExpiresAt: EXPIRY,
			sourceIntentId: nextId("intent"),
			createdAt: NOW,
		});
		await expect(
			updateProject(db, project.id, {
				objectiveId: "objective-new",
				updatedAt: LATER,
			}),
		).rejects.toBeInstanceOf(ProjectPurposeError);
	});

	it("soft-archives (status=archived + archivedAt)", async () => {
		const { db } = fixture();
		const project = await createProject(db, {
			id: nextId("proj"),
			orgId: ORG,
			key: "PLAT",
			name: "Platform",
			createdAt: NOW,
		});
		const archived = await archiveProject(db, project.id, LATER);
		expect(archived?.status).toBe("archived");
		expect(archived?.archivedAt).toBe(LATER);
		// the row stays queryable (audit-preserving).
		expect((await getProjectById(db, project.id))?.status).toBe("archived");
	});
});

describe("getProjectRollup", () => {
	it("rolls up every work item grouped under the project + headline items", async () => {
		const { db } = fixture();
		const project = await createProject(db, {
			id: nextId("proj"),
			orgId: ORG,
			key: "PLAT",
			name: "Platform",
			createdAt: NOW,
		});

		const seed = async (
			workKind: "other" | "coding" | "research",
			disposition: "proposed" | "accepted" | "completed" | "cancelled",
		) => {
			const id = nextId("wi");
			await db.insert(workItems).values({
				id,
				orgId: ORG,
				title: id,
				workKind,
				disposition,
				projectId: project.id,
				createdAt: NOW,
			});
			return id;
		};

		await seed("other", "accepted");
		await seed("research", "completed");
		await seed("research", "completed");
		await seed("coding", "proposed");
		await seed("coding", "cancelled");
		// A work item in the same org but NOT in this project must be excluded.
		await createWorkItem(db, {
			id: nextId("wi"),
			orgId: ORG,
			title: "unrelated",
			workKind: "coding",
			workClass: "maintenance",
			purposeExceptionExpiresAt: EXPIRY,
			sourceIntentId: nextId("intent"),
			createdAt: NOW,
		});

		const rollup = await getProjectRollup(db, {
			orgId: ORG,
			projectId: project.id,
		});
		expect(rollup.projectId).toBe(project.id);
		expect(rollup.total).toBe(5);
		expect(rollup.byDisposition).toEqual({
			accepted: 1,
			completed: 2,
			proposed: 1,
			cancelled: 1,
		});
		expect(rollup.byWorkKind).toEqual({
			other: 1,
			research: 2,
			coding: 2,
		});
		// denom = 5 - 1 cancelled = 4, done = 2 → 0.5.
		expect(rollup.percentDone).toBeCloseTo(0.5, 6);
		// has an in_progress → aggregateStatus in_progress.
		expect(rollup.aggregateDisposition).toBe("proposed");
		expect(rollup.distinctExecutors).toEqual([]);
		// Headline items are canonical roots: hierarchy is expressed by parent ids,
		// independently from artifact-neutral work kind.
		expect(rollup.topLevelItems).toHaveLength(5);
		expect(rollup.topLevelItems[0]?.workKind).toBe("other");
		// well under the scan cap → not truncated.
		expect(rollup.truncated).toBe(false);
	});

	it("empty project → zeroed rollup", async () => {
		const { db } = fixture();
		const project = await createProject(db, {
			id: nextId("proj"),
			orgId: ORG,
			key: "EMPTY",
			name: "Empty",
			createdAt: NOW,
		});
		const rollup = await getProjectRollup(db, {
			orgId: ORG,
			projectId: project.id,
		});
		expect(rollup.total).toBe(0);
		expect(rollup.aggregateDisposition).toBe("empty");
		expect(rollup.percentDone).toBe(0);
		expect(rollup.topLevelItems).toEqual([]);
		expect(rollup.truncated).toBe(false);
	});

	// F5: getProjectRollup is the one uncapped hierarchy scan. It now caps the
	// scan at PROJECT_ROLLUP_ITEM_CAP (2000) and flags truncated when a project
	// has more items than the cap, so the busiest table can't blow the D1 budget.
	it("caps the scan and flags truncation for an over-cap project", async () => {
		const { db, sqlite } = fixture();
		const project = await createProject(db, {
			id: nextId("proj"),
			orgId: ORG,
			key: "HUGE",
			name: "Huge",
			createdAt: NOW,
		});
		// Mirrors PROJECT_ROLLUP_ITEM_CAP in queries/projects.ts. Raw-insert past
		// the cap (fast bulk seed; the query path is what's under test).
		const CAP = 2000;
		const insert = sqlite.prepare(
			`INSERT INTO work_items
				(id, org_id, title, work_kind, disposition, priority, project_id, created_at)
			 VALUES (?, ?, ?, 'coding', 'proposed', 'medium', ?, ?)`,
		);
		for (let i = 0; i < CAP + 5; i++) {
			insert.run(`wi-cap-${i}`, ORG, `t${i}`, project.id, NOW);
		}
		const rollup = await getProjectRollup(db, {
			orgId: ORG,
			projectId: project.id,
		});
		expect(rollup.truncated).toBe(true);
		// only the first `cap` rows feed the totals.
		expect(rollup.total).toBe(CAP);
	});
});

const PORTFOLIO_DDL = `
CREATE TABLE tedis (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT);
CREATE TABLE work_attempts (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, heartbeat_at TEXT NOT NULL);
CREATE TABLE work_project_health_judgments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, observed_at TEXT NOT NULL);
CREATE TABLE work_agent_sessions (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT, last_event_at TEXT NOT NULL);
`;

describe("listProjectPortfolio", () => {
	it("returns each project's card facts in one batch, scoped to the org", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(PORTFOLIO_DDL);
		const project = (key: string, leadTediId: string | null = null) =>
			createProject(db, {
				id: nextId("proj"),
				orgId: ORG,
				key,
				name: key,
				leadTediId,
				createdAt: NOW,
			});
		const tours = await project("TOURS", "tedi-nova");
		const quiet = await project("QUIET");
		await createProject(db, {
			id: nextId("proj"),
			orgId: "org-2",
			key: "OTHER",
			name: "Other org",
			createdAt: NOW,
		});
		const item = async (
			title: string,
			disposition: "proposed" | "accepted" | "completed",
			createdAt: string,
			parentWorkItemId: string | null = null,
		) => {
			const id = nextId("wi");
			await db.insert(workItems).values({
				id,
				orgId: ORG,
				title,
				disposition,
				projectId: tours.id,
				parentWorkItemId,
				createdAt,
			});
			return id;
		};
		await item("Price the tours", "proposed", NOW);
		const boat = await item("Book the boat", "accepted", LATER);
		await item("Child step", "accepted", NOW, boat);
		await item("Done", "completed", NOW);
		sqlite.exec(`
			INSERT INTO tedis VALUES ('tedi-nova', '${ORG}', 'nova', 'Nova');
			INSERT INTO work_attempts VALUES ('a-1', '${ORG}', '${boat}', '2026-07-19T00:00:00.000Z');
			INSERT INTO work_project_health_judgments VALUES
				('h-1', '${ORG}', '${tours.id}', 'on_track', '${NOW}'),
				('h-2', '${ORG}', '${tours.id}', 'at_risk', '${LATER}');
			INSERT INTO work_agent_sessions VALUES
				('s-1', '${ORG}', '${tours.id}', '2026-07-20T00:00:00.000Z'),
				('s-2', 'org-2', '${tours.id}', '2026-07-30T00:00:00.000Z');
		`);

		const { data } = await listProjectPortfolio(db, { orgId: ORG, limit: 100 });

		expect(data.map((row) => row.project.key)).toEqual(["QUIET", "TOURS"]);
		expect(data[0]).toMatchObject({
			project: { id: quiet.id },
			leadTediName: null,
			total: 0,
			byDisposition: {},
			next: null,
			health: null,
			lastActivityAt: null,
		});
		expect(data[1]).toMatchObject({
			project: { id: tours.id, metadata: {} },
			leadTediName: "Nova",
			total: 4,
			byDisposition: { proposed: 1, accepted: 2, completed: 1 },
			next: { id: boat, title: "Book the boat" },
			health: "at_risk",
			lastActivityAt: "2026-07-20T00:00:00.000Z",
		});
	});
});

it("preserves observer authority at the write even when an ordinary edit read stale metadata", async () => {
	const { db } = fixture();
	const project = await createProject(db, {
		id: nextId("observer"),
		orgId: ORG,
		key: "WATCH",
		name: "Watch",
		createdAt: NOW,
		metadata: { repositoryObserver: { owner: "old" }, label: "old" },
	});
	const { configureRepositoryObserver } = await import("./repository-observer");
	const { RepositoryObserverConfigSchema } =
		await import("@tedix/api-contract/schemas/repository-observer");
	const config = RepositoryObserverConfigSchema.parse({
		repository: "example/product",
		ownerTediId: "11111111-1111-4111-8111-111111111111",
		escalationUserId: "human",
		instructions: "Read current evidence and report one diagnosis.",
	});
	expect(
		await configureRepositoryObserver(
			db,
			"another-org",
			project.id,
			config,
			LATER,
		),
	).toBe(false);
	expect(
		await configureRepositoryObserver(db, ORG, project.id, config, LATER),
	).toBe(true);
	const updated = await updateProject(db, project.id, {
		metadata: {
			...project.metadata,
			label: "new",
			repositoryObserver: { owner: "attacker" },
		},
		updatedAt: "2026-07-17T02:00:00.000Z",
	});
	expect(updated?.metadata?.repositoryObserver).toEqual(config);
	expect(updated?.metadata?.label).toBe("new");
});
it("cannot install observer authority through ordinary project metadata", async () => {
	const { db } = fixture();
	const project = await createProject(db, {
		id: nextId("unconfigured"),
		orgId: ORG,
		key: "UNCONFIGURED",
		name: "Unconfigured",
		createdAt: NOW,
	});
	const updated = await updateProject(db, project.id, {
		metadata: { repositoryObserver: { owner: "attacker" }, label: "safe" },
		updatedAt: LATER,
	});
	expect(updated?.metadata).toEqual({ label: "safe" });
});
