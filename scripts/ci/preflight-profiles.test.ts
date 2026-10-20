import { expect, test } from "bun:test";
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
