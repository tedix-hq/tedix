import { describe, expect, test } from "bun:test";
import { DATA_BOUNDARY, renderWho } from "./who";

/**
 * `tedix who` is the only surface that works in the first five minutes of an
 * account, because every other one reads the Work board and a new organization's
 * board is empty. Its whole job is to say something true about a repository the
 * caller already has — so the two ways it can say nothing must never be
 * confused, and it must never imply it uploaded anything.
 */
const COVERAGE = "Coverage: read local HEAD plus 12 remote-tracking refs.";

function rows(
	overrides: Partial<Parameters<typeof renderWho>[0][number]>[] = [],
) {
	return overrides.map((row) => ({
		session: "claude · dev@example.com",
		tier: "coauthor" as const,
		commits: 2,
		paths: ["api/route.ts"],
		...row,
	}));
}

describe("tedix who output", () => {
	test("states the data boundary before any result", () => {
		const text = renderWho(rows([{}]), {
			hours: 24,
			scope: ["api"],
			attributed: 5,
			coverage: COVERAGE,
		});
		expect(text.startsWith(DATA_BOUNDARY)).toBe(true);
		expect(DATA_BOUNDARY).toContain("stay on this machine");
	});

	test("distinguishes 'nobody was here' from 'this repo does not say'", () => {
		const nobody = renderWho([], {
			hours: 24,
			scope: ["api"],
			attributed: 9,
			coverage: COVERAGE,
		});
		expect(nobody).toContain("Nobody else has been in these files");
		expect(nobody).not.toContain("cannot tell");

		const cannotTell = renderWho([], {
			hours: 24,
			scope: ["api"],
			attributed: 0,
			coverage: COVERAGE,
		});
		expect(cannotTell).toContain("cannot tell you who has been in");
		expect(cannotTell).toContain("Co-Authored-By");
	});

	test("always states coverage, including when it found nothing", () => {
		for (const attributed of [0, 9]) {
			const text = renderWho([], {
				hours: 24,
				scope: [],
				attributed,
				coverage: COVERAGE,
			});
			expect(text).toContain(COVERAGE);
		}
	});

	test("uses no Tedix vocabulary a new account would not recognise", () => {
		const text = renderWho(rows([{}, { tier: "session" }]), {
			hours: 24,
			scope: ["api"],
			attributed: 4,
			coverage: COVERAGE,
		});
		for (const jargon of [
			"Work Item",
			"Work-Item",
			"Agent-Session",
			"tedix work",
			"corroborat",
			"attempt",
		]) {
			expect(text).not.toContain(jargon);
		}
	});

	test("explains the coarser identity only when it used it", () => {
		const coarse = renderWho(rows([{ tier: "coauthor" }]), {
			hours: 24,
			scope: [],
			attributed: 2,
			coverage: COVERAGE,
		});
		expect(coarse).toContain("co-author line");

		const exact = renderWho(rows([{ tier: "session" }]), {
			hours: 24,
			scope: [],
			attributed: 2,
			coverage: COVERAGE,
		});
		expect(exact).not.toContain("co-author line");
	});

	test("singular and plural both read correctly", () => {
		expect(
			renderWho(rows([{ commits: 1 }]), {
				hours: 1,
				scope: [],
				attributed: 1,
				coverage: COVERAGE,
			}),
		).toContain("1 other agent touched");
		expect(
			renderWho(rows([{}, {}]), {
				hours: 1,
				scope: [],
				attributed: 2,
				coverage: COVERAGE,
			}),
		).toContain("2 other agents touched");
	});
});
