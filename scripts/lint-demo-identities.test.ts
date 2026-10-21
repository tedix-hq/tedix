import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import policy from "./demo-identity-hashes.json";
import {
	demoIdentityFindings,
	isDemoIdentityPath,
	scanDemoIdentities,
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

	test("the clean-content cache skips only contents already found clean", () => {
		const root = mkdtempSync(join(tmpdir(), "demo-identities-"));
		try {
			mkdirSync(join(root, "fixtures"));
			writeFileSync(join(root, "fixtures/clean.json"), "Maya Lindqvist");
			writeFileSync(join(root, "fixtures/bad.json"), "realperson");
			const paths = ["fixtures/clean.json", "fixtures/bad.json"];
			const first = scanDemoIdentities(root, paths, new Set(), denylist);
			expect(first.findings).toEqual([
				"fixtures/bad.json:1: use a fictional sample identity",
			]);
			expect(first.clean.size).toBe(1);
			// A cached digest is skipped; the unclean file is scanned again.
			const second = scanDemoIdentities(root, paths, first.clean, denylist);
			expect(second.findings).toEqual(first.findings);
			expect(second.clean).toEqual(first.clean);
			// Changing the clean file to an identity is caught despite the cache.
			writeFileSync(join(root, "fixtures/clean.json"), "Private customer");
			expect(
				scanDemoIdentities(root, paths, first.clean, denylist).findings,
			).toHaveLength(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
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
