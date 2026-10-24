import { describe, expect, it } from "bun:test";
import { groupToolCollisions, parseReportHours } from "./tool-collision-report";

describe("parseReportHours", () => {
	it("uses the default report window when --hours is absent", () => {
		expect(parseReportHours([])).toBe(24);
	});

	it("accepts positive plain decimal hours within the report window", () => {
		expect(parseReportHours(["--hours", "168"])).toBe(168);
	});

	it.each(["0", "-1", "1.5", "1e3", "0x10", " 24", "024"])(
		"rejects malformed --hours value %j",
		(value) => {
			expect(() => parseReportHours(["--hours", value])).toThrow(
				"positive plain decimal",
			);
		},
	);

	it("rejects report windows longer than one week", () => {
		expect(() => parseReportHours(["--hours", "169"])).toThrow("at most 168");
	});
});

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
