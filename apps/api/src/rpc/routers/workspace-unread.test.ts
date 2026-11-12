import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import {
	osWorkspaceCollaborators,
	osWorkspaceAccessEdges,
} from "@tedix/db/schema/os-collaborators";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { userConfigs } from "@tedix/db/schema/user-configs";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceFeedLedger,
	workspaceOutputIndex,
} from "@tedix/db/schema/workspace-feed";
import { saveWorkspaceReadMarker } from "@tedix/db/queries/workspace-unread";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { apiKeyContext, userContext } from "../test-context";
import { workspaceUnreadRouter } from "./workspace-unread";

const WS = "00000000-0000-4000-8000-0000000000a1";
const PRIVATE = "00000000-0000-4000-8000-0000000000a2";
const FILE = "00000000-0000-4000-8000-0000000000f1";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			userConfigs,
			osWorkspaces,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			workspaceActivity,
			workspaceFeedCursors,
			workspaceFeedLedger,
			workspaceOutputIndex,
		),
	);
	const d1 = createD1Facade(sqlite);
	const db = createDbClient(d1);
	const client = (userId = "person-a", organizationId = "org-a") =>
		createRouterClient(workspaceUnreadRouter, {
			context: userContext({
				db,
				env: { DB: d1 },
				organizationId,
				userId,
				permissions: ["os:read"],
			}),
		});
	let seq = 0;
	const event = async (
		workspaceId: string,
		row: {
			kind: "output" | "run";
			actorId: string;
			actorKind?: "user" | "tedi";
			entityId?: string;
			operation?: string;
		},
	) => {
		seq += 1;
		const shared = {
			id: `${workspaceId}:${seq}`,
			organizationId: "org-a",
			workspaceId,
			seq,
			kind: row.kind,
			entityId: row.entityId ?? `turn-${seq}`,
			revision: 1,
			actorKind: row.actorKind ?? ("user" as const),
			actorId: row.actorId,
			changeRecordId: `record-${seq}`,
		};
		const at = new Date(Date.UTC(2026, 10, 12, 10, 0, seq)).toISOString();
		await db.insert(workspaceFeedLedger).values({
			...shared,
			summary: JSON.stringify(
				row.kind === "run"
					? {
							conversationId: "chat-1",
							action: {
								resource: "conversation",
								operation: row.operation ?? "turn.started",
								outcome: "applied",
								surface: "workspace_object",
								traceId: shared.entityId,
							},
						}
					: {},
			),
			at,
		});
		await db.insert(workspaceActivity).values({
			...shared,
			title: row.kind === "output" ? "Plan" : null,
			occurredAt: at,
			appliedAt: at,
		});
		await db
			.insert(workspaceFeedCursors)
			.values({
				workspaceId,
				organizationId: "org-a",
				lastSeq: seq,
				appliedAt: at,
				lastEventAt: at,
			})
			.onConflictDoUpdate({
				target: workspaceFeedCursors.workspaceId,
				set: { lastSeq: seq },
			});
	};
	return { client, db, event };
}

async function workspaces(db: ReturnType<typeof setup>["db"]) {
	const now = "2026-11-12T09:00:00.000Z";
	await db.insert(osWorkspaces).values([
		{
			id: WS,
			organizationId: "org-a",
			name: "Launch",
			createdByKind: "user",
			createdById: "person-a",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: PRIVATE,
			organizationId: "org-a",
			name: "Private notes",
			visibility: "private",
			ownerUserId: "person-b",
			createdByKind: "user",
			createdById: "person-b",
			createdAt: now,
			updatedAt: now,
		},
	] as (typeof osWorkspaces.$inferInsert)[]);
}

describe("workspace unread API", () => {
	it("shows what others did after the first visit and clears it as the person looks", async () => {
		const { client, db, event } = setup();
		await workspaces(db);
		await event(WS, { kind: "run", actorId: "person-b" });
		// Nothing is unread before the first visit, and the visit starts the marker.
		expect(await client().summary({})).toEqual({ total: 0, workspaces: [] });
		expect(
			await client().markRead({ workspaceId: WS, target: { type: "chat" } }),
		).toMatchObject({ total: 0 });

		await event(WS, { kind: "run", actorId: "person-b" });
		await event(WS, { kind: "run", actorId: "person-a" });
		await event(WS, {
			kind: "run",
			actorId: "tedi-1",
			actorKind: "tedi",
			operation: "turn.finished",
		});
		await event(WS, { kind: "output", actorId: "person-b", entityId: FILE });
		expect(await client().summary({})).toEqual({
			total: 3,
			workspaces: [{ workspaceId: WS, chat: 2, files: 1, total: 3 }],
		});
		expect(await client().workspace({ workspaceId: WS })).toEqual({
			workspaceId: WS,
			chat: 2,
			files: 1,
			total: 3,
			fileIds: [FILE],
			conversations: [{ conversationId: "chat-1", count: 2 }],
		});
		// The other person sees only what they did not do themselves.
		expect(await client("person-b").summary({})).toEqual({
			total: 0,
			workspaces: [],
		});

		expect(
			await client().markRead({
				workspaceId: WS,
				target: { type: "file", outputId: FILE },
			}),
		).toMatchObject({ chat: 2, files: 0 });
		// Looking at another conversation leaves this one unread.
		expect(
			await client().markRead({
				workspaceId: WS,
				target: { type: "chat", conversationId: "chat-2" },
			}),
		).toMatchObject({ chat: 2 });
		expect(
			await client().markRead({
				workspaceId: WS,
				target: { type: "chat", conversationId: "chat-1" },
			}),
		).toMatchObject({ total: 0 });
		await event(WS, { kind: "output", actorId: "person-b", entityId: FILE });
		expect((await client().summary({})).total).toBe(1);
		await client().markAllRead({});
		expect(await client().summary({})).toEqual({ total: 0, workspaces: [] });
	});

	it("lists unread newest first by workspace and names only files the person may open", async () => {
		const { client, db, event } = setup();
		await workspaces(db);
		await client().markRead({ workspaceId: WS, target: { type: "all" } });
		await event(WS, { kind: "output", actorId: "person-b", entityId: FILE });
		await event(WS, { kind: "run", actorId: "person-b" });
		// No current index row: the file cannot be verified, so it is left out.
		let list = await client().list({});
		expect(list.groups).toHaveLength(1);
		expect(list.groups[0]?.items.map((item) => item.kind)).toEqual(["message"]);
		await db.insert(workspaceOutputIndex).values({
			id: `${FILE}:1`,
			organizationId: "org-a",
			workspaceId: WS,
			outputId: FILE,
			revision: 1,
			revisionId: "rev-1",
			isCurrent: 1,
			outputKind: "document",
			title: "Launch plan",
			status: "active",
			outputCreatedByKind: "user",
			outputCreatedById: "person-b",
			outputCreatedAt: "t",
			revisionCreatedByKind: "user",
			revisionCreatedById: "person-b",
			revisionCreatedAt: "t",
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			updatedAt: "t",
		});
		list = await client().list({});
		expect(list).toMatchObject({
			total: 2,
			groups: [
				{
					workspaceId: WS,
					workspaceName: "Launch",
					items: [
						{ kind: "message", conversationId: "chat-1" },
						{ kind: "file", outputId: FILE, title: "Launch plan" },
					],
				},
			],
		});
	});

	it("never reports a workspace the person can no longer see, and refuses machine callers", async () => {
		const { client, db, event } = setup();
		await workspaces(db);
		await expect(
			client().markRead({ workspaceId: PRIVATE, target: { type: "all" } }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// A marker left over from when the workspace was still visible.
		await saveWorkspaceReadMarker(
			db,
			{ organizationId: "org-a", userId: "person-a" },
			PRIVATE,
			{ floor: 0, chat: 0, chats: {}, files: {} },
		);
		await event(PRIVATE, { kind: "run", actorId: "person-b" });
		expect(await client().summary({})).toEqual({ total: 0, workspaces: [] });
		const machine = createRouterClient(workspaceUnreadRouter, {
			context: apiKeyContext({ db, scopes: ["apps:read"] }),
		});
		await expect(machine.summary({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
