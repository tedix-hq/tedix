import { recordFrom } from "./codemode-ui";
import {
	type CatalogToolEntry,
	workflowTediOwners,
	tediNativeInterfaceGroups,
	isTediNativeInterfaceTool,
	mirroredSkillWorkflowSurface,
	splitCallable,
	type CatalogPageEntry,
	type CatalogSearchMatch,
} from "./codemode-catalog-entries";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const DEFAULT_DISCOVERY_LIMIT = 25;

const MAX_DISCOVERY_LIMIT = 100;

// Schema-bearing pages carry a full input JSON Schema per row, so a naive
// includeParameters search at the normal default limit is the single largest
// discovery payload (measured ~62k est. tokens over a 223-tool namespace).

// When the caller opts into schemas but does not name a limit, default small;
// an explicit limit is always honored up to MAX_DISCOVERY_LIMIT.
export const SCHEMA_DISCOVERY_DEFAULT_LIMIT = 5;

// Search rows are for ranking and callable selection; the full description
// (plus exact schemas) is one discover.describe(callable) away. Budget chosen
// so a default page of rows stays well under client-side result truncation.
const DISCOVERY_DESCRIPTION_BUDGET = 280;

export function normalizeDiscoverySearchInput(input: unknown): {
	includeParameters: boolean;
	includeOutputSchema: boolean;
	includeMetadata: boolean;
	limit: number;
	offset: number;
	query: string;
	namespace: string;
} {
	const record = recordFrom(input);
	const rawLimit = record?.limit;
	const rawOffset = record?.offset;
	const includeParameters = record?.includeParameters === true;
	// outputSchema blobs dominate discovery payload size (full JSON Schema per
	// tool); keep them out of the default response so casual discovery stays
	// lean and survives client-side truncation. Opt in with
	// { includeOutputSchema: true } when planning downstream composition.
	const includeOutputSchema = record?.includeOutputSchema === true;
	return {
		query: (typeof input === "string"
			? input
			: typeof record?.query === "string"
				? record.query
				: ""
		).trim(),
		includeParameters,
		includeOutputSchema,
		includeMetadata: record?.includeMetadata === true,
		namespace:
			typeof record?.namespace === "string" ? record.namespace.trim() : "",
		limit: clampCatalogNumber(
			typeof rawLimit === "number"
				? rawLimit
				: includeParameters || includeOutputSchema
					? SCHEMA_DISCOVERY_DEFAULT_LIMIT
					: DEFAULT_DISCOVERY_LIMIT,
			1,
			MAX_DISCOVERY_LIMIT,
		),
		offset: clampCatalogNumber(
			typeof rawOffset === "number" ? rawOffset : 0,
			0,
		),
	};
}

function clampCatalogNumber(
	value: number,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function paginateCatalog(
	catalog: Record<string, Record<string, CatalogToolEntry>>,
	limit: number,
	offset: number,
	includeParameters: boolean,
	includeOutputSchema: boolean,
	extraMeta?: Record<string, unknown>,
	keepAliasEntries = false,
	preferredTediNamespace?: string,
	includeMetadata = false,
): CatalogDiscoveryResult {
	const tediOwners = workflowTediOwners(catalog);
	// keepAliasEntries doubles as the "explicitly namespace-filtered" signal:
	// filtered browsing shows a worker's own rows; unfiltered browsing
	// collapses repeated role verbs onto one representative row.
	const roleGroups = keepAliasEntries
		? null
		: tediNativeInterfaceGroups(catalog, preferredTediNamespace);
	const entries = Object.entries(catalog)
		.flatMap(([namespace, tools]) =>
			Object.entries(tools).flatMap(([tool, meta]) => {
				if (meta.aliasOf && !keepAliasEntries) return [];
				const roleGroup = roleGroups?.get(tool);
				const isGroupedRoleVerb =
					roleGroup !== undefined && isTediNativeInterfaceTool(meta);
				if (isGroupedRoleVerb && namespace !== roleGroup[0]!.namespace) {
					return [];
				}
				const mirror = mirroredSkillWorkflowSurface(namespace, tool, meta);
				if (mirror) {
					const canonical = splitCallable(mirror.canonicalCallable);
					if (catalog[canonical.namespace]?.[canonical.tool]) return [];
				}
				const groupOwners = isGroupedRoleVerb
					? roleGroup!.filter((owner) => owner.namespace !== namespace)
					: undefined;
				return [
					{
						namespace,
						tool,
						meta: {
							...meta,
							...(tediOwners.get(meta.callable)
								? {
										equivalentTediOwners: tediOwners.get(meta.callable),
									}
								: groupOwners && groupOwners.length > 0
									? { equivalentTediOwners: groupOwners }
									: {}),
						},
					},
				];
			}),
		)
		.sort((a, b) =>
			a.namespace === b.namespace
				? a.tool.localeCompare(b.tool)
				: a.namespace.localeCompare(b.namespace),
		);
	return paginateCatalogEntries(
		entries,
		limit,
		offset,
		includeParameters,
		includeOutputSchema,
		extraMeta,
		includeMetadata,
	);
}

export function paginateCatalogEntries(
	entries: CatalogPageEntry[],
	limit: number,
	offset: number,
	includeParameters: boolean,
	includeOutputSchema: boolean,
	extraMeta?: Record<string, unknown>,
	includeMetadata = false,
): CatalogDiscoveryResult {
	const page = entries.slice(offset, offset + limit);
	const resultsArray: unknown[] = [];
	const namespaceMaps: Record<string, unknown> = {};
	for (const entry of page) {
		const projected = projectCatalogMeta(
			entry.meta,
			includeParameters,
			includeOutputSchema,
			false,
			includeMetadata,
		);
		const namespaceTools = recordFrom(namespaceMaps[entry.namespace]) ?? {};
		namespaceTools[entry.tool] = projected;
		namespaceMaps[entry.namespace] = namespaceTools;
		// Flat ranked array for model-natural iteration and slicing.
		resultsArray.push(projected);
	}
	return createCatalogDiscoveryResult(resultsArray, namespaceMaps, {
		pagination: {
			limit,
			offset,
			total: entries.length,
		},
		...extraMeta,
	});
}

export interface CatalogDiscoveryResult {
	results: unknown[];
	namespaces: Record<string, unknown>;
	meta: Record<string, unknown>;
}

/**
 * Plain-object result on purpose. The previous shape was a decorated array
 * (expando `results`/`_meta`/per-namespace props on the ranked array), but
 * structured clone at the sandbox RPC boundary strips expando properties from
 * arrays — sandbox code received a bare array and every documented meta
 * property was silently undefined. A plain object survives the boundary
 * intact, so the declared types are finally honest.
 */
function createCatalogDiscoveryResult(
	resultsArray: unknown[],
	namespaceMaps: Record<string, unknown>,
	meta: Record<string, unknown>,
): CatalogDiscoveryResult {
	return { results: resultsArray, namespaces: namespaceMaps, meta };
}

/**
 * Project a catalog entry for the discovery wire: strip the heavy
 * `parameters` (full input JSON Schema) and `outputSchema` blobs unless the
 * caller explicitly opted into each. Both default off so casual discovery
 * stays compact and survives client-side truncation — callers add
 * { includeParameters: true } / { includeOutputSchema: true } when they need
 * exact schemas to plan a call or downstream composition. Native descriptors,
 * schema freshness and match evidence require includeMetadata; describe keeps
 * the complete definition.
 */
export function projectCatalogMeta(
	meta: unknown,
	includeParameters: boolean,
	includeOutputSchema: boolean,
	fullDescription = false,
	includeMetadata = false,
): unknown {
	if (!isRecord(meta)) return meta;
	const { parameters, outputSchema, ...rest } = meta;
	const {
		native: _native,
		schemaFreshness: _freshness,
		_match,
		...compact
	} = rest;
	const compacted =
		!fullDescription && typeof rest.description === "string"
			? compactDiscoveryDescription(rest.description)
			: null;
	return {
		...(fullDescription || includeMetadata ? rest : compact),
		...(compacted ? compacted : {}),
		...(includeParameters ? { parameters } : {}),
		...(includeOutputSchema ? { outputSchema } : {}),
	};
}

/**
 * Search rows carry a bounded description: the full text (vendor tools ship
 * multi-KB REST doc dumps) is one discover.describe(callable) away, and
 * ranking already ran against the full text. The paid-tool notice appended by
 * buildCatalogProvider survives truncation in full — it changes how the call
 * must be made, so it must never be cut.
 */
function compactDiscoveryDescription(description: string): {
	description: string;
	descriptionTruncated?: true;
} {
	const paidIndex = description.indexOf("\n\nPaid tool: ");
	const head = (paidIndex >= 0 ? description.slice(0, paidIndex) : description)
		.replace(/\s+/g, " ")
		.trim();
	const tail =
		paidIndex >= 0 ? description.slice(paidIndex).replace(/\s+/g, " ") : "";
	if (head.length <= DISCOVERY_DESCRIPTION_BUDGET)
		return { description: `${head}${tail}` };
	const cut = head.slice(0, DISCOVERY_DESCRIPTION_BUDGET);
	const lastSpace = cut.lastIndexOf(" ");
	const trimmed = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
	return {
		description: `${trimmed}…${tail}`,
		descriptionTruncated: true,
	};
}

interface CatalogSearchField {
	text: string;
	weight: number;
	/** Tokenized fields earn the full weight only on a whole-token match. */
	tokens?: ReadonlySet<string>;
	substringWeight?: number;
}

/**
 * Normalized search text per catalog entry, computed once per entry instead of
 * once per scoring pass. Normalizing every field (including the stringified
 * input schema) of a 13k-tool aggregate catalog on each pass is what drove
 * single broad `discover.search` calls past the Worker CPU limit: one search
 * scored the whole catalog for ranking and again for nearest namespaces.
 * Entries are immutable after `buildCatalogProvider`, so a WeakMap keyed by
 * the entry is exact and is released with the catalog.
 */
/**
 * Indexed prefix of the two unbounded fields. Vendor tools ship multi-KB REST
 * doc dumps as descriptions and deep input schemas; ranking weights them at 4
 * and 1, so their tails add CPU without changing which tools rank first.
 */
const CATALOG_SEARCH_DESCRIPTION_CHARS = 4_000;

const CATALOG_SEARCH_PARAMETERS_CHARS = 2_000;

const catalogSearchFieldsCache = new WeakMap<
	CatalogToolEntry,
	CatalogSearchField[]
>();

function catalogSearchFields(
	namespace: string,
	toolName: string,
	meta: CatalogToolEntry,
): CatalogSearchField[] {
	const cached = catalogSearchFieldsCache.get(meta);
	if (cached) return cached;
	const namespaceText = normalizeSearchText(namespace);
	const fields: CatalogSearchField[] = [
		// Namespace is the highest-signal field, but a substring-only hit (e.g. the
		// query "tedi" inside the tenant suffix "tedix" across ~40 external app
		// namespaces) used to win at full weight and drown real results. So a
		// full-TOKEN namespace match keeps 14, while a substring-only match is
		// demoted below toolName (12) via `substringWeight`.
		{
			text: namespaceText,
			weight: 14,
			substringWeight: 6,
			tokens: new Set(namespaceText.split(/[^a-z0-9]+/).filter(Boolean)),
		},
		{ text: normalizeSearchText(toolName), weight: 12 },
		{ text: normalizeSearchText(meta.callable ?? ""), weight: 10 },
		{ text: normalizeSearchText(meta.name ?? ""), weight: 8 },
		{ text: normalizeSearchText(meta.displayName ?? ""), weight: 8 },
		{
			text: normalizeSearchText(
				(meta.description ?? "").slice(0, CATALOG_SEARCH_DESCRIPTION_CHARS),
			),
			weight: 4,
		},
		{
			text: normalizeSearchText(
				(JSON.stringify(meta.parameters) ?? "").slice(
					0,
					CATALOG_SEARCH_PARAMETERS_CHARS,
				),
			),
			weight: 1,
		},
	];
	catalogSearchFieldsCache.set(meta, fields);
	return fields;
}

export function scoreCatalogSearch(
	terms: string[],
	namespace: string,
	toolName: string,
	meta: CatalogToolEntry,
): CatalogSearchMatch | null {
	if (terms.length === 0) {
		return { score: 1, matchedTerms: [], unmatchedTerms: [] };
	}
	const fields = catalogSearchFields(namespace, toolName, meta);
	let score = 0;
	const matchedTerms: string[] = [];
	const unmatchedTerms: string[] = [];
	for (const term of terms) {
		const variants = searchTermVariants(term);
		let best = 0;
		for (const field of fields) {
			for (const variant of variants) {
				if (!field.text.includes(variant)) continue;
				const fieldWeight =
					field.tokens && !field.tokens.has(variant)
						? (field.substringWeight ?? field.weight)
						: field.weight;
				if (fieldWeight > best) best = fieldWeight;
			}
		}
		if (best > 0) {
			score += best;
			matchedTerms.push(term);
		} else {
			unmatchedTerms.push(term);
		}
	}
	if (matchedTerms.length === 0) return null;
	score += Math.round((matchedTerms.length / terms.length) * 20);
	// When the name contains every query term, favour names devoted to those
	// terms over longer vendor names. Count repeated tokens in the denominator.
	const nameTokens = normalizeSearchText(toolName).split(" ").filter(Boolean);
	if (terms.every((term) => nameTokens.includes(term))) {
		score += (terms.length / nameTokens.length) * 16;
	}
	// Every term can hit a high-weight field of a sibling tool too ("list tedis"
	// scores tedis.list_addresses like tedis.list_tedis), so a query that IS
	// the tool's name must outrank its namespace neighbours.
	const namesTool = (text: string) => {
		const tokens = new Set(normalizeSearchTerms(text));
		return (
			tokens.size === terms.length && terms.every((term) => tokens.has(term))
		);
	};
	if (namesTool(toolName) || namesTool(meta.callable ?? "")) score += 20;
	return { score, matchedTerms, unmatchedTerms };
}

function searchTermVariants(term: string): string[] {
	const variants = new Set([term]);
	if (term.length > 4 && term.endsWith("s")) variants.add(term.slice(0, -1));
	if (term.length > 4 && term.endsWith("ies")) {
		variants.add(`${term.slice(0, -3)}y`);
	}
	return [...variants];
}

export function nearestCatalogNamespaces(
	query: string,
	catalog: Record<string, Record<string, CatalogToolEntry>>,
): Array<{
	namespace: string;
	score: number;
	tools: number;
	sampleTools: string[];
}> {
	const terms = normalizeSearchTerms(query);
	return Object.entries(catalog)
		.map(([namespace, tools]) => {
			let score = 0;
			for (const [toolName, meta] of Object.entries(tools)) {
				const match = scoreCatalogSearch(terms, namespace, toolName, meta);
				score = Math.max(score, match?.score ?? 0);
			}
			if (score === 0) {
				score = fuzzyNamespaceScore(terms, namespace, Object.keys(tools));
			}
			return {
				namespace,
				score,
				tools: Object.keys(tools).length,
				sampleTools: Object.keys(tools).slice(0, 5),
			};
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.namespace.localeCompare(b.namespace))
		.slice(0, 8);
}

function fuzzyNamespaceScore(
	terms: string[],
	namespace: string,
	toolNames: string[],
): number {
	const candidates = normalizeSearchText([namespace, ...toolNames].join(" "))
		.split(" ")
		.filter(Boolean);
	let score = 0;
	for (const term of terms) {
		const best = candidates.reduce(
			(min, candidate) => Math.min(min, editDistance(term, candidate)),
			Number.POSITIVE_INFINITY,
		);
		if (best <= 2) score += 2 - best + 1;
	}
	return score;
}

export function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			const cost = left[i - 1] === right[j - 1] ? 0 : 1;
			current[j] = Math.min(
				current[j - 1]! + 1,
				previous[j]! + 1,
				previous[j - 1]! + cost,
			);
		}
		for (let j = 0; j < current.length; j++) previous[j] = current[j]!;
	}
	return previous[right.length] ?? 0;
}

export function suggestedCatalogQueries(
	terms: string[],
	catalog: Record<string, Record<string, CatalogToolEntry>>,
): string[] {
	const namespaceTerms = new Set<string>();
	for (const namespace of Object.keys(catalog)) {
		for (const term of normalizeSearchTerms(namespace))
			namespaceTerms.add(term);
	}
	const shared = terms.filter((term) => namespaceTerms.has(term)).slice(0, 3);
	return Array.from(
		new Set([
			...(shared.length > 0 ? [shared.join(" ")] : []),
			terms.slice(0, 3).join(" "),
			terms.slice(-3).join(" "),
		]),
	).filter(Boolean);
}

export function normalizeSearchTerms(query: string): string[] {
	return Array.from(new Set(normalizeSearchText(query).split(" "))).filter(
		Boolean,
	);
}

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// =============================================================================
// TOOL-NOT-FOUND SUGGESTIONS
// =============================================================================

/**
 * Token-overlap score between a missed tool name and an existing callable.
 * "list_skills" vs "skills.list_by_app_skills" → tokens {list, skills} vs
 * {skills, list, by, app} → overlap 2 / max 4 = 0.5.
 */
function scoreCallableMatch(missed: string, candidate: string): number {
	const missedTokens = new Set(
		missed.toLowerCase().split(/[._]+/).filter(Boolean),
	);
	const candidateTokens = new Set(
		candidate.toLowerCase().split(/[._]+/).filter(Boolean),
	);
	if (missedTokens.size === 0 || candidateTokens.size === 0) return 0;
	let overlap = 0;
	for (const token of missedTokens) {
		if (candidateTokens.has(token)) overlap += 1;
	}
	return overlap / Math.max(missedTokens.size, candidateTokens.size);
}

/** Top callables most similar to a missed tool name (token overlap ≥ ~1/3). */
function findClosestCallables(
	missed: string,
	callables: readonly string[],
	limit = 5,
): string[] {
	return callables
		.map((callable) => ({
			callable,
			score: scoreCallableMatch(missed, callable),
		}))
		.filter((entry) => entry.score >= 0.34)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.callable);
}

const TOOL_NOT_FOUND_PATTERN = /Tool "([^"]+)" not found/;

/**
 * Enrich upstream's bare `Tool "X" not found` execution error with the
 * closest existing callables so the model self-corrects in one round trip
 * instead of retrying guessed name variants. Zero static context cost —
 * suggestions only ship when a guess misses.
 */
export function enrichToolNotFoundError(
	error: string,
	callables: readonly string[],
): string {
	const match = error.match(TOOL_NOT_FOUND_PATTERN);
	if (!match?.[1]) return error;
	const missed = match[1];
	const closest = findClosestCallables(missed, callables);
	const suggestions =
		closest.length > 0 ? ` Closest callables: ${closest.join(", ")}.` : "";
	return `${error}.${suggestions} Run discover.search({ query: "${missed.replace(/_/g, " ")}" }) and call the returned callable exactly.`;
}

const NOT_DEFINED_PATTERN = /\b([A-Za-z_$][\w$]*) is not defined\b/;

/**
 * Explain a missing binding that matches the gateway's potential namespaces.
 * That inventory does not prove exposure: explicit tool filters can exclude
 * every tool in a namespace, and upstream resolution can also fail. These
 * inputs identify neither cause, so report only the observed missing binding
 * and direct the caller to discovery on the current organization target.
 */
export function enrichUnmountedNamespaceError(
	error: string,
	knownNamespaces: ReadonlySet<string>,
	mountedNamespaces: ReadonlySet<string>,
	requestedNamespaces: ReadonlySet<string> | null,
): string {
	const missing = error.match(NOT_DEFINED_PATTERN)?.[1];
	if (!missing) return error;
	if (mountedNamespaces.has(missing)) return error;
	if (!knownNamespaces.has(missing)) return error;
	// Extraction is a regex over `ns.tool(` call sites: it sees `ns.tool(...)`
	// and `ns["tool"](...)`, but not `ns[variable](...)`. A snippet that reaches
	// a namespace dynamically therefore never asks for it, so no hydration is
	// even attempted and retrying is futile — a deterministic miss, not a flake.
	if (requestedNamespaces && !requestedNamespaces.has(missing)) {
		return `${error}. Namespace "${missing}" is unavailable in this request, and your snippet never requested it: namespace hydration uses literal \`ns.tool(args)\` call sites, and computed access like \`ns[variable](args)\` is invisible to that scan. Use discover.search on the current organization target to confirm exposure, then call the returned callable literally.`;
	}
	return `${error}. Namespace "${missing}" is unavailable in this request. The potential namespace inventory does not establish tool exposure or the cause of the missing binding. Use discover.search on the current organization target to find an exposed callable. This result does not establish an upstream failure or missing organization membership.`;
}
