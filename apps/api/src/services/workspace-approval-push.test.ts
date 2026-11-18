import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { savePushConfig } from "@tedix/db/queries/web-push";
import { createDbQueryClient } from "@tedix/db/query-client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceShareLinks,
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
import { pushWaitingWorkspaceApprovals } from "./workspace-approval-push";

vi.mock("@block65/webcrypto-web-push", () => ({
	buildPushPayload: vi.fn(async (message: { data: string }) => ({
		method: "POST",
		body: message.data,
	})),
}));

const WS = "00000000-0000-4000-8000-0000000000a1";
const CHAT = "chat-1";
const NOW = Date.parse("2026-11-12T09:00:00.000Z");
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
			osWorkspaceShareLinks,
			workspaceActivity,
			workspaceFeedCursors,
			workspaceFeedLedger,
		),
	);
	const d1 = createD1Facade(sqlite);
	const db = createDbClient(d1);
	const at = new Date(NOW - 30_000).toISOString();
	await db.insert(osWorkspaces).values({
		id: WS,
		organizationId: "org-a",
		name: "Launch",
		createdByKind: "user",
		createdById: "ada",
		createdAt: at,
		updatedAt: at,
	} as typeof osWorkspaces.$inferInsert);
	// Cy only reads in this organization, so cannot decide a change.
	for (const name of ["ada", "ben", "cy"]) {
		await db.insert(organizationMembers).values({
			id: `member-${name}`,
			organizationId: "org-a",
			userId: name,
			descopeUserId: `descope-${name}`,
			email: `${name}@example.test`,
			name,
			role: name === "cy" ? "viewer" : "member",
			status: "active",
		} as typeof organizationMembers.$inferInsert);
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
	}
	let seq = 0;
	/** One feed row, as the workspace records it. */
	const record = async (
		operation: string,
		options: {
			by?: string;
			turn?: string;
			description?: string;
			occurredAt?: string;
		} = {},
	) => {
		seq += 1;
		const shared = {
			id: `${WS}:${seq}`,
			organizationId: "org-a",
			workspaceId: WS,
			seq,
			kind: "run" as const,
			entityId: options.turn ?? "turn-1",
			revision: 1,
			actorKind: options.by ? ("user" as const) : ("service" as const),
			actorId: options.by ? `descope-${options.by}` : "workspace_object",
			changeRecordId: `workspace-event:${seq}`,
		};
		const occurredAt = options.occurredAt ?? at;
		await db.insert(workspaceFeedLedger).values({
			...shared,
			summary: JSON.stringify({
				conversationId: CHAT,
				...(options.description ? { description: options.description } : {}),
				action: {
					resource: "conversation",
					operation,
					outcome: "applied",
					surface: "workspace_object",
				},
			}),
			at: occurredAt,
		});
		await db
			.insert(workspaceActivity)
			.values({ ...shared, occurredAt, appliedAt: at });
		await db
			.insert(workspaceFeedCursors)
			.values({
				workspaceId: WS,
				organizationId: "org-a",
				lastSeq: seq,
				appliedAt: at,
				lastEventAt: occurredAt,
			})
			.onConflictDoUpdate({
				target: workspaceFeedCursors.workspaceId,
				set: { lastSeq: seq, appliedAt: at },
			});
	};
	const sweep = (now = NOW) =>
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
			now,
		);
	const people = () =>
		sent.map((entry) => entry.endpoint.split("/").at(-1)).sort();
	return { db, record, sweep, people };
}

describe("workspace approval push", () => {
	it("tells a person who can decide once, without content, and not someone who cannot", async () => {
		const { record, sweep, people } = await setup();
		await record("turn.started", { by: "ben" });
		await record("turn.started", { by: "cy", turn: "turn-0" });
		await record("approval.requested", { description: "Creating a new app" });
		expect(await sweep()).toEqual({ workspaces: 1, notified: 1 });
		expect(people()).toEqual(["ben"]);
		expect(sent[0]?.payload).toEqual({
			title: "Launch",
			body: "A change is waiting for your approval: Creating a new app.",
			url: `/workspace/${WS}?conversation=chat-1&pane=chat`,
			conversationId: `workspace:${WS}`,
			tag: `approval:${WS}`,
		});
		// The same request is not announced again two minutes later.
		expect(await sweep(NOW + 120_000)).toEqual({ workspaces: 1, notified: 0 });
		expect(sent).toHaveLength(1);
	});

	it("sends nothing for a change that applied at once or was already decided", async () => {
		const { record, sweep } = await setup();
		await record("turn.started", { by: "ben" });
		await record("approval.automatic");
		await record("approval.decided");
		await record("approval.requested", { turn: "turn-2" });
		await record("approval.decided", { by: "ada", turn: "turn-2" });
		expect(await sweep()).toEqual({ workspaces: 0, notified: 0 });
		expect(sent).toHaveLength(0);
	});

	it("still tells about a request that waits beside one applied at once", async () => {
		const { record, sweep, people } = await setup();
		await record("turn.started", { by: "ben" });
		await record("approval.automatic");
		await record("approval.decided");
		await record("approval.requested");
		expect(await sweep()).toEqual({ workspaces: 1, notified: 1 });
		expect(people()).toEqual(["ben"]);
		expect(sent[0]?.payload.body).toBe(
			"A change is waiting for your approval.",
		);
	});

	it("stays quiet for a muted workspace, an open workspace and an old request", async () => {
		const { db, record, sweep, people } = await setup();
		await record("turn.started", { by: "ada" });
		await record("turn.started", { by: "ben" });
		await record("approval.requested");
		await savePushConfig(
			db,
			{ organizationId: "org-a", userId: "ben" },
			"preferences",
			{ mutedProjectIds: [], mutedWorkspaceIds: [WS] },
		);
		await db.insert(userConfigs).values({
			userId: "ada",
			namespace: "os.push:org-a",
			key: "visible:tab",
			value: { conversationId: `workspace:${WS}` },
			updatedAt: new Date(NOW - 5_000).toISOString(),
		} as typeof userConfigs.$inferInsert);
		expect(await sweep()).toEqual({ workspaces: 1, notified: 0 });
		expect(people()).toEqual([]);

		const old = await setup();
		await old.record("turn.started", { by: "ben" });
		await old.record("approval.requested", {
			occurredAt: new Date(NOW - 11 * 60_000).toISOString(),
		});
		expect(await old.sweep()).toEqual({ workspaces: 0, notified: 0 });
	});

	it("sends one push for several requests that wait together", async () => {
		const { record, sweep, people } = await setup();
		await record("turn.started", { by: "ben" });
		for (const description of ["Creating a new app", "Reading a web page"])
			await record("approval.requested", { description });
		await record("approval.requested", { description: "Editing slides" });
		expect(await sweep()).toEqual({ workspaces: 1, notified: 1 });
		expect(people()).toEqual(["ben"]);
		expect(sent[0]?.payload.body).toBe(
			"3 changes are waiting for your approval.",
		);
	});
});
