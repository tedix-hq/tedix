import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { workAttempts } from "../../schema/work-items";
import {
	getAuthoritativeWorkItemAttempt,
	getRecordedWorkItemAttempt,
} from "./attempts";

describe("historical Attempt reads", () => {
	it("reads a settled external Attempt without conferring live authority and keeps tenant and Work fences", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(schemaDdl(workAttempts));
			sqlite.exec(
				"CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org'); CREATE TABLE work_items (id TEXT NOT NULL, org_id TEXT NOT NULL, UNIQUE(org_id,id)); INSERT INTO work_items VALUES ('work','org');",
			);
			const db = createDbQueryClient(createD1Facade(sqlite));
			await db.insert(workAttempts).values({
				id: "attempt",
				orgId: "org",
				workItemId: "work",
				executorType: "external_agent",
				executorId: "agent",
				externalSessionKey: "codex:old",
				runtimeState: "succeeded",
				outcome: "succeeded",
				attemptNumber: 1,
				startedAt: "2026-01-01T00:00:00.000Z",
				heartbeatAt: "2026-01-01T00:00:00.000Z",
				expiresAt: "2026-01-01T01:00:00.000Z",
				finishedAt: "2026-01-01T00:30:00.000Z",
			});
			const scope = { orgId: "org", workItemId: "work", attemptId: "attempt" };
			expect(await getRecordedWorkItemAttempt(db, scope)).toMatchObject({
				id: "attempt",
				outcome: "succeeded",
			});
			expect(
				await getRecordedWorkItemAttempt(db, { ...scope, orgId: "foreign" }),
			).toBeNull();
			expect(
				await getRecordedWorkItemAttempt(db, {
					...scope,
					workItemId: "foreign",
				}),
			).toBeNull();
			await expect(
				getAuthoritativeWorkItemAttempt(db, {
					...scope,
					externalSessionKey: "codex:old",
				}),
			).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
		} finally {
			sqlite.close();
		}
	});
});
