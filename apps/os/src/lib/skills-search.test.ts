import { describe, expect, it } from "vite-plus/test";
import { validateSkillsSearch } from "./skills-search";

const validate = (search: Parameters<typeof validateSkillsSearch>[0]) =>
	validateSkillsSearch(search);

describe("validateSkillsSearch", () => {
	it("defaults invalid and missing state", () => {
		expect(validate({} as Parameters<typeof validate>[0])).toEqual({
			section: "skills",
			q: "",
			page: 1,
		});
		expect(
			validate({ section: "removed" as "skills", page: 0 } as Parameters<
				typeof validate
			>[0]),
		).toEqual({ section: "skills", q: "", page: 1 });
	});

	it("preserves valid shareable state", () => {
		expect(
			validate({ section: "workflows", q: "deploy", page: 3 } as Parameters<
				typeof validate
			>[0]),
		).toEqual({ section: "workflows", q: "deploy", page: 3 });
	});
});
