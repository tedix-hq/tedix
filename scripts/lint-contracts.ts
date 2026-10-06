#!/usr/bin/env bun

/**
 * Contract lints (`bun scripts/lint-contracts.ts`, part of `lint:repo`): naming and JSON-boundary conventions
 * (no trailing-slash collection routes, kebab-case private tags, described public
 * REST procedures, JSON-only wire schemas), and collection-read inputs that reject
 * unknown keys. Any finding exits 1; `--update-baseline` refreshes the
 * input-strictness baseline, which may only shrink.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lineAt } from "./oxc-ast.ts";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTRACTS_DIR = join(REPO_ROOT, "packages/api-contract/src/contracts");
const SCHEMAS_DIR = join(REPO_ROOT, "packages/api-contract/src/schemas");
const DB_SCHEMA_DIR = join(REPO_ROOT, "packages/db/src/schema");
const PUBLIC_REST_INVENTORY = join(
	REPO_ROOT,
	"apps/api/src/rpc/public-rest-operations.ts",
);

// These private runtime/provider envelopes are intentionally not JSON wire
// contracts. Their values are normalized before persistence or publication.
const PRIVATE_UNKNOWN_SCHEMA_FILES = new Set([
	"automation-events.ts",
	"browser.ts",
	"cognitive-runtime.ts",
	"cognitive.ts",
	"kernel-runtime.ts",
]);

// Frozen REST-description debt, keyed by path relative to the contracts
// directory. A procedure tagged `REST` publishes its `description` into both
// the generated OpenAPI operation and the MCP tool description that tenants and
// LLM clients read, so a missing one ships an unexplained tool.
//
// This allowlist gates the delta rather than the absolute: it is SHRINK-ONLY,
// and it self-expires — once a listed file describes every REST procedure it
// owns (or stops existing), the lint fails until the entry is deleted. Never
// add a file here to make a new procedure pass.
//
// Measured empty at introduction: all 72 REST-tagged procedures across the 74
// contract files already carry a non-empty description, so this gate freezes
// zero debt and only holds the line going forward.
const REST_DESCRIPTION_DEBT_FILES: ReadonlySet<string> = new Set<string>([]);

function productionTsFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) return productionTsFiles(path);
		if (!path.endsWith(".ts") || /\.(?:test|spec)\.ts$|\.d\.ts$/.test(path)) {
			return [];
		}
		return [path];
	});
}

type Finding = { file: string; line: number; message: string };

/**
 * Skip past the token starting at `index` when it opens a string, template, or
 * comment. Returns the index just past the token, or `index` when the
 * character starts nothing that needs skipping.
 *
 * Route objects embed braces inside path strings (`"/{tediId}/usage"`), so a
 * naive brace counter tears the object apart.
 */
function skipToken(source: string, index: number): number {
	const char = source[index];
	if (char === '"' || char === "'" || char === "`") {
		let cursor = index + 1;
		while (cursor < source.length) {
			if (source[cursor] === "\\") {
				cursor += 2;
				continue;
			}
			if (source[cursor] === char) return cursor + 1;
			cursor += 1;
		}
		return source.length;
	}
	if (char === "/" && source[index + 1] === "/") {
		const end = source.indexOf("\n", index);
		return end === -1 ? source.length : end;
	}
	if (char === "/" && source[index + 1] === "*") {
		const end = source.indexOf("*/", index + 2);
		return end === -1 ? source.length : end + 2;
	}
	return index;
}

/**
 * Extract the object-literal body of every `.route({ ... })` call, along with
 * the source index the object opens at.
 */
export function routeObjects(
	source: string,
): { body: string; index: number }[] {
	const objects: { body: string; index: number }[] = [];
	for (const match of source.matchAll(/\.route\(\s*\{/g)) {
		const open = source.indexOf("{", match.index);
		let cursor = open + 1;
		let depth = 1;
		while (cursor < source.length && depth > 0) {
			const skipped = skipToken(source, cursor);
			if (skipped !== cursor) {
				cursor = skipped;
				continue;
			}
			const char = source[cursor];
			if (char === "{" || char === "[" || char === "(") depth += 1;
			else if (char === "}" || char === "]" || char === ")") depth -= 1;
			cursor += 1;
		}
		if (depth !== 0) continue;
		objects.push({ body: source.slice(open + 1, cursor - 1), index: open });
	}
	return objects;
}

/** Split an object-literal body into its top-level `key: value` entries. */
function topLevelEntries(body: string): { key: string; value: string }[] {
	const entries: { key: string; value: string }[] = [];
	let depth = 0;
	let start = 0;
	let cursor = 0;
	const push = (segment: string): void => {
		const separator = segment.indexOf(":");
		if (separator === -1) return;
		const key = segment.slice(0, separator).trim();
		if (!/^[A-Za-z_$][\w$]*$/.test(key)) return;
		entries.push({ key, value: segment.slice(separator + 1).trim() });
	};
	while (cursor < body.length) {
		const skipped = skipToken(body, cursor);
		if (skipped !== cursor) {
			cursor = skipped;
			continue;
		}
		const char = body[cursor];
		if (char === "{" || char === "[" || char === "(") depth += 1;
		else if (char === "}" || char === "]" || char === ")") depth -= 1;
		else if (char === "," && depth === 0) {
			push(body.slice(start, cursor));
			start = cursor + 1;
		}
		cursor += 1;
	}
	push(body.slice(start));
	return entries;
}

/**
 * Resolve a `description:` expression to its literal text.
 *
 * Handles the two forms the contracts use — a single string and a `+`
 * concatenation produced by the formatter wrapping a long line. Returns `null`
 * for anything that is not literal-only; a computed description cannot be
 * proven empty statically, so it is accepted as present.
 */
export function literalText(expression: string): string | null {
	const pieces: string[] = [];
	let cursor = 0;
	let expectLiteral = true;
	while (cursor < expression.length) {
		const char = expression[cursor] ?? "";
		if (/\s/.test(char)) {
			cursor += 1;
			continue;
		}
		if (expectLiteral) {
			if (char !== '"' && char !== "'" && char !== "`") return null;
			const end = skipToken(expression, cursor);
			const raw = expression.slice(cursor + 1, end - 1);
			if (char === "`" && raw.includes("${")) return null;
			pieces.push(raw);
			cursor = end;
			expectLiteral = false;
			continue;
		}
		if (char !== "+") return null;
		cursor += 1;
		expectLiteral = true;
	}
	if (expectLiteral) return null;
	return pieces.join("");
}

export type RestDescriptionFinding = {
	line: number;
	summary: string | null;
	reason: "missing" | "empty";
};

/**
 * Find every `REST`-tagged procedure in one contract source whose route object
 * carries no usable `description`.
 *
 * A procedure is REST-published when its own `.route({ tags })` array contains
 * `"REST"` — the same marker `isPublicProcedure()` in
 * `apps/api/src/rpc/openapi-filter.ts` reads to admit an operation to the
 * public spec. Router-level `.route({ tags })` never carries `REST`, so no tag
 * inheritance is involved.
 */
export function findRestDescriptionFindings(
	source: string,
): RestDescriptionFinding[] {
	const findings: RestDescriptionFinding[] = [];
	for (const { body, index } of routeObjects(source)) {
		const entries = topLevelEntries(body);
		const tags = entries.find((entry) => entry.key === "tags")?.value ?? "";
		if (!/(^|[[,\s])"REST"(\s*[,\]]|$)/.test(tags)) continue;
		const summaryEntry = entries.find((entry) => entry.key === "summary");
		const summary = summaryEntry ? literalText(summaryEntry.value) : null;
		const description = entries.find((entry) => entry.key === "description");
		if (!description) {
			findings.push({
				line: lineAt(source, index),
				summary,
				reason: "missing",
			});
			continue;
		}
		const text = literalText(description.value);
		if (text !== null && text.trim() === "") {
			findings.push({ line: lineAt(source, index), summary, reason: "empty" });
		}
	}
	return findings;
}

/** How many procedures in this source are published to the public REST spec. */
export function findRestTaggedRouteCount(source: string): number {
	let count = 0;
	for (const { body } of routeObjects(source)) {
		const tags =
			topLevelEntries(body).find((entry) => entry.key === "tags")?.value ?? "";
		if (/(^|[[,\s])"REST"(\s*[,\]]|$)/.test(tags)) count += 1;
	}
	return count;
}

export type ContractSource = { fileName: string; source: string };

/**
 * Apply the REST-description rule across the contract directory against a
 * shrink-only debt allowlist, and expire allowlist entries that no longer earn
 * their place.
 */
export function restDescriptionFindings(
	files: ContractSource[],
	debtFiles: ReadonlySet<string> = REST_DESCRIPTION_DEBT_FILES,
): { fileName: string; line: number; message: string }[] {
	const findings: { fileName: string; line: number; message: string }[] = [];
	const seenDebtFiles = new Set<string>();
	for (const { fileName, source } of files) {
		const missing = findRestDescriptionFindings(source);
		if (debtFiles.has(fileName)) {
			seenDebtFiles.add(fileName);
			if (missing.length === 0) {
				findings.push({
					fileName,
					line: 0,
					message: `remove the stale REST description debt entry for ${fileName}: every REST-tagged procedure here now has a description`,
				});
			}
			continue;
		}
		for (const finding of missing) {
			const label = finding.summary ? ` (${finding.summary})` : "";
			findings.push({
				fileName,
				line: finding.line,
				message:
					finding.reason === "missing"
						? `REST-tagged procedure${label} must set a description: it ships into the OpenAPI operation and the MCP tool description clients read`
						: `REST-tagged procedure${label} has an empty description: it ships into the OpenAPI operation and the MCP tool description clients read`,
			});
		}
	}
	for (const fileName of debtFiles) {
		if (seenDebtFiles.has(fileName)) continue;
		findings.push({
			fileName,
			line: 0,
			message: `remove the stale REST description debt entry for ${fileName}: that contract file no longer exists`,
		});
	}
	return findings;
}

function conventionsMain(): number {
	const findings: Finding[] = [];
	const record = (
		file: string,
		source: string,
		index: number,
		message: string,
	): void => {
		findings.push({
			file: relative(REPO_ROOT, file),
			line: lineAt(source, index),
			message,
		});
	};

	const contractFiles = productionTsFiles(CONTRACTS_DIR);
	let restProcedures = 0;
	const contractSources: ContractSource[] = [];
	for (const file of contractFiles) {
		const source = readFileSync(file, "utf8");
		contractSources.push({
			fileName: relative(CONTRACTS_DIR, file),
			source,
		});
		restProcedures += findRestTaggedRouteCount(source);
		for (const match of source.matchAll(/path:\s*"([^"]*\/)"/g)) {
			record(
				file,
				source,
				match.index,
				`route path must not end in a slash: ${JSON.stringify(match[1])}`,
			);
		}
		for (const match of source.matchAll(/tags:\s*\[([^\]]*)\]/g)) {
			for (const tagMatch of (match[1] ?? "").matchAll(/"([^"]+)"/g)) {
				const tag = tagMatch[1] ?? "";
				if (
					tag !== "REST" &&
					tag !== "internal" &&
					tag !== "service" &&
					!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)
				) {
					record(
						file,
						source,
						match.index + tagMatch.index,
						`contract tag must use kebab-case: ${JSON.stringify(tag)}`,
					);
				}
			}
		}
	}

	for (const finding of restDescriptionFindings(contractSources)) {
		findings.push({
			file: relative(REPO_ROOT, join(CONTRACTS_DIR, finding.fileName)),
			line: finding.line,
			message: finding.message,
		});
	}

	const schemaFiles = productionTsFiles(SCHEMAS_DIR);
	for (const file of schemaFiles) {
		const source = readFileSync(file, "utf8");
		const fileName = relative(SCHEMAS_DIR, file);
		if (PRIVATE_UNKNOWN_SCHEMA_FILES.has(fileName)) {
			if (!source.includes("z.unknown()")) {
				record(
					file,
					source,
					0,
					"remove stale private z.unknown() convention exemption",
				);
			}
			continue;
		}
		for (const match of source.matchAll(/z\.unknown\(\)/g)) {
			record(
				file,
				source,
				match.index,
				"wire schemas must use a domain schema or JsonValueSchema, not z.unknown()",
			);
		}
	}

	const dbSchemaFiles = productionTsFiles(DB_SCHEMA_DIR);
	for (const file of dbSchemaFiles) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/Record<string,\s*unknown>/g)) {
			record(
				file,
				source,
				match.index,
				"persisted JSON types must use JsonValue instead of unknown",
			);
		}
	}

	const inventorySource = readFileSync(PUBLIC_REST_INVENTORY, "utf8");
	for (const match of inventorySource.matchAll(
		/"(?:GET|POST|PUT|PATCH|DELETE) [^"]+\/"/g,
	)) {
		record(
			PUBLIC_REST_INVENTORY,
			inventorySource,
			match.index,
			"public REST inventory paths must not end in a slash",
		);
	}

	if (findings.length > 0) {
		for (const finding of findings) {
			console.error(`${finding.file}:${finding.line}: ${finding.message}`);
		}
		console.error(`contract conventions: ${findings.length} finding(s)`);
		return 1;
	}

	console.log(
		`contract conventions: OK — ${contractFiles.length} contracts (${restProcedures} REST procedures, ${REST_DESCRIPTION_DEBT_FILES.size} REST-description debt files), ${schemaFiles.length} wire schemas, and ${dbSchemaFiles.length} DB schema files checked`,
	);
	return 0;
}

// ── Input strictness ──────────────────────────────────────────────────────

/**
 * INPUT STRICTNESS.
 *
 * THE DEFECT CLASS THIS EXISTS TO END. A caller passes a filter argument the
 * endpoint does not declare; a non-strict Zod object silently strips it; the
 * endpoint returns an UNFILTERED page; and the caller — having asked a precise
 * question and received a plausible answer — is confidently wrong. Three
 * instances shipped in two days before this gate existed:
 *
 *   - `discover.search` ignored `namespace`   (found by scripted measurement)
 *   - `workItems.list` ignored `status`       (found by a cold-agent probe,
 *      which reported COMPLETED work as pending)
 *   - `workItems.listActivity` ignored `workItemId`
 *
 * Each was fixed one at a time. Fixing instances does not retire a class, so
 * this module makes the class enumerable and the baseline makes it shrink-only.
 *
 * WHY LIST-LIKE ONLY. Strictness is desirable almost everywhere, but the
 * failure above needs three things together: the caller supplies a FILTER, the
 * server returns a COLLECTION, and a dropped filter is indistinguishable from
 * an honest wide scope. Mutations fail loudly on bad input and single-entity
 * reads return the entity or nothing, so a dropped key there is visible.
 * Scoping the gate to collection reads keeps every entry in the baseline a real
 * confidently-wrong risk instead of a style violation nobody will burn down.
 *
 * WHY A BASELINE RATHER THAN A FLIP. 304 of 1,786 procedures were loose
 * list-like reads when this landed. Turning them strict at once would 400 every
 * caller that passes an extra key — internal services, the OS UI, the CLI, and
 * the MCP edge's context injection among them. The baseline freezes today's
 * debt, the gate refuses NEW debt, and each entry leaves as its callers are
 * verified. Shrink-only in both directions: a fixed procedure MUST leave the
 * baseline in the same change (a stale entry fails), so the file is the proof
 * of burn-down, like a lockfile.
 */

/** A procedure the scanner found, with its input-object strictness. */
export interface ContractProcedureInput {
	/** Contract file, relative to the contracts directory. */
	file: string;
	/** Dotted procedure path, e.g. `workItemsContract.list`. */
	procedure: string;
	/** HTTP method from the OpenAPI meta, when the contract declares one. */
	method: string;
	/** `strict` accepts no unknown keys; `loose` silently strips them. */
	strictness: "strict" | "loose" | "absent" | "non-object";
}

export interface StrictnessFinding {
	key: string;
	severity: "error" | "warning";
	message: string;
}

/**
 * Collection-read procedures: the names under which a dropped filter is
 * invisible. Deliberately narrow — see the module header.
 */
const LIST_LIKE = /(^|\.)(list|search|find|query|feed|inbox|projection)/i;

/** `<file>::<procedure>` — stable across formatting, unique per procedure. */
export function baselineKey(entry: ContractProcedureInput): string {
	return `${entry.file}::${entry.procedure}`;
}

export function isListLike(entry: ContractProcedureInput): boolean {
	return LIST_LIKE.test(entry.procedure);
}

/**
 * A procedure carries the risk when it reads a collection AND declares an
 * object input that strips unknown keys. `absent` (no input at all) cannot
 * receive a filter, so it cannot drop one.
 */
export function isAtRisk(entry: ContractProcedureInput): boolean {
	return entry.strictness === "loose" && isListLike(entry);
}

export function currentDebt(entries: ContractProcedureInput[]): string[] {
	return entries.filter(isAtRisk).map(baselineKey).sort();
}

/**
 * Compare observed debt against the frozen baseline.
 *
 * NEW entries are errors: a fresh loose collection read is exactly the defect
 * this gate exists to stop. STALE entries are also errors, for the reason every
 * shrink-only baseline in this repo treats them so — an entry that no longer
 * reproduces means the baseline was not committed beside the fix that earned
 * it, and a baseline nobody updates stops describing reality.
 */
export function evaluateStrictness(
	entries: ContractProcedureInput[],
	baseline: readonly string[],
): StrictnessFinding[] {
	const observed = new Set(currentDebt(entries));
	const frozen = new Set(baseline);
	const findings: StrictnessFinding[] = [];
	for (const key of [...observed].sort()) {
		if (frozen.has(key)) continue;
		findings.push({
			key,
			severity: "error",
			message:
				"new loose collection-read input: an undeclared filter key would be silently stripped and the caller would read an unfiltered page as a filtered one. Add .strict() to the input object.",
		});
	}
	for (const key of [...frozen].sort()) {
		if (observed.has(key)) continue;
		findings.push({
			key,
			severity: "error",
			message:
				"baseline entry no longer reproduces — commit the shrunken baseline beside the fix that earned it (bun scripts/lint-contracts.ts --update-baseline).",
		});
	}
	return findings;
}

/*
 * Strictness is read from the RUNTIME schema, never from source text. A regex
 * cannot see `.strict()` applied through a shared builder, a spread, or an
 * `.extend()` chain, and this repo composes inputs all three ways; the built
 * schema is the only honest answer.
 */
const BASELINE = join(
	REPO_ROOT,
	"scripts/contract-input-strictness-baseline.json",
);

/** Peel wrappers a contract puts around its input object. */
function unwrap(schema: unknown): Record<string, unknown> | null {
	const node = schema as {
		_zod?: { def?: Record<string, unknown> };
		def?: Record<string, unknown>;
		_def?: Record<string, unknown>;
	} | null;
	const def = node?._zod?.def ?? node?.def ?? node?._def;
	if (!def) return null;
	const type = def.type as string | undefined;
	if (
		type === "optional" ||
		type === "nullable" ||
		type === "default" ||
		type === "nonoptional" ||
		type === "readonly"
	) {
		return unwrap(def.innerType);
	}
	return def;
}

/**
 * Zod 4 encodes `.strict()` as a `never` catchall rather than the v3
 * `unknownKeys` flag — read the catchall, or every strict object reads loose.
 */
function classify(schema: unknown): ContractProcedureInput["strictness"] {
	const def = unwrap(schema);
	if (!def) return "absent";
	if (def.type !== "object") return "non-object";
	const catchall = def.catchall as
		| { _zod?: { def?: { type?: string } } }
		| undefined;
	return catchall?._zod?.def?.type === "never" ? "strict" : "loose";
}

async function collect(): Promise<ContractProcedureInput[]> {
	const files = readdirSync(CONTRACTS_DIR)
		.filter((f) => f.endsWith(".ts") && !f.includes(".test."))
		.sort();
	const entries: ContractProcedureInput[] = [];
	for (const file of files) {
		const mod = (await import(join(CONTRACTS_DIR, file))) as Record<
			string,
			unknown
		>;
		for (const [exportName, exported] of Object.entries(mod)) {
			if (!exported || typeof exported !== "object") continue;
			const walk = (
				node: Record<string, unknown>,
				path: string,
				depth: number,
			): void => {
				if (depth > 8) return;
				const orpc = node["~orpc"] as
					| { inputSchemas?: unknown; meta?: Record<string, unknown> }
					| undefined;
				if (orpc?.inputSchemas) {
					const schemas = orpc.inputSchemas;
					const schema = Array.isArray(schemas) ? schemas[0] : schemas;
					const openapi = (orpc.meta?.["~openapi"] ?? {}) as {
						method?: string;
					};
					entries.push({
						file,
						procedure: path,
						method: openapi.method ?? "?",
						strictness: classify(schema),
					});
					return;
				}
				for (const [key, value] of Object.entries(node)) {
					if (key.startsWith("~")) continue;
					if (value && typeof value === "object") {
						walk(
							value as Record<string, unknown>,
							path ? `${path}.${key}` : key,
							depth + 1,
						);
					}
				}
			};
			walk(exported as Record<string, unknown>, exportName, 0);
		}
	}
	return entries;
}

async function strictnessMain(): Promise<number> {
	const entries = await collect();
	const debt = currentDebt(entries);

	if (process.argv.includes("--update-baseline")) {
		writeFileSync(BASELINE, `${JSON.stringify(debt, null, "\t")}\n`);
		console.log(relative(REPO_ROOT, BASELINE));
		return 0;
	}

	const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as string[];
	const findings = evaluateStrictness(entries, baseline);
	for (const finding of findings) {
		console.error(`${finding.key}: ${finding.message}`);
	}
	console.log(
		`contract input strictness: ${entries.length} procedure(s), ${debt.length} loose collection read(s) vs ${baseline.length} baselined; ${findings.length} finding(s)`,
	);
	return findings.length > 0 ? 1 : 0;
}

if (import.meta.main) {
	const conventions = conventionsMain();
	const strictness = await strictnessMain();
	process.exit(conventions || strictness);
}
