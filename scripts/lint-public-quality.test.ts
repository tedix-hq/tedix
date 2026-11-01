import { describe, expect, test } from "bun:test";
import {
	baselineKey,
	compareToBaseline,
	compileRules,
	readRules,
	scanContent,
} from "./lint-public-quality";

const rules = compileRules(readRules());
const ids = (path: string, content: string) =>
	scanContent(path, content, rules).map((finding) => finding.rule);

describe("slop rules", () => {
	test("flag marketing filler and banned labels in public prose", () => {
		expect(ids("docs/public/intro.md", "A seamless experience.")).toEqual([
			"slop-marketing-words",
		]);
		expect(ids("README.md", "Tedix runs AI workers.")).toEqual([
			"slop-banned-labels",
		]);
		expect(
			ids("packages/cli/src/banner.ts", '"persistent AI workers"'),
		).toEqual(["slop-banned-labels"]);
	});

	test("leave technical uses in source comments alone", () => {
		expect(ids("apps/api/src/x.ts", "// robust to a long-lived DO")).toEqual(
			[],
		);
		expect(ids("AGENTS.md", "Avoid “AI workers”.")).toEqual([]);
	});

	test("flag comments that narrate the edit, not those stating a reason", () => {
		expect(ids("apps/api/src/x.ts", "// now we check the token")).toEqual([
			"slop-narrating-comments",
		]);
		expect(
			ids("apps/api/src/x.ts", "// the lookup costs a round trip per request"),
		).toEqual([]);
	});

	test("flag emoji in source but not text-style symbols", () => {
		expect(ids("packages/db/src/x.ts", 'const ok = "🎉";')).toEqual([
			"slop-emoji",
		]);
		expect(ids("packages/db/src/x.ts", "// gate↔objective coupling")).toEqual(
			[],
		);
	});
});

describe("internal rules", () => {
	test("flag developer paths, private links and machine names", () => {
		expect(ids("docs/public/a.md", "run /Users/jane/repo/x.sh")).toEqual([
			"internal-local-path",
		]);
		expect(
			ids("docs/public/a.md", "see https://plan.ref.tools/abc for proof"),
		).toEqual(["internal-private-links"]);
		expect(ids("scripts/x.ts", "host janes-mbp-2")).toEqual([
			"internal-machine-identity",
		]);
	});

	test("allow container paths, connector URLs and test fixtures", () => {
		expect(ids("apps/tedi/README.md", "cwd /home/tedi/workstation")).toEqual(
			[],
		);
		expect(
			ids("apps/os/src/lib/sources.ts", "https://www.notion.so/0f8fad5b"),
		).toEqual([]);
		expect(ids("apps/os/src/x.test.ts", "/Users/jane/fixture")).toEqual([]);
	});
});

describe("config rules", () => {
	test("flag hardcoded hosts, tenants and model ids in source", () => {
		expect(ids("apps/api/src/cors.ts", '"https://os.tedix.dev",')).toEqual([
			"config-hardcoded-product-host",
		]);
		expect(ids("apps/api/src/x.ts", 'orgId: "org_tedix",')).toEqual([
			"config-literal-organization-id",
		]);
		expect(ids("apps/api/src/x.ts", 'if (orgId === "org_tedix")')).toEqual([
			"config-literal-organization-id",
			"config-tenant-branch",
		]);
		expect(ids("apps/api/src/x.ts", 'const MODEL = "gpt-5-mini";')).toEqual([
			"config-hardcoded-model-id",
		]);
	});

	test("allow env-defaulted hosts, roles, sentinels and harness names", () => {
		expect(
			ids("apps/api/src/x.ts", 'env.OS_URL || "https://os.tedix.dev"'),
		).toEqual([]);
		expect(ids("apps/api/src/x.ts", 'role === "org_admin"')).toEqual([]);
		expect(ids("apps/api/src/x.ts", 'organizationId === "system"')).toEqual([]);
		expect(
			ids("apps/api/src/x.ts", 'typeof organizationId !== "string"'),
		).toEqual([]);
		expect(ids("packages/cli/src/x.ts", '"claude-code"')).toEqual([]);
		expect(ids("packages/db/src/models.ts", '"gpt-5"')).toEqual([]);
	});
});

describe("baseline", () => {
	test("keys ignore line numbers and report stale entries", () => {
		const finding = {
			path: "a.md",
			line: 3,
			rule: "slop-emoji",
			message: "",
		};
		expect(baselineKey(finding)).toBe("a.md\tslop-emoji");
		const { fresh, stale } = compareToBaseline(
			[finding],
			new Set(["a.md\tslop-emoji", "gone.md\tslop-emoji"]),
		);
		expect(fresh).toEqual([]);
		expect(stale).toEqual(["gone.md\tslop-emoji"]);
	});
});
