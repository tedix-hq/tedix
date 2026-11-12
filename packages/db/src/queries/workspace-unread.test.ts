import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { userConfigs } from "../schema/user-configs";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceFeedLedger,
} from "../schema/workspace-feed";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getWorkspaceReadMarker,
	listWorkspaceFeedPositions,
	listWorkspaceReadMarkers,
	listWorkspaceUnreadFeed,
	listWorkspaceUnreadFeeds,
	parseWorkspaceReadMarker,
	saveWorkspaceReadMarker,
} from "./workspace-unread";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			userConfigs,
			workspaceActivity,
			workspaceFeedCursors,
			workspaceFeedLedger,
		),
	);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

async function event(
	db: ReturnType<typeof setup>["db"],
	row: {
		workspaceId?: string;
		organizationId?: string;
		seq: number;
		kind: "output" | "run" | "memory";
		actorId: string;
		entityId?: string;
	},
) {
	const workspaceId = row.workspaceId ?? "ws-1";
	const shared = {
		id: `${workspaceId}:${row.seq}`,
		organizationId: row.organizationId ?? "org-a",
		workspaceId,
		seq: row.seq,
		kind: row.kind,
		entityId: row.entityId ?? `entity-${row.seq}`,
		revision: 1,
		actorKind: "user" as const,
		actorId: row.actorId,
		changeRecordId: `record-${row.seq}`,
	};
	await db.insert(workspaceFeedLedger).values({
		...shared,
		summary: JSON.stringify({ marker: row.seq }),
		at: "2026-11-12T10:00:00.000Z",
	});
	await db.insert(workspaceActivity).values({
		...shared,
		title: `Title ${row.seq}`,
		occurredAt: "2026-11-12T10:00:00.000Z",
		appliedAt: "2026-11-12T10:00:01.000Z",
	});
}

describe("workspace read markers", () => {
	it("keeps one marker per person, workspace and organization", async () => {
		const { sqlite, db } = setup();
		const a = { organizationId: "org-a", userId: "person-a" };
		await saveWorkspaceReadMarker(db, a, "ws-1", {
			floor: 5,
			chat: 9,
			chats: {},
			files: { old: 3, open: 8 },
		});
		await saveWorkspaceReadMarker(db, a, "ws-1", {
			floor: 6,
			chat: 4,
			chats: {},
			files: { open: 8 },
		});
		await saveWorkspaceReadMarker(
			db,
			{ organizationId: "org-b", userId: "person-a" },
			"ws-1",
			{ floor: 1, chat: 1, chats: {}, files: {} },
		);
		expect(await getWorkspaceReadMarker(db, a, "ws-1")).toEqual({
			floor: 6,
			chat: 6,
			chats: {},
			files: { open: 8 },
		});
		expect([...(await listWorkspaceReadMarkers(db, a)).keys()]).toEqual([
			"ws-1",
		]);
		expect(
			await getWorkspaceReadMarker(
				db,
				{ organizationId: "org-a", userId: "person-b" },
				"ws-1",
			),
		).toBeNull();
		expect(
			(
				sqlite.prepare("SELECT count(*) AS n FROM user_configs").get() as {
					n: number;
				}
			).n,
		).toBe(2);
		sqlite.close();
	});

	it("reads damaged stored values as nothing read", () => {
		expect(parseWorkspaceReadMarker(null)).toEqual({
			floor: 0,
			chat: 0,
			chats: {},
			files: {},
		});
		expect(
			parseWorkspaceReadMarker({ floor: -1, chat: "9", files: { a: 2.5 } }),
		).toEqual({ floor: 0, chat: 0, chats: {}, files: {} });
	});
});

describe("workspace unread feed", () => {
	it("returns other people's file and run rows above the marker, newest first, with run metadata only", async () => {
		const { sqlite, db } = setup();
		await event(db, { seq: 1, kind: "output", actorId: "person-b" });
		await event(db, { seq: 2, kind: "run", actorId: "person-b" });
		await event(db, { seq: 3, kind: "output", actorId: "person-a" });
		await event(db, { seq: 4, kind: "memory", actorId: "person-b" });
		await event(db, { seq: 5, kind: "output", actorId: "person-b" });
		await event(db, {
			seq: 6,
			kind: "output",
			actorId: "person-b",
			organizationId: "org-b",
			workspaceId: "ws-1",
		});
		const params = {
			organizationId: "org-a",
			workspaceId: "ws-1",
			afterSeq: 1,
			readerIds: ["person-a", "descope-a"],
		};
		const rows = await listWorkspaceUnreadFeed(db, params);
		expect(rows.map((row) => [row.seq, row.kind, row.runSummary])).toEqual([
			[5, "output", null],
			[2, "run", JSON.stringify({ marker: 2 })],
		]);
		// The same statement keeps its columns apart inside a batch.
		expect(
			await listWorkspaceUnreadFeeds(db, [params, { ...params, afterSeq: 4 }]),
		).toEqual([rows, rows.slice(0, 1)]);
		sqlite.close();
	});

	it("reads feed positions for the asked workspaces of one organization", async () => {
		const { sqlite, db } = setup();
		await db.insert(workspaceFeedCursors).values([
			{
				workspaceId: "ws-1",
				organizationId: "org-a",
				lastSeq: 7,
				appliedAt: "t",
				lastEventAt: "t",
			},
			{
				workspaceId: "ws-2",
				organizationId: "org-b",
				lastSeq: 9,
				appliedAt: "t",
				lastEventAt: "t",
			},
		]);
		expect(
			await listWorkspaceFeedPositions(db, "org-a", ["ws-1", "ws-2", "ws-3"]),
		).toEqual(new Map([["ws-1", 7]]));
		sqlite.close();
	});
});
