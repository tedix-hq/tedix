import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { userConfigs } from "../schema/user-configs";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	savePushConfig,
	listPushConfigs,
	deletePushConfig,
	hasVisiblePushConversation,
} from "./web-push";

describe("push config tenant boundaries", () => {
	it("isolates subscriptions, preferences and deletes by both user and organization", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(userConfigs));
		const db = createDbQueryClient(createD1Facade(sqlite));
		const a = { organizationId: "org-a", userId: "person-a" };
		const b = { organizationId: "org-b", userId: "person-a" };
		const c = { organizationId: "org-a", userId: "person-c" };
		for (const scope of [a, b, c])
			await savePushConfig(db, scope, "subscription:device", {
				endpoint: scope.organizationId,
			});
		await deletePushConfig(db, a, "subscription:device");
		expect(await listPushConfigs(db, a, "subscription:")).toEqual([]);
		expect(await listPushConfigs(db, b, "subscription:")).toHaveLength(1);
		expect(await listPushConfigs(db, c, "subscription:")).toHaveLength(1);
		sqlite.close();
	});
	it("expires visibility leases and clearing one tab does not clear another", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(userConfigs));
		const db = createDbQueryClient(createD1Facade(sqlite));
		const scope = { organizationId: "org-a", userId: "person-a" };
		await savePushConfig(db, scope, "visible:tab-a", {
			conversationId: "chat-a",
		});
		await savePushConfig(db, scope, "visible:tab-b", {
			conversationId: "chat-a",
		});
		await deletePushConfig(db, scope, "visible:tab-a");
		expect(
			await hasVisiblePushConversation(db, scope, "chat-a", Date.now()),
		).toBe(true);
		expect(
			await hasVisiblePushConversation(db, scope, "chat-b", Date.now()),
		).toBe(false);
		expect(
			await hasVisiblePushConversation(
				db,
				{ ...scope, organizationId: "org-b" },
				"chat-a",
				Date.now(),
			),
		).toBe(false);
		expect(
			await hasVisiblePushConversation(
				db,
				scope,
				"chat-a",
				Date.now() + 61_000,
			),
		).toBe(false);
		sqlite.close();
	});
});
