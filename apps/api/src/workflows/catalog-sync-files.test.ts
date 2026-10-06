import { describe, expect, it } from "vite-plus/test";
import {
	isCatalogSyncDeployReset,
	planCatalogFileBatchOffsets,
	planCatalogVectorPageOffsets,
} from "./catalog-sync-files";

describe("planCatalogFileBatchOffsets", () => {
	it("splits the production-sized Claude registry into stable bounded batches", () => {
		const offsets = planCatalogFileBatchOffsets(327, 25);

		expect(offsets).toHaveLength(14);
		expect(offsets).toEqual([
			0, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300, 325,
		]);
	});

	it("runs one explicit batch for an empty file", () => {
		expect(planCatalogFileBatchOffsets(0, 25)).toEqual([0]);
	});

	it("rejects invalid batch plans", () => {
		expect(() => planCatalogFileBatchOffsets(-1, 25)).toThrow(
			"recordCount must be a non-negative safe integer",
		);
		expect(() => planCatalogFileBatchOffsets(10, 0)).toThrow(
			"batchSize must be a positive safe integer",
		);
	});
});

describe("planCatalogVectorPageOffsets", () => {
	it("splits the enabled catalog into durable AI Search pages", () => {
		expect(planCatalogVectorPageOffsets(2722, 100)).toEqual([
			0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300,
			1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500,
			2600, 2700,
		]);
	});

	it("skips upload steps for an empty enabled catalog", () => {
		expect(planCatalogVectorPageOffsets(0, 100)).toEqual([]);
	});
});

describe("isCatalogSyncDeployReset", () => {
	it("classifies a code-deploy reset as replayable", () => {
		expect(
			isCatalogSyncDeployReset(
				Object.assign(
					new Error("Durable Object reset because its code was updated."),
					{ remote: true, retryable: true, durableObjectReset: true },
				),
			),
		).toBe(true);
	});

	it("classifies a storage-timeout reset as replayable", () => {
		// The production shape: overloaded and reset, with no `retryable` flag.
		expect(
			isCatalogSyncDeployReset(
				Object.assign(new Error("Durable Object reset."), {
					remote: true,
					overloaded: true,
					durableObjectReset: true,
				}),
			),
		).toBe(true);
	});

	it("does not hide ordinary sync failures", () => {
		expect(
			isCatalogSyncDeployReset(
				new Error("Attempt failed due to internal workflows error"),
			),
		).toBe(false);
	});
});
