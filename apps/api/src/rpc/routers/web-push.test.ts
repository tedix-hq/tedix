import { auditEvents } from "@tedix/db/schema/audit-events";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { userContext, apiKeyContext } from "../test-context";
import {
	PUSH_DEVICE_CAP,
	PUSH_SUBSCRIBE_LIMIT,
	PUSH_SUBSCRIBE_WINDOW_MS,
	webPushRouter,
} from "./web-push";
import { pushEndpointKey } from "../../services/web-push";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});
function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(userConfigs, osWorkspaces, auditEvents));
	const db = createDbClient(createD1Facade(sqlite));
	const client = (
		organizationId = "org-a",
		userId = "person-a",
		env?: CloudflareEnv,
	) =>
		createRouterClient(webPushRouter, {
			context: userContext({
				db,
				env,
				organizationId,
				userId,
				permissions: ["os:read"],
			}),
		});
	return { client, db };
}
describe("personal Web Push API", () => {
	it("returns disabled without secrets and stores visibility only for the caller's tenant and user", async () => {
		const { client, db } = setup();
		expect(await client().getStatus({})).toEqual({
			enabled: false,
			publicKey: null,
			preferences: { mutedProjectIds: [] },
		});
		const clientId = "00000000-0000-4000-8000-000000000001";
		await client().setVisibility({ clientId, conversationId: "chat-a" });
		await client("org-b").setVisibility({ clientId, conversationId: "chat-b" });
		await client("org-a", "person-b").setVisibility({
			clientId,
			conversationId: "chat-c",
		});
		await client().setVisibility({ clientId, conversationId: null });
		const rows = await db.select().from(userConfigs);
		expect(rows.map((row) => row.value.conversationId).sort()).toEqual([
			"chat-b",
			"chat-c",
		]);
	});
	it("refuses machine principals even when their read scope passes", async () => {
		const { db } = setup();
		const machine = createRouterClient(webPushRouter, {
			context: apiKeyContext({ db, scopes: ["apps:read"] }),
		});
		await expect(machine.getStatus({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			machine.setPreferences({ mutedProjectIds: [] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("stores workspace mutes, keeps them on a project-only write, and rejects unknown ids", async () => {
		const { client, db } = setup();
		const workspaceId = "00000000-0000-4000-8000-000000000010";
		await db.insert(osWorkspaces).values({
			id: workspaceId,
			organizationId: "org-a",
			name: "Ops",
			createdByKind: "user",
			createdById: "person-a",
		});
		expect(
			await client().setPreferences({
				mutedProjectIds: [],
				mutedWorkspaceIds: [workspaceId],
			}),
		).toEqual({ mutedProjectIds: [], mutedWorkspaceIds: [workspaceId] });
		// A stale client that only knows project mutes keeps the saved workspace
		// mutes instead of wiping them.
		expect(await client().setPreferences({ mutedProjectIds: [] })).toEqual({
			mutedProjectIds: [],
			mutedWorkspaceIds: [workspaceId],
		});
		expect((await client().getStatus({})).preferences).toEqual({
			mutedProjectIds: [],
			mutedWorkspaceIds: [workspaceId],
		});
		await expect(
			client().setPreferences({
				mutedProjectIds: [],
				mutedWorkspaceIds: ["00000000-0000-4000-8000-000000000099"],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// A foreign tenant's workspace is not a valid mute target either.
		await expect(
			client("org-b").setPreferences({
				mutedProjectIds: [],
				mutedWorkspaceIds: [workspaceId],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("does not persist a subscription while push is disabled", async () => {
		const { client, db } = setup();
		expect(
			await client().subscribe({
				endpoint: "https://web.push.apple.com/device",
				keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
			}),
		).toEqual({ enabled: false });
		expect(await db.select().from(userConfigs)).toEqual([]);
	});
	it("limits new devices per person and keeps only the newest ones", async () => {
		const { client, db } = setup();
		const env = {
			ENVIRONMENT: "test",
			VAPID_PUBLIC_KEY: "public",
			VAPID_PRIVATE_KEY: "private",
			VAPID_SUBJECT: "mailto:ops@example.test",
		} as unknown as CloudflareEnv;
		const keys = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
		const endpoint = (n: number) => `https://web.push.apple.com/device-${n}`;
		// Eleven devices registered before the window, oldest first.
		const old = Date.now() - PUSH_SUBSCRIBE_WINDOW_MS - 60_000;
		for (let n = 0; n <= PUSH_DEVICE_CAP; n++)
			await db.insert(userConfigs).values({
				id: crypto.randomUUID(),
				userId: "person-a",
				namespace: "os.push:org-a",
				key: await pushEndpointKey(endpoint(n)),
				value: { endpoint: endpoint(n), keys },
				createdAt: new Date(old + n * 1000).toISOString(),
				updatedAt: new Date(old + n * 1000).toISOString(),
			});
		const subscriptionEndpoints = async (userId = "person-a") =>
			(await db.select().from(userConfigs))
				.filter((row) => row.userId === userId)
				.map((row) => row.value.endpoint as string)
				.sort();
		const newest = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, i) =>
				endpoint(from + i),
			).sort();

		for (let n = 100; n < 100 + PUSH_SUBSCRIBE_LIMIT; n++)
			expect(
				await client("org-a", "person-a", env).subscribe({
					endpoint: endpoint(n),
					keys,
				}),
			).toEqual({ enabled: true });
		// The cap holds: the five new devices plus the five newest old ones.
		expect(await subscriptionEndpoints()).toEqual(
			[...newest(100, 104), ...newest(6, 10)].sort(),
		);

		// A sixth new device inside the window is refused and stores nothing.
		await expect(
			client("org-a", "person-a", env).subscribe({
				endpoint: endpoint(200),
				keys,
			}),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
		expect(await subscriptionEndpoints()).not.toContain(endpoint(200));
		// Refreshing an already registered device, new or old, still works.
		for (const n of [100, 10])
			await expect(
				client("org-a", "person-a", env).subscribe({
					endpoint: endpoint(n),
					keys,
				}),
			).resolves.toEqual({ enabled: true });
		expect(await subscriptionEndpoints()).toHaveLength(PUSH_DEVICE_CAP);
		// The limit is per person: a teammate can still register.
		await expect(
			client("org-a", "person-b", env).subscribe({
				endpoint: endpoint(300),
				keys,
			}),
		).resolves.toEqual({ enabled: true });
		expect(await subscriptionEndpoints("person-b")).toEqual([endpoint(300)]);
	});
});
