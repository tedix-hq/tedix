import { describe, expect, it } from "vite-plus/test";
import { skillsContract } from "./cognitive";

const validateInput = skillsContract.validate["~orpc"].inputSchemas[0]!;

describe("skills.validate input", () => {
	it("accepts draft skill fields", () => {
		expect(validateInput.parse({ title: "Draft", content: "# Draft" })).toEqual(
			{ title: "Draft", content: "# Draft" },
		);
	});

	it.each(["id", "skillId", "slug"])(
		"rejects removed stored-skill field %s",
		(field) => {
			expect(() => validateInput.parse({ [field]: "stored-skill" })).toThrow();
		},
	);
});
