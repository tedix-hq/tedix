import { describe, expect, it } from "vite-plus/test";
import { TEAM_TAB_IDS, TEAM_TABS, teamSearchSchema } from "./team-tabs";

describe("team search schema", () => {
	it("defaults an empty search to the roster tab and first page", () => {
		expect(teamSearchSchema.parse({})).toEqual({ tab: "tedis", page: 1 });
	});

	it("accepts every declared tab", () => {
		for (const tab of TEAM_TAB_IDS) {
			expect(teamSearchSchema.parse({ tab })).toMatchObject({ tab });
		}
	});

	it("falls back instead of failing on an unrecognized or hand-typed value", () => {
		// `.catch` semantics: a bad search must land on the page, not error it.
		expect(teamSearchSchema.parse({ tab: "everyone" })).toMatchObject({
			tab: "tedis",
		});
		expect(teamSearchSchema.parse({ tab: 42, page: "x" })).toEqual({
			tab: "tedis",
			page: 1,
		});
	});

	it("refuses page values below 1 and non-integers", () => {
		expect(teamSearchSchema.parse({ page: 0 })).toMatchObject({ page: 1 });
		expect(teamSearchSchema.parse({ page: -3 })).toMatchObject({ page: 1 });
		expect(teamSearchSchema.parse({ page: 2.5 })).toMatchObject({ page: 1 });
		expect(teamSearchSchema.parse({ page: 4 })).toMatchObject({ page: 4 });
	});

	it("keeps the tab strip and the schema on the same vocabulary", () => {
		expect(TEAM_TABS.map((tab) => tab.id)).toEqual([...TEAM_TAB_IDS]);
	});
});
