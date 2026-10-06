import { describe, expect, it } from "vite-plus/test";
import {
	createGraphProjectionDrainBatch,
	selectGraphProjectionDispatchOrganizations,
} from "./graph-projection-scheduling";

describe("graph projection dispatch scheduling", () => {
	it("reserves five recertification slots under a saturated backlog", () => {
		const backlogOrganizationIds = Array.from(
			{ length: 25 },
			(_, index) => `backlog-${index}`,
		);
		const recertificationOrganizationIds = Array.from(
			{ length: 5 },
			(_, index) => `recertify-${index}`,
		);

		const selected = selectGraphProjectionDispatchOrganizations({
			backlogOrganizationIds,
			recertificationOrganizationIds,
		});

		expect(selected).toHaveLength(25);
		expect(selected.filter((id) => id.startsWith("backlog-"))).toHaveLength(20);
		expect(selected.filter((id) => id.startsWith("recertify-"))).toHaveLength(
			5,
		);
	});

	it("deduplicates a tenant selected by both sources", () => {
		expect(
			selectGraphProjectionDispatchOrganizations({
				backlogOrganizationIds: ["org-shared", "org-backlog"],
				recertificationOrganizationIds: ["org-shared", "org-stale"],
			}),
		).toEqual(["org-shared", "org-backlog", "org-stale"]);
	});
});

describe("graph projection Workflow admission", () => {
	it("reports retained duplicate instance IDs as deduplicated, not failed", async () => {
		const submitted: string[] = [];
		const result = await createGraphProjectionDrainBatch(
			{
				async createBatch(batch) {
					submitted.push(...batch.map((entry) => entry.id));
					return batch.slice(0, 1);
				},
			},
			[
				{ organizationId: "org-started", cursor: 42 },
				{ organizationId: "org-retained", cursor: 7 },
			],
			123,
		);

		expect(submitted).toEqual([
			"graph-projection-org-started-42-123",
			"graph-projection-org-retained-7-123",
		]);
		expect(result).toEqual({ candidates: 2, started: 1, deduplicated: 1 });
	});

	it("does not call createBatch when there are no candidates", async () => {
		let called = false;
		const result = await createGraphProjectionDrainBatch(
			{
				async createBatch() {
					called = true;
					return [];
				},
			},
			[],
			123,
		);

		expect(called).toBe(false);
		expect(result).toEqual({ candidates: 0, started: 0, deduplicated: 0 });
	});
});
