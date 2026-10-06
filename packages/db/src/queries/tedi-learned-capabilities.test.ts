import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	getTediLearnedCapabilities,
	invalidateTediLearnedCapabilityBefore,
	knowledgeRowToLearnedCapability,
	TEDI_LEARNED_CAPABILITY_ID_PREFIX,
	tediLearnedCapabilityEntryId,
	upsertTediLearnedCapability,
} from "./cognitive/learned-capabilities";

/**
 * Learned-capability storage helpers (capability flywheel) against a REAL
 * in-memory SQLite engine via the production createDbClient path.
 *
 * Invariants under test:
 *   - upsert is idempotent per tedi: the deterministic `tcap:{tediId}` id makes
 *     a re-run OVERWRITE the row (never duplicate it)
 *   - the batched read keys by tediId, scopes by org, and skips unusable rows
 *   - chunking survives > 80 tedi ids (D1 bound-param discipline)
 */

const REAL_DDL = `
CREATE TABLE knowledge_entries (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	tedi_id TEXT,
	domain_id TEXT,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	entry_type TEXT NOT NULL,
	source_fact_ids TEXT,
	source_count INTEGER NOT NULL DEFAULT 0,
	confidence REAL NOT NULL DEFAULT 0.8,
	revision INTEGER NOT NULL DEFAULT 1,
	revision_reasoning TEXT,
	supersedes_id TEXT,
	visibility TEXT NOT NULL DEFAULT 'private',
	tags TEXT,
	last_validated_at TEXT,
	created_at TEXT DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

function realDb(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(REAL_DDL);
	return createDbClient(createD1Facade(sqlite));
}

const ORG = "org-1";

describe("tediLearnedCapabilityEntryId", () => {
	it("builds the deterministic prefixed id", () => {
		expect(tediLearnedCapabilityEntryId("tedi-1")).toBe(
			`${TEDI_LEARNED_CAPABILITY_ID_PREFIX}tedi-1`,
		);
	});
});

describe("knowledgeRowToLearnedCapability", () => {
	it("maps a well-formed row", () => {
		expect(
			knowledgeRowToLearnedCapability({
				tediId: "tedi-1",
				content: "  Reliable at deploy audits.  ",
				sourceCount: 7,
				updatedAt: "2026-07-01T00:00:00.000Z",
			}),
		).toEqual({
			tediId: "tedi-1",
			learnedDescription: "Reliable at deploy audits.",
			evidenceCount: 7,
			updatedAt: "2026-07-01T00:00:00.000Z",
		});
	});

	it("degrades unusable rows to null", () => {
		expect(
			knowledgeRowToLearnedCapability({
				tediId: null,
				content: "x",
				sourceCount: 1,
				updatedAt: null,
			}),
		).toBeNull();
		expect(
			knowledgeRowToLearnedCapability({
				tediId: "tedi-1",
				content: "   ",
				sourceCount: 1,
				updatedAt: null,
			}),
		).toBeNull();
	});
});

describe("upsertTediLearnedCapability + getTediLearnedCapabilities", () => {
	it("invalidates only a profile older than the correction revision", async () => {
		const db = realDb();
		await upsertTediLearnedCapability(db, {
			organizationId: ORG,
			tediId: "tedi-1",
			learnedDescription: "stale",
			evidenceCount: 4,
			successRate: 1,
			updatedAt: "2026-09-23T00:00:00.000Z",
		});
		await invalidateTediLearnedCapabilityBefore(db, {
			organizationId: ORG,
			tediId: "tedi-1",
			correctionAt: "2026-09-24T00:00:00.000Z",
		});
		expect((await getTediLearnedCapabilities(db, ORG, ["tedi-1"])).size).toBe(
			0,
		);
		await upsertTediLearnedCapability(db, {
			organizationId: ORG,
			tediId: "tedi-1",
			learnedDescription: "revised",
			evidenceCount: 4,
			successRate: 0.75,
			updatedAt: "2026-09-25T00:00:00.000Z",
		});
		await invalidateTediLearnedCapabilityBefore(db, {
			organizationId: ORG,
			tediId: "tedi-1",
			correctionAt: "2026-09-24T00:00:00.000Z",
		});
		expect(
			(await getTediLearnedCapabilities(db, ORG, ["tedi-1"])).get("tedi-1")
				?.learnedDescription,
		).toBe("revised");
	});

	it("round-trips a distilled description keyed by tediId", async () => {
		const db = realDb();
		await upsertTediLearnedCapability(db, {
			organizationId: ORG,
			tediId: "tedi-1",
			learnedDescription: "Succeeds at read-heavy research objectives.",
			evidenceCount: 5,
			successRate: 0.8,
			updatedAt: "2026-07-01T00:00:00.000Z",
		});

		const learned = await getTediLearnedCapabilities(db, ORG, [
			"tedi-1",
			"tedi-missing",
		]);
		expect(learned.size).toBe(1);
		expect(learned.get("tedi-1")).toEqual({
			tediId: "tedi-1",
			learnedDescription: "Succeeds at read-heavy research objectives.",
			evidenceCount: 5,
			updatedAt: "2026-07-01T00:00:00.000Z",
		});
	});

	it("re-running the upsert overwrites the same row (idempotent per night)", async () => {
		const db = realDb();
		await upsertTediLearnedCapability(db, {
			organizationId: ORG,
			tediId: "tedi-1",
			learnedDescription: "v1",
			evidenceCount: 3,
			successRate: 1,
			updatedAt: "2026-07-01T00:00:00.000Z",
		});
		await upsertTediLearnedCapability(db, {
			organizationId: ORG,
			tediId: "tedi-1",
			learnedDescription: "v2 — now with failures observed.",
			evidenceCount: 6,
			successRate: 0.5,
			updatedAt: "2026-07-02T00:00:00.000Z",
		});

		const learned = await getTediLearnedCapabilities(db, ORG, ["tedi-1"]);
		expect(learned.size).toBe(1);
		expect(learned.get("tedi-1")).toEqual({
			tediId: "tedi-1",
			learnedDescription: "v2 — now with failures observed.",
			evidenceCount: 6,
			updatedAt: "2026-07-02T00:00:00.000Z",
		});
	});

	it("scopes reads by org", async () => {
		const db = realDb();
		await upsertTediLearnedCapability(db, {
			organizationId: "org-other",
			tediId: "tedi-1",
			learnedDescription: "other org's evidence",
			evidenceCount: 4,
			successRate: 0.75,
		});
		expect((await getTediLearnedCapabilities(db, ORG, ["tedi-1"])).size).toBe(
			0,
		);
	});

	it("returns an empty map for an empty id list without querying", async () => {
		// A db that throws on ANY select proves the empty-input short-circuit.
		const throwingDb = {
			select: () => {
				throw new Error("should not query");
			},
		} as unknown as DbClient;
		expect(await getTediLearnedCapabilities(throwingDb, ORG, [])).toEqual(
			new Map(),
		);
	});

	it("chunks reads across > 80 tedi ids", async () => {
		const db = realDb();
		const ids = Array.from({ length: 85 }, (_, i) => `tedi-${i}`);
		// Seed the first and last so both chunks must be read to find them.
		for (const tediId of [ids[0]!, ids[84]!]) {
			await upsertTediLearnedCapability(db, {
				organizationId: ORG,
				tediId,
				learnedDescription: `learned for ${tediId}`,
				evidenceCount: 3,
				successRate: 1,
			});
		}
		const learned = await getTediLearnedCapabilities(db, ORG, ids);
		expect(learned.size).toBe(2);
		expect(learned.get("tedi-0")?.learnedDescription).toBe(
			"learned for tedi-0",
		);
		expect(learned.get("tedi-84")?.learnedDescription).toBe(
			"learned for tedi-84",
		);
	});
});
