import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { projects } from "@tedix/db/schema/projects";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { workItems, workEvents } from "@tedix/db/schema/work-items";
import { agentSessionRequests } from "@tedix/db/schema/agent-session-requests";
import { recordAgentSessionRequests } from "@tedix/db/queries/agent-session-requests";
import { recordRequestFiling } from "@tedix/db/queries/request-filings";
import { upsertUserConfig } from "@tedix/db/queries/user-configs";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { materializeFilingReviews } from "./decision-filing-reviews";

const owner = {
	organizationId: "00000000-0000-4000-8000-000000000001",
	userId: "ada",
};
const projectId = "00000000-0000-4000-8000-000000000002";
const now = "2026-10-17T00:00:00.000Z";

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			projects,
			tediObjectives,
			organizationMembers,
			userConfigs,
			learningInteractionEvents,
			workInteractions,
			workItems,
			workEvents,
			agentSessionRequests,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(projects).values({
		id: projectId,
		orgId: owner.organizationId,
		key: "DOCS",
		name: "Acme Docs",
		createdAt: now,
	});
	await db.insert(organizationMembers).values({
		id: "membership",
		organizationId: owner.organizationId,
		userId: owner.userId,
		descopeUserId: "ada-sub",
		email: "ada@acme.test",
		role: "owner",
		status: "active",
	});
	async function filing(
		text: string,
		confidence: number,
		userId = owner.userId,
	) {
		const [row] = await recordAgentSessionRequests(db, {
			...owner,
			userId,
			harness: "codex",
			sessionKey: "acme-session",
			sourceKey: crypto.randomUUID(),
			sourceAt: now,
			now,
			requests: [{ kind: "request", text }],
		});
		return (await recordRequestFiling(db, {
			...owner,
			userId,
			row: row!,
			projectId,
			by: "auto",
			confidence,
			reason: "The request may fit the docs brief",
			now,
		}))!;
	}
	return { db, sqlite, filing };
}

describe("filing review source", () => {
	it("batches uncertain filings into one expiring FYI per owner per day", async () => {
		const f = await fixture();
		for (let i = 0; i < 25; i++) await f.filing(`Uncertain request ${i}`, 0.4);
		await f.filing("Definitely docs", 0.99);
		await f.filing("Another person's private request", 0.2, "grace");
		await materializeFilingReviews(f.db, owner, now);
		await materializeFilingReviews(f.db, owner, now);
		const rows = await f.db.select().from(workInteractions);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "coordination",
			targetType: "user",
			targetId: owner.userId,
			projectId,
			expiresAt: "2026-10-18T00:00:00.000Z",
		});
		expect(rows[0]!.metadata).toMatchObject({
			source: "request-auto-filing-digest",
			attention: { kind: "fyi" },
		});
		expect(rows[0]!.metadata.decisionDeck).toBeUndefined();
		await materializeFilingReviews(f.db, owner, "2026-10-18T00:00:00.000Z");
		expect(await f.db.select().from(workInteractions)).toHaveLength(2);
	});
	it("respects opt-out and never offers an obsolete auto filing after a correction", async () => {
		const f = await fixture();
		const low = await f.filing("Uncertain request", 0.4);
		await recordRequestFiling(f.db, {
			...owner,
			row: low.row,
			projectId: null,
			by: "correction",
			confidence: 1,
			reason: "Owner corrected it",
			now: "2026-10-17T00:00:02.000Z",
		});
		await materializeFilingReviews(f.db, owner);
		expect(await f.db.select().from(workInteractions)).toHaveLength(0);
		await f.filing("Another uncertain request", 0.4);
		await upsertUserConfig(f.db, {
			userId: owner.userId,
			namespace: `organization:${owner.organizationId}`,
			key: "decision-filing-reviews",
			value: { enabled: false },
		});
		await materializeFilingReviews(f.db, owner);
		expect(await f.db.select().from(workInteractions)).toHaveLength(0);
	});
});
