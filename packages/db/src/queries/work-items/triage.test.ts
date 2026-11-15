import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { workEvents } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import {
	countTriageQueues,
	declineProposedWorkItem,
	listTriageQueue,
	markWorkItemDuplicate,
	snoozeProposedWorkItem,
} from "./triage";

const ORG = "org-acme";
const NOW = "2026-11-15T12:00:00.000Z";
const LATER = "2026-11-16T12:00:00.000Z";
const actor = { type: "user" as const, id: "fictional-owner" };

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(canonicalWorkFactoryDdl());
	sqlite.exec(
		schemaDdl(workEvents, workInteractions, workInteractionResponses),
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	const seed = (
		id: string,
		options: {
			org?: string;
			projectId?: string;
			disposition?: string;
			priority?: string;
			createdAt?: string;
		} = {},
	) =>
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,disposition,priority,project_id,created_at) VALUES(?,?,?,?,?,?,?)",
			)
			.run(
				id,
				options.org ?? ORG,
				id,
				options.disposition ?? "proposed",
				options.priority ?? "medium",
				options.projectId ?? null,
				options.createdAt ?? "2026-11-01T00:00:00.000Z",
			);
	const row = (id: string) =>
		sqlite
			.prepare("SELECT disposition, metadata FROM work_items WHERE id=?")
			.get(id) as { disposition: string; metadata: string | null };
	return { sqlite, db: createDbClient(createD1Facade(sqlite)), seed, row };
}

it("declines only a proposal, and only with a reason", async () => {
	const { sqlite, db, seed, row } = fixture();
	seed("ask");
	seed("running", { disposition: "accepted" });
	const base = { orgId: ORG, actor, at: NOW };
	await expect(
		declineProposedWorkItem(db, { ...base, workItemId: "ask", reason: "  " }),
	).rejects.toThrow(/needs a reason/);
	await expect(
		declineProposedWorkItem(db, {
			...base,
			workItemId: "running",
			reason: "Not now",
		}),
	).rejects.toThrow(/Only proposed work/);
	expect(row("running").disposition).toBe("accepted");
	const declined = await declineProposedWorkItem(db, {
		...base,
		workItemId: "ask",
		reason: "Not this quarter",
	});
	expect(declined).toMatchObject({
		disposition: "cancelled",
		cancelledAt: NOW,
	});
	expect(
		sqlite
			.prepare(
				"SELECT event_type, payload FROM work_events WHERE work_item_id='ask'",
			)
			.all()
			.map((event) => ({
				type: event.event_type,
				payload: JSON.parse(String(event.payload)),
			})),
	).toEqual([
		{
			type: "work.cancelled",
			payload: { reason: "Not this quarter", triageExit: "declined" },
		},
	]);
	sqlite.close();
});

it("marks a duplicate by recording the relation and cancelling together", async () => {
	const { sqlite, db, seed, row } = fixture();
	seed("original", { disposition: "accepted" });
	seed("copy");
	seed("foreign", { org: "org-other" });
	const base = { orgId: ORG, actor, at: NOW, relationId: "relation-1" };
	await expect(
		markWorkItemDuplicate(db, {
			...base,
			workItemId: "copy",
			duplicateOfWorkItemId: "copy",
		}),
	).rejects.toThrow(/cannot duplicate itself/);
	await expect(
		markWorkItemDuplicate(db, {
			...base,
			workItemId: "copy",
			duplicateOfWorkItemId: "foreign",
		}),
	).rejects.toThrow(/NOT_FOUND/);
	// An accepted item is not in triage: nothing is cancelled or related.
	await expect(
		markWorkItemDuplicate(db, {
			...base,
			workItemId: "original",
			duplicateOfWorkItemId: "copy",
		}),
	).rejects.toThrow(/Only proposed work/);
	expect(
		sqlite.prepare("SELECT count(*) AS n FROM work_item_relations").get()?.n,
	).toBe(0);
	const cancelled = await markWorkItemDuplicate(db, {
		...base,
		workItemId: "copy",
		duplicateOfWorkItemId: "original",
	});
	expect(cancelled.disposition).toBe("cancelled");
	expect(row("original").disposition).toBe("accepted");
	expect(
		sqlite
			.prepare(
				"SELECT id, org_id, from_work_item_id, to_work_item_id, relation_type FROM work_item_relations",
			)
			.all(),
	).toEqual([
		{
			id: "relation-1",
			org_id: ORG,
			from_work_item_id: "copy",
			to_work_item_id: "original",
			relation_type: "duplicates",
		},
	]);
	expect(
		JSON.parse(
			String(
				sqlite
					.prepare("SELECT payload FROM work_events WHERE work_item_id='copy'")
					.get()?.payload,
			),
		),
	).toEqual({
		reason: 'Duplicate of "original"',
		triageExit: "duplicate",
		duplicateOfWorkItemId: "original",
	});
	sqlite.close();
});

it("snoozes a proposal out of its queue until the wake time, and wakes it early", async () => {
	const { sqlite, db, seed, row } = fixture();
	seed("later");
	seed("running", { disposition: "accepted" });
	const base = { orgId: ORG, actor, at: NOW };
	await expect(
		snoozeProposedWorkItem(db, { ...base, workItemId: "later", until: NOW }),
	).rejects.toThrow(/future time/);
	await expect(
		snoozeProposedWorkItem(db, {
			...base,
			workItemId: "running",
			until: LATER,
		}),
	).rejects.toThrow(/Only proposed work/);
	const snoozed = await snoozeProposedWorkItem(db, {
		...base,
		workItemId: "later",
		until: "2026-11-16T13:00:00+01:00",
	});
	expect(snoozed.disposition).toBe("proposed");
	expect(snoozed.metadata).toEqual({ triageSnoozedUntil: LATER });
	const queue = (now: string) =>
		listTriageQueue(db, { orgId: ORG, projectId: null, now });
	expect((await queue(NOW)).total).toBe(0);
	expect(await countTriageQueues(db, { orgId: ORG, now: NOW })).toEqual({
		queues: [],
		snoozed: 1,
	});
	// The wake time itself puts it back without anyone acting.
	expect((await queue(LATER)).data.map((item) => item.id)).toEqual(["later"]);
	await snoozeProposedWorkItem(db, {
		...base,
		workItemId: "later",
		until: null,
	});
	expect(JSON.parse(String(row("later").metadata))).toEqual({});
	expect((await queue(NOW)).total).toBe(1);
	expect(
		sqlite
			.prepare(
				"SELECT event_type FROM work_events WHERE work_item_id='later' ORDER BY sequence",
			)
			.all()
			.map((event) => event.event_type),
	).toEqual(["work.snoozed", "work.woken"]);
	sqlite.close();
});

it("lists proposals per project and organization-wide for work with no project", async () => {
	const { sqlite, db, seed } = fixture();
	seed("unfiled-old", { createdAt: "2026-11-01T00:00:00.000Z" });
	seed("unfiled-urgent", {
		priority: "critical",
		createdAt: "2026-11-10T00:00:00.000Z",
	});
	seed("unfiled-new", { createdAt: "2026-11-12T00:00:00.000Z" });
	seed("in-project", { projectId: "project-a" });
	seed("accepted", { disposition: "accepted" });
	seed("accepted-in-project", {
		projectId: "project-a",
		disposition: "accepted",
	});
	seed("cancelled", { disposition: "cancelled" });
	seed("foreign", { org: "org-other" });
	const organization = await listTriageQueue(db, {
		orgId: ORG,
		projectId: null,
		now: NOW,
		limit: 2,
	});
	expect(organization.total).toBe(3);
	expect(organization.data.map((item) => item.id)).toEqual([
		"unfiled-urgent",
		"unfiled-old",
	]);
	const project = await listTriageQueue(db, {
		orgId: ORG,
		projectId: "project-a",
		now: NOW,
	});
	expect(project.data.map((item) => item.id)).toEqual(["in-project"]);
	const counts = await countTriageQueues(db, { orgId: ORG, now: NOW });
	expect(counts.queues.sort((a, b) => a.count - b.count)).toEqual([
		{ projectId: "project-a", count: 1 },
		{ projectId: null, count: 3 },
	]);
	expect(counts.snoozed).toBe(0);
	sqlite.close();
});
