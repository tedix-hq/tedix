import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	decayConfidence,
	archiveLowConfidence,
	promoteFromProbation,
	resetCollapsedConfidence,
} from "./memory-graph/fact-lifecycle";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`CREATE TABLE memory_facts (id TEXT PRIMARY KEY,organization_id TEXT,tedi_id TEXT,domain_id TEXT,confidence REAL,archived_at TEXT,valid_to TEXT,last_verified_at TEXT,last_accessed_at TEXT,created_at TEXT,updated_at TEXT,priority TEXT,usage_count INTEGER,access_count INTEGER,status TEXT,source TEXT,metadata TEXT); INSERT INTO memory_facts (id,organization_id,confidence,created_at,updated_at) VALUES ('selected','org',0.05,'2020-01-01','2020-01-01'),('outside','org',0.05,'2020-01-01','2020-01-01'),('foreign','other',0.05,'2020-01-01','2020-01-01');`,
	);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}
describe("reflection selection bounds lifecycle writes", () => {
	it("promotes used afterTurn facts unless the evidence check rejected them", async () => {
		const { sqlite, db } = fixture();
		try {
			const insert = sqlite.prepare(
				"INSERT INTO memory_facts (id,organization_id,status,source,metadata,access_count) VALUES (?,?, 'probation',?,?,1)",
			);
			const quality = (verdict: string, hash: string | null = "a".repeat(64)) =>
				JSON.stringify({
					memoryQuality: {
						recipe: "memory-quality-v1",
						verdict,
						sourceEvidenceSha256: hash,
					},
				});
			insert.run(
				"grounded",
				"org",
				"observation://turn/0",
				quality("durable_candidate"),
			);
			for (const verdict of [
				"unsupported",
				"transient_or_unsupported",
				"supported",
				"uncertain",
				"unavailable",
				"insufficient_evidence",
			]) {
				insert.run(
					verdict,
					"org",
					`observation://turn/${verdict}`,
					quality(verdict),
				);
			}
			insert.run(
				"missing-hash",
				"org",
				"observation://turn/1",
				quality("durable_candidate", null),
			);
			insert.run("legacy", "org", "observation://turn/2", null);
			insert.run("malformed", "org", "observation://turn/3", "{broken");
			insert.run("other-producer", "org", "home:reflection:org:event", null);
			insert.run(
				"foreign-grounded",
				"other",
				"observation://turn/4",
				quality("durable_candidate"),
			);

			expect(await promoteFromProbation(db, "org", 1)).toBe(8);
			const statuses = sqlite
				.prepare(
					"SELECT id,status FROM memory_facts WHERE status IS NOT NULL ORDER BY id",
				)
				.all() as Array<{ id: string; status: string }>;
			expect(
				statuses.filter((row) => row.status === "active").map((row) => row.id),
			).toEqual([
				"grounded",
				"insufficient_evidence",
				"legacy",
				"missing-hash",
				"other-producer",
				"supported",
				"unavailable",
				"uncertain",
			]);
			expect(
				statuses.find((row) => row.id === "foreign-grounded")?.status,
			).toBe("probation");
		} finally {
			sqlite.close();
		}
	});
	it("resets only selected facts within the organization", async () => {
		const { sqlite, db } = fixture();
		try {
			expect(
				await resetCollapsedConfidence(db, "org", 0.8, ["selected", "foreign"]),
			).toBe(1);
			expect(
				sqlite
					.prepare("SELECT confidence FROM memory_facts WHERE id='outside'")
					.get()?.confidence,
			).toBe(0.05);
			expect(
				sqlite
					.prepare("SELECT confidence FROM memory_facts WHERE id='foreign'")
					.get()?.confidence,
			).toBe(0.05);
		} finally {
			sqlite.close();
		}
	});
	it("decays and archives only the selected facts", async () => {
		const { sqlite, db } = fixture();
		try {
			expect(
				await decayConfidence(db, "org", 0.99, 0.1, { factIds: ["selected"] }),
			).toBe(1);
			expect(
				(await archiveLowConfidence(db, "org", 0.2, { factIds: ["selected"] }))
					.archivedIds,
			).toEqual(["selected"]);
			expect(
				sqlite
					.prepare("SELECT archived_at FROM memory_facts WHERE id='outside'")
					.get()?.archived_at,
			).toBeNull();
		} finally {
			sqlite.close();
		}
	});
	it("treats an empty selection as no work", async () => {
		const { sqlite, db } = fixture();
		try {
			expect(await resetCollapsedConfidence(db, "org", 0.8, [])).toBe(0);
			expect(await decayConfidence(db, "org", 0.99, 0.1, { factIds: [] })).toBe(
				0,
			);
			expect(
				await archiveLowConfidence(db, "org", 0.2, { factIds: [] }),
			).toEqual({ count: 0, archivedIds: [] });
		} finally {
			sqlite.close();
		}
	});
});
