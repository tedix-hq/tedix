import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateInProfile, procedureParityGates } from "./preflight-profiles.mjs";

test("procedure parity runs the checks whose inputs changed", () => {
	const all = procedureParityGates(null).map((gate) => gate.name);
	const [api, reviewed, capability, native] = all;
	if (!api || !reviewed || !capability || !native)
		throw new Error("Expected four parity checks");
	const cases = [
		[null, all],
		["scripts/ci/preflight-gates.mjs", all],
		["packages/api-contract/src/contracts/os-app-runtime.ts", all],
		["packages/api-contract/src/utils/contract-routers.ts", all],
		[
			"packages/api-contract/src/schemas/mcp-capability-scopes.ts",
			[api, reviewed, capability],
		],
		["packages/mcp/src/auth/reviewed-rpc-endpoint-scopes.ts", [api, reviewed]],
		["apps/mcp/src/mcp/aggregate-tedi-catalog.generated.json", [native]],
		["apps/mcp/src/mcp/home-surface-tools.ts", [native]],
		["apps/api/src/rpc/routers/connections.ts", [api]],
		["apps/api/src/rpc/os-audit.ts", [api]],
		["apps/api/src/rpc/fleet-authority-guards.json", [api]],
		["apps/api/src/services/tool-schema-projection.ts", [api]],
		["apps/api/src/rpc/routers/contract-parity.test.ts", [api]],
		["apps/api/src/rpc/routers/projects.portfolio-access.test.ts", []],
		["README.md", []],
	] as const;
	for (const [file, expected] of cases) {
		const selected = procedureParityGates(file === null ? null : [file])
			.filter((gate) => gate.when)
			.map((gate) => gate.name);
		expect(selected).toEqual([...expected]);
	}
});

describe("fast pre-push parity failures", () => {
	const bin = mkdtempSync(join(tmpdir(), "preflight-parity-"));
	writeFileSync(
		join(bin, "bun"),
		`#!/bin/sh
case "$*" in
  *tool-schema-sync-scope-coverage.test.ts*)
    i=0
    while [ "$i" -lt 14 ]; do
      echo 'test runner output before the failure'
      i=$((i + 1))
    done
    echo 'new endpoints without an MCP capability mapping: example/propose'
    exit 1 ;;
  *reviewed-rpc-endpoint-scopes.test.ts*)
    echo 'reviewed endpoint without a valid scope: example/propose'
    exit 1 ;;
  *mcp-capability-scopes.test.ts*)
    echo 'tool without an exact capability scope: propose_example'
    exit 1 ;;
  *aggregate-contract-parity.test.ts*)
    echo 'aggregate tool without a contract procedure: example/propose'
    exit 1 ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	const run = (file: string) => {
		const result = Bun.spawnSync(
			[
				process.execPath,
				"scripts/ci/preflight-gates.mjs",
				"--local-fast",
				"--files",
				file,
			],
			{
				cwd: new URL("../..", import.meta.url).pathname,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					TEDIX_PUSH_TRAIN_RANGES: "[]",
					CI: "true",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		return {
			status: result.exitCode,
			stderr: result.stderr.toString(),
		};
	};
	const result = run("packages/api-contract/src/contracts/example.ts");
	const docs = run("README.md");
	afterAll(() => rmSync(bin, { recursive: true, force: true }));

	test("refuses parity failures with actionable messages", () => {
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"new endpoints without an MCP capability mapping: example/propose",
		);
		for (const message of [
			"reviewed endpoint without a valid scope: example/propose",
			"tool without an exact capability scope: propose_example",
			"aggregate tool without a contract procedure: example/propose",
		])
			expect(result.stderr).toContain(message);
		for (const gate of procedureParityGates(null)) {
			expect(result.stderr).toContain(gate.name);
			expect(result.stderr).toContain(`fix: ${gate.fix}`);
		}
		expect(docs.status).toBe(0);
		expect(docs.stderr).not.toContain("procedure parity");
	});
});

test("fast pre-push leaves workspace type checking to Main verify", () => {
	const local = [
		"node_modules matches the lockfile",
		"format:check (Oxfmt)",
		"lint:code (Oxlint errors)",
		"lint:repo (architecture boundaries)",
		"lint:deps (Sherif)",
		"OSS secret and customer-identity scan",
		"type-check scripts/",
		"migration order against the push base",
	];
	const moved = [
		"tests (packages/cli)",
		"tests related to the changed files (apps/api)",
		"changed script tests",
		"actionlint",
		"workflow timeouts and pull_request_target safety",
		"generated Worker types are current",
		"D1 schema, history, chain, destructive-DDL",
		"widget build",
		"cms-runtime build",
		"CMS Tedix starter template build",
		"license map, dependency licenses and patch notices",
		"migration gates for a changed migration",
	];
	for (const name of local)
		expect(gateInProfile(name, "local-fast")).toBe(true);
	for (const name of moved) {
		expect(gateInProfile(name, "local-fast")).toBe(false);
		expect(gateInProfile(name, "full")).toBe(true);
		if (!name.startsWith("tests ") && name !== "changed script tests")
			expect(gateInProfile(name, "ci-policy")).toBe(true);
	}
	for (const workspace of ["apps/cms", "packages/db"]) {
		const gate = `type-check ${workspace}`;
		expect(gateInProfile(gate, "local-fast")).toBe(false);
		expect(gateInProfile(gate, "ci-policy")).toBe(false);
		expect(gateInProfile(gate, "full")).toBe(true);
	}
	expect(
		gateInProfile("type-check:workers apps/tedi-runtime", "ci-policy"),
	).toBe(true);
});

test("successful preflight exposes only lint:repo gate timings", () => {
	const bin = mkdtempSync(join(tmpdir(), "preflight-timings-"));
	try {
		writeFileSync(
			join(bin, "bun"),
			String.raw`#!/bin/sh
 if [ "$*" = "run lint:repo" ]; then
 printf '\033[32mok   scripts/lint-d1.ts (1.2s)\033[0m\n'
 printf 'ok   scripts/lint-authz.ts --strict (2.3s)\n'
 printf 'lint:repo: 2 gates passed in 2.3s\n'
 else
 printf 'successful child noise\n'
 fi
 `,
			{ mode: 0o755 },
		);
		const result = spawnSync(
			process.execPath,
			[
				"scripts/ci/preflight-gates.mjs",
				"--local-fast",
				"--files",
				"README.md",
			],
			{
				cwd: new URL("../..", import.meta.url),
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					TEDIX_PUSH_TRAIN_RANGES: "[]",
				},
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		expect(
			result.stdout.split("\n").filter((line) => line.startsWith("ok   ")),
		).toEqual([
			"ok   scripts/lint-d1.ts (1.2s)",
			"ok   scripts/lint-authz.ts --strict (2.3s)",
		]);
		expect(result.stdout).not.toContain("successful child noise");
		expect(result.stdout).not.toContain("lint:repo: 2 gates");
	} finally {
		rmSync(bin, { recursive: true, force: true });
	}
});
