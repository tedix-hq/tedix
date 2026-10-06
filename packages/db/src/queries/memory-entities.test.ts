import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { MEMORY_ENTITY_GOVERNANCE_TRIGGER_SQL } from "../schema/memory-entities";
import { createD1Facade } from "../test/d1-facade";
import {
	createMemoryEntity,
	getCurrentMemoryEntityResolution,
	getMemoryEntityMentionState,
	listMemoryEntityCandidates,
	listMemoryEntityResolutionDecisions,
	type MemoryEntityGovernanceError,
	proposeMemoryEntityResolution,
	proposeMemoryEntityResolutionRollback,
	recordMemoryEntityMention,
	reviewMemoryEntityResolutionProposal,
} from "./memory-entities";

const ENTITY_DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE memory_facts (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id)
);
CREATE TABLE graph_projection_outbox (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	event_id TEXT NOT NULL UNIQUE,
	organization_id TEXT NOT NULL,
	entity_kind TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	operation TEXT NOT NULL,
	payload TEXT,
	schema_version INTEGER NOT NULL DEFAULT 1,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT,
	last_error TEXT,
	poisoned_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE TABLE memory_entities (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	entity_type TEXT NOT NULL,
	display_name TEXT NOT NULL,
	normalized_name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	merged_into_entity_id TEXT REFERENCES memory_entities(id) ON DELETE RESTRICT,
	version INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	CHECK (version >= 0),
	CHECK (
		(status = 'merged' AND merged_into_entity_id IS NOT NULL AND merged_into_entity_id != id)
		OR (status != 'merged' AND merged_into_entity_id IS NULL)
	)
);
CREATE UNIQUE INDEX uniq_memory_entity_org_id
	ON memory_entities (organization_id, id);
CREATE TABLE memory_entity_mentions (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	occurrence_key TEXT NOT NULL,
	source_fact_id TEXT REFERENCES memory_facts(id) ON DELETE RESTRICT,
	source_uri TEXT,
	source_content_hash TEXT,
	source_session_id TEXT,
	source_run_id TEXT,
	surface_form TEXT NOT NULL,
	normalized_form TEXT NOT NULL,
	proposed_type TEXT NOT NULL,
	char_start INTEGER,
	char_end INTEGER,
	extractor TEXT NOT NULL,
	extractor_version TEXT NOT NULL,
	model_id TEXT,
	harness_version_id TEXT,
	confidence REAL NOT NULL,
	evidence TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (organization_id, occurrence_key),
	CHECK (confidence >= 0 AND confidence <= 1),
	CHECK (
		(char_start IS NULL AND char_end IS NULL)
		OR (char_start >= 0 AND char_end > char_start)
	)
);
CREATE TABLE memory_entity_aliases (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE RESTRICT,
	surface_form TEXT NOT NULL,
	normalized_form TEXT NOT NULL,
	alias_kind TEXT NOT NULL,
	locale TEXT NOT NULL DEFAULT 'und',
	confidence REAL NOT NULL,
	review_status TEXT NOT NULL DEFAULT 'pending',
	source_mention_id TEXT REFERENCES memory_entity_mentions(id) ON DELETE RESTRICT,
	valid_from TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	valid_to TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (organization_id, entity_id, normalized_form, locale)
);
CREATE TABLE memory_entity_resolution_heads (
	mention_id TEXT PRIMARY KEY NOT NULL REFERENCES memory_entity_mentions(id) ON DELETE CASCADE,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	version INTEGER NOT NULL DEFAULT 0,
	current_resolution_id TEXT,
	current_entity_id TEXT REFERENCES memory_entities(id) ON DELETE RESTRICT,
	last_decision_id TEXT,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (organization_id, mention_id),
	CHECK (version >= 0),
	CHECK (
		(current_resolution_id IS NULL AND current_entity_id IS NULL AND last_decision_id IS NULL)
		OR (current_resolution_id IS NOT NULL AND last_decision_id IS NOT NULL)
	)
);
CREATE TABLE memory_entity_resolution_decisions (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	client_proposal_key TEXT NOT NULL,
	operation TEXT NOT NULL,
	mention_id TEXT REFERENCES memory_entity_mentions(id) ON DELETE RESTRICT,
	alias_id TEXT REFERENCES memory_entity_aliases(id) ON DELETE RESTRICT,
	source_entity_id TEXT REFERENCES memory_entities(id) ON DELETE RESTRICT,
	target_entity_id TEXT REFERENCES memory_entities(id) ON DELETE RESTRICT,
	status TEXT NOT NULL DEFAULT 'proposed',
	confidence REAL NOT NULL,
	rationale TEXT NOT NULL,
	evidence TEXT NOT NULL DEFAULT '{}',
	proposed_by_type TEXT NOT NULL,
	proposed_by_id TEXT NOT NULL,
	reviewed_by_type TEXT,
	reviewed_by_id TEXT,
	review_rationale TEXT,
	source_run_id TEXT,
	expected_mention_version INTEGER NOT NULL,
	expected_head_decision_id TEXT,
	expected_entity_version INTEGER,
	version INTEGER NOT NULL DEFAULT 0,
	supersedes_decision_id TEXT REFERENCES memory_entity_resolution_decisions(id) ON DELETE RESTRICT,
	rollback_of_decision_id TEXT REFERENCES memory_entity_resolution_decisions(id) ON DELETE RESTRICT,
	inverse TEXT NOT NULL,
	proposed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	reviewed_at TEXT,
	applied_at TEXT,
	UNIQUE (organization_id, client_proposal_key),
	UNIQUE (rollback_of_decision_id),
	CHECK (
		reviewed_by_id IS NULL
		OR reviewed_by_type != proposed_by_type
		OR reviewed_by_id != proposed_by_id
	)
);
CREATE TABLE memory_entity_resolutions (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	mention_id TEXT NOT NULL REFERENCES memory_entity_mentions(id) ON DELETE RESTRICT,
	entity_id TEXT REFERENCES memory_entities(id) ON DELETE RESTRICT,
	decision_id TEXT NOT NULL UNIQUE REFERENCES memory_entity_resolution_decisions(id) ON DELETE RESTRICT,
	resolution_kind TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	confidence REAL NOT NULL,
	valid_from TEXT NOT NULL,
	valid_to TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	CHECK (
		(resolution_kind = 'linked' AND entity_id IS NOT NULL)
		OR (resolution_kind = 'unresolved' AND entity_id IS NULL)
	),
	CHECK (
		(status = 'active' AND valid_to IS NULL)
		OR (status = 'revoked' AND valid_to IS NOT NULL)
	)
);
CREATE UNIQUE INDEX uniq_memory_entity_resolution_active
	ON memory_entity_resolutions (organization_id, mention_id)
	WHERE status = 'active';
`;

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(ENTITY_DDL);
	for (const trigger of MEMORY_ENTITY_GOVERNANCE_TRIGGER_SQL) {
		sqlite.exec(trigger);
	}
	sqlite.prepare("INSERT INTO organizations (id) VALUES (?)").run("org-1");
	const db = createDbClient(createD1Facade(sqlite));
	return { db, sqlite };
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

describe("governed memory entity evidence", () => {
	it("keeps mentions immutable and idempotent", async () => {
		const { db, sqlite } = fixture();
		const first = await seedMention(db);
		const second = await seedMention(db, first.id, T1);
		expect(second).toEqual(first);
		expect(second.createdAt).toBe(T0);

		expect(() =>
			sqlite
				.prepare(
					"UPDATE memory_entity_mentions SET surface_form = 'Changed' WHERE id = ?",
				)
				.run(first.id),
		).toThrow(/immutable/);
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
		const { db, sqlite } = fixture();
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
			sqlite
				.prepare(
					`SELECT COUNT(*) AS count
					 FROM graph_projection_outbox
					 WHERE entity_kind = 'entity' AND entity_id = 'entity-cf'`,
				)
				.get(),
		).toEqual({ count: 1 });
		sqlite
			.prepare(
				`INSERT INTO memory_entity_aliases
				 (id, organization_id, entity_id, surface_form, normalized_form,
				  alias_kind, locale, confidence, review_status, valid_from, created_at)
				 VALUES (?, ?, ?, ?, ?, 'synonym', 'und', 1, 'confirmed', ?, ?)`,
			)
			.run(
				"alias-cf",
				"org-1",
				"entity-cf",
				"Cloudflare",
				"cloudflare",
				T0,
				T0,
			);
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
	});
});

describe("reviewed temporal entity resolution", () => {
	it("enforces independent review, CAS, temporal reassignment, and append-only rollback", async () => {
		const { db, sqlite } = fixture();
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
		const temporal = sqlite
			.prepare(
				`SELECT id, entity_id, status, valid_from, valid_to
				 FROM memory_entity_resolutions ORDER BY valid_from`,
			)
			.all() as Array<Record<string, unknown>>;
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
		expect(() =>
			sqlite
				.prepare(
					"UPDATE memory_entity_resolution_decisions SET rationale = 'rewrite' WHERE id = 'decision-2'",
				)
				.run(),
		).toThrow(/terminal.*immutable/);

		const projectionEvents = sqlite
			.prepare(
				`SELECT entity_kind, entity_id, operation
				 FROM graph_projection_outbox
				 ORDER BY sequence`,
			)
			.all() as Array<Record<string, unknown>>;
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
		const revokeEvents = sqlite
			.prepare(
				`SELECT entity_id, payload
				 FROM graph_projection_outbox
				 WHERE entity_kind = 'entity_resolution'
				   AND operation = 'delete'
				 ORDER BY sequence`,
			)
			.all() as Array<{ entity_id: string; payload: string }>;
		expect(
			revokeEvents.map((event) => ({
				entityId: event.entity_id,
				payload: JSON.parse(event.payload),
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
		const { db } = fixture();
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
	});
});
