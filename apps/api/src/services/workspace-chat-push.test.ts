import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { savePushConfig } from "@tedix/db/queries/web-push";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
} from "@tedix/db/schema/os-collaborators";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { userConfigs } from "@tedix/db/schema/user-configs";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceFeedLedger,
} from "@tedix/db/schema/workspace-feed";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { workspaceUnreadRouter } from "../rpc/routers/workspace-unread";
import { userContext } from "../rpc/test-context";

vi.mock("@block65/webcrypto-web-push", () => ({
	buildPushPayload: vi.fn(async (message: { data: string }) => ({
		method: "POST",
		body: message.data,
	})),
}));

const WS = "00000000-0000-4000-8000-0000000000a1";
const CHAT = "chat-1";
const databases: DatabaseSync[] = [];
const sent: Array<{ endpoint: string; payload: Record<string, string> }> = [];
beforeEach(() => {
	sent.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (endpoint: string, init: { body: string }) => {
			sent.push({ endpoint, payload: JSON.parse(init.body) });
			return new Response(null, { status: 201 });
		}),
	);
});
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
	vi.unstubAllGlobals();
});

async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			userConfigs,
			organizationMembers,
			osWorkspaces,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			workspaceActivity,
			workspaceFeedCursors,
			workspaceFeedLedger,
		),
	);
	const d1 = createD1Facade(sqlite);
	const db = createDbClient(d1);
	const now = "2026-11-12T09:00:00.000Z";
	await db.insert(osWorkspaces).values({
		id: WS,
		organizationId: "org-a",
		name: "Launch",
		createdByKind: "user",
		createdById: "ada",
		createdAt: now,
		updatedAt: now,
	} as typeof osWorkspaces.$inferInsert);
	for (const name of ["ada", "ben", "cy", "dee"])
		await db.insert(organizationMembers).values({
			id: `member-${name}`,
			organizationId: "org-a",
			userId: name,
			descopeUserId: `descope-${name}`,
			email: `${name}@example.test`,
			name: name[0]!.toUpperCase() + name.slice(1),
			role: "member",
			status: "active",
		} as typeof organizationMembers.$inferInsert);
	for (const name of ["ada", "ben", "cy", "dee"])
		await savePushConfig(
			db,
			{ organizationId: "org-a", userId: name },
			"subscription:device",
			{
				endpoint: `https://fcm.googleapis.com/${name}`,
				expirationTime: null,
				keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
			},
		);
	let seq = 0;
	const post = async (name: string, conversationId = CHAT) => {
		seq += 1;
		const shared = {
			id: `${WS}:${seq}`,
			organizationId: "org-a",
			workspaceId: WS,
			seq,
			kind: "run" as const,
			entityId: `turn-${seq}`,
			revision: 1,
			actorKind: "user" as const,
			actorId: `descope-${name}`,
			changeRecordId: `record-${seq}`,
		};
		await db.insert(workspaceFeedLedger).values({
			...shared,
			summary: JSON.stringify({
				conversationId,
				action: {
					resource: "conversation",
					operation: "turn.started",
					outcome: "applied",
					surface: "workspace_object",
				},
			}),
			at: now,
		});
		await db
			.insert(workspaceActivity)
			.values({ ...shared, occurredAt: now, appliedAt: now });
		await db
			.insert(workspaceFeedCursors)
			.values({
				workspaceId: WS,
				organizationId: "org-a",
				lastSeq: seq,
				appliedAt: now,
				lastEventAt: now,
			})
			.onConflictDoUpdate({
				target: workspaceFeedCursors.workspaceId,
				set: { lastSeq: seq },
			});
	};
	const notify = (name: string, mentionedUserIds: string[] = [], keys = true) =>
		createRouterClient(workspaceUnreadRouter, {
			context: userContext({
				db,
				env: {
					DB: d1,
					...(keys
						? {
								VAPID_PUBLIC_KEY: "public",
								VAPID_PRIVATE_KEY: "private",
								VAPID_SUBJECT: "mailto:push@example.test",
							}
						: {}),
				},
				organizationId: "org-a",
				userId: name,
				sub: `descope-${name}`,
				permissions: ["os:read"],
			}),
		}).notifyChat({ workspaceId: WS, conversationId: CHAT, mentionedUserIds });
	return { db, post, notify };
}

describe("workspace chat push", () => {
	it("notifies people who took part or are mentioned, once, and never the poster", async () => {
		const { post, notify } = await setup();
		await post("ben");
		await post("cy", "another-chat");
		// Not in the feed yet: nothing is sent and the browser may ask again.
		expect(await notify("ada")).toEqual({ status: "pending", notified: 0 });
		await post("ada");
		expect(await notify("ada", ["descope-dee", "descope-ada"])).toEqual({
			status: "sent",
			notified: 2,
		});
		expect(sent.map((entry) => entry.endpoint).sort()).toEqual([
			"https://fcm.googleapis.com/ben",
			"https://fcm.googleapis.com/dee",
		]);
		const byPerson = Object.fromEntries(
			sent.map((entry) => [entry.endpoint.split("/").at(-1), entry.payload]),
		);
		expect(byPerson.ben).toEqual({
			title: "Launch",
			body: "Ada replied in a chat you took part in.",
			url: `/workspace/${WS}?conversation=chat-1&pane=chat`,
			conversationId: `workspace:${WS}`,
			tag: `chat:${WS}:3`,
		});
		expect(byPerson.dee?.body).toBe("Ada mentioned you in the chat.");
		// The same post never notifies twice.
		expect(await notify("ada", ["descope-dee"])).toEqual({
			status: "pending",
			notified: 0,
		});
		expect(sent).toHaveLength(2);
	});

	it("stays quiet for a muted workspace, an open workspace and a private workspace of someone else", async () => {
		const { db, post, notify } = await setup();
		await post("ben");
		await post("cy");
		await post("dee");
		await savePushConfig(
			db,
			{ organizationId: "org-a", userId: "ben" },
			"preferences",
			{ mutedProjectIds: [], mutedWorkspaceIds: [WS] },
		);
		await savePushConfig(
			db,
			{ organizationId: "org-a", userId: "cy" },
			"visible:tab-1",
			{ conversationId: `workspace:${WS}` },
		);
		await post("ada");
		expect(await notify("ada")).toEqual({ status: "sent", notified: 1 });
		expect(sent.map((entry) => entry.endpoint)).toEqual([
			"https://fcm.googleapis.com/dee",
		]);
		await db
			.update(osWorkspaces)
			.set({ visibility: "private", ownerUserId: "descope-ada" });
		await post("ada");
		expect(await notify("ada", ["descope-dee"])).toEqual({
			status: "none",
			notified: 0,
		});
		expect(sent).toHaveLength(1);
	});

	it("does nothing when push is not set up for this installation", async () => {
		const { post, notify } = await setup();
		await post("ben");
		await post("ada");
		expect(await notify("ada", [], false)).toEqual({
			status: "none",
			notified: 0,
		});
		expect(sent).toEqual([]);
	});
});
