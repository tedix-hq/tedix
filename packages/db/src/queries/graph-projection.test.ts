import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import type { GraphProjectionOutboxEvent } from "../schema/graph-projection";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	acquireGraphProjectionLease,
	advanceGraphProjectionCursor,
	coalesceGraphProjectionEvents,
	getGraphProjectionBacklogStats,
	getGraphProjectionCursor,
	listGraphProjectionConsumerHealth,
	getGraphProjectionReadState,
	listGraphProjectionCertificationOrganizations,
	listGraphProjectionOrganizations,
	pruneAcknowledgedGraphProjectionEvents,
	readGraphEdgeBackfillPage,
	readGraphFactBackfillPage,
	readGraphProjectionBatch,
	recordGraphProjectionFailure,
	releaseGraphProjectionLease,
	renewGraphProjectionLease,
	resetGraphProjectionFailure,
	setGraphProjectionReadiness,
} from "./graph-projection";

function createProjectionTables(sqlite: DatabaseSync): void {
	sqlite.exec(`
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
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE graph_projection_consumers (
			organization_id TEXT PRIMARY KEY,
			last_projected_sequence INTEGER NOT NULL DEFAULT 0,
			lease_token TEXT,
			lease_until TEXT,
			last_success_at TEXT,
			last_error TEXT,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE graph_projection_readiness (
			organization_id TEXT PRIMARY KEY,
			state TEXT NOT NULL DEFAULT 'disabled',
			reason TEXT,
			projection_epoch TEXT,
			persisted_watermark INTEGER NOT NULL DEFAULT 0,
			gds_watermark INTEGER NOT NULL DEFAULT 0,
			gds_epoch TEXT,
			node_mismatch_count INTEGER,
			edge_mismatch_count INTEGER,
			lifecycle_mismatch_count INTEGER,
			repair_id TEXT,
			repair_phase TEXT,
			repair_cursor TEXT,
			repair_high_water INTEGER,
			repair_started_at TEXT,
			last_certified_at TEXT,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`);
	// Discovery reads `organizations` to find tenants that have never been
	// leased. Generated from the drizzle table so the fixture cannot drift.
	sqlite.exec(schemaDdl(organizations));
}

function createMemoryTables(sqlite: DatabaseSync): void {
	sqlite.exec(`
		CREATE TABLE memory_domains (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			name TEXT NOT NULL,
			parent_id TEXT,
			description TEXT,
			created_at TEXT
		);
		CREATE TABLE memory_facts (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			domain_id TEXT,
			content TEXT NOT NULL,
			summary TEXT,
			fact_type TEXT NOT NULL,
			confidence REAL NOT NULL DEFAULT 0.8,
			valid_from TEXT,
			valid_to TEXT,
			status TEXT,
			source TEXT,
			source_session_id TEXT,
			source_url TEXT,
			source_hash TEXT,
			embedding_id TEXT,
			topic_key TEXT,
			memory_scope TEXT,
			use_policy TEXT,
			review_status TEXT,
			metadata TEXT,
			priority TEXT,
			visibility TEXT,
			promoted_from TEXT,
			promoted_at TEXT,
			last_verified_at TEXT,
			last_accessed_at TEXT,
			access_count INTEGER NOT NULL DEFAULT 0,
			usage_count INTEGER NOT NULL DEFAULT 0,
			archived_at TEXT,
			created_at TEXT,
			updated_at TEXT
		);
		CREATE TABLE memory_edges (
			id TEXT PRIMARY KEY,
			source_fact_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
			target_fact_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
			relation_type TEXT NOT NULL,
			strength REAL NOT NULL DEFAULT 0.5,
			context TEXT,
			created_at TEXT,
			UNIQUE(source_fact_id, target_fact_id, relation_type)
		);
	`);
}

function insertOutbox(
	sqlite: DatabaseSync,
	input: {
		id: string;
		orgId?: string;
		kind?: GraphProjectionOutboxEvent["entityKind"];
		entityId?: string;
		operation?: GraphProjectionOutboxEvent["operation"];
		createdAt?: string;
		attemptCount?: number;
		nextAttemptAt?: string | null;
		poisonedAt?: string | null;
	},
): number {
	const result = sqlite
		.prepare(`
			INSERT INTO graph_projection_outbox (
				event_id, organization_id, entity_kind, entity_id, operation,
				attempt_count, next_attempt_at, poisoned_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			input.id,
			input.orgId ?? "org-1",
			input.kind ?? "fact",
			input.entityId ?? input.id,
			input.operation ?? "upsert",
			input.attemptCount ?? 0,
			input.nextAttemptAt ?? null,
			input.poisonedAt ?? null,
			input.createdAt ?? "2026-07-01T00:00:00.000Z",
		);
	return Number(result.lastInsertRowid);
}

function event(
	sequence: number,
	kind: GraphProjectionOutboxEvent["entityKind"],
	entityId: string,
	operation: GraphProjectionOutboxEvent["operation"] = "upsert",
): GraphProjectionOutboxEvent {
	return {
		sequence,
		eventId: `event-${sequence}`,
		organizationId: "org-1",
		entityKind: kind,
		entityId,
		operation,
		payload: null,
		schemaVersion: 1,
		attemptCount: 0,
		nextAttemptAt: null,
		lastError: null,
		poisonedAt: null,
		createdAt: "2026-07-01T00:00:00.000Z",
	};
}

describe("graph projection ledger queries", () => {
	it("keeps retry and poison heads visible in strict sequence order", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const first = insertOutbox(sqlite, {
			id: "retry",
			nextAttemptAt: "2099-01-01T00:00:00.000Z",
		});
		const second = insertOutbox(sqlite, {
			id: "poison",
			poisonedAt: "2026-07-01T00:00:00.000Z",
		});
		const rows = await readGraphProjectionBatch(
			createDbClient(createD1Facade(sqlite)),
			"org-1",
			0,
			10,
		);

		expect(rows.map((row) => row.sequence)).toEqual([first, second]);
		expect(rows[0]!.nextAttemptAt).not.toBeNull();
		expect(rows[1]!.poisonedAt).not.toBeNull();
	});

	it("rotates pending organizations fairly and does not hide poison heads", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		insertOutbox(sqlite, {
			id: "org-a-poison",
			orgId: "org-a",
			poisonedAt: "2026-07-01T00:00:00.000Z",
		});
		insertOutbox(sqlite, { id: "org-b-pending", orgId: "org-b" });
		sqlite.exec(`
			INSERT INTO graph_projection_consumers
				(organization_id, last_projected_sequence, updated_at)
			VALUES
				('org-a', 0, '2026-07-02T00:00:00.000Z'),
				('org-b', 0, '2026-07-01T00:00:00.000Z')
		`);

		await expect(
			listGraphProjectionOrganizations(
				createDbClient(createD1Facade(sqlite)),
				10,
			),
		).resolves.toEqual(["org-b", "org-a"]);
	});

	it("discovers a never-leased organization ahead of serviced ones", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		// `acquireGraphProjectionLease` writes the consumer row, and it only runs
		// after discovery -- so a tenant's very first event has no consumer row to
		// join against. Discovery has to reach it through `organizations`.
		insertOutbox(sqlite, { id: "fresh-first-event", orgId: "org-fresh" });
		insertOutbox(sqlite, { id: "served-pending", orgId: "org-served" });
		sqlite.exec(`
			INSERT INTO organizations (id, name, slug)
			VALUES ('org-fresh', 'Fresh', 'fresh'), ('org-served', 'Served', 'served')
		`);
		sqlite.exec(`
			INSERT INTO graph_projection_consumers
				(organization_id, last_projected_sequence, updated_at)
			VALUES ('org-served', 0, '2026-07-01T00:00:00.000Z')
		`);

		await expect(
			listGraphProjectionOrganizations(
				createDbClient(createD1Facade(sqlite)),
				10,
			),
		).resolves.toEqual(["org-fresh", "org-served"]);
	});

	it("omits organizations whose backlog is fully acknowledged", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const acked = insertOutbox(sqlite, { id: "acked", orgId: "org-quiet" });
		insertOutbox(sqlite, { id: "pending", orgId: "org-busy" });
		sqlite.exec(`
			INSERT INTO organizations (id, name, slug)
			VALUES ('org-quiet', 'Quiet', 'quiet'), ('org-busy', 'Busy', 'busy')
		`);
		sqlite.exec(`
			INSERT INTO graph_projection_consumers
				(organization_id, last_projected_sequence, updated_at)
			VALUES
				('org-quiet', ${acked}, '2026-07-01T00:00:00.000Z'),
				('org-busy', 0, '2026-07-02T00:00:00.000Z')
		`);

		await expect(
			listGraphProjectionOrganizations(
				createDbClient(createD1Facade(sqlite)),
				10,
			),
		).resolves.toEqual(["org-busy"]);
	});

	it("recertifies stale ready rows and retries quiet baseline-complete failures", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		sqlite.exec(`
			INSERT INTO graph_projection_readiness
				(organization_id, state, repair_phase, repair_high_water, last_certified_at, updated_at)
			VALUES
				('ready-stale', 'ready', 'complete', 10, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
				('degraded-old', 'degraded', 'complete', 10, NULL, '2026-07-01T00:00:00.000Z'),
				('catching-recent', 'catching_up', 'complete', 10, NULL, '2026-07-03T00:00:00.000Z'),
				('repair-incomplete', 'degraded', 'facts', 10, NULL, '2026-07-01T00:00:00.000Z')
		`);

		await expect(
			listGraphProjectionCertificationOrganizations(
				createDbClient(createD1Facade(sqlite)),
				"2026-07-02T00:00:00.000Z",
				"2026-07-02T00:00:00.000Z",
				10,
			),
		).resolves.toEqual(["degraded-old", "ready-stale"]);
	});

	it("uses one Workflow-compatible lease API and never steals a live token", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const db = createDbClient(createD1Facade(sqlite));

		await expect(
			acquireGraphProjectionLease(db, "org-1", "workflow-a", 60_000),
		).resolves.toBe(true);
		await expect(
			acquireGraphProjectionLease(db, "org-1", "workflow-b", 60_000),
		).resolves.toBe(false);
		await expect(
			acquireGraphProjectionLease(db, "org-1", "workflow-a", 60_000),
		).resolves.toBe(true);
		await expect(
			renewGraphProjectionLease(db, "org-1", "workflow-b", 60_000),
		).resolves.toBe(false);
		await expect(
			renewGraphProjectionLease(db, "org-1", "workflow-a", 60_000),
		).resolves.toBe(true);

		await releaseGraphProjectionLease(db, "org-1", "workflow-b");
		expect(
			sqlite
				.prepare(
					"SELECT lease_token FROM graph_projection_consumers WHERE organization_id = 'org-1'",
				)
				.get()!.lease_token,
		).toBe("workflow-a");
		await releaseGraphProjectionLease(db, "org-1", "workflow-a");
		await expect(
			acquireGraphProjectionLease(db, "org-1", "workflow-b", 60_000),
		).resolves.toBe(true);
	});

	it("atomically fences cursor advancement by lease, expiry, and expected cursor", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const db = createDbClient(createD1Facade(sqlite));

		await expect(
			acquireGraphProjectionLease(db, "org-1", "workflow-a", 60_000),
		).resolves.toBe(true);
		await expect(
			advanceGraphProjectionCursor(db, "org-1", "workflow-b", 10, {
				expectedCursor: 0,
			}),
		).resolves.toBe(false);
		await expect(
			advanceGraphProjectionCursor(db, "org-1", "workflow-a", 10, {
				expectedCursor: 0,
			}),
		).resolves.toBe(true);
		await expect(
			advanceGraphProjectionCursor(db, "org-1", "workflow-a", 5, {
				expectedCursor: 10,
			}),
		).resolves.toBe(false);
		await expect(
			advanceGraphProjectionCursor(db, "org-1", "workflow-a", 11, {
				expectedCursor: 0,
			}),
		).resolves.toBe(false);
		// A durable step that committed this exact advance and was then replayed
		// must see its own outcome, not a fence. Only the lease holder can have
		// produced this state, so re-reporting it is not a weakened CAS.
		await expect(
			advanceGraphProjectionCursor(db, "org-1", "workflow-a", 10, {
				expectedCursor: 0,
			}),
		).resolves.toBe(true);
		// A different lease holder replaying the same sequence is still fenced.
		await expect(
			advanceGraphProjectionCursor(db, "org-1", "workflow-b", 10, {
				expectedCursor: 0,
			}),
		).resolves.toBe(false);

		await expect(getGraphProjectionCursor(db, "org-1")).resolves.toBe(10);

		sqlite
			.prepare(
				"UPDATE graph_projection_consumers SET lease_until = ? WHERE organization_id = ?",
			)
			.run("2000-01-01T00:00:00.000Z", "org-1");
		await expect(
			advanceGraphProjectionCursor(db, "org-1", "workflow-a", 11, {
				expectedCursor: 10,
			}),
		).resolves.toBe(false);
		await expect(getGraphProjectionCursor(db, "org-1")).resolves.toBe(10);
	});

	it("preserves the stable projection generation across repair checkpoints", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const db = createDbClient(createD1Facade(sqlite));
		await setGraphProjectionReadiness(db, {
			organizationId: "org-1",
			state: "ready",
			projectionEpoch: "projection-generation-a",
			persistedWatermark: 12,
			gdsWatermark: 12,
			gdsEpoch: "projection-generation-a",
			certified: true,
		});
		await setGraphProjectionReadiness(db, {
			organizationId: "org-1",
			state: "catching_up",
			reason: "repair_in_progress",
			repairId: "repair-1",
			repairPhase: "facts",
			repairCursor: "fact-100",
			repairHighWater: 12,
			repairStartedAt: "2026-07-27T00:00:00.000Z",
		});

		await expect(
			getGraphProjectionReadState(db, "org-1"),
		).resolves.toMatchObject({
			state: "catching_up",
			projectionEpoch: "projection-generation-a",
			persistedWatermark: 12,
			gdsWatermark: 12,
			gdsEpoch: "projection-generation-a",
			repairId: "repair-1",
			repairPhase: "facts",
			repairCursor: "fact-100",
			repairHighWater: 12,
		});
	});

	it("resets a failed head without changing another tenant's event", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const sequence = insertOutbox(sqlite, {
			id: "failed",
			attemptCount: 2,
			nextAttemptAt: "2099-01-01T00:00:00.000Z",
			poisonedAt: "2026-07-01T00:00:00.000Z",
		});
		const otherSequence = insertOutbox(sqlite, {
			id: "other",
			orgId: "org-2",
			attemptCount: 2,
			poisonedAt: "2026-07-01T00:00:00.000Z",
		});
		const db = createDbClient(createD1Facade(sqlite));

		await expect(
			resetGraphProjectionFailure(db, "org-1", sequence),
		).resolves.toBe(true);
		await expect(
			resetGraphProjectionFailure(db, "org-1", otherSequence),
		).resolves.toBe(false);
		expect(
			sqlite
				.prepare(
					"SELECT attempt_count, next_attempt_at, poisoned_at FROM graph_projection_outbox WHERE sequence = ?",
				)
				.get(sequence),
		).toMatchObject({
			attempt_count: 0,
			next_attempt_at: null,
			poisoned_at: null,
		});
		expect(
			sqlite
				.prepare(
					"SELECT poisoned_at FROM graph_projection_outbox WHERE sequence = ?",
				)
				.get(otherSequence)!.poisoned_at,
		).not.toBeNull();
	});

	it("tracks retry and poison backlog independently", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		insertOutbox(sqlite, { id: "pending" });
		insertOutbox(sqlite, {
			id: "retry",
			attemptCount: 1,
			nextAttemptAt: "2099-01-01T00:00:00.000Z",
		});
		insertOutbox(sqlite, {
			id: "poison",
			attemptCount: 8,
			poisonedAt: "2026-07-01T00:00:00.000Z",
		});
		const db = createDbClient(createD1Facade(sqlite));
		await acquireGraphProjectionLease(db, "org-1", "backlog-test", 60_000);
		await advanceGraphProjectionCursor(db, "org-1", "backlog-test", 1, {
			expectedCursor: 0,
		});

		await expect(getGraphProjectionBacklogStats(db, "org-1")).resolves.toEqual({
			cursor: 1,
			highWaterSequence: 3,
			pendingCount: 2,
			retryCount: 1,
			poisonedCount: 1,
			oldestPendingAt: "2026-07-01T00:00:00.000Z",
		});
	});

	it("records failures on both the event and consumer diagnostic", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		insertOutbox(sqlite, { id: "failed" });
		const db = createDbClient(createD1Facade(sqlite));
		await acquireGraphProjectionLease(db, "org-1", "failure-test", 60_000);
		await advanceGraphProjectionCursor(db, "org-1", "failure-test", 0, {
			expectedCursor: 0,
		});
		const [failed] = await readGraphProjectionBatch(db, "org-1", 0, 1);

		await recordGraphProjectionFailure(
			db,
			failed!,
			new Error("neo4j unavailable"),
		);

		expect(
			sqlite
				.prepare(
					"SELECT attempt_count, last_error FROM graph_projection_outbox WHERE sequence = 1",
				)
				.get(),
		).toMatchObject({
			attempt_count: 1,
			last_error: "neo4j unavailable",
		});
		expect(
			sqlite
				.prepare(
					"SELECT last_error FROM graph_projection_consumers WHERE organization_id = 'org-1'",
				)
				.get()!.last_error,
		).toBe("neo4j unavailable");
	});

	it("prunes only old acknowledged rows and honors the batch bound", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const oldAckedA = insertOutbox(sqlite, { id: "old-acked-a" });
		const oldAckedB = insertOutbox(sqlite, { id: "old-acked-b" });
		const oldPending = insertOutbox(sqlite, { id: "old-pending" });
		const recentAcked = insertOutbox(sqlite, {
			id: "recent-acked",
			createdAt: "2026-07-26T12:00:00.000Z",
		});
		sqlite
			.prepare(`
				INSERT INTO graph_projection_consumers
					(organization_id, last_projected_sequence)
				VALUES ('org-1', ?)
			`)
			.run(oldAckedB);

		const db = createDbClient(createD1Facade(sqlite));
		await expect(
			pruneAcknowledgedGraphProjectionEvents(db, {
				now: new Date("2026-07-27T12:00:00.000Z"),
				retentionDays: 7,
				limit: 1,
			}),
		).resolves.toBe(1);
		const remaining = sqlite
			.prepare("SELECT sequence FROM graph_projection_outbox ORDER BY sequence")
			.all()
			.map((row) => Number(row.sequence));
		expect(remaining).toEqual([oldAckedB, oldPending, recentAcked]);
		expect(remaining).not.toContain(oldAckedA);
	});

	// `created_at` has no TypeScript writer: SQL triggers leave it on the
	// `CURRENT_TIMESTAMP` default, so every stored row is space-separated
	// ('2026-07-20 18:00:00'). An ISO cutoff mis-sorts against exactly those
	// rows -- 'T' (0x54) > ' ' (0x20) -- so every row on the cutoff DAY compares
	// below the cutoff and is pruned up to a day early. Both rows here sit on the
	// boundary day, one inside the window and one outside it, which is the only
	// place the two formats disagree.
	it("honors the retention boundary against space-format created_at", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const pastRetention = insertOutbox(sqlite, {
			id: "boundary-outside",
			createdAt: "2026-07-20 06:00:00",
		});
		const insideRetention = insertOutbox(sqlite, {
			id: "boundary-inside",
			createdAt: "2026-07-20 18:00:00",
		});
		sqlite
			.prepare(`
				INSERT INTO graph_projection_consumers
					(organization_id, last_projected_sequence)
				VALUES ('org-1', ?)
			`)
			.run(insideRetention);

		const db = createDbClient(createD1Facade(sqlite));
		await expect(
			pruneAcknowledgedGraphProjectionEvents(db, {
				now: new Date("2026-07-27T12:00:00.000Z"),
				retentionDays: 7,
				limit: 100,
			}),
		).resolves.toBe(1);
		const remaining = sqlite
			.prepare("SELECT sequence FROM graph_projection_outbox ORDER BY sequence")
			.all()
			.map((row) => Number(row.sequence));
		expect(remaining).toEqual([insideRetention]);
		expect(remaining).not.toContain(pastRetention);
	});

	// The count MUST come from D1's `changes`, not from a `RETURNING` row count.
	// `RETURNING` reports MATCHED rows, so the first wiring of this prune
	// reported 10 x its 5,000 batch cap on five consecutive nightly production
	// runs while the outbox never lost a single row. Pinning "reported == rows
	// that actually disappeared" across several batches is the assertion that
	// tells those two apart.
	it("reports exactly the rows it removed across batches", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const eligible: number[] = [];
		for (let i = 0; i < 7; i += 1) {
			eligible.push(
				insertOutbox(sqlite, {
					id: `batched-${i}`,
					createdAt: "2026-07-01 00:00:00",
				}),
			);
		}
		const retained = insertOutbox(sqlite, {
			id: "retained",
			createdAt: "2026-07-26 12:00:00",
		});
		sqlite
			.prepare(`
				INSERT INTO graph_projection_consumers
					(organization_id, last_projected_sequence)
				VALUES ('org-1', ?)
			`)
			.run(retained);
		const countRows = () =>
			Number(
				(
					sqlite
						.prepare("SELECT COUNT(*) AS n FROM graph_projection_outbox")
						.get() as { n: number | bigint }
				).n,
			);

		const db = createDbClient(createD1Facade(sqlite));
		const before = countRows();
		const removed = await pruneAcknowledgedGraphProjectionEvents(db, {
			now: new Date("2026-08-01T00:00:00.000Z"),
			retentionDays: 7,
			limit: 2,
			maxBatches: 10,
		});

		expect(removed).toBe(eligible.length);
		expect(before - countRows()).toBe(removed);
		expect(
			sqlite
				.prepare(
					"SELECT sequence FROM graph_projection_outbox ORDER BY sequence",
				)
				.all()
				.map((row) => Number(row.sequence)),
		).toEqual([retained]);
	});

	it("caps the work it does per call at maxBatches", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		let last = 0;
		for (let i = 0; i < 7; i += 1) {
			last = insertOutbox(sqlite, {
				id: `capped-${i}`,
				createdAt: "2026-07-01 00:00:00",
			});
		}
		sqlite
			.prepare(`
				INSERT INTO graph_projection_consumers
					(organization_id, last_projected_sequence)
				VALUES ('org-1', ?)
			`)
			.run(last);

		const db = createDbClient(createD1Facade(sqlite));
		await expect(
			pruneAcknowledgedGraphProjectionEvents(db, {
				now: new Date("2026-08-01T00:00:00.000Z"),
				retentionDays: 7,
				limit: 2,
				maxBatches: 2,
			}),
		).resolves.toBe(4);
	});

	// Fail closed on the production symptom itself: a DELETE that reports
	// deletions which do not land. Five nightly runs returned a confident
	// 50,000 against an untouched table; the prune must refuse to report a
	// number its own keyset contradicts.
	it("throws when reported deletions do not move the prunable head", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		let last = 0;
		for (let i = 0; i < 4; i += 1) {
			last = insertOutbox(sqlite, {
				id: `phantom-${i}`,
				createdAt: "2026-07-01 00:00:00",
			});
		}
		sqlite
			.prepare(`
				INSERT INTO graph_projection_consumers
					(organization_id, last_projected_sequence)
				VALUES ('org-1', ?)
			`)
			.run(last);

		// A D1 that acknowledges the DELETE without applying it. Every other
		// statement runs against the real facade, so the prune's own keyset read
		// is honest and only the mutation is phantom.
		const facade = createD1Facade(sqlite);
		const phantomD1 = {
			...facade,
			prepare(query: string) {
				const statement = facade.prepare(query);
				if (!/^\s*delete\s+from/i.test(query)) return statement;
				const lying = {
					bind: (...values: unknown[]) => {
						statement.bind(...values);
						return lying;
					},
					run: async () => ({
						success: true,
						meta: { changes: 2, last_row_id: 0, duration: 0 },
					}),
					all: async () => ({ results: [], success: true, meta: {} }),
					first: async () => null,
					raw: async () => [],
				};
				return lying;
			},
		} as unknown as D1Database;

		const db = createDbClient(phantomD1);
		await expect(
			pruneAcknowledgedGraphProjectionEvents(db, {
				now: new Date("2026-08-01T00:00:00.000Z"),
				retentionDays: 7,
				limit: 2,
				maxBatches: 10,
			}),
		).rejects.toThrow(/prunable head did not advance/);
		expect(
			Number(
				(
					sqlite
						.prepare("SELECT COUNT(*) AS n FROM graph_projection_outbox")
						.get() as { n: number | bigint }
				).n,
			),
		).toBe(4);
	});
});

describe("coalesceGraphProjectionEvents", () => {
	it("keeps the newest mutation for each canonical node", () => {
		const result = coalesceGraphProjectionEvents([
			event(1, "fact", "fact-1"),
			event(2, "fact", "fact-1"),
			event(3, "entity", "entity-1"),
		]);

		expect(result.map((item) => item.sequence)).toEqual([2, 3]);
	});

	it("orders nodes before relationships and preserves relation history", () => {
		const rows = coalesceGraphProjectionEvents([
			event(1, "fact", "fact-1"),
			event(2, "edge", "edge-1", "delete"),
			event(3, "fact", "fact-1"),
			event(4, "edge", "edge-1", "upsert"),
			event(5, "entity_resolution", "resolution-1", "delete"),
			event(6, "entity_resolution", "resolution-1", "upsert"),
		]);

		expect(
			rows.map((row) => [row.sequence, row.entityKind, row.operation]),
		).toEqual([
			[3, "fact", "upsert"],
			[2, "edge", "delete"],
			[4, "edge", "upsert"],
			[5, "entity_resolution", "delete"],
			[6, "entity_resolution", "upsert"],
		]);
	});
});

describe("graph projection repair scans", () => {
	it("uses a stable id keyset and includes archived graph-anchor facts", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createMemoryTables(sqlite);
		const insert = sqlite.prepare(`
			INSERT INTO memory_facts (
				id, organization_id, content, fact_type, confidence,
				memory_scope, archived_at, access_count, usage_count
			) VALUES (?, ?, ?, 'technical', 0.8, ?, ?, 0, 0)
		`);
		insert.run("a", "org-1", "active", "tedi", null);
		insert.run("b", "org-1", "anchor", "graph", null);
		insert.run("c", "org-1", "archived", "tedi", "2026-07-01");
		insert.run("d", "org-2", "other tenant", "graph", null);
		const db = createDbClient(createD1Facade(sqlite));

		const first = await readGraphFactBackfillPage(db, "org-1", { limit: 2 });
		const second = await readGraphFactBackfillPage(db, "org-1", {
			afterId: first.nextCursor!,
			limit: 2,
		});

		expect(first.rows.map((row) => row.id)).toEqual(["a", "b"]);
		expect(first.done).toBe(false);
		expect(second.rows.map((row) => row.id)).toEqual(["c"]);
		expect(second.done).toBe(true);
	});

	it("excludes cross-tenant edges from repair pages", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createMemoryTables(sqlite);
		const insertFact = sqlite.prepare(`
			INSERT INTO memory_facts (
				id, organization_id, content, fact_type, confidence,
				access_count, usage_count
			) VALUES (?, ?, ?, 'technical', 0.8, 0, 0)
		`);
		insertFact.run("a", "org-1", "a");
		insertFact.run("b", "org-1", "b");
		insertFact.run("foreign", "org-2", "foreign");
		sqlite
			.prepare(`
				INSERT INTO memory_edges
					(id, source_fact_id, target_fact_id, relation_type)
				VALUES
					('local', 'a', 'b', 'related_to'),
					('cross', 'a', 'foreign', 'related_to')
			`)
			.run();

		const page = await readGraphEdgeBackfillPage(
			createDbClient(createD1Facade(sqlite)),
			"org-1",
			{
				limit: 10,
			},
		);

		expect(page.rows.map((row) => row.id)).toEqual(["local"]);
		expect(page.rows[0]?.organizationId).toBe("org-1");
	});
});

describe("listGraphProjectionConsumerHealth", () => {
	it("reads success evidence independently of activity and scopes pending work to its consumer", async () => {
		const sqlite = new DatabaseSync(":memory:");
		createProjectionTables(sqlite);
		const db = createDbClient(createD1Facade(sqlite));
		sqlite.exec(`
   INSERT INTO graph_projection_consumers (organization_id, last_projected_sequence, last_success_at, updated_at) VALUES
    ('stuck', 10, '2026-07-20T08:00:00.000Z', '2026-07-27T08:00:00.000Z'),
    ('idle', 100, NULL, '2026-07-27T08:00:00.000Z');
   INSERT INTO graph_projection_outbox (sequence, event_id, organization_id, entity_kind, entity_id, operation, created_at) VALUES
    (1, 'acked', 'stuck', 'fact', 'f1', 'upsert', '2026-07-01T00:00:00.000Z'),
    (11, 'pending', 'stuck', 'fact', 'f2', 'upsert', '2026-07-26T08:00:00.000Z'),
    (101, 'other', 'other-org', 'fact', 'f3', 'upsert', '2026-07-01T00:00:00.000Z');
  `);
		expect(await listGraphProjectionConsumerHealth(db)).toEqual([
			{ organizationId: "idle", lastSuccessAt: null, oldestPendingAt: null },
			{
				organizationId: "stuck",
				lastSuccessAt: "2026-07-20T08:00:00.000Z",
				oldestPendingAt: "2026-07-26T08:00:00.000Z",
			},
		]);
		sqlite.close();
	});
});
