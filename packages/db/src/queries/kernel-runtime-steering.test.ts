import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { kernelRuntimeEvents } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listWithdrawnSteeringMessageIds,
	steeringWithdrawalEventId,
} from "./kernel-runtime-steering";

describe("steering withdrawal replay", () => {
	it("finds only organization and conversation owned withdrawals across bounded chunks", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(schemaDdl(kernelRuntimeEvents));
			const db = createDbClient(createD1Facade(sqlite));
			const ids = Array.from({ length: 105 }, (_, index) => `message-${index}`);
			for (const messageId of ids)
				await db.insert(kernelRuntimeEvents).values({
					id: steeringWithdrawalEventId("org-1", messageId),
					organizationId: "org-1",
					conversationId: "home:one",
					messageId,
					kind: "message.progress",
					payload: { action: "home.steering.withdrawn" },
					createdAt: "2026-10-26T00:00:00Z",
				});
			expect(
				new Set(
					await listWithdrawnSteeringMessageIds(db, {
						organizationId: "org-1",
						conversationId: "home:one",
						messageIds: ids,
					}),
				),
			).toEqual(new Set(ids));
			expect(
				await listWithdrawnSteeringMessageIds(db, {
					organizationId: "org-2",
					conversationId: "home:one",
					messageIds: ids,
				}),
			).toEqual([]);
			expect(
				await listWithdrawnSteeringMessageIds(db, {
					organizationId: "org-1",
					conversationId: "home:two",
					messageIds: ids,
				}),
			).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});
