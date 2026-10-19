import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { workItems } from "@tedix/db/schema/work-items";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { describe, expect, it } from "vite-plus/test";
import { materializeDeadlineDecisions } from "./deadline-decisions";
const orgId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-19T15:00:00Z");
describe("deadline decision producer", () => {
	it("creates one card per owned near deadline and excludes other people, tenants, distant and completed work", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(workItems, workInteractions, organizationMembers));
		const db = createDbQueryClient(createD1Facade(sqlite));
		await db.insert(organizationMembers).values({
			id: "member",
			organizationId: orgId,
			userId: "ada",
			descopeUserId: "ada-sub",
			email: "ada@acme.test",
			role: "owner",
			status: "active",
		});
		const base = {
			orgId,
			title: "Review event video",
			createdAt: now.toISOString(),
			accountableOwnerType: "user" as const,
			accountableOwnerId: "ada",
			deadline: "2026-10-20",
		};
		await db.insert(workItems).values([
			{ ...base, id: "00000000-0000-4000-8000-000000000002" },
			{ ...base, id: "other-owner", accountableOwnerId: "other" },
			{ ...base, id: "other-org", orgId: "other" },
			{ ...base, id: "far", deadline: "2026-11-20" },
			{ ...base, id: "done", disposition: "completed" },
		]);
		expect(
			(await materializeDeadlineDecisions(db, { orgId, userId: "ada" }, now))
				.created,
		).toBe(1);
		expect(
			(await materializeDeadlineDecisions(db, { orgId, userId: "ada" }, now))
				.created,
		).toBe(0);
		const cards = await db.select().from(workInteractions);
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			creatorType: "system",
			targetId: "ada",
			workItemId: "00000000-0000-4000-8000-000000000002",
		});
		expect(cards[0]?.metadata).toMatchObject({
			decisionDeck: { classId: "deadline.owner" },
		});
		sqlite.close();
	});
});
