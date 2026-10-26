import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { userContext, apiKeyContext } from "../test-context";
import { webPushRouter } from "./web-push";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});
function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(userConfigs, osWorkspaces));
	const db = createDbClient(createD1Facade(sqlite));
	const client = (organizationId = "org-a", userId = "person-a") =>
		createRouterClient(webPushRouter, {
			context: userContext({
				db,
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
});
