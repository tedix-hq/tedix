/**
 * `listApprovedAgentLessons` feeds every local agent prompt, so only
 * confirmed, current, org-wide lessons under the topic prefix of one
 * organization may pass.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { memoryFacts } from "../schema/memory-graph";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listApprovedAgentLessons,
	listArchivedLearningFeedLessonsForOwner,
	listStaleLearningFeedLessons,
} from "./memory-graph/agent-lessons";

type Seed = {
	id: string;
	org?: string;
	topicKey?: string | null;
	tediId?: string | null;
	status?: string;
	reviewStatus?: string;
	usePolicy?: string;
	archivedAt?: string | null;
	validTo?: string | null;
	confidence?: number;
	visibility?: string | null;
	ownerUserId?: string;
	lastEventAt?: string;
};

function seed(seeds: Seed[]) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryFacts));
	const insert = sqlite.prepare(`
		INSERT INTO memory_facts
			(id, organization_id, topic_key, tedi_id, content, fact_type, confidence,
			 status, review_status, use_policy, archived_at, valid_to, metadata,
			 visibility)
		VALUES (?, ?, ?, ?, ?, 'preference', ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (const fact of seeds) {
		insert.run(
			fact.id,
			fact.org ?? "org-1",
			fact.topicKey === undefined
				? `learning-feed:decision:tedix:codex:${fact.id}`
				: fact.topicKey,
			fact.tediId ?? null,
			`content ${fact.id}`,
			fact.confidence ?? 0.8,
			fact.status ?? "active",
			fact.reviewStatus ?? "confirmed",
			fact.usePolicy ?? "requires_user_confirmation",
			fact.archivedAt ?? null,
			fact.validTo ?? null,
			JSON.stringify({
				learningFeed: {
					scope: { repo: "tedix" },
					...(fact.ownerUserId ? { ownerUserId: fact.ownerUserId } : {}),
					...(fact.lastEventAt ? { lastEventAt: fact.lastEventAt } : {}),
				},
			}),
			fact.visibility === undefined ? "org" : fact.visibility,
		);
	}
	return createDbClient(createD1Facade(sqlite));
}

describe("listApprovedAgentLessons", () => {
	it("returns only confirmed, current, org-wide lessons under the prefix", async () => {
		const db = seed([
			{ id: "approved", confidence: 0.9 },
			{
				id: "instruction",
				confidence: 0.5,
				usePolicy: "can_use_as_instruction",
			},
			{ id: "pending", status: "probation", reviewStatus: "pending" },
			{ id: "evidence", usePolicy: "can_use_as_evidence" },
			{ id: "barred", usePolicy: "do_not_inject_automatically" },
			{ id: "archived", archivedAt: "2026-10-01" },
			{ id: "superseded", validTo: "2026-10-01", reviewStatus: "superseded" },
			{ id: "tedi-private", tediId: "tedi-1" },
			{ id: "other-topic", topicKey: "org:x.connector.y.state" },
			{ id: "near-prefix", topicKey: "learning-feeds" },
			{ id: "no-topic", topicKey: null },
			{ id: "other-org", org: "org-2" },
		]);
		const rows = await listApprovedAgentLessons(db, "org-1", "learning-feed:");
		expect(rows.map((row) => row.id)).toEqual(["approved", "instruction"]);
		expect(rows[0]!.metadata).toEqual({
			learningFeed: { scope: { repo: "tedix" } },
		});
		expect(
			await listApprovedAgentLessons(db, "org-3", "learning-feed:"),
		).toEqual([]);
	});

	it("delivers a personal lesson only to its owner, also from a tedi brain", async () => {
		const db = seed([
			{ id: "team", confidence: 0.9 },
			{ id: "legacy-private", confidence: 0.85, visibility: null },
			{
				id: "mine",
				confidence: 0.8,
				visibility: "private",
				ownerUserId: "user-a",
			},
			{
				id: "mine-routed",
				confidence: 0.7,
				visibility: "private",
				tediId: "tedi-cto",
				ownerUserId: "user-a",
			},
			{
				id: "theirs",
				confidence: 0.6,
				visibility: "private",
				ownerUserId: "user-b",
			},
			{
				id: "widened",
				confidence: 0.5,
				visibility: "org",
				ownerUserId: "user-b",
			},
		]);
		const ids = async (viewerUserId?: string) =>
			(
				await listApprovedAgentLessons(db, "org-1", "learning-feed:", {
					viewerUserId,
				})
			).map((row) => row.id);
		expect(await ids("user-a")).toEqual([
			"team",
			"legacy-private",
			"mine",
			"mine-routed",
			"widened",
		]);
		expect(await ids("user-b")).toEqual([
			"team",
			"legacy-private",
			"theirs",
			"widened",
		]);
		expect(await ids()).toEqual(["team", "legacy-private", "widened"]);
	});

	it("lists current lessons whose newest decision is older than the cutoff", async () => {
		const db = seed([
			{ id: "old", lastEventAt: "2026-06-01T00:00:00.000Z" },
			{ id: "fresh", lastEventAt: "2026-10-01T00:00:00.000Z" },
			{ id: "undated" },
			{
				id: "old-archived",
				lastEventAt: "2026-06-01T00:00:00.000Z",
				archivedAt: "2026-09-01",
			},
			{
				id: "old-superseded",
				lastEventAt: "2026-06-01T00:00:00.000Z",
				validTo: "2026-09-01",
			},
			{
				id: "old-other-org",
				org: "org-2",
				lastEventAt: "2026-06-01T00:00:00.000Z",
			},
			{
				id: "old-other-topic",
				topicKey: "org:x.state",
				lastEventAt: "2026-06-01T00:00:00.000Z",
			},
		]);
		const rows = await listStaleLearningFeedLessons(
			db,
			"org-1",
			"learning-feed:decision:",
			"2026-07-09T00:00:00.000Z",
		);
		expect(rows.map((row) => row.id)).toEqual(["old"]);
		expect(rows[0]!.reviewStatus).toBe("confirmed");
	});

	it("lists one person's archived lessons", async () => {
		const db = seed([
			{ id: "mine", ownerUserId: "user-1", archivedAt: "2026-09-01" },
			{ id: "mine-current", ownerUserId: "user-1" },
			{ id: "theirs", ownerUserId: "user-2", archivedAt: "2026-09-01" },
			{
				id: "mine-other-org",
				org: "org-2",
				ownerUserId: "user-1",
				archivedAt: "2026-09-01",
			},
		]);
		const rows = await listArchivedLearningFeedLessonsForOwner(
			db,
			"org-1",
			"learning-feed:decision:",
			"user-1",
		);
		expect(rows.map((row) => [row.id, row.content])).toEqual([
			["mine", "content mine"],
		]);
	});
});
