import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateInProfile, procedureParityGates } from "./preflight-profiles.mjs";

test("procedure parity selects only the invariant suites for every risky source path", () => {
	for (const file of [
		"packages/api-contract/src/contracts/os-app-runtime.ts",
		"packages/api-contract/src/contract-versions.ts",
		"packages/api-contract/src/utils/contract-routers.ts",
		"packages/api-contract/src/schemas/mcp-capability-scopes.ts",
		"packages/mcp/src/auth/reviewed-rpc-endpoint-scopes.ts",
		"apps/api/src/rpc/routers/connections.ts",
		"apps/api/src/rpc/os-audit.ts",
		"apps/api/src/rpc/fleet-authority-guards.json",
		"apps/mcp/src/mcp/home-surface-tools.ts",
		"apps/mcp/src/mcp/aggregate-tedis-work-items.ts",
		"apps/os/src/components/workspace-webmcp-tools.ts",
		"apps/os/src/lib/webmcp/derive-schema.ts",
		"apps/os/dev/local-fixtures.ts",
		"scripts/ci/preflight-gates.mjs",
		"scripts/ci/preflight-profiles.mjs",
	]) {
		const gates = procedureParityGates([file]);
		expect(gates.every((gate) => gate.when)).toBe(true);
		for (const gate of gates)
			for (const profile of ["local-fast", "full", "ci-policy"])
				expect(gateInProfile(gate.name, profile)).toBe(true);
		expect(gates.map((gate) => gate.cmd)).toEqual([
			[
				"bun",
				"run",
				"--cwd",
				"apps/api",
				"test:unit",
				"src/services/tool-schema-sync-scope-coverage.test.ts",
				"src/rpc/os-audit.coverage.test.ts",
				"src/rpc/routers/contract-parity.test.ts",
				"src/rpc/fleet-authority-coverage.test.ts",
				"src/rpc/contract-surface-versions.test.ts",
			],
			[
				"bun",
				"run",
				"--cwd",
				"packages/mcp",
				"test:run",
				"src/auth/reviewed-rpc-endpoint-scopes.test.ts",
			],
			[
				"bun",
				"run",
				"--cwd",
				"packages/api-contract",
				"test:run",
				"src/schemas/mcp-capability-scopes.test.ts",
			],
			[
				"bun",
				"run",
				"--cwd",
				"apps/mcp",
				"test:run",
				"src/mcp/aggregate-contract-parity.test.ts",
			],
			[
				"bun",
				"run",
				"--cwd",
				"apps/os",
				"test:unit",
				"dev/local-fixtures-parity.test.ts",
				"dev/local-fixtures.test.ts",
				"src/components/webmcp-tools-conventions.test.ts",
			],
		]);
	}
	for (const files of [
		[],
		["README.md"],
		["apps/os/src/components/avatar.tsx"],
		["packages/api-contract/src/schemas/unrelated.ts"],
	])
		expect(procedureParityGates(files).some((gate) => gate.when)).toBe(false);
	expect(procedureParityGates(null).every((gate) => gate.when)).toBe(true);
});

test("fast pre-push refuses parity failures with actionable messages", () => {
	const bin = mkdtempSync(join(tmpdir(), "preflight-parity-"));
	try {
		writeFileSync(
			join(bin, "bun"),
			`#!/bin/sh
case "$*" in
  *tool-schema-sync-scope-coverage.test.ts*)
    echo 'new endpoints without an MCP capability mapping: example/propose'
    exit 1 ;;
  *local-fixtures-parity.test.ts*)
    echo 'OS procedures checked; missing fixtures: example/propose'
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
		const run = (file: string) =>
			spawnSync(
				process.execPath,
				["scripts/ci/preflight-gates.mjs", "--local-fast", "--files", file],
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
		const result = run("packages/api-contract/src/contracts/example.ts");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"new endpoints without an MCP capability mapping: example/propose",
		);
		expect(result.stderr).toContain("missing fixtures: example/propose");
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
		const docs = run("README.md");
		expect(docs.status).toBe(0);
		expect(docs.stderr).not.toContain("procedure parity");
	} finally {
		rmSync(bin, { recursive: true, force: true });
	}
});

test("fast local checks retain source safety and owner types while CI retains every other gate", () => {
	const local = [
		"node_modules matches the lockfile",
		"format:check (Oxfmt)",
		"lint:code (Oxlint errors)",
		"lint:repo (architecture boundaries)",
		"lint:deps (Sherif)",
		"OSS secret and customer-identity scan",
		"type-check apps/api",
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
		"CMS Tedix starter template build",
		"license map, dependency licenses and patch notices",
		"migration gates for a changed migration",
	];
	for (const name of local)
		expect(gateInProfile(name, "local-fast")).toBe(true);
	for (const name of moved) {
		expect(gateInProfile(name, "local-fast")).toBe(false);
		expect(gateInProfile(name, "full")).toBe(true);
		if (!name.startsWith("tests "))
			expect(gateInProfile(name, "ci-policy")).toBe(true);
	}
	expect(gateInProfile("type-check apps/api", "ci-policy")).toBe(false);
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
