import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { schemaDdl } from "../test/schema-ddl";
import { createD1Facade } from "../test/d1-facade";
import {
	osShareLinks,
	osShareSessions,
	osReviewBatches,
	osReviewFeedback,
} from "../schema/os-shares";
import { osGadgets } from "../schema/os-workspaces";
import {
	createOsReviewBatch,
	getOsReviewBatch,
	listOsReviewFeedback,
	saveOsReviewFeedback,
} from "./os-review-batches";
const now = "2026-10-06T12:00:00.000Z";
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			osShareLinks,
			osShareSessions,
			osReviewBatches,
			osReviewFeedback,
			osGadgets,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(osGadgets).values({
		id: "gadget",
		organizationId: "org",
		workspaceId: "workspace",
		name: "Review",
		createdByKind: "user",
		createdById: "owner",
		status: "active",
	});
	await db.insert(osShareLinks).values({
		id: "share",
		organizationId: "org",
		resourceType: "gadget",
		resourceId: "gadget",
		tokenHash: "linkhash",
		role: "use",
		createdByKind: "user",
		createdById: "owner",
	});
	await db.insert(osShareSessions).values({
		id: "session",
		shareLinkId: "share",
		sessionTokenHash: "sessionhash",
		expiresAt: "2026-10-07T12:00:00.000Z",
	});
	const batch = {
		id: "batch",
		organizationId: "org",
		shareLinkId: "share",
		sourceOutputId: "output",
		sourceRevisionId: "revision",
		title: "Review batch",
		cards: JSON.stringify([{ id: "card" }]),
		accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
		createdById: "owner",
		createdAt: now,
	};
	const params = {
		organizationId: "org",
		shareId: "share",
		sessionHash: "sessionhash",
		batchId: "batch",
		cardId: "card",
		reviewerId: "reviewer",
		expectedRevision: 0,
		decision: "edit" as const,
		editedReply: "Useful reply",
		reason: "Check price",
		now,
	};
	return { db, sqlite, batch, params };
}
describe("bounded review persistence", () => {
	it("pins one immutable batch and preserves source provenance", async () => {
		const { db, batch } = await fixture();
		expect(await createOsReviewBatch(db, batch, now)).toMatchObject(batch);
		expect(
			await createOsReviewBatch(
				db,
				{ ...batch, id: "second", cards: "[]" },
				now,
			),
		).toBeUndefined();
		expect(await getOsReviewBatch(db, "other-org", "share")).toBeUndefined();
		expect(await getOsReviewBatch(db, "org", "share")).toMatchObject({
			cards: batch.cards,
		});
	});
	it("keeps reviewers separate and rejects stale writes without changing research", async () => {
		const { db, batch, params } = await fixture();
		await createOsReviewBatch(db, batch, now);
		expect(await saveOsReviewFeedback(db, params)).toMatchObject({
			revision: 1,
			reviewerId: "reviewer",
		});
		expect(await saveOsReviewFeedback(db, params)).toBeUndefined();
		expect(
			await saveOsReviewFeedback(db, {
				...params,
				expectedRevision: 1,
				decision: "skip",
			}),
		).toMatchObject({ revision: 2, decision: "skip" });
		await saveOsReviewFeedback(db, { ...params, reviewerId: "other" });
		expect(
			await listOsReviewFeedback(db, "org", "batch", "reviewer"),
		).toHaveLength(1);
		expect(await listOsReviewFeedback(db, "org", "batch")).toHaveLength(2);
		expect(await listOsReviewFeedback(db, "other-org", "batch")).toHaveLength(
			0,
		);
		expect(await getOsReviewBatch(db, "org", "share")).toMatchObject({
			cards: batch.cards,
			sourceRevisionId: "revision",
		});
	});
	for (const [name, mutation] of [
		[
			"revoked link",
			"UPDATE os_share_links SET revoked_at='2026-10-06T11:00:00.000Z'",
		],
		[
			"expired link",
			"UPDATE os_share_links SET expires_at='2026-10-06T11:00:00.000Z'",
		],
		[
			"revoked session",
			"UPDATE os_share_sessions SET revoked_at='2026-10-06T11:00:00.000Z'",
		],
		[
			"expired session",
			"UPDATE os_share_sessions SET expires_at='2026-10-06T11:00:00.000Z'",
		],
		["narrowed policy", "UPDATE os_share_links SET policy_max_role='viewer'"],
		["archived gadget", "UPDATE os_gadgets SET status='archived'"],
	] as const) {
		it(`atomically refuses insert and update after ${name}`, async () => {
			const { db, sqlite, batch, params } = await fixture();
			await createOsReviewBatch(db, batch, now);
			await saveOsReviewFeedback(db, params);
			sqlite.exec(mutation);
			expect(
				await saveOsReviewFeedback(db, { ...params, reviewerId: "new" }),
			).toBeUndefined();
			expect(
				await saveOsReviewFeedback(db, { ...params, expectedRevision: 1 }),
			).toBeUndefined();
			expect(
				(await listOsReviewFeedback(db, "org", "batch"))[0]?.revision,
			).toBe(1);
		});
	}
	it("rejects a foreign tenant, session, share, card or batch", async () => {
		const { db, batch, params } = await fixture();
		await createOsReviewBatch(db, batch, now);
		for (const patch of [
			{ organizationId: "other" },
			{ sessionHash: "foreign" },
			{ shareId: "foreign" },
			{ cardId: "missing" },
			{ batchId: "foreign" },
		])
			expect(
				await saveOsReviewFeedback(db, { ...params, ...patch }),
			).toBeUndefined();
	});
	it("refuses batch approval after revocation, expiry or from another owner", async () => {
		for (const mutation of [
			"UPDATE os_share_links SET revoked_at='2026-10-06T11:00:00.000Z'",
			"UPDATE os_share_links SET expires_at='2026-10-06T11:00:00.000Z'",
			"UPDATE os_share_links SET created_by_id='someone-else'",
		]) {
			const { db, sqlite, batch } = await fixture();
			sqlite.exec(mutation);
			expect(await createOsReviewBatch(db, batch, now)).toBeUndefined();
		}
	});
});
