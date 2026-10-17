import { describe, expect, test } from "bun:test";
import { sessionGenericityFindings } from "./lint-session-genericity";

describe("session genericity", () => {
	for (const identifier of [
		"Lead",
		"Aaron",
		"ff227ab0",
		"org_tedix",
		"night shift",
		"Europe/Berlin",
		"10000000-0000-4000-8000-000000000001",
	]) {
		test(`rejects ${identifier} in session source, UI and plugin instructions`, () => {
			for (const path of [
				"apps/api/src/services/agent-session-request-ledger.ts",
				"apps/os/src/components/work-attention-page.tsx",
				"packages/cli/src/lane.ts",
				"plugins/tedix/skills/tedix-session-guide/SKILL.md",
			]) {
				expect(
					sessionGenericityFindings(path, `const value = "${identifier}";`),
				).toHaveLength(1);
			}
		});
	}
	test("allows fixture identities and generic session language", () => {
		expect(
			sessionGenericityFindings(
				"packages/cli/src/hooks/request-ledger.test.ts",
				"Lead in Berlin",
			),
		).toEqual([]);
		expect(
			sessionGenericityFindings(
				"packages/context-core/src/request-ledger-precision.json",
				"Lead",
			),
		).toEqual([]);
		expect(
			sessionGenericityFindings(
				"plugins/tedix/skills/tedix-session-guide/SKILL.md",
				"A lead session coordinates other sessions.",
			),
		).toEqual([]);
		expect(
			sessionGenericityFindings(
				"apps/os/src/components/work-attention-page.tsx",
				"Your requests · Attention · Session activity",
			),
		).toEqual([]);
	});
});
