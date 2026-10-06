import { describe, expect, test } from "bun:test";
import {
	affectedWorkspaces,
	relatedTestTargetsByWorkspace,
	testRunnerFor,
} from "./preflight-test-targets.mjs";

/**
 * A small stand-in repo: one shared package, one app that consumes it, one app
 * that does not, and one workspace with no test runner.
 */
const WORKSPACE_DIRS = [
	"packages/api-contract",
	"packages/untested",
	"apps/mcp",
	"apps/untested",
];

const MANIFESTS: Record<string, { name: string; deps: Set<string> }> = {
	"packages/api-contract": { name: "@tedix/api-contract", deps: new Set() },
	"packages/untested": { name: "@tedix/untested", deps: new Set() },
	"apps/mcp": {
		name: "@tedix/mcp",
		deps: new Set(["@tedix/api-contract", "@tedix/untested"]),
	},
	"apps/untested": { name: "@tedix/untested", deps: new Set() },
};

const io = {
	// apps/untested ships no test runner, so it can never be a target.
	isTestableWorkspace: (dir: string) => dir !== "apps/untested",
	readManifest: (dir: string) => MANIFESTS[dir] ?? null,
	workspaceDirs: WORKSPACE_DIRS,
};

describe("relatedTestTargetsByWorkspace", () => {
	/*
	 * THE REGRESSION. Grouping by owning workspace ran only the shared package's
	 * own tests, so the consumer test that encodes its contract was never
	 * selected. That is how apps/mcp's codemode-auth fail-closed test went red on
	 * main for five days after a change to this exact file. The dependent must
	 * appear here, reaching back out of its own directory for the path.
	 */
	test("runs a changed package's tests in the workspaces that depend on it", () => {
		const targets = relatedTestTargetsByWorkspace(
			["packages/api-contract/src/schemas/mcp-capability-scopes.ts"],
			io,
		);
		expect([...targets.keys()]).toEqual(["apps/mcp", "packages/api-contract"]);
		expect(targets.get("packages/api-contract")).toEqual([
			"src/schemas/mcp-capability-scopes.ts",
		]);
		expect(targets.get("apps/mcp")).toEqual([
			"../../packages/api-contract/src/schemas/mcp-capability-scopes.ts",
		]);
	});

	test("does not pull in a workspace that does not depend on the package", () => {
		const targets = relatedTestTargetsByWorkspace(
			["packages/api-contract/src/schemas/a.ts"],
			io,
		);
		expect(targets.has("apps/untested")).toBe(false);
	});

	test("skips a dependent with no test runner", () => {
		// apps/untested would depend on it, but has no vitest/vite config.
		const targets = relatedTestTargetsByWorkspace(
			["packages/untested/src/a.ts"],
			{
				...io,
				readManifest: (dir: string) =>
					dir === "apps/untested"
						? { name: "@tedix/untested", deps: new Set(["@tedix/untested"]) }
						: (MANIFESTS[dir] ?? null),
			},
		);
		expect(targets.has("apps/untested")).toBe(false);
		expect(targets.has("apps/mcp")).toBe(true);
	});

	/*
	 * An app is a leaf: nothing imports it, so it must not fan out. Without this
	 * the gate would re-run unrelated suites on every ordinary app change and
	 * the added time would be blamed on the fan-out rather than on the bug.
	 */
	test("an app change stays in its own workspace", () => {
		const targets = relatedTestTargetsByWorkspace(
			["apps/mcp/src/mcp/codemode-auth.ts"],
			io,
		);
		expect([...targets.keys()]).toEqual(["apps/mcp"]);
		expect(targets.get("apps/mcp")).toEqual(["src/mcp/codemode-auth.ts"]);
	});

	test("de-duplicates and sorts the paths per workspace", () => {
		const targets = relatedTestTargetsByWorkspace(
			[
				"packages/api-contract/src/schemas/b.ts",
				"packages/api-contract/src/schemas/a.ts",
				"packages/api-contract/src/schemas/b.ts",
			],
			io,
		);
		expect(targets.get("packages/api-contract")).toEqual([
			"src/schemas/a.ts",
			"src/schemas/b.ts",
		]);
	});

	/*
	 * `--all` passes null: the gate runs the whole-repo lane instead, and an
	 * empty map must not be mistaken for "nothing to test".
	 */
	test("returns nothing when the changed set is unknown", () => {
		expect(relatedTestTargetsByWorkspace(null, io).size).toBe(0);
		expect(relatedTestTargetsByWorkspace([], io).size).toBe(0);
	});

	test("ignores paths outside a workspace", () => {
		expect(
			relatedTestTargetsByWorkspace(["bun.lock", "docs/README.md"], io).size,
		).toBe(0);
	});
});

describe("testRunnerFor", () => {
	/*
	 * THE REGRESSION. The gate decided "can this workspace be tested?" by looking
	 * for a vitest/vite config at the workspace root. packages/db (178 test
	 * files) and packages/api-contract (64) keep no such config and were skipped
	 * entirely, even though `vp test related` runs in both. 553 test files across
	 * 21 workspaces were invisible to the only check standing before production.
	 */
	test("a workspace whose script runs vp test is vitest, config file or not", () => {
		expect(testRunnerFor({ testScript: "vp test run" }, false)).toBe("vitest");
		expect(
			testRunnerFor(
				{ testScript: "vp test run --exclude 'src/**/*.integration.test.ts'" },
				false,
			),
		).toBe("vitest");
		expect(testRunnerFor({ testScript: "vitest run" }, false)).toBe("vitest");
	});

	test("a config file alone still counts, for a script that delegates", () => {
		// apps/tedi-workstation-egress-broker: "bun run test:workerd".
		expect(testRunnerFor({ testScript: "bun run test:workerd" }, true)).toBe(
			"vitest",
		);
	});

	test("a bun:test workspace gets the whole-suite lane", () => {
		// packages/cli — 1,189 tests that never ran in preflight.
		expect(
			testRunnerFor({ testScript: "bun test --max-concurrency=1" }, false),
		).toBe("bun");
		// apps/tedi-runtime's hand-rolled loop over its assertion scripts.
		expect(
			testRunnerFor(
				{
					testScript: 'for f in src/*.test.ts; do bun run "$f" || exit 1; done',
				},
				false,
			),
		).toBe("bun");
	});

	test("a workspace with no test script has no lane", () => {
		expect(testRunnerFor({ testScript: "" }, false)).toBe(null);
		expect(testRunnerFor(null, false)).toBe(null);
	});
});

describe("affectedWorkspaces", () => {
	const io2 = {
		isRelevantWorkspace: (dir: string) => dir in MANIFESTS,
		readManifest: (dir: string) => MANIFESTS[dir] ?? null,
		workspaceDirs: WORKSPACE_DIRS,
	};

	/*
	 * THE REGRESSION, typecheck half. Type-checking only the OWNING workspace
	 * misses a consumer-only break: renaming an export nothing inside the package
	 * uses type-checks clean there and fails in every consumer. Verified live
	 * against packages/api-contract → packages/mcp, where NO type-check gate
	 * fired before this.
	 */
	test("includes the dependents of a changed package", () => {
		expect(
			affectedWorkspaces(
				["packages/api-contract/src/schemas/mcp-capability-scopes.ts"],
				io2,
			),
		).toEqual(["apps/mcp", "packages/api-contract"]);
	});

	test("an app change stays in its own workspace", () => {
		expect(affectedWorkspaces(["apps/mcp/src/index.ts"], io2)).toEqual([
			"apps/mcp",
		]);
	});

	test("returns nothing for an unknown changed set or a non-workspace path", () => {
		expect(affectedWorkspaces(null, io2)).toEqual([]);
		expect(affectedWorkspaces(["bun.lock"], io2)).toEqual([]);
	});
});
