import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workCaseItems, workCases } from "../../schema/work-factory";
import {
	workAttempts,
	workEvents,
	workItemComments,
	workItems,
} from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createWorkCase,
	detachWorkItemFromCase,
	linkWorkItemToCase,
} from "./cases";
import { restoreWorkItemFiling, updateWorkItemSpecification } from "./crud";

const NOW = "2026-11-16T12:00:00.000Z";
const actor = { type: "user" as const, id: "owner" };

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workEvents,
			workAttempts,
			workItemComments,
			workCases,
			workCaseItems,
		),
	);
	const insert = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,disposition,created_at,project_id,work_class,objective_id,purpose_exception_expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
	);
	// Original filings: no project and a maintenance exception; and an objective one.
	insert.run(
		"free",
		"org",
		"Free",
		"accepted",
		NOW,
		null,
		"maintenance",
		null,
		"2026-11-30T00:00:00.000Z",
	);
	insert.run(
		"obj",
		"org",
		"Obj",
		"accepted",
		NOW,
		"p1",
		"objective",
		"o1",
		null,
	);
	insert.run(
		"done",
		"org",
		"Done",
		"completed",
		NOW,
		null,
		"hygiene",
		null,
		"2026-11-30T00:00:00.000Z",
	);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const row = (sqlite: DatabaseSync, id: string) =>
	sqlite
		.prepare(
			"SELECT project_id,objective_id,work_class,purpose_exception_expires_at,version,admission_spec_revision FROM work_items WHERE id=?",
		)
		.get(id) as Record<string, unknown>;

it("restores the exact original filing, nulls included, and audits both sides", async () => {
	const { sqlite, db } = setup();
	const original = row(sqlite, "free");
	// The cleanup: file into a project as objective Work.
	const filed = await updateWorkItemSpecification(db, {
		orgId: "org",
		workItemId: "free",
		actor,
		projectId: "p1",
		objectiveId: "o1",
		workClass: "objective",
		purposeExceptionExpiresAt: null,
	});
	expect(filed.workClass).toBe("objective");

	const restored = await restoreWorkItemFiling(db, {
		orgId: "org",
		workItemId: "free",
		actor,
		expectedWorkItemVersion: filed.version,
		filing: {
			projectId: null,
			objectiveId: null,
			workClass: "maintenance",
			purposeExceptionExpiresAt: "2026-11-30T00:00:00.000Z",
		},
	});
	expect(restored).toMatchObject({
		projectId: null,
		objectiveId: null,
		workClass: "maintenance",
		purposeExceptionExpiresAt: "2026-11-30T00:00:00.000Z",
		disposition: "accepted",
	});
	const after = row(sqlite, "free");
	expect({ ...after, version: 0, admission_spec_revision: 0 }).toEqual({
		...original,
		version: 0,
		admission_spec_revision: 0,
	});
	expect(after.admission_spec_revision).not.toBe(
		original.admission_spec_revision,
	);
	const event = sqlite
		.prepare(
			"SELECT payload,actor_id FROM work_events WHERE work_item_id='free' AND event_type='work.filing_restored'",
		)
		.get() as { payload: string; actor_id: string };
	expect(event.actor_id).toBe("owner");
	expect(JSON.parse(event.payload)).toMatchObject({
		from: { projectId: "p1", objectiveId: "o1", workClass: "objective" },
		to: { projectId: null, objectiveId: null, workClass: "maintenance" },
	});
	// Earlier history is still there.
	expect(
		sqlite
			.prepare(
				"SELECT COUNT(*) AS n FROM work_events WHERE work_item_id='free'",
			)
			.get(),
	).toEqual({ n: 2 });
	sqlite.close();
});

it("refuses a stale version, closed Work, and Work with a live Attempt", async () => {
	const { sqlite, db } = setup();
	const filing = {
		projectId: null,
		objectiveId: null,
		workClass: null,
		purposeExceptionExpiresAt: null,
	};
	const base = { orgId: "org", actor, filing } as const;
	await expect(
		restoreWorkItemFiling(db, {
			...base,
			workItemId: "obj",
			expectedWorkItemVersion: 99,
		}),
	).rejects.toThrow(/expected version/);
	await expect(
		restoreWorkItemFiling(db, {
			...base,
			workItemId: "done",
			expectedWorkItemVersion: row(sqlite, "done").version as number,
		}),
	).rejects.toThrow(/NOT_READY/);
	sqlite
		.prepare(
			"INSERT INTO work_attempts(id,org_id,work_item_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at) VALUES('a1','org','obj','tedi','t','running',1,?,?)",
		)
		.run(NOW, NOW);
	await expect(
		restoreWorkItemFiling(db, {
			...base,
			workItemId: "obj",
			expectedWorkItemVersion: row(sqlite, "obj").version as number,
			updatedAt: NOW,
		}),
	).rejects.toThrow(/live Attempt/);
	expect(row(sqlite, "obj")).toMatchObject({
		project_id: "p1",
		work_class: "objective",
	});
	sqlite.close();
});

it("detaches an epic link without touching the Work, and it can be re-attached", async () => {
	const { sqlite, db } = setup();
	await createWorkCase(db, {
		id: "epic",
		orgId: "org",
		title: "Epic",
		kind: "other",
		accountableOwnerType: "system",
		accountableOwnerId: "tedix",
		openedAt: NOW,
		now: NOW,
	});
	await linkWorkItemToCase(db, {
		id: "link-1",
		orgId: "org",
		caseId: "epic",
		workItemId: "free",
		rationale: "why",
		discoveredAt: NOW,
	});
	const detached = await detachWorkItemFromCase(db, {
		orgId: "org",
		caseId: "epic",
		workItemId: "free",
		actor,
		now: NOW,
	});
	expect(detached).toMatchObject({ id: "link-1", rationale: "why" });
	expect(
		sqlite.prepare("SELECT COUNT(*) AS n FROM work_case_items").get(),
	).toEqual({ n: 0 });
	expect(sqlite.prepare("SELECT COUNT(*) AS n FROM work_items").get()).toEqual({
		n: 3,
	});
	const event = sqlite
		.prepare(
			"SELECT payload FROM work_events WHERE event_type='work.case_detached'",
		)
		.get() as { payload: string };
	expect(JSON.parse(event.payload)).toMatchObject({
		caseId: "epic",
		rationale: "why",
		discoveredAt: NOW,
	});
	await expect(
		detachWorkItemFromCase(db, {
			orgId: "org",
			caseId: "epic",
			workItemId: "free",
			actor,
			now: NOW,
		}),
	).rejects.toThrow(/not attached/);
	await linkWorkItemToCase(db, {
		id: "link-2",
		orgId: "org",
		caseId: "epic",
		workItemId: "free",
		rationale: detached.rationale,
		discoveredAt: detached.discoveredAt,
	});
	expect(
		sqlite.prepare("SELECT COUNT(*) AS n FROM work_case_items").get(),
	).toEqual({ n: 1 });
	sqlite.close();
});
