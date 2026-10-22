import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateInProfile } from "./preflight-profiles.mjs";

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
