import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import policy from "./demo-identity-hashes.json";
import {
	demoIdentityFindings,
	isDemoIdentityPath,
} from "./lint-demo-identities";

const denylist = [
	{ words: 1, sha256: createHash("sha256").update("realperson").digest("hex") },
	{
		words: 2,
		sha256: createHash("sha256").update("private customer").digest("hex"),
	},
];

describe("demo identity guard", () => {
	test("ships a nonempty hash-only policy", () => {
		expect(policy.length).toBeGreaterThan(0);
		expect(new Set(policy.map((entry) => entry.sha256)).size).toBe(
			policy.length,
		);
		for (const entry of policy) {
			expect(Object.keys(entry).sort()).toEqual(["sha256", "words"]);
			expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(Number.isInteger(entry.words) && entry.words > 0).toBe(true);
		}
	});

	test("covers packs, seeders, browser fixtures, snapshots and public examples", () => {
		for (const path of [
			"apps/os/dev/demo-pack/cards.json",
			"apps/os/dev/demo-pack.ts",
			"apps/os/dev/local-fixtures.ts",
			"scripts/local-demo-pack-seed.ts",
			"apps/os/browser-tests/deck.tsx",
			"packages/db/src/queries/example.test.ts",
			"tests/snapshots/deck.snap",
			"apps/api/src/services/example.fixture.json",
			"examples/supplier-review/input.md",
			"docs/public/getting-started.md",
			"AGENT-REVIEW.md",
		])
			expect(isDemoIdentityPath(path)).toBe(true);
		expect(isDemoIdentityPath("apps/os/src/components/work-shell.tsx")).toBe(
			false,
		);
	});

	test("matches names, possessives, emails, punctuation and Unicode escapes without leaking text", () => {
		for (const text of [
			"REALPERSON’s review",
			"realperson@fictional.example",
			"Private-Customer",
			"private_customer",
			"Private\nCustomer",
			String.raw`"\u0052ealperson"`,
		]) {
			const findings = demoIdentityFindings(
				"fixtures/example.json",
				text,
				denylist,
			);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toBe(
				"fixtures/example.json:1: use a fictional sample identity",
			);
		}
	});

	test("uses token boundaries and allows fictional identities and vendors", () => {
		expect(
			demoIdentityFindings(
				"fixtures/example.json",
				"Maya Lindqvist at PricePilot uses Cloudflare and GitHub; notrealperson",
				denylist,
			),
		).toEqual([]);
	});
});
