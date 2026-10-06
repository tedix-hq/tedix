#!/usr/bin/env bun

/**
 * Conventional-commit-derived release notes for Tedix releases.
 *
 * The repo lands dozens of direct-to-main agent-authored commits per day, so
 * per-PR changeset files do not fit; instead this script collapses a commit
 * range into legible Markdown release notes:
 *
 *   bun scripts/release/generate-release-notes.ts \
 *     --from v0.1.0 --to v0.2.0 --version v0.2.0 --out RELEASE_NOTES.md
 *
 * Parsing, classification, and rendering are pure functions over
 * `CommitRecord` values so tests never shell out to git; the git access is a
 * thin shell at the bottom of this file.
 *
 * Determinism contract: identical inputs (range, options) produce
 * byte-identical output. The notes body never reads the clock — the version
 * label is an input, not a timestamp.
 */

import { spawnSync } from "node:child_process";
import { detachedGitEnv } from "../oss/git-env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_REPOSITORY_URL = "https://github.com/tedix-hq/tedix";

/**
 * Stable-contract surfaces: commits touching these
 * paths are compatibility-relevant and always listed explicitly.
 */
export const CONTRACT_SURFACES = [
	"packages/api-contract/",
	"packages/db/src/schema/",
] as const;

/** Types collapsed into one "internal" count line unless --full is passed. */
export const COLLAPSED_TYPES = ["docs", "test", "chore"] as const;

/** Stable sentinel for a first release with no earlier version tag. */
export const INITIAL_HISTORY_REF = "<initial>";

const SHORT_SHA_LENGTH = 9;

export interface CommitRecord {
	sha: string;
	subject: string;
	body: string;
	files: string[];
}

export interface ConventionalSubject {
	type: string;
	scopes: string[];
	bang: boolean;
	description: string;
}

export interface ClassifiedCommit {
	record: CommitRecord;
	conventional: ConventionalSubject | null;
	breaking: boolean;
	breakingNotes: string[];
	contractSurfaces: string[];
}

export interface CheckOffender {
	sha: string;
	subject: string;
	reason: string;
}

export interface CheckResult {
	ok: boolean;
	offenders: CheckOffender[];
}

export interface ReleaseNotesOptions {
	/** Human version label for the H1 (e.g. the tag name). Never a date. */
	version: string;
	from: string;
	to: string;
	full?: boolean;
	repositoryUrl?: string;
}

/**
 * The one conventional-commit subject grammar:
 *
 *   type(scope)!: description
 *
 * - type: lowercase word ([a-z][a-z0-9]*)
 * - scope: optional, parenthesized, no whitespace/parens; commas allowed for
 *   multi-scope commits (`feat(mcp,cli): ...`)
 * - "!": optional breaking marker after type/scope
 * - ": " separator, then a non-empty description
 */
const SUBJECT_GRAMMAR =
	/^(?<type>[a-z][a-z0-9]*)(?:\((?<scope>[^()\s]+)\))?(?<bang>!)?: (?<description>\S.*)$/;

export function parseSubject(subject: string): ConventionalSubject | null {
	const match = SUBJECT_GRAMMAR.exec(subject);
	if (!match?.groups) return null;
	const { type, scope, bang, description } = match.groups;
	return {
		type: type as string,
		scopes: scope
			? scope
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean)
			: [],
		bang: bang === "!",
		description: (description as string).trim(),
	};
}

/**
 * Breaking-change notes from a commit body: lines that start with
 * `BREAKING CHANGE:` / `BREAKING-CHANGE:` (or a bare leading `BREAKING`).
 * Mid-line mentions of the word do not count.
 */
export function breakingNotes(body: string): string[] {
	return body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^BREAKING(?:[- ]CHANGE)?\b/.test(line));
}

export function classifyCommit(record: CommitRecord): ClassifiedCommit {
	const conventional = parseSubject(record.subject);
	const notes = breakingNotes(record.body);
	return {
		record,
		conventional,
		breaking: (conventional?.bang ?? false) || notes.length > 0,
		breakingNotes: notes,
		contractSurfaces: CONTRACT_SURFACES.filter((surface) =>
			record.files.some((file) => file.startsWith(surface)),
		),
	};
}

export function checkCommits(records: CommitRecord[]): CheckResult {
	const offenders = records
		.filter((record) => parseSubject(record.subject) === null)
		.map((record) => ({
			sha: record.sha,
			subject: record.subject,
			reason: "subject does not match `type(scope)!: description`",
		}));
	return { ok: offenders.length === 0, offenders };
}

function commitLink(sha: string, repositoryUrl: string): string {
	return `[${sha.slice(0, SHORT_SHA_LENGTH)}](${repositoryUrl}/commit/${sha})`;
}

function entryLine(
	classified: ClassifiedCommit,
	repositoryUrl: string,
	withType: boolean,
): string {
	const link = commitLink(classified.record.sha, repositoryUrl);
	const conventional = classified.conventional;
	if (!conventional) return `- ${classified.record.subject} (${link})`;
	const scope = conventional.scopes.join(",");
	const label = withType
		? `${conventional.type}${scope ? `(${scope})` : ""}${conventional.bang ? "!" : ""}`
		: scope;
	const prefix = label ? `**${label}:** ` : "";
	return `- ${prefix}${conventional.description} (${link})`;
}

/**
 * Deterministic section ordering: scope ascending (scopeless last), input
 * order as the tie-breaker; when `byType` is set, type name sorts first.
 */
function sortEntries(
	entries: ClassifiedCommit[],
	byType: boolean,
): ClassifiedCommit[] {
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => {
			const left = a.entry.conventional as ConventionalSubject;
			const right = b.entry.conventional as ConventionalSubject;
			if (byType && left.type !== right.type)
				return left.type < right.type ? -1 : 1;
			const leftScope = left.scopes.join(",");
			const rightScope = right.scopes.join(",");
			if (leftScope !== rightScope) {
				if (leftScope === "") return 1;
				if (rightScope === "") return -1;
				return leftScope < rightScope ? -1 : 1;
			}
			return a.index - b.index;
		})
		.map(({ entry }) => entry);
}

export function renderReleaseNotes(
	records: CommitRecord[],
	options: ReleaseNotesOptions,
): string {
	const repositoryUrl = options.repositoryUrl ?? DEFAULT_REPOSITORY_URL;
	const classified = records.map(classifyCommit);
	const lines: string[] = [];
	const pushSection = (title: string, rows: string[]): void => {
		if (rows.length === 0) return;
		lines.push(`## ${title}`, "", ...rows, "");
	};

	lines.push(`# Tedix ${options.version}`, "");
	lines.push(
		`Commit range: \`${options.from}..${options.to}\` — ${records.length} commit${records.length === 1 ? "" : "s"}.`,
		"",
	);
	if (records.length === 0) {
		lines.push("No commits in range.", "");
		return lines.join("\n");
	}

	const conventional = classified.filter(
		(entry) => entry.conventional !== null,
	);
	const unclassified = classified.filter(
		(entry) => entry.conventional === null,
	);
	const ofType = (type: string): ClassifiedCommit[] =>
		conventional.filter(
			(entry) => (entry.conventional as ConventionalSubject).type === type,
		);
	const collapsedTypes = new Set<string>(COLLAPSED_TYPES);
	const primaryTypes = new Set(["feat", "fix", "perf"]);

	pushSection(
		"Breaking changes",
		sortEntries(
			conventional.filter((entry) => entry.breaking),
			true,
		).flatMap((entry) => [
			entryLine(entry, repositoryUrl, true),
			...entry.breakingNotes.map((note) => `  - ${note}`),
		]),
	);

	const typedSections: Array<[string, string]> = [
		["feat", "Features"],
		["fix", "Fixes"],
		["perf", "Performance"],
	];
	for (const [type, title] of typedSections) {
		pushSection(
			title,
			sortEntries(ofType(type), false).map((entry) =>
				entryLine(entry, repositoryUrl, false),
			),
		);
	}

	pushSection(
		"Other changes",
		sortEntries(
			conventional.filter((entry) => {
				const type = (entry.conventional as ConventionalSubject).type;
				return !primaryTypes.has(type) && !collapsedTypes.has(type);
			}),
			true,
		).map((entry) => entryLine(entry, repositoryUrl, true)),
	);

	if (options.full) {
		const collapsedSections: Array<[string, string]> = [
			["docs", "Documentation"],
			["test", "Tests"],
			["chore", "Chores"],
		];
		for (const [type, title] of collapsedSections) {
			pushSection(
				title,
				sortEntries(ofType(type), false).map((entry) =>
					entryLine(entry, repositoryUrl, false),
				),
			);
		}
	} else {
		const internal = conventional.filter((entry) =>
			collapsedTypes.has((entry.conventional as ConventionalSubject).type),
		).length;
		if (internal > 0) {
			lines.push(
				`_${internal} internal commit${internal === 1 ? "" : "s"} (docs, test, chore) not listed — rerun with \`--full\` to include them._`,
				"",
			);
		}
	}

	const contract = classified.filter(
		(entry) => entry.contractSurfaces.length > 0,
	);
	pushSection(
		"Contracts and compatibility",
		contract.length > 0
			? contract.map(
					(entry) =>
						`- ${entry.record.subject} (${commitLink(entry.record.sha, repositoryUrl)}) — ${entry.contractSurfaces
							.map((surface) => `\`${surface.replace(/\/$/, "")}\``)
							.join(", ")}`,
				)
			: [
					"No commits in this range touched `packages/api-contract` or `packages/db/src/schema`.",
				],
	);

	pushSection(
		"Unclassified commits",
		unclassified.map((entry) => entryLine(entry, repositoryUrl, false)),
	);

	return lines.join("\n");
}

// --- thin git shell -------------------------------------------------------

const RECORD_START = "\u001d";
const FIELD_SEPARATOR = "\u001f";
const META_END = "\u001e";

function gitText(repositoryRoot: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: detachedGitEnv(),
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.status !== 0)
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr?.trim() ?? "unknown error"}`,
		);
	return result.stdout;
}

/**
 * Read `${from}..${to}` as structured commit records. Merge commits are
 * excluded: they are git plumbing, not conventional changes. Control-char
 * delimiters keep multi-line bodies unambiguous without ad hoc splitting.
 */
export function readCommitRange(
	repositoryRoot: string,
	from: string,
	to: string,
): CommitRecord[] {
	const range = from === INITIAL_HISTORY_REF ? to : `${from}..${to}`;
	const raw = gitText(repositoryRoot, [
		"log",
		"--no-merges",
		"--name-only",
		`--format=${RECORD_START}%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${META_END}`,
		range,
	]);
	return raw
		.split(RECORD_START)
		.filter((chunk) => chunk.length > 0)
		.map((chunk) => {
			const [meta, fileBlock] = chunk.split(META_END);
			const [sha, subject, body] = (meta as string).split(FIELD_SEPARATOR);
			return {
				sha: (sha as string).trim(),
				subject: (subject ?? "").trim(),
				body: (body ?? "").trim(),
				files: (fileBlock ?? "")
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean),
			};
		});
}

/**
 * Default --from: the most recent v* tag reachable from --to. When --to is
 * itself the tagged commit, step back one tag so a tag build gets
 * "previous tag .. this tag" instead of an empty range. A repository with no
 * earlier v* tag uses INITIAL_HISTORY_REF so its root commit is included in
 * the first release notes.
 */
export function defaultFromRef(repositoryRoot: string, to: string): string {
	const toCommit = gitText(repositoryRoot, [
		"rev-parse",
		"--verify",
		`${to}^{commit}`,
	]).trim();
	let described: string;
	try {
		described = gitText(repositoryRoot, [
			"describe",
			"--tags",
			"--abbrev=0",
			"--match",
			"v*",
			toCommit,
		]).trim();
	} catch {
		return INITIAL_HISTORY_REF;
	}
	const describedCommit = gitText(repositoryRoot, [
		"rev-parse",
		"--verify",
		`${described}^{commit}`,
	]).trim();
	if (describedCommit !== toCommit) return described;
	try {
		return gitText(repositoryRoot, [
			"describe",
			"--tags",
			"--abbrev=0",
			"--match",
			"v*",
			`${toCommit}^`,
		]).trim();
	} catch {
		return INITIAL_HISTORY_REF;
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			from: { type: "string" },
			to: { type: "string", default: "HEAD" },
			version: { type: "string" },
			out: { type: "string" },
			full: { type: "boolean", default: false },
			check: { type: "boolean", default: false },
			"repo-url": { type: "string", default: DEFAULT_REPOSITORY_URL },
			"repo-root": { type: "string" },
		},
	});
	const repositoryRoot = values["repo-root"]
		? resolve(values["repo-root"])
		: resolve(import.meta.dirname, "../..");
	const to = values.to as string;
	const from = values.from ?? defaultFromRef(repositoryRoot, to);
	const records = readCommitRange(repositoryRoot, from, to);

	if (values.check) {
		const { ok, offenders } = checkCommits(records);
		if (ok) {
			process.stdout.write(
				`release-notes check: all ${records.length} commits in ${from}..${to} match the conventional-commit shape\n`,
			);
			process.exit(0);
		}
		for (const offender of offenders) {
			process.stderr.write(
				`${offender.sha.slice(0, SHORT_SHA_LENGTH)} ${offender.subject} — ${offender.reason}\n`,
			);
		}
		process.stderr.write(
			`release-notes check: ${offenders.length} of ${records.length} commits in ${from}..${to} fail the conventional-commit shape\n`,
		);
		process.exit(1);
	}

	const markdown = renderReleaseNotes(records, {
		version: values.version ?? to,
		from,
		to,
		full: values.full as boolean,
		repositoryUrl: values["repo-url"] as string,
	});
	if (values.out) {
		const outPath = resolve(values.out);
		mkdirSync(dirname(outPath), { recursive: true });
		writeFileSync(outPath, markdown);
		process.stdout.write(`wrote ${outPath}\n`);
	} else {
		process.stdout.write(markdown);
	}
}
