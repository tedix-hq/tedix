import { describe, expect, test } from "bun:test";
import {
	isWorkspaceProse,
	typeCheckTargets,
} from "./preflight-typecheck-targets.mjs";

const allWorkspacesExist = () => true;

describe("typeCheckTargets", () => {
	/*
	 * The regression. The derivation used to match only `apps/<name>/`, so a
	 * change confined to packages/ produced NO type-check gate and a type error
	 * there passed the pre-push preflight. This assertion fails against that
	 * behaviour and is the reason the module exists.
	 */
	test("type-checks a changed workspace under packages/", () => {
		expect(
			typeCheckTargets(["packages/cli/src/work.ts"], allWorkspacesExist),
		).toEqual(["packages/cli"]);
	});

	test("still type-checks a changed workspace under apps/", () => {
		expect(
			typeCheckTargets(["apps/os/src/main.tsx"], allWorkspacesExist),
		).toEqual(["apps/os"]);
	});

	test("covers both roots at once, sorted and de-duplicated", () => {
		expect(
			typeCheckTargets(
				[
					"packages/db/src/schema/a.ts",
					"apps/os/src/main.tsx",
					"packages/cli/src/work.ts",
					"packages/cli/src/auth-resolve.ts",
				],
				allWorkspacesExist,
			),
		).toEqual(["apps/os", "packages/cli", "packages/db"]);
	});

	/*
	 * `--all` passes null and the gate runs the whole-repo lane instead, so the
	 * per-workspace gates must stay empty rather than expanding to everything.
	 */
	test("returns nothing when the changed set is null", () => {
		expect(typeCheckTargets(null, allWorkspacesExist)).toEqual([]);
	});

	test("drops a path whose workspace no longer exists", () => {
		expect(
			typeCheckTargets(
				["packages/removed/src/gone.ts", "apps/os/src/main.tsx"],
				(dir) => dir !== "packages/removed",
			),
		).toEqual(["apps/os"]);
	});

	test("ignores paths outside a type-checked workspace root", () => {
		expect(
			typeCheckTargets(
				["README.md", "scripts/ci/preflight-gates.mjs", "docs/AGENTS.md"],
				allWorkspacesExist,
			),
		).toEqual([]);
	});

	/*
	 * A bare `packages/cli` with no trailing segment is not a source change in
	 * that workspace, and must not synthesise a gate.
	 */
	test("requires a path inside the workspace, not the directory itself", () => {
		expect(typeCheckTargets(["packages/cli"], allWorkspacesExist)).toEqual([]);
	});

	/*
	 * A docs sweep over workspace READMEs type-checked every touched workspace
	 * (and, through the dependent fan-out, 26 of them) though tsc reads none.
	 */
	test("skips a workspace's root prose", () => {
		expect(
			typeCheckTargets(
				[
					"apps/os/README.md",
					"packages/db/AGENTS.md",
					"packages/cli/CHANGELOG.md",
				],
				allWorkspacesExist,
			),
		).toEqual([]);
	});

	test("nested Markdown still selects its workspace", () => {
		expect(
			typeCheckTargets(
				["apps/cms/templates/tedix/README.md", "apps/landing/src/content/a.md"],
				allWorkspacesExist,
			),
		).toEqual(["apps/cms", "apps/landing"]);
	});
});

describe("isWorkspaceProse", () => {
	test("matches only a workspace's root prose files", () => {
		expect(isWorkspaceProse("apps/os/README.md")).toBe(true);
		expect(isWorkspaceProse("packages/cli/CHANGELOG.md")).toBe(true);
		expect(isWorkspaceProse("README.md")).toBe(false);
		expect(isWorkspaceProse("apps/os/DESIGN.md")).toBe(false);
		expect(isWorkspaceProse("apps/os/src/README.md")).toBe(false);
		expect(isWorkspaceProse("packages/cli/README.mdx")).toBe(false);
	});
});
