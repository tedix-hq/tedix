import { describe, expect, it } from "vite-plus/test";
import type { DbClient } from "../client";
import type { NewMemoryFact } from "../schema/memory-graph";
import {
	assertBulkFactAdmission,
	BULK_FACT_ADMISSION_THRESHOLD,
	BulkFactAdmissionError,
	createFacts,
} from "./memory-graph/facts";

/**
 * Bulk memory admission gate (agent-capability-mutation-gate ADR):
 * single-fact learning is the normal loop and stays ungated; mass admission
 * (>BULK_FACT_ADMISSION_THRESHOLD facts in one call) requires the handler
 * layer to have positively proven non-agent authority. Fails closed.
 */

function makeFacts(count: number): NewMemoryFact[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `fact-${i}`,
		organizationId: "org-1",
		content: `fact content ${i}`,
		factType: "technical",
	})) as NewMemoryFact[];
}

/** A db that records inserts without a real database. */
function mockDb() {
	const inserted: NewMemoryFact[][] = [];
	const db = {
		insert: () => ({
			values: (rows: NewMemoryFact[]) => ({
				returning: async () => {
					inserted.push(rows);
					return rows;
				},
			}),
		}),
	} as unknown as DbClient;
	return { db, inserted };
}

/** A db that throws if any query is attempted — proves the gate runs first. */
const untouchableDb = new Proxy(
	{},
	{
		get() {
			throw new Error("db must not be touched when the admission gate fires");
		},
	},
) as DbClient;

describe("assertBulkFactAdmission", () => {
	it("passes at and below the threshold without any authority", () => {
		expect(() => assertBulkFactAdmission(0)).not.toThrow();
		expect(() => assertBulkFactAdmission(1)).not.toThrow();
		expect(() =>
			assertBulkFactAdmission(BULK_FACT_ADMISSION_THRESHOLD),
		).not.toThrow();
	});

	it("rejects above the threshold without operator authority (agent path)", () => {
		expect(() =>
			assertBulkFactAdmission(BULK_FACT_ADMISSION_THRESHOLD + 1),
		).toThrowError(BulkFactAdmissionError);
	});

	it("passes above the threshold with proven operator authority", () => {
		expect(() =>
			assertBulkFactAdmission(BULK_FACT_ADMISSION_THRESHOLD + 1, {
				operatorAuthority: true,
			}),
		).not.toThrow();
	});
});

describe("createFacts", () => {
	it("rejects >threshold agent writes before touching the database", async () => {
		await expect(
			createFacts(untouchableDb, makeFacts(BULK_FACT_ADMISSION_THRESHOLD + 1)),
		).rejects.toBeInstanceOf(BulkFactAdmissionError);
	});

	it("inserts ≤threshold writes without authority (the normal loop)", async () => {
		const { db, inserted } = mockDb();
		const facts = makeFacts(BULK_FACT_ADMISSION_THRESHOLD);
		const created = await createFacts(db, facts);
		expect(created).toHaveLength(facts.length);
		expect(inserted.flat()).toHaveLength(facts.length);
	});

	it("inserts >threshold writes when operator authority is proven", async () => {
		const { db, inserted } = mockDb();
		const facts = makeFacts(BULK_FACT_ADMISSION_THRESHOLD + 5);
		const created = await createFacts(db, facts, { operatorAuthority: true });
		expect(created).toHaveLength(facts.length);
		expect(inserted.flat()).toHaveLength(facts.length);
	});

	it("returns empty for an empty batch without touching the database", async () => {
		await expect(createFacts(untouchableDb, [])).resolves.toEqual([]);
	});
});
