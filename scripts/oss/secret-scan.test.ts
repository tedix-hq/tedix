import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	parseCli,
	PRIVATE_SCAN_RULES_PATH,
	readPrivateScanRules,
	requirePrivateScanRules,
	renderSecretScan,
	scanCommits,
	scanTrackedFiles,
	trailerFindings,
} from "./secret-scan";
import { detachedGitEnv } from "./git-env";

const fixtures: string[] = [];

function fixture(files: Record<string, string>): string {
	const root = mkdtempSync(resolve(tmpdir(), "tedix-secret-scan-"));
	fixtures.push(root);
	const initialized = spawnSync(
		"git",
		["init", "--quiet", "--initial-branch=main"],
		{ cwd: root, env: detachedGitEnv() },
	);
	if (initialized.status !== 0) throw new Error(initialized.stderr.toString());
	for (const [path, content] of Object.entries(files)) {
		const destination = resolve(root, path);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, content);
	}
	const added = spawnSync("git", ["add", "--all"], {
		cwd: root,
		env: detachedGitEnv(),
	});
	if (added.status !== 0) throw new Error(added.stderr.toString());
	return root;
}

function commitFixture(
	root: string,
	identity: string,
	message: string,
): string {
	const [name = "", email = ""] = identity.split("|");
	const result = spawnSync(
		"git",
		[
			"-c",
			`user.name=${name}`,
			"-c",
			`user.email=${email}`,
			"commit",
			"--quiet",
			"--allow-empty",
			"-m",
			message,
		],
		{ cwd: root, env: detachedGitEnv() },
	);
	if (result.status !== 0) throw new Error(result.stderr.toString());
	return spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		env: detachedGitEnv(),
	})
		.stdout.toString()
		.trim();
}

function setOriginMain(root: string, commit: string): void {
	const result = spawnSync(
		"git",
		["update-ref", "refs/remotes/origin/main", commit],
		{ cwd: root, env: detachedGitEnv() },
	);
	if (result.status !== 0) throw new Error(result.stderr.toString());
}

afterEach(() => {
	for (const root of fixtures.splice(0)) rmSync(root, { recursive: true });
});

/**
 * Placeholder overlay in the shape of `private-scan-rules.json`. The real
 * file names customers and live ids, so it never ships and never appears in
 * this (published) test; these invented values exercise the same mechanics.
 */
const PLACEHOLDER_ACCOUNT = "0123456789abcdef0123456789abcdef";
function placeholderRules(): string {
	const dir = mkdtempSync(resolve(tmpdir(), "tedix-secret-rules-"));
	fixtures.push(dir);
	const path = resolve(dir, "private-scan-rules.json");
	writeFileSync(
		path,
		JSON.stringify({
			rules: [
				{
					rule: "customer-identity",
					pattern: "(?<![a-z0-9])globexcorp",
					flags: "i",
					examples: ["globexcorp"],
				},
				{
					rule: "cloudflare-account-id",
					pattern: PLACEHOLDER_ACCOUNT,
					flags: "i",
					exemptExportRewritten: true,
					examples: [PLACEHOLDER_ACCOUNT],
				},
			],
		}),
	);
	return path;
}

describe("public secret scan", () => {
	test("NUL-containing source cannot bypass private content rules", () => {
		const root = fixture({
			"src/example.ts": "export const tenant = 'globex\0corp';\n",
			"assets/example.png": "\0synthetic image bytes globexcorp",
		});
		const findings = scanTrackedFiles(root, {
			privateRulesPath: placeholderRules(),
		});
		expect(findings.map(({ path, rule }) => ({ path, rule }))).toEqual([
			{ path: "src/example.ts", rule: "nul-in-text-source" },
			{ path: "src/example.ts", rule: "customer-identity" },
		]);
	});
	test("public Worker configs cannot inherit private export rewrite exemptions", () => {
		const project = ["P3", "Syntheticproject0000000000"].join("");
		const bucket = `pub-${"0123456789abcdef".repeat(2)}.r2.dev`;
		const aura = ["neo4j+s://", "0badc0de", ".databases.neo4j.io"].join("");
		const founder = `${["Aa", "ron"].join("")} Codex`;
		const config = JSON.stringify({
			vars: {
				DESCOPE_PROJECT_ID: project,
				ASSETS_URL: bucket,
				GRAPH_DB_URI: aura,
				OWNER: founder,
			},
			account_id: PLACEHOLDER_ACCOUNT,
		});
		const privateRulesPath = placeholderRules();
		for (const path of [
			"apps/api/wrangler.jsonc",
			"apps/os/cloudflare.config.ts",
		]) {
			const files = {
				[path]: config,
				"LICENSES/example.txt": `Author: author@${["license", "holder.net"].join("-")}\n`,
			};
			const publicFindings = scanTrackedFiles(fixture(files), {
				privateRulesPath,
			});
			expect(
				publicFindings
					.map((finding) => `${finding.path}:${finding.rule}`)
					.sort(),
			).toEqual(
				[
					`${path}:cloudflare-account-id`,
					`${path}:descope-project-id`,
					`${path}:founder-identity`,
					`${path}:neo4j-aura-uri`,
					`${path}:r2-public-bucket`,
				].sort(),
			);
			expect(
				scanTrackedFiles(
					fixture({ ...files, "scripts/oss/public-files.json": "{}\n" }),
					{ privateRulesPath },
				),
			).toEqual([]);
		}
	});
	test("reviewed founder path metadata does not exempt reasons, credentials or stale references", () => {
		const founder = ["aa", "ron"].join("");
		const path = `apps/landing/src/pages/${founder}-linktree.astro`;
		const content = `<strong>${founder} </strong>\n`;
		const allowancePath = "scripts/oss/secret-scan-allowlist.json";
		const entry = {
			path,
			rule: "founder-identity",
			sha256: createHash("sha256").update(content).digest("hex"),
			reason: "Reviewed public founder attribution",
		};
		const allowance = (reason: string) =>
			JSON.stringify({
				privateKeyHeaders: [],
				secretScan: [{ ...entry, reason }],
			});
		const root = fixture({
			[path]: content,
			[allowancePath]: allowance(entry.reason),
		});
		expect(scanTrackedFiles(root)).toEqual([]);
		writeFileSync(
			resolve(root, allowancePath),
			JSON.stringify({
				privateKeyHeaders: [],
				secretScan: [entry, { ...entry, rule: "github-token" }],
			}),
		);
		expect(
			scanTrackedFiles(root).some(
				(finding) =>
					finding.path === allowancePath && finding.rule === "founder-identity",
			),
		).toBe(true);
		writeFileSync(resolve(root, allowancePath), allowance(entry.reason));
		spawnSync("git", ["rm", "--cached", "--", path], {
			cwd: root,
			env: detachedGitEnv(),
		});
		expect(
			scanTrackedFiles(root, { paths: [allowancePath] }).some(
				(finding) => finding.rule === "founder-identity",
			),
		).toBe(true);
		spawnSync("git", ["add", "--", path], { cwd: root, env: detachedGitEnv() });
		writeFileSync(resolve(root, allowancePath), allowance(`${founder} `));
		expect(
			scanTrackedFiles(root).some(
				(finding) =>
					finding.path === allowancePath && finding.rule === "founder-identity",
			),
		).toBe(true);
		const fakeToken = ["ghp", "_123456789012345678901234"].join("");
		writeFileSync(resolve(root, allowancePath), allowance(fakeToken));
		expect(
			scanTrackedFiles(root).some(
				(finding) =>
					finding.path === allowancePath && finding.rule === "github-token",
			),
		).toBe(true);
		writeFileSync(resolve(root, allowancePath), allowance(entry.reason));
		writeFileSync(resolve(root, path), content + "<!-- later edit -->\n");
		const stale = scanTrackedFiles(root);
		expect(
			stale.some(
				(finding) =>
					finding.path === allowancePath && finding.rule === "founder-identity",
			),
		).toBe(true);
		expect(
			stale.some(
				(finding) => finding.rule === "stale-allowlist:founder-identity",
			),
		).toBe(true);
	});

	test("reviewed public founder content does not exempt credentials or later edits", () => {
		const path = "apps/landing/src/pages/imprint.astro";
		const founder = ["Aa", "ron", " ", "Koi", "vunen"].join("");
		const fakeToken = ["ghp", "_123456789012345678901234"].join("");
		const content = `<strong>${founder}</strong>\nconst token = "${fakeToken}";\n`;
		const root = fixture({
			[path]: content,
			"scripts/oss/secret-scan-allowlist.json": JSON.stringify({
				privateKeyHeaders: [],
				secretScan: [
					{
						path,
						rule: "founder-identity",
						sha256: createHash("sha256").update(content).digest("hex"),
						reason: "Reviewed public founder attribution",
					},
				],
			}),
		});
		const reviewed = scanTrackedFiles(root);
		expect(
			reviewed.some((finding) => finding.rule === "founder-identity"),
		).toBe(false);
		expect(reviewed.some((finding) => finding.rule === "github-token")).toBe(
			true,
		);
		writeFileSync(resolve(root, path), content + "<!-- later edit -->\n");
		const edited = scanTrackedFiles(root);
		expect(edited.some((finding) => finding.rule === "founder-identity")).toBe(
			true,
		);
		expect(
			edited.some(
				(finding) => finding.rule === "stale-allowlist:founder-identity",
			),
		).toBe(true);
	});

	test("passes a clean tracked tree", () => {
		const findings = scanTrackedFiles(
			fixture({ "src/index.ts": 'export const value = "safe";\n' }),
		);
		expect(findings).toEqual([]);
		expect(renderSecretScan(findings)).toStartWith("Secret scan passed:");
	});

	test("reports sensitive paths and redacted credential rules", () => {
		const fakeToken = ["ghp", "_123456789012345678901234"].join("");
		const findings = scanTrackedFiles(
			fixture({
				"config/.env.production": "TOKEN=not-printed\n",
				"src/config.ts": `const token = "${fakeToken}";\n`,
			}),
		);
		expect(findings).toEqual([
			{
				kind: "path",
				path: "config/.env.production",
				rule: "sensitive-path",
			},
			{
				kind: "content",
				line: 1,
				path: "src/config.ts",
				rule: "github-token",
			},
		]);
		const rendered = renderSecretScan(findings);
		expect(rendered).toContain("src/config.ts:1 [github-token]");
		expect(rendered).not.toContain(fakeToken);
	});

	test("accepts only hash-bound reviewed fixture matches", () => {
		const fakeToken = ["ghp", "_123456789012345678901234"].join("");
		const fixtureContent = `const token = "${fakeToken}";\n`;
		const fixtureHash = createHash("sha256")
			.update(fixtureContent)
			.digest("hex");
		const findings = scanTrackedFiles(
			fixture({
				"scripts/oss/secret-scan-allowlist.json": `${JSON.stringify({
					privateKeyHeaders: [],
					secretScan: [
						{
							path: "src/config.ts",
							reason: "Synthetic credential-redaction fixture",
							rule: "github-token",
							sha256: fixtureHash,
						},
					],
				})}\n`,
				"src/config.ts": fixtureContent,
			}),
		);
		expect(findings).toEqual([]);
	});

	test("accepts a hash-bound reviewed synthetic database seed", () => {
		const seed = "INSERT INTO demo VALUES ('synthetic');\n";
		const seedHash = createHash("sha256").update(seed).digest("hex");
		const findings = scanTrackedFiles(
			fixture({
				"scripts/oss/secret-scan-allowlist.json": `${JSON.stringify({
					privateKeyHeaders: [],
					secretScan: [
						{
							path: "scripts/local-demo-seed.sql",
							reason: "Deterministic synthetic local demo rows",
							rule: "database-backup-path",
							sha256: seedHash,
						},
					],
				})}\n`,
				"scripts/local-demo-seed.sql": seed,
			}),
		);
		expect(findings).toEqual([]);
	});

	test("loads private rules and exempts only the paths the export rewrites", () => {
		const privateRulesPath = placeholderRules();
		const root = fixture({
			"scripts/oss/public-files.json": "{}\n",
			"src/tenant.ts": 'const slug = "cms_globexcorp__content";\n',
			"src/infra.ts": `const account = "${PLACEHOLDER_ACCOUNT}";\n`,
			"apps/api/wrangler.jsonc": `{\n"account_id": "${PLACEHOLDER_ACCOUNT}",\n"vars": { "TENANT": "globexcorp" }\n}\n`,
			"packages/other/wrangler.jsonc": `{ "account_id": "${PLACEHOLDER_ACCOUNT}" }\n`,
		});
		expect(
			scanTrackedFiles(root, { privateRulesPath })
				.map((finding) => `${finding.path}:${finding.line}:${finding.rule}`)
				.sort(),
		).toEqual([
			// The exporter drops account_id here; the customer name still has to go.
			"apps/api/wrangler.jsonc:3:customer-identity",
			// A wrangler.jsonc the exporter does not rewrite ships raw.
			"packages/other/wrangler.jsonc:1:cloudflare-account-id",
			"src/infra.ts:1:cloudflare-account-id",
			"src/tenant.ts:1:customer-identity",
		]);
		expect(
			scanTrackedFiles(root, { privateRulesPath, paths: ["src/infra.ts"] }),
		).toEqual([
			{
				kind: "content",
				line: 1,
				path: "src/infra.ts",
				rule: "cloudflare-account-id",
			},
		]);
		// A public clone has no overlay and scans with the generic rules alone.
		expect(
			scanTrackedFiles(root, {
				privateRulesPath: resolve(root, "absent.json"),
			}),
		).toEqual([]);
	});

	test("fails closed when a required private overlay is absent or empty", () => {
		const dir = mkdtempSync(resolve(tmpdir(), "tedix-secret-rules-required-"));
		fixtures.push(dir);
		expect(() => requirePrivateScanRules(resolve(dir, "missing.json"))).toThrow(
			"required private scan rules are absent or empty",
		);
		const empty = resolve(dir, "empty.json");
		writeFileSync(empty, JSON.stringify({ rules: [] }));
		expect(() => requirePrivateScanRules(empty)).toThrow(
			"required private scan rules are absent or empty",
		);
		expect(requirePrivateScanRules(placeholderRules())).toHaveLength(2);
	});

	/**
	 * The private gate's own proof: every real overlay rule catches the
	 * examples recorded beside it. Absent from a public clone by design.
	 */
	test.skipIf(!existsSync(PRIVATE_SCAN_RULES_PATH))(
		"every private rule catches its recorded examples",
		() => {
			const rules = readPrivateScanRules();
			expect(rules.length).toBeGreaterThan(0);
			for (const { rule, examples } of rules) {
				expect(examples.length).toBeGreaterThan(0);
				const files = Object.fromEntries(
					examples.map((example, index) => [
						`src/${index}.ts`,
						`const value = "${example}";\n`,
					]),
				);
				const caught = scanTrackedFiles(fixture(files))
					.filter((finding) => finding.rule === rule)
					.map((finding) => finding.path)
					.sort();
				expect(caught).toEqual(Object.keys(files).sort());
			}
		},
	);

	test("leaves legitimate third-party integrations alone", () => {
		// klarna, nosana and promptwatch are shipped integrations, not customers.
		const findings = scanTrackedFiles(
			fixture({
				"src/providers.ts":
					'export const providers = ["klarna", "nosana", "promptwatch"];\n',
			}),
		);
		expect(findings).toEqual([]);
	});

	test("reports real addresses and ignores reserved and own domains", () => {
		// Split so this line is not itself an address the rule would report.
		const real = ["maria", "@", "clinica-real", ".mx"].join("");
		const findings = scanTrackedFiles(
			fixture({
				"src/safe.ts":
					'const addresses = ["a@example.com", "b@acme.example", "c@host.test", "d@tedix.dev", "e@cto.tedix.tech"];\n',
				"src/version.ts": 'const patched = "pkg@0.23.0.patch";\n',
				"src/leak.ts": `const owner = "${real}";\n`,
			}),
		);
		expect(findings).toEqual([
			{ kind: "content", line: 1, path: "src/leak.ts", rule: "customer-email" },
		]);
	});

	test("keeps real bearer credentials while ignoring readable fixtures", () => {
		const jwt = ["eyJ", "hbGciOiJIUzI1NiJ9", ".payload.sig"].join("");
		const opaque = ["A1b2C3d4", "E5f6G7h8", "I9j0K1l2"].join("");
		const findings = scanTrackedFiles(
			fixture({
				"src/fixture.ts": 'const h = "Bearer just-issued-descope-jwt";\n',
				"src/jwt.ts": `const h = "Bearer ${jwt}";\n`,
				"src/opaque.ts": `const h = "Bearer ${opaque}";\n`,
			}),
		).filter((finding) => finding.rule === "bearer-token");
		expect(findings.map((finding) => finding.path).sort()).toEqual([
			"src/jwt.ts",
			"src/opaque.ts",
		]);
	});

	test("treats fixture and licence-attribution addresses as placeholders", () => {
		const findings = scanTrackedFiles(
			fixture({
				"LICENSES/third-party/thing-MIT.txt": `Copyright (c) A <${["a", "hey.com"].join("@")}>\n`,
				"src/fixtures.ts": `const a = ["${["bob", "company.org"].join("@")}", "${["owner", "solstice.dev"].join("@")}"];\n`,
				"src/real.ts": `const a = "${["ops", "a-real-partner.de"].join("@")}";\n`,
			}),
		).filter((finding) => finding.rule === "customer-email");
		expect(findings).toEqual([
			{ kind: "content", line: 1, path: "src/real.ts", rule: "customer-email" },
		]);
	});

	test("does not report stale allowlist entries during a scoped scan", () => {
		const fakeToken = ["ghp", "_123456789012345678901234"].join("");
		const content = `const token = "${fakeToken}";\n`;
		const root = fixture({
			"scripts/oss/secret-scan-allowlist.json": `${JSON.stringify({
				privateKeyHeaders: [],
				secretScan: [
					{
						path: "src/config.ts",
						reason: "Synthetic credential-redaction fixture",
						rule: "github-token",
						sha256: createHash("sha256").update(content).digest("hex"),
					},
				],
			})}\n`,
			"src/config.ts": content,
			"src/other.ts": "export const value = 1;\n",
		});
		expect(scanTrackedFiles(root, { paths: ["src/other.ts"] })).toEqual([]);
		expect(scanTrackedFiles(root)).toEqual([]);
	});

	test("reports the live Descope project id and accepts the documented placeholder", () => {
		const live = ["P3", "Syntheticproject0000000000"].join("");
		const findings = scanTrackedFiles(
			fixture({
				"scripts/oss/public-files.json": "{}\n",
				"src/live.test.ts": `const PROJECT = "${live}";\n`,
				"src/placeholder.test.ts":
					'const PROJECT = "P2example000000000000000000";\n',
				"apps/os/wrangler.jsonc": `{ "vars": { "DESCOPE_PROJECT_ID": "${live}" } }\n`,
			}),
		);
		expect(findings).toEqual([
			{
				kind: "content",
				line: 1,
				path: "src/live.test.ts",
				rule: "descope-project-id",
			},
		]);
		expect(renderSecretScan(findings)).not.toContain(live);
	});

	test("reports Stripe object ids everywhere, including a wrangler config", () => {
		const account = ["acct_", "Synthetic0000000"].join("");
		const price = ["price_", "Synthetic000000000"].join("");
		const findings = scanTrackedFiles(
			fixture({
				"src/billing.ts": `const account = "${account}";\n`,
				"src/catalog.sql": `INSERT INTO prices VALUES ('${price}');\n`,
				"apps/api/wrangler.jsonc": `{ "vars": { "STRIPE_ACCOUNT": "${account}" } }\n`,
				"src/prose.ts":
					'const words = ["sub_agent", "prod_ready", "price_list"];\n',
			}),
		).map((finding) => `${finding.path}:${finding.rule}`);
		expect(findings.sort()).toEqual([
			"apps/api/wrangler.jsonc:stripe-object-id",
			"src/billing.ts:stripe-object-id",
			"src/catalog.sql:stripe-object-id",
		]);
	});

	test("reports the public R2 bucket and Neo4j Aura host outside redacted vars", () => {
		const bucket = `pub-${"0123456789abcdef".repeat(2)}.r2.dev`;
		const aura = ["neo4j+s://", "0badc0de", ".databases.neo4j.io"].join("");
		const findings = scanTrackedFiles(
			fixture({
				"scripts/oss/public-files.json": "{}\n",
				"src/assets.ts": `const fallback = "https://${bucket}";\n`,
				"src/graph.ts": `const uri = "${aura}";\n`,
				"apps/api/wrangler.jsonc": `{ "vars": { "ASSETS_URL": "https://${bucket}", "GRAPH_DB_URI": "${aura}" } }\n`,
				"src/placeholder.ts":
					'const fallback = "https://pub-tedix-assets.r2.dev";\n',
			}),
		).map((finding) => `${finding.path}:${finding.rule}`);
		expect(findings.sort()).toEqual([
			"src/assets.ts:r2-public-bucket",
			"src/graph.ts:neo4j-aura-uri",
		]);
	});

	test("reports the founder's identity while leaving embedded letters alone", () => {
		const first = ["Aa", "ron"].join("");
		const last = ["Koi", "vunen"].join("");
		const findings = scanTrackedFiles(
			fixture({
				"scripts/oss/public-files.json": "{}\n",
				"src/display.ts": `const name = "${first} Codex";\n`,
				"src/slug.ts": `const key = "${first.toLowerCase()}-coding-agents";\n`,
				"src/mail.ts": `const owner = "${first.toLowerCase()}@example.com";\n`,
				"src/last.ts": `const author = "${last}";\n`,
				"src/embedded.ts": `const word = "m${first.toLowerCase()}ic";\n`,
				"src/synthetic.ts": 'const name = "Ada Codex";\n',
				"apps/api/wrangler.jsonc": `{ "vars": { "OWNER": "${first}" } }\n`,
			}),
		).map((finding) => `${finding.path}:${finding.rule}`);
		expect(findings.sort()).toEqual([
			"src/display.ts:founder-identity",
			"src/last.ts:founder-identity",
			"src/mail.ts:founder-identity",
			"src/slug.ts:founder-identity",
		]);
	});

	test("scans pushed commit messages and identities with the same rules", () => {
		const privateRulesPath = placeholderRules();
		const root = fixture({ "src/index.ts": "export {};\n" });
		const base = commitFixture(root, "Ada Codex|ada@acme.dev", "chore: base");
		setOriginMain(root, base);
		// A contributor's real address is exempt; split so this file is not a finding.
		const clean = commitFixture(
			root,
			`Outside Contributor|${["someone", "a-real-partner.de"].join("@")}`,
			"fix: a public change\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
		);
		const leaky = commitFixture(
			root,
			"Ada Codex|ada@globexcorp.example",
			`fix(billing): repair the globexcorp tenant\n\naccount ${PLACEHOLDER_ACCOUNT}`,
		);
		expect(
			scanCommits(root, [{ base, head: clean }], { privateRulesPath }),
		).toEqual([]);
		const findings = scanCommits(root, [{ base, head: leaky }], {
			privateRulesPath,
		}).map((finding) => `${finding.path}:${finding.line}:${finding.rule}`);
		const at = `commit ${leaky.slice(0, 12)}`;
		expect(findings.sort()).toEqual([
			`${at}:1:customer-identity`,
			`${at}:2:customer-identity`,
			`${at}:3:customer-identity`,
			`${at}:5:cloudflare-account-id`,
		]);
	});

	test("accepts commits without trailers or with both exact trailers", () => {
		const item = "33708ba5-b62d-4cd8-8d44-e0353e47b412";
		const session = "codex:01a105c7-a9ae-7440-9449-a37e588b09a6";
		expect(
			trailerFindings("fix: a change\n\nCo-Authored-By: A <a@x.dev>"),
		).toEqual([]);
		expect(
			trailerFindings(
				`fix: a change\n\nBody text.\n\nWork-Item: ${item}\nAgent-Session: ${session}\nCo-Authored-By: A <a@x.dev>\n`,
			),
		).toEqual([]);
	});

	test("rejects malformed, split, partial or duplicated trailers", () => {
		const item = "33708ba5-b62d-4cd8-8d44-e0353e47b412";
		const id = "01a105c7-a9ae-7440-9449-a37e588b09a6";
		// Session without a harness prefix.
		expect(
			trailerFindings(`fix: a\n\nWork-Item: ${item}\nAgent-Session: ${id}`),
		).toEqual([4]);
		// Descriptive suffix after the session uuid.
		expect(
			trailerFindings(
				`fix: a\n\nWork-Item: ${item}\nAgent-Session: codex:${id}-review-20261005`,
			),
		).toEqual([4]);
		// A blank line splits the block, so Git sees only the last paragraph.
		expect(
			trailerFindings(
				`fix: a\n\nWork-Item: ${item}\n\nAgent-Session: codex:${id}`,
			),
		).toEqual([3]);
		// One trailer without the other.
		expect(trailerFindings(`fix: a\n\nWork-Item: ${item}`)).toEqual([3]);
		// Not a uuid, and a repeated session.
		expect(
			trailerFindings(
				`fix: a\n\nWork-Item: TEDIX-12\nAgent-Session: codex:${id}\nAgent-Session: codex:${id}`,
			),
		).toEqual([3, 5]);
	});

	test("reports malformed trailers in the pushed range as commit findings", () => {
		const privateRulesPath = placeholderRules();
		const root = fixture({ "src/index.ts": "export {};\n" });
		const base = commitFixture(root, "Ada Codex|ada@acme.dev", "chore: base");
		setOriginMain(root, base);
		const head = commitFixture(
			root,
			"Ada Codex|ada@acme.dev",
			"fix: a\n\nWork-Item: 33708ba5-b62d-4cd8-8d44-e0353e47b412",
		);
		expect(scanCommits(root, [{ base, head }], { privateRulesPath })).toEqual([
			{
				kind: "commit",
				path: `commit ${head.slice(0, 12)}`,
				rule: "commit-trailer",
				line: 5,
			},
		]);
	});

	test("skips main commits absorbed by a branch but scans its own new commits", () => {
		const privateRulesPath = placeholderRules();
		const root = fixture({ "src/index.ts": "export {};\n" });
		const base = commitFixture(root, "Ada Codex|ada@acme.dev", "chore: base");
		const alreadyMain = commitFixture(
			root,
			"Ada Codex|ada@globexcorp.example",
			"fix: previously published main commit",
		);
		setOriginMain(root, alreadyMain);
		const branchCommit = commitFixture(
			root,
			"Ada Codex|ada@acme.dev",
			`fix: new branch commit for account ${PLACEHOLDER_ACCOUNT}`,
		);
		const findings = scanCommits(root, [{ base, head: branchCommit }], {
			privateRulesPath,
		});
		expect(findings).toEqual([
			{
				kind: "commit",
				path: `commit ${branchCommit.slice(0, 12)}`,
				line: 3,
				rule: "cloudflare-account-id",
			},
		]);
	});

	test("fails closed when origin/main is missing for an existing ref", () => {
		const root = fixture({ "src/index.ts": "export {};\n" });
		const base = commitFixture(root, "Ada Codex|ada@acme.dev", "chore: base");
		const head = commitFixture(root, "Ada Codex|ada@acme.dev", "chore: next");
		expect(() => scanCommits(root, [{ base, head }])).toThrow();
	});

	test("fails closed when tracked-file discovery fails", () => {
		const root = mkdtempSync(resolve(tmpdir(), "tedix-secret-scan-no-git-"));
		fixtures.push(root);
		expect(() => scanTrackedFiles(root)).toThrow("not a git repository");
	});
});

describe("command line", () => {
	test("a bare run sweeps every tracked file", () => {
		expect(parseCli([])).toEqual({
			publicOnly: false,
			requirePrivateRules: false,
		});
	});

	test("push ranges without a path list still sweep the whole scope", () => {
		expect(parseCli(["--base", "aaa", "--head", "bbb"]).paths).toBeUndefined();
	});

	test("--public without a path list sweeps the whole published set", () => {
		expect(parseCli(["--public"])).toEqual({
			publicOnly: true,
			requirePrivateRules: false,
		});
	});

	test("a private-source scan can require its non-public overlay", () => {
		expect(parseCli(["--public", "--require-private-rules"])).toEqual({
			publicOnly: true,
			requirePrivateRules: true,
		});
	});

	test("a path list narrows the scope to those files", () => {
		expect(parseCli(["--public", "--paths", "a.ts", "b.ts"])).toEqual({
			publicOnly: true,
			requirePrivateRules: false,
			paths: ["a.ts", "b.ts"],
		});
	});

	// The sub-second pre-push case: preflight passes --paths with nothing when the
	// push changed no published file. That must stay a no-op, not an 8s full sweep.
	test("an explicitly empty path list stays a no-op", () => {
		expect(parseCli(["--paths"])).toEqual({
			publicOnly: false,
			requirePrivateRules: false,
			paths: [],
		});
	});
});
