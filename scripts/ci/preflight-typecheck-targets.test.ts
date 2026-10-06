import { describe, expect, test } from "bun:test";
import { typeCheckTargets } from "./preflight-typecheck-targets.mjs";

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
});
