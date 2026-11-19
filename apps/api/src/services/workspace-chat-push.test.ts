import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { savePushConfig } from "@tedix/db/queries/web-push";
import { createDbQueryClient } from "@tedix/db/query-client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
} from "@tedix/db/schema/os-collaborators";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { tedis } from "@tedix/db/schema/tedis";
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
import { pushWaitingWorkspaceApprovals } from "./workspace-approval-push";

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
			tedis,
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
	const post = async (
		name: string,
		conversationId = CHAT,
		actorKind: "user" | "tedi" = "user",
	) => {
		seq += 1;
		const shared = {
			id: `${WS}:${seq}`,
			organizationId: "org-a",
			workspaceId: WS,
			seq,
			kind: "run" as const,
			entityId: `turn-${seq}`,
			revision: 1,
			actorKind,
			actorId: actorKind === "tedi" ? name : `descope-${name}`,
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
	const client = (name: string) =>
		createRouterClient(workspaceUnreadRouter, {
			context: userContext({
				db,
				env: { DB: d1 },
				organizationId: "org-a",
				userId: name,
				sub: `descope-${name}`,
				permissions: ["os:read"],
			}),
		});
	const sweep = () =>
		pushWaitingWorkspaceApprovals(
			{
				db,
				env: {
					DB: d1,
					VAPID_PUBLIC_KEY: "public",
					VAPID_PRIVATE_KEY: "private",
					VAPID_SUBJECT: "mailto:push@example.test",
				} as unknown as CloudflareEnv,
			},
			createDbQueryClient(d1),
			Date.parse(now),
		);
	await db.insert(tedis).values({
		id: "tedi-ada",
		organizationId: "org-a",
		name: "Helper",
		slug: "helper",
		ownerUserId: "descope-ada",
	});
	return { db, post, notify, client, sweep };
}

describe("workspace chat push", () => {
	it("sweeps tedi posts to participants and followers, including an away owner, once", async () => {
		const { post, client, sweep } = await setup();
		await post("ada");
		await post("ben");
		await post("cy", "another-chat");
		await client("dee").setChatNotifications({
			workspaceId: WS,
			conversationId: CHAT,
			on: true,
		});
		await post("tedi-ada", CHAT, "tedi");
		expect(await sweep()).toEqual({ workspaces: 0, notified: 3 });
		expect(
			sent.map((entry) => entry.endpoint.split("/").at(-1)).sort(),
		).toEqual(["ada", "ben", "dee"]);
		expect(sent[0]?.payload).toMatchObject({
			title: "Launch",
			body: "Helper replied in a chat you get notifications for.",
			url: `/workspace/${WS}?conversation=chat-1&pane=chat`,
		});
		expect(await sweep()).toEqual({ workspaces: 0, notified: 0 });
		expect(sent).toHaveLength(3);
	});

	it("keeps tedi messages quiet for a visible owner, muted participant and opted-out follower", async () => {
		const { db, post, client, sweep } = await setup();
		for (const name of ["ada", "ben", "cy"]) await post(name);
		await savePushConfig(
			db,
			{ organizationId: "org-a", userId: "ada" },
			"visible:tab",
			{ conversationId: `workspace:${WS}` },
		);
		await savePushConfig(
			db,
			{ organizationId: "org-a", userId: "ben" },
			"preferences",
			{ mutedProjectIds: [], mutedWorkspaceIds: [WS] },
		);
		await client("cy").setChatNotifications({
			workspaceId: WS,
			conversationId: CHAT,
			on: false,
		});
		await post("tedi-ada", CHAT, "tedi");
		expect(await sweep()).toEqual({ workspaces: 0, notified: 0 });
		expect(sent).toEqual([]);
	});

	it("sweeps several tedi conversations in feed order without skipping an older conversation", async () => {
		const { post, sweep } = await setup();
		await post("ben", "another-chat");
		await post("ben");
		await post("tedi-ada", CHAT, "tedi");
		await post("tedi-ada", "another-chat", "tedi");
		await post("tedi-ada", CHAT, "tedi");
		expect(await sweep()).toEqual({ workspaces: 0, notified: 2 });
		expect(sent.map((entry) => entry.payload.tag)).toEqual([
			`chat:${WS}:4`,
			`chat:${WS}:5`,
		]);
		expect(await sweep()).toEqual({ workspaces: 0, notified: 0 });
	});

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

	it("stays quiet during a timed mute and notifies again once it has ended", async () => {
		const { db, post, notify } = await setup();
		const mute = (until: string) =>
			savePushConfig(
				db,
				{ organizationId: "org-a", userId: "ben" },
				"preferences",
				{
					mutedProjectIds: [],
					mutedWorkspaceIds: [WS],
					mutedWorkspaceUntil: { [WS]: until },
				},
			);
		await post("ben");
		await mute(new Date(Date.now() + 60 * 60_000).toISOString());
		await post("ada");
		expect(await notify("ada")).toEqual({ status: "none", notified: 0 });
		expect(sent).toEqual([]);
		await mute(new Date(Date.now() - 1_000).toISOString());
		await post("ada");
		expect(await notify("ada")).toEqual({ status: "sent", notified: 1 });
		expect(sent.map((entry) => entry.endpoint)).toEqual([
			"https://fcm.googleapis.com/ben",
		]);
	});

	it("leaves out a member who never took part, and tells one who turned the chat on", async () => {
		const { post, notify, client } = await setup();
		await post("ben");
		// Cy is in the workspace but never posted here; Dee asked to be told.
		await post("cy", "another-chat");
		await client("dee").setChatNotifications({
			workspaceId: WS,
			conversationId: CHAT,
			on: true,
		});
		await post("ada");
		expect(await notify("ada")).toEqual({ status: "sent", notified: 2 });
		const byPerson = Object.fromEntries(
			sent.map((entry) => [entry.endpoint.split("/").at(-1), entry.payload]),
		);
		expect(Object.keys(byPerson).sort()).toEqual(["ben", "dee"]);
		expect(byPerson.dee?.body).toBe(
			"Ada replied in a chat you get notifications for.",
		);
	});

	it("stops telling someone who turned the chat off, even when they posted or are mentioned", async () => {
		const { post, notify, client } = await setup();
		await post("ben");
		await post("cy");
		for (const name of ["ben", "cy"])
			await client(name).setChatNotifications({
				workspaceId: WS,
				conversationId: CHAT,
				on: false,
			});
		await post("ada");
		expect(await notify("ada", ["descope-cy"])).toEqual({
			status: "none",
			notified: 0,
		});
		expect(sent).toEqual([]);
	});

	it("counts posting and being mentioned as taking part from then on", async () => {
		const { post, notify, client } = await setup();
		await post("ada");
		await notify("ada", ["descope-dee"]);
		const following = async (name: string) =>
			(await client(name).workspace({ workspaceId: WS }))
				.notifyingConversationIds;
		expect(await following("ada")).toEqual([CHAT]);
		expect(await following("dee")).toEqual([CHAT]);
		expect(await following("cy")).toEqual([]);
		// Dee was only mentioned, and is told about the next reply as well.
		sent.length = 0;
		await post("ben");
		expect(await notify("ben")).toEqual({ status: "sent", notified: 2 });
		expect(sent.map((entry) => entry.endpoint).sort()).toEqual([
			"https://fcm.googleapis.com/ada",
			"https://fcm.googleapis.com/dee",
		]);
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
