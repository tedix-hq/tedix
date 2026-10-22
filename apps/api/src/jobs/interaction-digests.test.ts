import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { workItems } from "@tedix/db/schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
	workInteractionAttention,
	workInteractionDeliveries,
} from "@tedix/db/schema/work-factory";
import {
	createWorkInteraction,
	listWorkInteractionInbox,
	listRequestedWorkInteractionEvents,
} from "@tedix/db/queries/work-items/interactions";
import {
	flushWorkInteractionDigests,
	nextInteractionDigestAt,
} from "@tedix/db/queries/work-items/interaction-digests";

const now = "2026-10-16T22:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			organizationMembers,
			tedis,
			workItems,
			workInteractions,
			workInteractionResponses,
			workInteractionAttention,
			workInteractionDeliveries,
		),
	);
	sqlite.exec(`INSERT INTO tedis(id,organization_id,name,slug,status) VALUES ('river','org','River','river','active');
		INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,role,status) VALUES ('member','org','person','person-sub','person@example.test','owner','active');
		INSERT INTO work_items(id,org_id,title,created_at) VALUES ('work','org','Fictional review','${now}');`);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const create = (
		id: string,
		extra: Partial<Parameters<typeof createWorkInteraction>[1]> = {},
	) =>
		createWorkInteraction(db, {
			id,
			orgId: "org",
			workItemId: "work",
			kind: "coordination",
			subject: `Update ${id}`,
			prompt: "Prepared the review.",
			creator: { type: "tedi", id: "river" },
			targetType: "user",
			targetId: "person",
			now,
			...extra,
		});
	const inbox = (observedAt = now) =>
		listWorkInteractionInbox(db, {
			orgId: "org",
			targetType: "user",
			targetId: "person",
			states: ["open"],
			observedAt,
		});
	return { sqlite, db, create, inbox };
}

describe("quiet Interaction digests", () => {
	it("holds overnight updates for one morning digest and deduplicates ticks", async () => {
		const { db, create, inbox } = fixture();
		await create("one");
		await create("two");
		expect((await inbox()).data).toHaveLength(0);
		expect(
			await listRequestedWorkInteractionEvents(db, {
				orgId: "org",
				after: null,
				targetId: "person",
				limit: 50,
			}),
		).toHaveLength(0);
		expect(
			await flushWorkInteractionDigests(db, "2026-10-17T02:00:00.000Z"),
		).toMatchObject({ digests: 0 });
		expect(
			await flushWorkInteractionDigests(db, "2026-10-17T08:00:00.000Z"),
		).toMatchObject({ digests: 1 });
		const rows = (await inbox("2026-10-17T08:01:00.000Z")).data;
		expect(rows).toHaveLength(1);
		expect(rows[0]!.request.prompt).toContain("Update one");
		expect(rows[0]!.request.prompt).toContain("Update two");
		expect(
			await flushWorkInteractionDigests(db, "2026-10-17T08:02:00.000Z"),
		).toMatchObject({ digests: 0 });
		await create("late");
		expect(
			await flushWorkInteractionDigests(db, "2026-10-17T08:03:00.000Z"),
		).toMatchObject({ digests: 0 });
		expect(
			await flushWorkInteractionDigests(db, "2026-10-17T12:00:00.000Z"),
		).toMatchObject({ digests: 1 });
	});
	it("lets failures, blocked approvals and near deadlines interrupt immediately", async () => {
		const { create, inbox } = fixture();
		await create("failure", { notificationReason: "failure" });
		await create("approval", { notificationReason: "blocked_approval" });
		await create("deadline", { dueAt: "2026-10-17T09:00:00.000Z" });
		expect((await inbox()).data).toHaveLength(3);
	});
	it("rechecks canonical deadlines and suppresses handled Work before delivery", async () => {
		const { db, sqlite, create, inbox } = fixture();
		await create("near", { dueAt: "2026-10-18T00:00:00.000Z" });
		await flushWorkInteractionDigests(db, "2026-10-17T01:00:00.000Z");
		expect((await inbox()).data.map((row) => row.request.id)).toEqual(["near"]);
		await create("obsolete");
		sqlite.exec(
			"UPDATE work_items SET disposition='completed' WHERE id='work'",
		);
		expect(
			await flushWorkInteractionDigests(db, "2026-10-17T08:00:00.000Z"),
		).toMatchObject({ suppressed: 1, digests: 0 });
	});
	it("uses four-hour daytime windows and leaves actual asks actionable", async () => {
		const { create, inbox } = fixture();
		expect(nextInteractionDigestAt("2026-10-17T08:01:00.000Z")).toBe(
			"2026-10-17T12:00:00.000Z",
		);
		await create("ask", { kind: "question" });
		expect((await inbox()).data[0]!.request.id).toBe("ask");
	});
});
