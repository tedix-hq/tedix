import { describe, expect, it } from "bun:test";
import { groupToolCollisions } from "./tool-collision-report";

describe("groupToolCollisions", () => {
	it("groups events by colliding key with owners, counts and last sighting", () => {
		expect(
			groupToolCollisions([
				{
					ownerKey: "acme_unified_crm.list_contacts",
					owners: ["acme-unified__list_contacts"],
					timestamp: Date.UTC(2026, 9, 1),
				},
				{
					ownerKey: "acme_unified_crm.list_contacts",
					owners: [
						"acme-unified__list-contacts",
						"acme-unified__list_contacts",
					],
					timestamp: Date.UTC(2026, 9, 2),
				},
				{ ownerKey: "sample_unified.get_report", owners: ["a", "b"] },
				{ ownerKey: "", owners: ["ignored"] },
				{ owners: ["no key"] },
			]),
		).toEqual([
			{
				ownerKey: "acme_unified_crm.list_contacts",
				owners: ["acme-unified__list-contacts", "acme-unified__list_contacts"],
				events: 2,
				lastSeen: "2026-10-02T00:00:00.000Z",
			},
			{
				ownerKey: "sample_unified.get_report",
				owners: ["a", "b"],
				events: 1,
				lastSeen: null,
			},
		]);
	});
});
