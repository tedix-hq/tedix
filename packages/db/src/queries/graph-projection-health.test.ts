import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	GRAPH_PROJECTION_EDGE_SAMPLE_LIMIT,
	GRAPH_PROJECTION_MAX_SAMPLE_LIMIT,
	getGraphProjectionCanonicalEdgeSample,
	getGraphProjectionCanonicalLifecycleSample,
	getGraphProjectionCanonicalSample,
} from "./graph-projection-health";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE memory_facts (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			valid_to TEXT,
			archived_at TEXT,
			created_at TEXT,
			updated_at TEXT
		);
		CREATE TABLE memory_edges (
			id TEXT PRIMARY KEY NOT NULL,
			source_fact_id TEXT NOT NULL,
			target_fact_id TEXT NOT NULL,
			relation_type TEXT NOT NULL,
			strength REAL NOT NULL DEFAULT 0.5,
			context TEXT,
			created_at TEXT,
			UNIQUE(source_fact_id, target_fact_id, relation_type)
		);
	`);
	const insert = sqlite.prepare(
		`INSERT INTO memory_facts
			(id, organization_id, valid_to, archived_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const insertEdge = sqlite.prepare(
		`INSERT INTO memory_edges
			(id, source_fact_id, target_fact_id, relation_type, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
	);
	return {
		db: createDbClient(createD1Facade(sqlite)),
		insertFact(input: {
			id: string;
			orgId?: string;
			validTo?: string | null;
			archivedAt?: string | null;
			createdAt: string;
			updatedAt?: string | null;
		}) {
			insert.run(
				input.id,
				input.orgId ?? "org-1",
				input.validTo ?? null,
				input.archivedAt ?? null,
				input.createdAt,
				input.updatedAt ?? null,
			);
		},
		insertEdge(input: {
			id: string;
			sourceFactId: string;
			targetFactId: string;
			relationType?: string;
			createdAt: string;
		}) {
			insertEdge.run(
				input.id,
				input.sourceFactId,
				input.targetFactId,
				input.relationType ?? "related_to",
				input.createdAt,
			);
		},
	};
}

describe("getGraphProjectionCanonicalSample", () => {
	it("returns the newest current facts from the requested D1 organization", async () => {
		const { db, insertFact } = fixture();
		insertFact({ id: "older", createdAt: "2026-07-18T09:00:00.000Z" });
		insertFact({
			id: "newer",
			createdAt: "2026-07-18T09:30:00.000Z",
			updatedAt: "2026-07-18T10:00:00.000Z",
		});
		insertFact({
			id: "other-org",
			orgId: "org-2",
			createdAt: "2026-07-18T11:00:00.000Z",
		});
		insertFact({
			id: "archived",
			createdAt: "2026-07-18T12:00:00.000Z",
			archivedAt: "2026-07-18T12:01:00.000Z",
		});
		insertFact({
			id: "invalidated",
			createdAt: "2026-07-18T13:00:00.000Z",
			validTo: "2026-07-18T13:01:00.000Z",
		});

		await expect(
			getGraphProjectionCanonicalSample(db, "org-1", 2),
		).resolves.toEqual([
			{
				id: "newer",
				canonicalUpdatedAt: "2026-07-18T10:00:00.000Z",
			},
			{
				id: "older",
				canonicalUpdatedAt: "2026-07-18T09:00:00.000Z",
			},
		]);
	});

	it("caps the requested sample to the diagnostic maximum", async () => {
		const { db, insertFact } = fixture();
		for (
			let index = 0;
			index < GRAPH_PROJECTION_MAX_SAMPLE_LIMIT + 5;
			index++
		) {
			insertFact({
				id: `fact-${String(index).padStart(3, "0")}`,
				createdAt: new Date(Date.UTC(2026, 6, 18, 0, index)).toISOString(),
			});
		}

		const sample = await getGraphProjectionCanonicalSample(db, "org-1", 10_000);
		expect(sample).toHaveLength(GRAPH_PROJECTION_MAX_SAMPLE_LIMIT);
		expect(sample[0]?.id).toBe("fact-104");
	});
});

describe("getGraphProjectionCanonicalEdgeSample", () => {
	it("returns only newest edges whose endpoints are current in the requested organization", async () => {
		const { db, insertEdge, insertFact } = fixture();
		for (const [id, orgId] of [
			["source", "org-1"],
			["target", "org-1"],
			["other-org", "org-2"],
			["archived", "org-1"],
			["invalidated", "org-1"],
		] as const) {
			insertFact({
				id,
				orgId,
				createdAt: "2026-07-18T09:00:00.000Z",
				archivedAt: id === "archived" ? "2026-07-18T09:01:00.000Z" : undefined,
				validTo: id === "invalidated" ? "2026-07-18T09:01:00.000Z" : undefined,
			});
		}
		insertEdge({
			id: "older-current",
			sourceFactId: "source",
			targetFactId: "target",
			createdAt: "2026-07-18T10:00:00.000Z",
		});
		insertEdge({
			id: "newer-current",
			sourceFactId: "target",
			targetFactId: "source",
			relationType: "requires",
			createdAt: "2026-07-18T11:00:00.000Z",
		});
		insertEdge({
			id: "cross-org",
			sourceFactId: "source",
			targetFactId: "other-org",
			createdAt: "2026-07-18T12:00:00.000Z",
		});
		insertEdge({
			id: "archived-endpoint",
			sourceFactId: "source",
			targetFactId: "archived",
			createdAt: "2026-07-18T13:00:00.000Z",
		});
		insertEdge({
			id: "invalidated-endpoint",
			sourceFactId: "source",
			targetFactId: "invalidated",
			createdAt: "2026-07-18T14:00:00.000Z",
		});

		await expect(
			getGraphProjectionCanonicalEdgeSample(db, "org-1"),
		).resolves.toEqual([
			{
				id: "newer-current",
				sourceFactId: "target",
				targetFactId: "source",
				relationType: "requires",
				canonicalCreatedAt: "2026-07-18T11:00:00.000Z",
			},
			{
				id: "older-current",
				sourceFactId: "source",
				targetFactId: "target",
				relationType: "related_to",
				canonicalCreatedAt: "2026-07-18T10:00:00.000Z",
			},
		]);
	});

	it("uses the edge diagnostic default and maximum bounds", async () => {
		const { db, insertEdge, insertFact } = fixture();
		for (
			let index = 0;
			index < GRAPH_PROJECTION_MAX_SAMPLE_LIMIT + 5;
			index++
		) {
			const sourceFactId = `source-${index}`;
			const targetFactId = `target-${index}`;
			insertFact({
				id: sourceFactId,
				createdAt: "2026-07-18T09:00:00.000Z",
			});
			insertFact({
				id: targetFactId,
				createdAt: "2026-07-18T09:00:00.000Z",
			});
			insertEdge({
				id: `edge-${String(index).padStart(3, "0")}`,
				sourceFactId,
				targetFactId,
				createdAt: new Date(Date.UTC(2026, 6, 18, 0, index)).toISOString(),
			});
		}

		await expect(
			getGraphProjectionCanonicalEdgeSample(db, "org-1"),
		).resolves.toHaveLength(GRAPH_PROJECTION_EDGE_SAMPLE_LIMIT);
		const capped = await getGraphProjectionCanonicalEdgeSample(
			db,
			"org-1",
			10_000,
		);
		expect(capped).toHaveLength(GRAPH_PROJECTION_MAX_SAMPLE_LIMIT);
		expect(capped[0]?.id).toBe("edge-104");
	});
});

describe("getGraphProjectionCanonicalLifecycleSample", () => {
	it("samples archived and invalidated facts without mixing current or cross-org rows", async () => {
		const { db, insertFact } = fixture();
		insertFact({
			id: "current",
			createdAt: "2026-07-18T09:00:00.000Z",
		});
		insertFact({
			id: "archived",
			createdAt: "2026-07-18T10:00:00.000Z",
			updatedAt: "2026-07-18T10:30:00.000Z",
			archivedAt: "2026-07-18T10:15:00.000Z",
		});
		insertFact({
			id: "invalidated",
			createdAt: "2026-07-18T11:00:00.000Z",
			validTo: "2026-07-18T11:15:00.000Z",
		});
		insertFact({
			id: "other-org-archived",
			orgId: "org-2",
			createdAt: "2026-07-18T12:00:00.000Z",
			archivedAt: "2026-07-18T12:15:00.000Z",
		});

		await expect(
			getGraphProjectionCanonicalLifecycleSample(db, "org-1"),
		).resolves.toEqual([
			{
				id: "invalidated",
				canonicalUpdatedAt: "2026-07-18T11:00:00.000Z",
				validTo: "2026-07-18T11:15:00.000Z",
				archivedAt: null,
			},
			{
				id: "archived",
				canonicalUpdatedAt: "2026-07-18T10:30:00.000Z",
				validTo: null,
				archivedAt: "2026-07-18T10:15:00.000Z",
			},
		]);
	});
});
