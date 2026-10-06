import { describe, expect, it } from "vite-plus/test";
import {
	DELEGATION_WORK_ITEM_TITLE_MAX,
	delegationWorkItemTitle,
} from "./delegation-work-item";

describe("delegationWorkItemTitle", () => {
	/*
	 * A context reference carries its own colons, so the first-clause split used
	 * to stop inside the token and title the item `[[tedix-context`. Four items
	 * were created that way. The well-formed sibling of the same delegation is
	 * titled "Delegate once to CTO", which is what the token-led content must
	 * now produce too.
	 */
	it("titles from the instruction, not a leading context reference", () => {
		const token =
			"[[tedix-context:workspace:5eed0014-0000-4000-8000-000000000014:Delegate%20once%20to%20CTO%3A%20perform%20a%20read-only%20check%E2%80%A6]]";
		const instruction =
			"Delegate once to CTO: read your assigned addresses now and return only the count of active primary addresses.";
		expect(delegationWorkItemTitle(`${token}\n\n${instruction}`)).toBe(
			"Delegate once to CTO",
		);
		expect(delegationWorkItemTitle(instruction)).toBe("Delegate once to CTO");
	});

	it("falls back rather than titling an item with a bare context reference", () => {
		expect(
			delegationWorkItemTitle(
				"[[tedix-context:workspace:5eed0014-0000-4000-8000-000000000014:x]]",
			),
		).toBe("Home delegation");
	});

	it("drops an unterminated context reference too", () => {
		expect(
			delegationWorkItemTitle(
				"[[tedix-context:workspace:abc:Do the thing\n\nDo the thing now.",
			),
		).toBe("Do the thing now");
	});

	it("never uses the raw prompt: first clause, courtesy stripped, capitalised, no trailing punctuation", () => {
		expect(
			delegationWorkItemTitle(
				"please list my 3 most recently updated work items as a markdown table. Include title, status, and updated date; sort descending.",
			),
		).toBe("List my 3 most recently updated work items as a markdown");
	});

	it("caps on a word boundary at the max length", () => {
		const title = delegationWorkItemTitle(
			"review the entire onboarding funnel for the globex pilot and propose three concrete improvements with owners",
		);
		expect(title.length).toBeLessThanOrEqual(DELEGATION_WORK_ITEM_TITLE_MAX);
		expect(title).toBe(
			"Review the entire onboarding funnel for the globex pilot",
		);
	});

	it("strips 'can you' / 'por favor' openers", () => {
		expect(delegationWorkItemTitle("Can you rotate the API keys?")).toBe(
			"Rotate the API keys",
		);
		expect(
			delegationWorkItemTitle("por favor, revisa las facturas de julio"),
		).toBe("Revisa las facturas de julio");
	});

	it("prefers an explicit title and falls back for empty input", () => {
		expect(delegationWorkItemTitle("whatever", "  Rotate keys. ")).toBe(
			"Rotate keys",
		);
		expect(delegationWorkItemTitle("   ")).toBe("Home delegation");
	});
});
