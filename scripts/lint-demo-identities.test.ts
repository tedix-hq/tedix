import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import policy from "./demo-identity-hashes.json";
import {
	createDemoIdentityScanner,
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

test("cold scans hash each distinct normalized phrase once across files", () => {
	const phrases: string[] = [];
	const scan = createDemoIdentityScanner(denylist, (phrase) => {
		phrases.push(phrase);
		return createHash("sha256").update(phrase).digest("hex");
	});
	const source = "Realperson private\ncustomer realperson private\ncustomer";
	expect(scan("fixtures/first.txt", source)).toEqual([
		"fixtures/first.txt:1: use a fictional sample identity",
		"fixtures/first.txt:2: use a fictional sample identity",
	]);
	const first = [...phrases];
	expect(new Set(first).size).toBe(first.length);
	expect(scan("fixtures/second.txt", source.toUpperCase())).toEqual([
		"fixtures/second.txt:1: use a fictional sample identity",
		"fixtures/second.txt:2: use a fictional sample identity",
	]);
	expect(phrases).toEqual(first);
	expect(createDemoIdentityScanner([])("fixtures/other.txt", source)).toEqual(
		[],
	);
});

test("preserves overlapping matches, normalized line numbers and long phrases", () => {
	const long = "one two three four five six seven eight nine";
	const hashes = [
		...denylist,
		{ words: 9, sha256: createHash("sha256").update(long).digest("hex") },
	];
	const source = String.raw`ｒｅａｌｐｅｒｓｏｎ\u000aPRIVATE
customer
one two three four five six seven eight nine
private customer realperson`;
	expect(demoIdentityFindings("fixtures/overlap.txt", source, hashes)).toEqual(
		[1, 2, 4, 5].map(
			(line) => `fixtures/overlap.txt:${line}: use a fictional sample identity`,
		),
	);
});

test("cached line transitions retain the original sliding-window verdicts", () => {
	const phrases = [
		"realperson",
		"private customer",
		"one two three four five six seven eight nine",
	];
	const hashes = phrases.map((phrase) => ({
		words: phrase.split(" ").length,
		sha256: createHash("sha256").update(phrase).digest("hex"),
	}));
	const scan = createDemoIdentityScanner(hashes);
	const rows = [
		"realperson",
		"PRIVATE",
		"customer",
		"one two three",
		"four five",
		"six seven eight nine",
		"",
		"---",
		String.raw`\u000aｒｅａｌｐｅｒｓｏｎ`,
		"fictional vendor",
	];
	for (let seed = 0; seed < 128; seed++) {
		const source = Array.from(
			{ length: 12 },
			(_, i) => rows[(seed * (i + 1) + i * i) % rows.length],
		).join("\n");
		const normalized = source
			.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
				String.fromCharCode(parseInt(hex, 16)),
			)
			.normalize("NFKC")
			.toLowerCase();
		const tokens = [...normalized.matchAll(/[\p{L}\p{N}]+/gu)];
		const expected = new Set<number>();
		for (let i = 0; i < tokens.length; i++) {
			for (const phrase of phrases) {
				const candidate = tokens
					.slice(i, i + phrase.split(" ").length)
					.map((token) => token[0])
					.join(" ");
				if (candidate === phrase)
					expected.add(
						normalized.slice(0, tokens[i]!.index).split("\n").length,
					);
			}
		}
		expect(scan(`fixtures/${seed}.txt`, source)).toEqual(
			[...expected].map(
				(line) =>
					`fixtures/${seed}.txt:${line}: use a fictional sample identity`,
			),
		);
	}
});
