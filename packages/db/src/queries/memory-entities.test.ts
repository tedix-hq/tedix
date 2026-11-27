import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { coreTable } from "../core-store/client";
import { memoryFacts } from "../schema/memory-graph";
import { memoryEntityAliases } from "../schema/memory-entities";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	createMemoryEntity,
	getCurrentMemoryEntityResolution,
	getMemoryEntity,
	getMemoryEntityResolutionDecision,
	getMemoryEntityMentionState,
	listMemoryEntityCandidates,
	listRecentPeopleFacts,
	listMemoryEntityResolutionDecisions,
	type MemoryEntityGovernanceError,
	proposeMemoryEntityResolution,
	proposeMemoryEntityResolutionRollback,
	recordMemoryEntityMention,
	reviewMemoryEntityResolutionProposal,
} from "./memory-entities";

async function fixture(store: "d1" | "postgres") {
	let db: DbClient;
	if (store === "d1") {
		const sqlite = createMigratedSqlite();
		onTestFinished(() => sqlite.close());
		db = createDbClient(createD1Facade(sqlite));
	} else {
		const fixture = await createPGliteFacade();
		onTestFinished(fixture.close);
		db = fixture.db;
		for (const migration of readMigrationFiles({
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle-pg", import.meta.url),
			),
		}))
			for (const ddl of migration.sql) await fixture.engine.exec(ddl);
	}
	await db.run(
		sql`INSERT INTO organizations(id, name, slug) VALUES ('org-1', 'Org', 'org-1')`,
	);
	return { db };
}

const T0 = "2026-07-26T12:00:00.000Z";
const T1 = "2026-07-26T12:01:00.000Z";
const T2 = "2026-07-26T12:02:00.000Z";
const T3 = "2026-07-26T12:03:00.000Z";
const T4 = "2026-07-26T12:04:00.000Z";
const T5 = "2026-07-26T12:05:00.000Z";

async function seedMention(
	db: ReturnType<typeof createDbClient>,
	id = "mention-1",
	createdAt = T0,
) {
	return recordMemoryEntityMention(db, {
		id,
		organizationId: "org-1",
		occurrenceKey: `doc:1:12:16:${id}`,
		sourceUri: "doc://architecture.md",
		sourceContentHash: "sha256:source",
		surfaceForm: "Cloudflare",
		proposedType: "organization",
		charStart: 12,
		charEnd: 22,
		extractor: "context-core",
		extractorVersion: "2",
		modelId: "gpt-test",
		harnessVersionId: "harness-1",
		confidence: 0.91,
		evidence: { excerpt: "Cloudflare Workers" },
		createdAt,
	});
}

const stores = ["d1", "postgres"] as const;

describe.each(stores)("entity evidence (%s)", (store) => {
	it("keeps mentions immutable and idempotent", async () => {
		const { db } = await fixture(store);
		const first = await seedMention(db);
		const second = await seedMention(db, first.id, T1);
		expect(second).toEqual(first);
		expect(second.createdAt).toBe(T0);

		await expect(
			db.run(
				sql`UPDATE memory_entity_mentions SET surface_form = 'Changed' WHERE id = ${first.id}`,
			),
		).rejects.toMatchObject(
			store === "d1"
				? { cause: { message: expect.stringMatching(/immutable/) } }
				: { message: expect.stringMatching(/immutable/) },
		);
		await expect(
			recordMemoryEntityMention(db, {
				id: first.id,
				organizationId: "org-1",
				occurrenceKey: first.occurrenceKey,
				sourceUri: "doc://architecture.md",
				sourceContentHash: "sha256:source",
				surfaceForm: "Different",
				proposedType: "organization",
				charStart: 12,
				charEnd: 22,
				extractor: "context-core",
				extractorVersion: "2",
				modelId: "gpt-test",
				harnessVersionId: "harness-1",
				confidence: 0.91,
				evidence: { excerpt: "Cloudflare Workers" },
				createdAt: T0,
			}),
		).rejects.toMatchObject<Partial<MemoryEntityGovernanceError>>({
			reason: "immutable_mention_conflict",
		});
	});

	it("finds bounded exact candidates across canonical names and confirmed aliases", async () => {
		const { db } = await fixture(store);
		const entity = await createMemoryEntity(db, {
			id: "entity-cf",
			organizationId: "org-1",
			entityType: "organization",
			displayName: "Cloudflare, Inc.",
			now: T0,
		});
		await expect(
			createMemoryEntity(db, {
				id: "entity-cf",
				organizationId: "org-1",
				entityType: "organization",
				displayName: "Cloudflare, Inc.",
				now: T0,
			}),
		).resolves.toEqual(entity);
		expect(
			await db.all(
				sql`SELECT event_id FROM graph_projection_outbox WHERE entity_kind = 'entity' AND entity_id = 'entity-cf'`,
			),
		).toHaveLength(1);
		await db.insert(coreTable(db, memoryEntityAliases)).values({
			id: "alias-cf",
			organizationId: "org-1",
			entityId: "entity-cf",
			surfaceForm: "Cloudflare",
			normalizedForm: "cloudflare",
			aliasKind: "synonym",
			locale: "und",
			confidence: 1,
			reviewStatus: "confirmed",
			validFrom: T0,
			createdAt: T0,
		});
		const candidates = await listMemoryEntityCandidates(db, {
			organizationId: "org-1",
			surface: "  CLOUDFLARE ",
			limit: 10,
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			matchedBy: "alias",
			aliasId: "alias-cf",
			entity: { id: "entity-cf" },
		});
		expect(
			await listMemoryEntityCandidates(db, {
				organizationId: "org-1",
				surface: "Cloudflare, Inc.",
			}),
		).toEqual([{ entity, matchedBy: "canonical", aliasId: null }]);
		expect(
			await listMemoryEntityCandidates(db, {
				organizationId: "other",
				surface: "Cloudflare",
			}),
		).toEqual([]);
		expect(
			await getMemoryEntity(db, {
				organizationId: "other",
				entityId: entity.id,
			}),
		).toBeNull();
		expect(
			await getMemoryEntity(db, {
				organizationId: "org-1",
				entityId: entity.id,
			}),
		).toEqual(entity);
	});
});

describe.each(stores)("temporal resolution (%s)", (store) => {
	it("enforces independent review, CAS, temporal reassignment, and append-only rollback", async () => {
		const { db } = await fixture(store);
		await createMemoryEntity(db, {
			id: "entity-a",
			organizationId: "org-1",
			entityType: "organization",
			displayName: "Acme",
			now: T0,
		});
		await createMemoryEntity(db, {
			id: "entity-b",
			organizationId: "org-1",
			entityType: "organization",
			displayName: "Acme Labs",
			now: T0,
		});
		await seedMention(db);

		const first = await proposeMemoryEntityResolution(db, {
			id: "decision-1",
			organizationId: "org-1",
			clientProposalKey: "proposal-1",
			mentionId: "mention-1",
			targetEntityId: "entity-a",
			confidence: 0.9,
			rationale: "Exact source identity",
			proposedBy: { type: "external_agent", id: "codex-1" },
			proposedAt: T1,
		});
		await expect(
			reviewMemoryEntityResolutionProposal(db, {
				organizationId: "org-1",
				decisionId: first.id,
				expectedDecisionVersion: 0,
				outcome: "accept",
				reviewer: { type: "external_agent", id: "codex-1" },
				reviewRationale: "self review",
				resolutionId: "resolution-1",
				reviewedAt: T2,
			}),
		).rejects.toMatchObject<Partial<MemoryEntityGovernanceError>>({
			reason: "reviewer_not_independent",
		});
		await reviewMemoryEntityResolutionProposal(db, {
			organizationId: "org-1",
			decisionId: first.id,
			expectedDecisionVersion: 0,
			outcome: "accept",
			reviewer: { type: "tedi", id: "cto" },
			reviewRationale: "Source confirms identity",
			resolutionId: "resolution-1",
			reviewedAt: T2,
		});

		const second = await proposeMemoryEntityResolution(db, {
			id: "decision-2",
			organizationId: "org-1",
			clientProposalKey: "proposal-2",
			mentionId: "mention-1",
			targetEntityId: "entity-b",
			confidence: 0.82,
			rationale: "Later evidence disambiguates the subsidiary",
			proposedBy: { type: "external_agent", id: "codex-1" },
			proposedAt: T3,
		});
		await reviewMemoryEntityResolutionProposal(db, {
			organizationId: "org-1",
			decisionId: second.id,
			expectedDecisionVersion: 0,
			outcome: "accept",
			reviewer: { type: "tedi", id: "cto" },
			reviewRationale: "Corroborated by source",
			resolutionId: "resolution-2",
			reviewedAt: T4,
		});

		const rollback = await proposeMemoryEntityResolutionRollback(db, {
			id: "decision-3",
			organizationId: "org-1",
			clientProposalKey: "rollback-2",
			rollbackOfDecisionId: second.id,
			rationale: "Disambiguating source was retracted",
			proposedBy: { type: "user", id: "owner-1" },
			proposedAt: T4,
		});
		await reviewMemoryEntityResolutionProposal(db, {
			organizationId: "org-1",
			decisionId: rollback.id,
			expectedDecisionVersion: 0,
			outcome: "accept",
			reviewer: { type: "tedi", id: "cto" },
			reviewRationale: "Retraction verified",
			resolutionId: "resolution-3",
			reviewedAt: T5,
		});

		const current = await getCurrentMemoryEntityResolution(db, {
			organizationId: "org-1",
			mentionId: "mention-1",
		});
		expect(current).toMatchObject({
			id: "resolution-3",
			entityId: "entity-a",
			decisionId: "decision-3",
			status: "active",
		});
		const state = await getMemoryEntityMentionState(db, {
			organizationId: "org-1",
			mentionId: "mention-1",
		});
		expect(state?.head).toMatchObject({
			version: 3,
			currentResolutionId: "resolution-3",
			currentEntityId: "entity-a",
			lastDecisionId: "decision-3",
		});
		const temporal = await db.all(
			sql`SELECT id, entity_id, status, valid_from, valid_to FROM memory_entity_resolutions ORDER BY valid_from`,
		);
		expect(temporal).toEqual([
			expect.objectContaining({
				id: "resolution-1",
				entity_id: "entity-a",
				status: "revoked",
				valid_to: T4,
			}),
			expect.objectContaining({
				id: "resolution-2",
				entity_id: "entity-b",
				status: "revoked",
				valid_to: T5,
			}),
			expect.objectContaining({
				id: "resolution-3",
				entity_id: "entity-a",
				status: "active",
				valid_to: null,
			}),
		]);
		const decisions = await listMemoryEntityResolutionDecisions(db, {
			organizationId: "org-1",
			mentionId: "mention-1",
		});
		expect(decisions.map((decision) => decision.status)).toEqual([
			"accepted",
			"accepted",
			"accepted",
		]);
		expect(decisions[2]?.rollbackOfDecisionId).toBe("decision-2");
		await expect(
			db.run(
				sql`UPDATE memory_entity_resolution_decisions SET rationale = 'rewrite' WHERE id = 'decision-2'`,
			),
		).rejects.toMatchObject(
			store === "d1"
				? {
						cause: {
							message: expect.stringMatching(/terminal.*immutable/),
						},
					}
				: { message: expect.stringMatching(/terminal.*immutable/) },
		);

		const projectionEvents = await db.all(
			sql`SELECT entity_kind, entity_id, operation FROM graph_projection_outbox ORDER BY sequence`,
		);
		expect(projectionEvents).toEqual([
			{ entity_kind: "entity", entity_id: "entity-a", operation: "upsert" },
			{ entity_kind: "entity", entity_id: "entity-b", operation: "upsert" },
			{
				entity_kind: "entity_resolution",
				entity_id: "resolution-1",
				operation: "upsert",
			},
			{
				entity_kind: "entity_resolution",
				entity_id: "resolution-1",
				operation: "delete",
			},
			{
				entity_kind: "entity_resolution",
				entity_id: "resolution-2",
				operation: "upsert",
			},
			{
				entity_kind: "entity_resolution",
				entity_id: "resolution-2",
				operation: "delete",
			},
			{
				entity_kind: "entity_resolution",
				entity_id: "resolution-3",
				operation: "upsert",
			},
		]);
		const revokeEvents = await db.all<{
			entity_id: string;
			payload: string | Record<string, unknown>;
		}>(
			sql`SELECT entity_id, payload FROM graph_projection_outbox WHERE entity_kind = 'entity_resolution' AND operation = 'delete' ORDER BY sequence`,
		);
		expect(
			revokeEvents.map((event) => ({
				entityId: event.entity_id,
				payload:
					typeof event.payload === "string"
						? JSON.parse(event.payload)
						: event.payload,
			})),
		).toEqual([
			{
				entityId: "resolution-1",
				payload: expect.objectContaining({ validTo: T4 }),
			},
			{
				entityId: "resolution-2",
				payload: expect.objectContaining({ validTo: T5 }),
			},
		]);
	});

	it("loses a stale competing CAS without accepting or changing the head", async () => {
		const { db } = await fixture(store);
		await createMemoryEntity(db, {
			id: "entity-a",
			organizationId: "org-1",
			entityType: "organization",
			displayName: "Acme",
			now: T0,
		});
		await createMemoryEntity(db, {
			id: "entity-b",
			organizationId: "org-1",
			entityType: "organization",
			displayName: "Acme Alt",
			now: T0,
		});
		await seedMention(db);
		const [left, right] = await Promise.all([
			proposeMemoryEntityResolution(db, {
				id: "decision-left",
				organizationId: "org-1",
				clientProposalKey: "left",
				mentionId: "mention-1",
				targetEntityId: "entity-a",
				confidence: 0.8,
				rationale: "candidate A",
				proposedBy: { type: "external_agent", id: "agent-left" },
				proposedAt: T1,
			}),
			proposeMemoryEntityResolution(db, {
				id: "decision-right",
				organizationId: "org-1",
				clientProposalKey: "right",
				mentionId: "mention-1",
				targetEntityId: "entity-b",
				confidence: 0.8,
				rationale: "candidate B",
				proposedBy: { type: "external_agent", id: "agent-right" },
				proposedAt: T1,
			}),
		]);
		await reviewMemoryEntityResolutionProposal(db, {
			organizationId: "org-1",
			decisionId: left.id,
			expectedDecisionVersion: 0,
			outcome: "accept",
			reviewer: { type: "tedi", id: "cto" },
			reviewRationale: "A wins",
			resolutionId: "resolution-left",
			reviewedAt: T2,
		});
		await expect(
			reviewMemoryEntityResolutionProposal(db, {
				organizationId: "org-1",
				decisionId: right.id,
				expectedDecisionVersion: 0,
				outcome: "accept",
				reviewer: { type: "tedi", id: "cto" },
				reviewRationale: "stale",
				resolutionId: "resolution-right",
				reviewedAt: T3,
			}),
		).rejects.toMatchObject<Partial<MemoryEntityGovernanceError>>({
			reason: "state_changed",
		});
		const decisions = await listMemoryEntityResolutionDecisions(db, {
			organizationId: "org-1",
			mentionId: "mention-1",
		});
		expect(
			decisions.find((decision) => decision.id === "decision-right")?.status,
		).toBe("proposed");
		expect(
			(
				await getCurrentMemoryEntityResolution(db, {
					organizationId: "org-1",
					mentionId: "mention-1",
				})
			)?.entityId,
		).toBe("entity-a");
		const rejection = {
			organizationId: "org-1",
			decisionId: right.id,
			expectedDecisionVersion: 0,
			outcome: "reject" as const,
			reviewer: { type: "tedi" as const, id: "cto" },
			reviewRationale: "Candidate A was confirmed",
			reviewedAt: T4,
		};
		expect(
			await reviewMemoryEntityResolutionProposal(db, rejection),
		).toMatchObject({
			decision: { status: "rejected", version: 1 },
			resolution: null,
			idempotent: false,
		});
		expect(
			await reviewMemoryEntityResolutionProposal(db, rejection),
		).toMatchObject({ decision: { status: "rejected" }, idempotent: true });
		expect(
			await getMemoryEntityResolutionDecision(db, {
				organizationId: "org-1",
				decisionId: right.id,
			}),
		).toMatchObject({ status: "rejected" });
		expect(
			await getMemoryEntityResolutionDecision(db, {
				organizationId: "other",
				decisionId: right.id,
			}),
		).toBeNull();
	});
});

it("keeps Postgres people recall tenant scoped, recent and bounded", async () => {
	const { db } = await fixture("postgres");
	await db.run(
		sql`INSERT INTO organizations(id, name, slug) VALUES ('org-2', 'Other', 'other')`,
	);
	const facts = coreTable(db, memoryFacts);
	await db.insert(facts).values([
		{
			id: "person",
			organizationId: "org-1",
			content: "Ada",
			factType: "technical",
			updatedAt: T2,
		},
		{
			id: "old",
			organizationId: "org-1",
			content: "Old",
			factType: "technical",
			updatedAt: T0,
		},
		{
			id: "tool",
			organizationId: "org-1",
			content: "Tool",
			factType: "technical",
			updatedAt: T2,
		},
		{
			id: "foreign",
			organizationId: "org-2",
			content: "Foreign",
			factType: "technical",
			updatedAt: T3,
		},
	]);
	for (const [id, organizationId, proposedType] of [
		["person", "org-1", "person"],
		["old", "org-1", "person"],
		["tool", "org-1", "tool"],
		["foreign", "org-2", "person"],
	] as const) {
		await recordMemoryEntityMention(db, {
			id: `mention-${id}`,
			organizationId,
			occurrenceKey: id,
			sourceFactId: id,
			surfaceForm: id,
			proposedType,
			extractor: "fixture",
			extractorVersion: "1",
			confidence: 1,
			createdAt: T3,
		});
	}
	await expect(
		recordMemoryEntityMention(db, {
			id: "wrong-org",
			organizationId: "org-2",
			occurrenceKey: "wrong-org",
			sourceFactId: "person",
			surfaceForm: "Ada",
			proposedType: "person",
			extractor: "fixture",
			extractorVersion: "1",
			confidence: 1,
			createdAt: T3,
		}),
	).rejects.toMatchObject({ reason: "source_fact_not_found" });
	const scope = { organizationId: "org-1", since: T1 };
	expect(
		(await listRecentPeopleFacts(db, scope)).map((fact) => fact.id),
	).toEqual(["person"]);
	await db.insert(facts).values(
		Array.from({ length: 50 }, (_, index) => ({
			id: `newer-${index}`,
			organizationId: "org-1",
			content: "Newer fact",
			factType: "technical" as const,
			updatedAt: T4,
		})),
	);
	expect(await listRecentPeopleFacts(db, scope)).toEqual([]);
});
