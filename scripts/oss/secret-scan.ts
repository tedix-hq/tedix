#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { findNodeAtLocation, parseTree } from "jsonc-parser";
import { parsePushRanges } from "../ci/push-range-selection.mjs";
import { detachedGitEnv } from "./git-env";

/**
 * Deploy configs whose account/database ids and vars the private export
 * rewrites before they reach the public tree. The infrastructure-id rules skip
 * these paths only in the private source checkout. Public configs scan as-is.
 */
export const EXPORT_REWRITTEN_WRANGLER_PATH =
	/^(?:apps\/[^/]+|apps\/cms\/templates\/[^/]+|packages\/db)\/wrangler\.jsonc$/;
export const EXPORT_REWRITTEN_CLOUDFLARE_CONFIG_PATH =
	/^apps\/[^/]+\/cloudflare\.config\.ts$/;

/** Hash-bound allowlist for reviewed synthetic fixtures. */
export const SECRET_SCAN_ALLOWLIST_PATH =
	"scripts/oss/secret-scan-allowlist.json";

/** The private export manifest; present only in the private source repository. */
const EXPORT_MANIFEST_PATH = "scripts/oss/public-files.json";

export interface SecretScanFinding {
	kind: "allowlist" | "commit" | "content" | "path";
	path: string;
	rule: string;
	line?: number;
}

/**
 * `.env.example` is the one env file that ships: it holds required key names
 * with secret-provider vault references and no values, and the
 * content rules below still scan every line of it.
 */
const SENSITIVE_PATH =
	/(^|\/)(\.env(?!\.example$)(?:\..*)?|.*\.(?:pem|key|p12|pfx|crt|cer|der|asc)|id_rsa|id_ed25519|credentials|secrets?)$/;
const BACKUP_PATH =
	/(^|\/)(?:packages\/db\/backups\/.*|backups?\/.*\.(?:sqlite|sqlite3|dump)|.*-(?:production|staging|backup|seed)\.(?:sql|dump))$/;
const TEXT_SOURCE_PATH =
	/\.(?:[cm]?[jt]sx?|astro|jsonc?|mdx?|ya?ml|sql|toml|sh|py|rs|go|txt|patch|lock|svg)$/i;

/**
 * The founder rule below is assembled from fragments so this file does not
 * match the rule it defines.
 */
function joinName(...parts: string[]): string {
	return parts.join("");
}

/**
 * Customer names, customer hostnames and the live installation's Cloudflare
 * account, D1 and organization ids live in ONE private file, never here: this
 * scanner is published, and a pattern that names a customer publishes the
 * customer list. The file is never exported, so the private pre-push gate
 * enforces it and a public clone scans with the generic credential rules alone. `exemptExportRewritten`
 * rules skip the paths the exporter rewrites or regenerates (see
 * EXPORT_DERIVED_INFRA_IDS). Integrations the product ships (klarna, nosana,
 * promptwatch) are not customers and do not belong in the file.
 */
export const PRIVATE_SCAN_RULES_PATH = resolve(
	import.meta.dirname,
	"private-scan-rules.json",
);

/**
 * A maintainer checkout points at the private rules kept outside this
 * repository: `TEDIX_PRIVATE_SCAN_RULES`, else the local, uncommitted
 * `git config tedix.privateScanRules <path>`. Configured rules are required,
 * so a moved or missing file fails the scan instead of silently passing.
 */
export function configuredPrivateRulesPath(
	environment: NodeJS.ProcessEnv = process.env,
	gitConfig: () => string = () =>
		spawnSync("git", ["config", "--get", "tedix.privateScanRules"], {
			cwd: import.meta.dirname,
			encoding: "utf8",
		}).stdout?.trim() ?? "",
): string | undefined {
	const configured =
		environment.TEDIX_PRIVATE_SCAN_RULES?.trim() || gitConfig();
	return configured ? resolve(configured) : undefined;
}

const CONFIGURED_PRIVATE_RULES_PATH = configuredPrivateRulesPath();
const DEFAULT_PRIVATE_RULES_PATH =
	CONFIGURED_PRIVATE_RULES_PATH ?? PRIVATE_SCAN_RULES_PATH;

interface PrivateScanRule {
	rule: string;
	pattern: string;
	flags?: string;
	exemptExportRewritten?: boolean;
	examples: string[];
}

export function readPrivateScanRules(
	path = DEFAULT_PRIVATE_RULES_PATH,
): PrivateScanRule[] {
	if (!existsSync(path)) return [];
	const file: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(file) || !Array.isArray(file.rules)) {
		throw new Error(`private scan rules are invalid: ${path}`);
	}
	return file.rules as PrivateScanRule[];
}

/** Fail closed when a private-source scan was expected to load its overlay. */
export function requirePrivateScanRules(
	path = DEFAULT_PRIVATE_RULES_PATH,
): PrivateScanRule[] {
	const rules = readPrivateScanRules(path);
	if (rules.length === 0) {
		throw new Error(`required private scan rules are absent or empty: ${path}`);
	}
	return rules;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*[A-Za-z0-9]\.[A-Za-z]{2,}/;

/**
 * Domains that carry no customer identity: RFC 2606 / RFC 6761 names reserved
 * for documentation and testing, our own domains, and a short reviewed list of
 * upstream vendors whose addresses appear in attribution and provider code.
 */
const RESERVED_EMAIL_TLDS = new Set([
	"example",
	"invalid",
	"local",
	"localhost",
	"test",
]);
const OWN_EMAIL_DOMAINS = ["tedix.com", "tedix.dev", "tedix.org", "tedix.tech"];
const REVIEWED_VENDOR_EMAIL_DOMAINS = [
	"anthropic.com",
	"cloudflare.com",
	"github.com",
	"openai.com",
];
/**
 * Fixture domains this repo already uses for invented people. `acme` is the
 * house placeholder vocabulary; `evil.com` names the adversary in negative
 * tests. None of these is a domain anyone can receive mail at on our behalf,
 * so an address here carries no customer identity.
 */
const FIXTURE_EMAIL_DOMAINS = [
	"acme.com",
	"acme.dev",
	"company.com",
	"company.org",
	"evil.com",
	"globex.com",
	"solstice.dev",
	"x.com",
	"x.dev",
];

function isPlaceholderEmail(address: string): boolean {
	const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
	const labels = domain.split(".");
	// `pkg@0.23.0.patch` in a lockfile or manifest is a version, not an address.
	if (labels.some((label) => /^\d+$/.test(label))) return true;
	if (RESERVED_EMAIL_TLDS.has(labels.at(-1) ?? "")) return true;
	if (
		["example.com", "example.net", "example.org"].some(
			(reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
		)
	) {
		return true;
	}
	return [
		...OWN_EMAIL_DOMAINS,
		...REVIEWED_VENDOR_EMAIL_DOMAINS,
		...FIXTURE_EMAIL_DOMAINS,
	].some((safe) => domain === safe || domain.endsWith(`.${safe}`));
}

interface ContentRule {
	rule: string;
	pattern: RegExp;
	/**
	 * When present, a match is a finding only if this returns true. Used where
	 * the shape alone is not the signal — every email literal matches the email
	 * pattern; only a non-placeholder domain is a leak.
	 */
	isFinding?: (match: string) => boolean;
	/**
	 * Paths where this rule does not apply because the EXPORT provably removes
	 * the value, so the stored bytes never reach the public repository. Not a
	 * softening of the rule: the exempt path is named, narrow, and tied to the
	 * transform that makes it safe.
	 */
	exemptPath?: RegExp;
}

/**
 * Only infrastructure-id rules may skip private-source configs awaiting export;
 * credentials and customer names still scan, as do all public-clone configs.
 */
const EXPORT_DERIVED_INFRA_IDS = new RegExp(
	`(?:${EXPORT_REWRITTEN_WRANGLER_PATH.source})|(?:${EXPORT_REWRITTEN_CLOUDFLARE_CONFIG_PATH.source})`,
);

const GENERIC_CONTENT_RULES: ReadonlyArray<ContentRule> = [
	{ rule: "openai-api-key", pattern: /sk-[A-Za-z0-9]{20,}/ },
	{ rule: "github-token", pattern: /ghp_[A-Za-z0-9]{20,}/ },
	{ rule: "github-pat", pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
	{ rule: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
	{ rule: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{20,}/ },
	{ rule: "aws-access-key", pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/ },
	{
		rule: "private-key-header",
		pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |)?PRIVATE KEY-----/,
	},
	{
		rule: "bearer-token",
		pattern: /Bearer ([A-Za-z0-9._-]{20,})/,
		// A real bearer credential is a JWT or an opaque high-entropy string, so
		// it carries mixed case and digits. `Bearer just-issued-descope-jwt` is a
		// readable kebab-case fixture; flagging those trains people to bypass the
		// hook, which costs more than the class it would catch.
		isFinding: (match) => {
			const token = match.slice("Bearer ".length);
			if (token.startsWith("eyJ")) return true;
			return /[A-Z]/.test(token) && /\d/.test(token);
		},
	},
	{
		rule: "postgres-credentials",
		pattern: /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/,
	},
	{
		rule: "mongodb-credentials",
		pattern: /mongodb(?:\+srv)?:\/\/[^\s]+:[^\s]+@/,
	},
	{
		rule: "customer-email",
		pattern: EMAIL,
		// Third-party licence texts must ship byte-for-byte; the author address
		// in one is required attribution, not our data.
		exemptPath: /^LICENSES\//,
		isFinding: (match) => !isPlaceholderEmail(match),
	},
	{
		// A Descope project id names the live auth project. Fixtures use the
		// placeholder `P2example000000000000000000`, which is one character
		// short of a real id and so never matches. The only Wrangler occurrence
		// is a redacted `vars` value; the inventory is regenerated.
		rule: "descope-project-id",
		pattern: /\bP[23][A-Za-z0-9]{26}\b/,
		exemptPath: EXPORT_DERIVED_INFRA_IDS,
	},
	{
		// Stripe account, catalog, customer, subscription and webhook-signing
		// object ids name a real Stripe account; prices resolve by lookup key.
		rule: "stripe-object-id",
		pattern: /\b(?:acct|prod|price|cus|sub|whsec)_[A-Za-z0-9]{14,}\b/,
	},
	{
		// The public R2 bucket hostname and the Neo4j Aura instance reach the
		// tree only as Wrangler `vars` (`ASSETS_URL`, `GRAPH_DB_URI`), which the
		// export redacts wholesale; the inventory is regenerated from that
		// rewritten tree. Anywhere else the value must come from configuration.
		rule: "r2-public-bucket",
		pattern: /pub-[0-9a-f]{32}\.r2\.dev/,
		exemptPath: EXPORT_DERIVED_INFRA_IDS,
	},
	{
		rule: "neo4j-aura-uri",
		pattern: /neo4j\+s:\/\/[0-9a-f]{8}\.databases\.neo4j\.io/,
		exemptPath: EXPORT_DERIVED_INFRA_IDS,
	},
	{
		// Public founder attribution requires a reviewed content allowance;
		// fixtures use synthetic identities.
		rule: "founder-identity",
		pattern: new RegExp(
			`(?<![a-z])${joinName("aa", "ron")}[-.@ ]|${joinName("koi", "vunen")}`,
			"i",
		),
		exemptPath: EXPORT_DERIVED_INFRA_IDS,
	},
];

/** The generic rules plus the private overlay, when this checkout has one. */
export function contentRules(
	privateRulesPath = DEFAULT_PRIVATE_RULES_PATH,
): ContentRule[] {
	return [
		...GENERIC_CONTENT_RULES,
		...readPrivateScanRules(privateRulesPath).map((entry) => ({
			rule: entry.rule,
			pattern: new RegExp(entry.pattern, entry.flags),
			...(entry.exemptExportRewritten
				? { exemptPath: EXPORT_DERIVED_INFRA_IDS }
				: {}),
		})),
	];
}

function lineHasFinding(line: string, rule: ContentRule): boolean {
	if (!rule.isFinding) return rule.pattern.test(line);
	const global = new RegExp(
		rule.pattern.source,
		rule.pattern.flags.includes("g")
			? rule.pattern.flags
			: `${rule.pattern.flags}g`,
	);
	for (const match of line.matchAll(global)) {
		if (rule.isFinding(match[0])) return true;
	}
	return false;
}

interface ContentAllowlistEntry {
	path: string;
	reason: string;
	rule: string;
	sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(
	value: unknown,
	defaultRule?: string,
): ContentAllowlistEntry {
	if (!isRecord(value))
		throw new Error("secret scan allowlist entry is invalid");
	const path = typeof value.path === "string" ? value.path : "";
	const reason = typeof value.reason === "string" ? value.reason : "";
	const rule =
		typeof value.rule === "string" ? value.rule : (defaultRule ?? "");
	const sha256 = typeof value.sha256 === "string" ? value.sha256 : "";
	if (!path || !reason.trim() || !rule || !/^[0-9a-f]{64}$/.test(sha256)) {
		throw new Error(
			`secret scan allowlist entry is invalid: ${path || "<path>"}`,
		);
	}
	return { path, reason, rule, sha256 };
}

function contentAllowlist(repositoryRoot: string): ContentAllowlistEntry[] {
	const path = resolve(repositoryRoot, SECRET_SCAN_ALLOWLIST_PATH);
	if (!existsSync(path)) return [];
	const allowlist: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(allowlist)) {
		throw new Error("secret scan allowlist is invalid");
	}
	const privateKeyHeaders = allowlist.privateKeyHeaders;
	const secretScan = allowlist.secretScan;
	if (!Array.isArray(privateKeyHeaders) || !Array.isArray(secretScan)) {
		throw new Error("secret scan allowlists are invalid");
	}
	const entries = [
		...privateKeyHeaders.map((entry) =>
			parseEntry(entry, "private-key-header"),
		),
		...secretScan.map((entry) => parseEntry(entry)),
	];
	const keys = entries.map((entry) => `${entry.path}\0${entry.rule}`);
	if (new Set(keys).size !== keys.length) {
		throw new Error(
			"secret scan allowlist contains duplicate path/rule entries",
		);
	}
	return entries;
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function trackedFiles(repositoryRoot: string): string[] {
	const result = spawnSync("git", ["ls-files", "-z"], {
		cwd: repositoryRoot,
		env: detachedGitEnv(),
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr.toString("utf8").trim() ||
				`git ls-files failed with status ${String(result.status)}`,
		);
	}
	return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

export interface SecretScanOptions {
	/**
	 * Restrict the scan to these tracked paths. The pre-push hook passes the
	 * pushed range's changed files: a full tree pass costs ~6 s, which is the
	 * kind of cost that gets a hook bypassed, and a path that did not change
	 * cannot have introduced a leak in this push. The release lane keeps
	 * scanning everything.
	 */
	paths?: string[];
	/** Overlay to load instead of {@link PRIVATE_SCAN_RULES_PATH}; tests only. */
	privateRulesPath?: string;
}

/**
 * A reviewed founder-named file must be named in the allowlist itself. Mask
 * only those structured path references for the founder rule, and only while
 * the referenced file still has the reviewed hash. All other fields and rules
 * scan the original bytes; this is not an exemption for the allowlist file.
 */
function founderMetadataLines(
	root: string,
	content: string,
	allowlist: ContentAllowlistEntry[],
	tracked: Set<string>,
): string[] {
	const tree = parseTree(content);
	if (!tree) throw new Error("invalid secret scan allowlist JSON tree");
	const entries = findNodeAtLocation(tree, ["secretScan"]);
	const reviewed = new Map(
		allowlist
			.filter((entry) => entry.rule === "founder-identity")
			.map((entry) => [entry.path, entry]),
	);
	const indices = (entries?.children ?? []).map((_, index) => index).reverse();
	for (const index of indices) {
		const node = findNodeAtLocation(tree, ["secretScan", index, "path"]);
		if (node?.type !== "string") continue;
		const entry = reviewed.get(String(node.value));
		if (
			!entry ||
			!tracked.has(entry.path) ||
			findNodeAtLocation(tree, ["secretScan", index, "rule"])?.value !==
				"founder-identity" ||
			findNodeAtLocation(tree, ["secretScan", index, "sha256"])?.value !==
				entry.sha256
		)
			continue;
		const target = resolve(root, entry.path);
		if (!existsSync(target) || sha256(readFileSync(target)) !== entry.sha256) {
			continue;
		}
		content =
			content.slice(0, node.offset) +
			" ".repeat(node.length) +
			content.slice(node.offset + node.length);
	}
	return content.split("\n");
}

export function scanTrackedFiles(
	repositoryRoot: string,
	options: SecretScanOptions = {},
): SecretScanFinding[] {
	const root = resolve(repositoryRoot);
	const findings: SecretScanFinding[] = [];
	const allowlist = contentAllowlist(root);
	const allowedByKey = new Map(
		allowlist.map((entry) => [`${entry.path}\0${entry.rule}`, entry]),
	);
	const usedAllowlist = new Set<string>();
	const rules = contentRules(options.privateRulesPath);
	const rewritesDeploymentConfig = existsSync(
		resolve(root, EXPORT_MANIFEST_PATH),
	);
	const scoped = options.paths !== undefined;
	const tracked = trackedFiles(root);
	const selected = scoped
		? tracked.filter((path) => new Set(options.paths).has(path))
		: tracked;

	for (const path of selected) {
		// A tracked symlink to a directory (`.claude/skills`) has no content of
		// its own; the files it points at are tracked and scanned at their path.
		if (statSync(resolve(root, path)).isDirectory()) continue;
		const content = readFileSync(resolve(root, path));
		const contentSha256 = sha256(content);
		const isAllowed = (rule: string): boolean => {
			const key = `${path}\0${rule}`;
			const allowed = allowedByKey.get(key);
			if (allowed?.sha256 !== contentSha256) return false;
			usedAllowlist.add(key);
			return true;
		};

		if (SENSITIVE_PATH.test(path) && !isAllowed("sensitive-path")) {
			findings.push({ kind: "path", path, rule: "sensitive-path" });
		}
		if (BACKUP_PATH.test(path) && !isAllowed("database-backup-path")) {
			findings.push({ kind: "path", path, rule: "database-backup-path" });
		}

		const hasNul = content.includes(0);
		if (hasNul && !TEXT_SOURCE_PATH.test(path)) continue;
		if (hasNul) {
			findings.push({ kind: "content", path, rule: "nul-in-text-source" });
		}
		const text = content.toString("utf8").replaceAll("\0", "");
		const founderLines =
			path === SECRET_SCAN_ALLOWLIST_PATH
				? founderMetadataLines(
						root,
						content.toString("utf8"),
						allowlist,
						new Set(tracked),
					)
				: undefined;
		for (const [index, line] of text.split("\n").entries()) {
			for (const contentRule of rules) {
				if (
					contentRule.exemptPath?.test(path) &&
					(contentRule.exemptPath !== EXPORT_DERIVED_INFRA_IDS ||
						rewritesDeploymentConfig)
				)
					continue;
				const scannedLine =
					contentRule.rule === "founder-identity"
						? (founderLines?.[index] ?? line)
						: line;
				if (lineHasFinding(scannedLine, contentRule)) {
					if (isAllowed(contentRule.rule)) continue;
					findings.push({
						kind: "content",
						path,
						rule: contentRule.rule,
						line: index + 1,
					});
				}
			}
		}
	}
	// A scoped pass reads only some files, so an unused entry proves nothing
	// about staleness. Only the full pass may retire an allowlist entry.
	for (const entry of scoped ? [] : allowlist) {
		const key = `${entry.path}\0${entry.rule}`;
		if (!usedAllowlist.has(key)) {
			findings.push({
				kind: "allowlist",
				path: entry.path,
				rule: `stale-allowlist:${entry.rule}`,
			});
		}
	}

	return findings;
}

/**
 * Rules that do not apply to commit metadata. A contributor's own address is
 * the author field's purpose, and the maintainer signs public commits by name.
 */
const COMMIT_EXEMPT_RULES = new Set(["customer-email", "founder-identity"]);

export interface PushRange {
	base: string;
	head: string;
}

const TRAILER_LINE = /^(Work-Item|Agent-Session):\s*(.*)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HARNESS_SESSION =
	/^[a-z][a-z0-9-]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Maintainer trailers are optional, but public history keeps them forever, so
 * a commit that carries one carries both, in the final trailer block, with
 * exact ids: `Work-Item: <uuid>` and `Agent-Session: <harness>:<uuid>`.
 * Returns 1-based message line numbers (the caller offsets them past the
 * author and committer lines).
 */
export function trailerFindings(message: string): number[] {
	const lines = message.replace(/\n+$/, "").split("\n");
	let lastBlockStart = 0;
	for (const [index, line] of lines.entries()) {
		if (line.trim() === "") lastBlockStart = index + 1;
	}
	const found = new Map<string, number[]>();
	const bad: number[] = [];
	for (const [index, line] of lines.entries()) {
		const match = TRAILER_LINE.exec(line);
		if (!match) continue;
		const key = (match[1] ?? "").toLowerCase();
		const value = (match[2] ?? "").trim();
		found.set(key, [...(found.get(key) ?? []), index + 1]);
		const valid =
			key === "work-item" ? UUID.test(value) : HARNESS_SESSION.test(value);
		if (!valid || index < lastBlockStart) bad.push(index + 1);
	}
	for (const [key, at] of found) {
		if (at.length > 1) bad.push(...at.slice(1));
		const other = key === "work-item" ? "agent-session" : "work-item";
		if (!found.has(other)) bad.push(...at);
	}
	return [...new Set(bad)].sort((a, b) => a - b);
}

/**
 * Scan what a push publishes besides file bytes: each commit's message and
 * its author and committer identity. Public `main` carries both forever, so a
 * customer name or live id in a message leaks exactly like one in a file.
 * Line 1 of a finding is the author, line 2 the committer, 3+ the message.
 * An all-zero base is a new remote ref: every commit no remote already has.
 * An existing ref may absorb main before its next push; commits already on
 * origin/main are not newly published by that push. Require origin/main to
 * resolve so a missing remote-tracking ref cannot silently reduce coverage.
 */
export function scanCommits(
	repositoryRoot: string,
	ranges: PushRange[],
	options: Pick<SecretScanOptions, "privateRulesPath"> = {},
): SecretScanFinding[] {
	const rules = contentRules(options.privateRulesPath).filter(
		(rule) => !COMMIT_EXEMPT_RULES.has(rule.rule),
	);
	const findings: SecretScanFinding[] = [];
	const seen = new Set<string>();
	for (const { base, head } of ranges) {
		const revisions = /^0+$/.test(base)
			? [head, "--not", "--remotes"]
			: [`${base}..${head}`, "--not", "origin/main"];
		const result = spawnSync(
			"git",
			["log", "-z", "--format=%H%n%an <%ae>%n%cn <%ce>%n%B", ...revisions],
			{
				cwd: resolve(repositoryRoot),
				env: detachedGitEnv(),
				maxBuffer: 256 * 1024 * 1024,
			},
		);
		if (result.status !== 0) {
			throw new Error(
				result.stderr.toString("utf8").trim() ||
					`git log failed with status ${String(result.status)}`,
			);
		}
		for (const record of result.stdout
			.toString("utf8")
			.split("\0")
			.filter(Boolean)) {
			const [sha = "", ...lines] = record.split("\n");
			if (seen.has(sha)) continue;
			seen.add(sha);
			for (const line of trailerFindings(lines.slice(2).join("\n"))) {
				findings.push({
					kind: "commit",
					path: `commit ${sha.slice(0, 12)}`,
					rule: "commit-trailer",
					line: line + 2,
				});
			}
			for (const [index, line] of lines.entries()) {
				for (const rule of rules) {
					if (lineHasFinding(line, rule)) {
						findings.push({
							kind: "commit",
							path: `commit ${sha.slice(0, 12)}`,
							rule: rule.rule,
							line: index + 1,
						});
					}
				}
			}
		}
	}
	return findings;
}

export function renderSecretScan(findings: SecretScanFinding[]): string {
	if (findings.length === 0) {
		return "Secret scan passed: no suspicious tracked paths or plaintext credential patterns found.";
	}
	return [
		`Secret scan failed with ${findings.length} finding(s):`,
		...findings.map(
			(finding) =>
				`- ${finding.path}${finding.line ? `:${finding.line}` : ""} [${finding.rule}]`,
		),
		"Matched values are intentionally redacted.",
	].join("\n");
}

/**
 * - bare: scan every tracked file (`bun run scan:secrets`), including the
 *   stale-allowlist check.
 * - `--paths <path>...`: only those files; an explicitly empty list is a no-op.
 *   It takes every argument after it, so it goes last.
 * - `--public`: in the private source repository, narrow to the files the
 *   export publishes. In the public repository every file is published, so it
 *   changes nothing.
 * - `--require-private-rules`: fail when the private customer/installation
 *   overlay is absent or empty. Private-source gates pass this; public clones do not.
 * - `--base <sha> --head <sha>` pairs: also scan each pushed commit's message
 *   and author/committer identity.
 */
export function parseCli(args: string[]): {
	publicOnly: boolean;
	requirePrivateRules: boolean;
	paths?: string[];
} {
	const index = args.indexOf("--paths");
	const publicOnly = args.includes("--public");
	const requirePrivateRules = args.includes("--require-private-rules");
	if (index === -1) return { publicOnly, requirePrivateRules };
	return {
		publicOnly,
		requirePrivateRules,
		paths: args.slice(index + 1).filter(Boolean),
	};
}

/** The file set the private export would publish from `ref`. */
async function publicFilesAtRef(
	repositoryRoot: string,
	ref: string,
): Promise<string[]> {
	// The exporter is private tooling; a computed specifier keeps the public
	// tree free of a static import it does not ship.
	const exporterPath = "./export";
	const { selectPublicFiles } = (await import(exporterPath)) as {
		selectPublicFiles: (
			tracked: string[],
			workspaceRoots: string[],
			policy: unknown,
			privateRoots: string[],
		) => string[];
	};
	const { checkPublicSurface, privateWorkspaceRoots, publicWorkspaceRoots } =
		await import("./public-surface");
	const show = (args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: repositoryRoot,
			env: detachedGitEnv(),
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
		if (result.status !== 0) {
			throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
		}
		return result.stdout;
	};
	const policy = JSON.parse(show(["show", `${ref}:${EXPORT_MANIFEST_PATH}`]));
	const tracked = show(["ls-tree", "-r", "--name-only", ref])
		.split("\n")
		.filter(Boolean);
	const surface = checkPublicSurface(repositoryRoot, ref, true);
	if (surface.errors.length > 0) {
		throw new Error(`public surface is invalid: ${surface.errors.join("; ")}`);
	}
	return selectPublicFiles(
		tracked,
		publicWorkspaceRoots(surface),
		policy,
		privateWorkspaceRoots(surface),
	);
}

if (import.meta.main) {
	const repositoryRoot = resolve(import.meta.dirname, "../..");
	const args = process.argv.slice(2);
	const {
		publicOnly,
		requirePrivateRules: privateRulesRequired,
		paths,
	} = parseCli(args);
	if (privateRulesRequired || CONFIGURED_PRIVATE_RULES_PATH)
		requirePrivateScanRules();
	let scope = paths;
	let note = "";
	// In the public repository every tracked file is already published.
	if (publicOnly && existsSync(resolve(repositoryRoot, EXPORT_MANIFEST_PATH))) {
		try {
			const published = await publicFilesAtRef(repositoryRoot, "HEAD");
			const publishedSet = new Set(published);
			scope =
				paths === undefined
					? published
					: paths.filter((path) => publishedSet.has(path));
		} catch (error) {
			note =
				"could not resolve the public export surface, so the unnarrowed scope " +
				`was scanned instead of only the published files: ${(error as Error).message}\n`;
		}
	}
	const findings: SecretScanFinding[] = scanCommits(
		repositoryRoot,
		parsePushRanges(args),
	);
	if (scope === undefined || scope.length > 0) {
		findings.push(
			...scanTrackedFiles(
				repositoryRoot,
				scope === undefined ? {} : { paths: scope },
			),
		);
	}
	process.stdout.write(`${note}${renderSecretScan(findings)}\n`);
	if (findings.length > 0) {
		if (publicOnly) {
			process.stdout.write(
				"These bytes are published. Remove the value; a reviewed synthetic\n" +
					`fixture earns a hash-bound entry in ${SECRET_SCAN_ALLOWLIST_PATH} instead.\n` +
					"A commit finding (line 1 author, 2 committer, 3+ message) is fixed by\n" +
					"rewording or re-signing that unpushed commit.\n",
			);
		}
		process.exit(1);
	}
}
