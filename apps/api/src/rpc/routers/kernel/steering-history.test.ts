import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { kernelRuntimeEvents } from "@tedix/db/schema/cognitive-runtime";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { steeringWithdrawalEventId } from "@tedix/db/queries/kernel-runtime-steering";
import { fetchConversationHistory } from "./context-history";
import { excludeWithdrawnSteering } from "./steering-history";
import { listKernelRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";

describe("withdrawn steering history", () => {
	it("retains audit rows while excluding withdrawn text from transcript and future Home model context", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(schemaDdl(kernelRuntimeEvents));
			const db = createDbClient(createD1Facade(sqlite));
			for (const [id, content] of [
				["keep", "Keep this direction"],
				["withdraw", "Do not replay this draft"],
			])
				await db.insert(kernelRuntimeEvents).values({
					id,
					messageId: id,
					organizationId: "org-1",
					conversationId: "home:one",
					kind: "message.received",
					payload: { role: "user", content, metadata: { steeringId: id } },
					createdAt: "2026-10-26T00:00:00Z",
				});
			await db.insert(kernelRuntimeEvents).values({
				id: steeringWithdrawalEventId("org-1", "withdraw"),
				messageId: "withdraw",
				organizationId: "org-1",
				conversationId: "home:one",
				kind: "message.progress",
				payload: { action: "home.steering.withdrawn" },
				createdAt: "2026-10-26T00:00:01Z",
			});
			const audit = await listKernelRuntimeEvents(db, {
				organizationId: "org-1",
				conversationId: "home:one",
			});
			expect(audit).toHaveLength(3);
			expect(
				(await excludeWithdrawnSteering(db, "org-1", "home:one", audit)).map(
					(row) => row.messageId,
				),
			).not.toContain("withdraw");
			const history = await fetchConversationHistory(db, "org-1", "home:one");
			expect(JSON.stringify(history.messages)).toContain("Keep this direction");
			expect(JSON.stringify(history.messages)).not.toContain(
				"Do not replay this draft",
			);
		} finally {
			sqlite.close();
		}
	});
});
